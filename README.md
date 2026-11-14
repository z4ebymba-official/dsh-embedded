# board-lab

Плагин для DSH: прошить плату, прочитать UART, поймать панику, прогнать сценарий — не отключая устройство.

Поддерживаются ESP32 / ESP32-S2 / ESP32-S3 (PlatformIO + esptool) и Artery AT32F403A/407
(GCC + Makefile, прошивка через J-Link / ST-Link / CMSIS-DAP / DFU).

## Что даёт

Инструменты агента (`board_*`):

| инструмент | назначение |
|---|---|
| `board_ports` | список портов, USB id, by-id |
| `board_build` | сборка проекта PlatformIO или `make` |
| `board_flash` | прошивка; без `project` — по определённой плате |
| `board_monitor` | постоянный монитор: start / read / stop / status |
| `board_write` | строка в устройство через уже открытый порт |
| `board_watch` | ждать regex в новом выводе (READY, PONG, panic) |
| `board_info` | чип, flash, PSRAM, MAC через `esptool flash_id` |
| `board_decode` | адреса паники → функция и строка через `addr2line` |
| `board_detect` | определить плату и подсказать проект/окружение |
| `board_test` | прогнать `board-tests.json` проекта и получить отчёт |
| `board_cycle` | сборка → прошивка → чтение лога одним вызовом |

Плюс панель «Лаборатория плат» в Web UI: сборка, прошивка, живой лог, команды, факты о чипе,
прогон сценария с шагами и таймингами.

## Требования

- DSH (профиль `web` или настольная версия) — плагин ставится как bundle.
- PlatformIO Core: либо системный (`pio` в PATH или `%USERPROFILE%\.platformio\penv` / `~/.platformio/penv`),
  либо локальный тулчейн в `<workspace>/.toolchain` (см. `tools/setup-toolchain.sh` в workspace).
- Python из PlatformIO уже содержит pyserial и esptool; отдельно ставить ничего не нужно.
- AT32: `make` и `arm-none-eabi-gcc` (на Windows — MSYS2).

## Установка

Из этой папки:

```bash
# Linux / macOS
./install.sh            # профиль web по умолчанию; ./install.sh myprofile
```

```powershell
# Windows
.\install.ps1           # или .\install.ps1 -Profile myprofile
```

Вручную то же самое:

```bash
dsh plugin --profile web add /путь/к/board-lab
```

После установки — перезапустить DSH. Панель появится в сайдбаре, инструменты `board_*` — у агента.

## Настройка

Конфиг bundle-строки `board-lab` (в `cordis.patch.yml` или профиле):

- `workspaceRoot` — корень, относительно которого ищутся `firmware/` и `.board-lab/`.
  По умолчанию вычисляется от расположения плагина (`<workspace>/board-lab` → `<workspace>`),
  поэтому обычно пусто.
- `toolchainDir` — локальный тулчейн (по умолчанию `.toolchain`); если его нет, используется PlatformIO.
- `projectsDir` — папка проектов (по умолчанию `firmware`).
- `python` — явный интерпретатор, если PlatformIO стоит нестандартно.

## Проверки

```bash
node tests/client_smoke.mjs                    # регистрация панели, без браузера
node tests/plugin_contract.mjs --port /dev/ttyACM0   # контракт инструментов (нужна плата для части проверок)
python3 tests/monitor_loopback.py              # monitor.py на pty, без железа (нужен pyserial)
```

`tests/ui_check.mjs` — снимок панели через Playwright (нужен Chromium).

## Документация

`docs/board-lab.md` — монитор и курсоры чтения, паники, сценарии, автоопределение,
ESP32-S3 (16 МБ flash / 8 МБ PSRAM), AT32, права на serial в Linux, Windows, ограничения.
