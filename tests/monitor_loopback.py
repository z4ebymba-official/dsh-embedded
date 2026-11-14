#!/usr/bin/env python3
"""Loopback test for board-lab/monitor.py without hardware.

Creates a pseudo-terminal, starts the monitor against it, checks that device
output lands in the log file, that a control-socket write reaches the device,
and that stop exits cleanly.
"""
from __future__ import annotations

import json
import os
import pty
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
MONITOR = os.path.join(ROOT, "monitor.py")
LIB = os.path.join(ROOT, ".toolchain", "pylib")


def main() -> int:
    master, slave = pty.openpty()
    port = os.ttyname(slave)
    work = tempfile.mkdtemp(prefix="board-lab-monitor-")
    log = os.path.join(work, "monitor.log")
    state = os.path.join(work, "monitor.json")

    env = dict(os.environ)
    env["PYTHONPATH"] = LIB + (":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    proc = subprocess.Popen(
        [sys.executable, MONITOR, "--port", port, "--baud", "115200",
         "--log", log, "--state", state, "--reset", "none"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    problems = []
    try:
        # The monitor binds a loopback TCP port and records it in the state
        # file; no AF_UNIX path (which Windows does not have) is involved.
        tcp_port = None
        for _ in range(50):
            try:
                with open(state, encoding="utf8") as handle:
                    tcp_port = json.load(handle).get("tcpPort")
            except (OSError, ValueError):
                tcp_port = None
            if tcp_port:
                break
            time.sleep(0.1)
        if not tcp_port:
            print("FAIL: monitor did not publish a tcpPort", file=sys.stderr)
            return 1

        os.write(master, b"=== hello ===\r\nREADY\r\n")
        time.sleep(0.5)
        with open(log, "rb") as handle:
            text = handle.read().decode("utf8", "replace")
        if "READY" not in text:
            problems.append(f"device output missing from log: {text!r}")

        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(3)
        client.connect(("127.0.0.1", tcp_port))
        client.sendall(json.dumps({"cmd": "write", "text": "PING\n"}).encode())
        reply = client.recv(4096).decode()
        if json.loads(reply.splitlines()[0]).get("ok") is not True:
            problems.append(f"write rejected: {reply!r}")
        time.sleep(0.2)
        echoed = os.read(master, 4096)
        if b"PING" not in echoed:
            problems.append(f"device did not receive PING: {echoed!r}")

        client.sendall(json.dumps({"cmd": "status"}).encode())
        status = json.loads(client.recv(4096).decode().splitlines()[0])
        if status.get("open") is not True:
            problems.append(f"status says port closed: {status!r}")

        client.sendall(json.dumps({"cmd": "stop"}).encode())
        client.close()
        proc.wait(timeout=5)
    finally:
        if proc.poll() is None:
            proc.kill()
    if problems:
        print("FAIL:", "; ".join(problems), file=sys.stderr)
        return 1
    print("OK: monitor captured device output, accepted a write, and stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
