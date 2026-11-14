#!/usr/bin/env python3
"""Persistent UART monitor for the board-lab tools.

Owns the serial port for as long as it runs: appends everything the device
prints to a log file and accepts control commands on a loopback TCP socket, so
the agent can read new output and write to the device without reopening the port
(and therefore without resetting the board). TCP works the same on Linux and
Windows and avoids the ~108-byte AF_UNIX path limit.

Control protocol: one JSON object per line over the socket, one JSON reply.

    {"cmd": "status"}                   -> {"ok": true, "bytes": ..., ...}
    {"cmd": "write", "text": "PING\\n"}  -> {"ok": true}
    {"cmd": "reset"}                    -> {"ok": true}   (ESP32 DTR/RTS pulse)
    {"cmd": "stop"}                     -> {"ok": true}   (then exits)

Usage (normally started by the board-lab Host plugin):

    monitor.py --port /dev/ttyACM0 --baud 115200 \
        --log .board-lab/monitor-ttyACM0.log \
        --state .board-lab/monitor-ttyACM0.json

The chosen TCP port is written to the state file as ``tcpPort`` before the
first command is accepted.
"""
from __future__ import annotations

import argparse
import json
import os
import selectors
import socket
import sys
import time

STOP = False
# select() understands sockets everywhere, but serial handles only on POSIX;
# Windows falls back to polling the port on every loop tick.
SELECTABLE = os.name != "nt"


def _stop(_signum, _frame):
    global STOP
    STOP = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent UART monitor")
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--log", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--reset", choices=["none", "esp"], default="none")
    parser.add_argument(
        "--max-log-bytes",
        type=int,
        default=8 * 1024 * 1024,
        help="rotate the log once it grows past this size (keeps one .1 copy)",
    )
    return parser.parse_args()


def write_state(path: str, state: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf8") as handle:
        json.dump(state, handle)
    os.replace(tmp, path)


def main() -> int:
    args = parse_args()
    os.makedirs(os.path.dirname(args.log), exist_ok=True)

    try:
        import serial
    except ImportError:
        print(json.dumps({"error": "pyserial is not importable"}))
        return 2

    try:
        import signal

        signal.signal(signal.SIGINT, _stop)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, _stop)
    except Exception:
        # Windows without a console: the "stop" command is the only path needed.
        pass

    log = open(args.log, "ab", buffering=0)
    state = {
        "pid": os.getpid(),
        "port": args.port,
        "baud": args.baud,
        "log": args.log,
        "startedAt": time.time(),
        "bytes": 0,
        "open": False,
        "error": None,
    }
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Loopback only: the socket carries raw UART writes, never exposed to LAN.
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    server.setblocking(False)
    state["tcpPort"] = server.getsockname()[1]
    write_state(args.state, state)

    port = None
    peers: list[socket.socket] = []
    selector = selectors.DefaultSelector()
    selector.register(server, selectors.EVENT_READ, ("accept", None))
    next_open_attempt = 0.0

    def maybe_rotate() -> None:
        nonlocal log
        try:
            if os.path.getsize(args.log) < args.max_log_bytes:
                return
        except OSError:
            return
        try:
            log.close()
            os.replace(args.log, f"{args.log}.1")
            log = open(args.log, "ab", buffering=0)
            # The read offset now points past the new file; the Host clamps it
            # back to 0, which self-heals the next read.
            state["bytes"] = 0
            state["rotated"] = int(state.get("rotated") or 0) + 1
            write_state(args.state, state)
        except Exception as exc:  # rotation is best effort; keep streaming
            state["error"] = f"log rotation failed: {exc}"
            write_state(args.state, state)
            try:
                log = open(args.log, "ab", buffering=0)
            except Exception:
                pass

    def open_port() -> bool:
        nonlocal port
        try:
            port = serial.Serial(
                args.port,
                args.baud,
                timeout=0,
                write_timeout=1,
                dsrdtr=False,
                rtscts=False,
                exclusive=False,
            )
            # Bytes buffered by the tty before we opened it belong to nobody: the
            # previous owner, or the firmware that the reset below is about to
            # replace. Dropping them is what keeps a torn half-line from being the
            # first thing a fresh log contains.
            try:
                port.reset_input_buffer()
            except Exception:
                pass
            if args.reset == "esp":
                port.dtr = False
                port.rts = True
                time.sleep(0.12)
                port.rts = False
                time.sleep(0.06)
            if SELECTABLE:
                selector.register(port.fileno(), selectors.EVENT_READ, ("serial", None))
            state["open"] = True
            state["error"] = None
            write_state(args.state, state)
            return True
        except Exception as exc:  # the port may be held by esptool right now
            port = None
            state["open"] = False
            state["error"] = str(exc)
            write_state(args.state, state)
            return False

    def read_serial() -> None:
        """Drain the port into the log; also used as the Windows poll path."""
        nonlocal port
        if port is None:
            return
        try:
            chunk = port.read(4096)
        except Exception as exc:
            state["error"] = str(exc)
            if SELECTABLE:
                try:
                    selector.unregister(port.fileno())
                except Exception:
                    pass
            try:
                port.close()
            except Exception:
                pass
            port = None
            state["open"] = False
            write_state(args.state, state)
            return
        if chunk:
            log.write(chunk)
            state["bytes"] += len(chunk)
            if state["bytes"] % 4096 < len(chunk):
                write_state(args.state, state)
            maybe_rotate()

    def ensure_port() -> None:
        """Non-blocking: never sleep while the socket may carry commands."""
        nonlocal next_open_attempt
        if port is not None:
            return
        now = time.monotonic()
        if now < next_open_attempt:
            return
        if not open_port():
            next_open_attempt = now + 1.0

    def reply(peer: socket.socket, payload: dict) -> None:
        try:
            peer.sendall((json.dumps(payload) + "\n").encode("utf8"))
        except OSError:
            pass

    def handle(line: bytes) -> dict:
        try:
            request = json.loads(line.decode("utf8"))
        except Exception:
            return {"ok": False, "error": "invalid JSON"}
        command = request.get("cmd")
        if command == "status":
            return {"ok": True, "pid": state["pid"], "port": state["port"],
                    "baud": state["baud"], "bytes": state["bytes"],
                    "open": state["open"], "error": state["error"]}
        if command == "write":
            if port is None:
                return {"ok": False, "error": "port is not open"}
            try:
                port.write(str(request.get("text", "")).encode("utf8"))
                return {"ok": True}
            except serial.SerialTimeoutException:
                # pyserial only raises this once the OS/CDC buffer refuses data,
                # i.e. the firmware has stopped draining the port.
                return {"ok": False,
                        "error": "write timed out: the device is not reading the port "
                                 "(firmware hung or crashed); try a reset or reflash"}
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
        if command == "reset":
            if port is None:
                return {"ok": False, "error": "port is not open"}
            try:
                port.dtr = False
                port.rts = True
                time.sleep(0.12)
                port.rts = False
                time.sleep(0.06)
                return {"ok": True}
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
        if command == "stop":
            return {"ok": True, "stopping": True}
        return {"ok": False, "error": f"unknown command {command!r}"}

    ensure_port()
    stopping = False
    try:
        while not STOP:
            events = selector.select(timeout=0.2)
            if port is None:
                ensure_port()
            elif not SELECTABLE:
                # Windows: serial handles are not selectable, poll them here.
                read_serial()
            for key, _mask in events:
                kind, _ = key.data
                if kind == "accept":
                    try:
                        peer, _addr = server.accept()
                        peer.setblocking(False)
                        peers.append(peer)
                        selector.register(peer, selectors.EVENT_READ, ("peer", peer))
                    except OSError:
                        pass
                    continue
                if kind == "peer":
                    peer = key.data[1]
                    try:
                        data = peer.recv(65536)
                    except OSError:
                        data = b""
                    if not data:
                        try:
                            selector.unregister(peer)
                        except Exception:
                            pass
                        if peer in peers:
                            peers.remove(peer)
                        peer.close()
                        continue
                    for line in data.splitlines():
                        if not line.strip():
                            continue
                        answer = handle(line)
                        reply(peer, answer)
                        if answer.get("stopping"):
                            stopping = True
                    continue
                if kind == "serial":
                    read_serial()
            if stopping:
                break
    finally:
        try:
            if port is not None:
                port.close()
        except Exception:
            pass
        selector.close()
        server.close()
        log.close()
        state["open"] = False
        state["stoppedAt"] = time.time()
        write_state(args.state, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException as exc:  # last resort: leave the reason on disk
        import traceback
        traceback.print_exc()
        try:
            state_path = sys.argv[sys.argv.index("--state") + 1]
            with open(state_path, "w", encoding="utf8") as handle:
                json.dump({"pid": os.getpid(), "error": str(exc), "open": False}, handle)
        except Exception:
            pass
        sys.exit(1)
