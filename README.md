# board-lab

Плагин для DSH: прошить плату, прочитать UART, поймать панику, прогнать сценарий — не отключая устройство.

Поддерживаются ESP32 / ESP32-S2 / ESP32-S3 (PlatformIO + esptool), Arduino AVR — Uno, Nano,
Mega (PlatformIO + avrdude), STM32 F1/F4/G0/G4/L4/H7 (PlatformIO + ST-Link / DFU / J-Link /
OpenOCD) и Artery AT32F403A/407 (GCC + Makefile, J-Link / ST-Link / CMSIS-DAP / DFU).

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
| `board_project` | текущий проект: показать, закрепить, открыть папку или `lib/` |
| `board_doctor` | проверить машину: PlatformIO, pyserial, probe-утилиты, порты, проект |
| `board_tools` | инвентарь инструментов и платформ с версиями; фоновая установка выбранных |
| `board_test` | прогнать `board-tests.json` проекта и получить отчёт |
| `board_cycle` | сборка → прошивка → чтение лога одним вызовом |

Плюс панель «Лаборатория плат» в Web UI: карточка текущего проекта с кнопками «Открыть папку»
и «Библиотеки», сборка, прошивка, живой лог, команды, факты о чипе, прогон сценария с шагами
и таймингами. Текущий проект — один на всё: `.board-lab/current.json`, поэтому `board_flash`
без `project` и агент видят ровно то, что выбрано в панели.

## Требования

- DSH (профиль `web` или настольная версия) — плагин ставится как bundle.
- PlatformIO Core: либо системный (`pio` в PATH или `%USERPROFILE%\.platformio\penv` / `~/.platformio/penv`),
  либо локальный тулчейн в `<workspace>/.toolchain` (см. `tools/setup-toolchain.sh` в workspace).
- Python из PlatformIO уже содержит pyserial и esptool; отдельно ставить ничего не нужно.
- AVR/Arduino: avrdude приходит с PlatformIO (`platform = atmelavr`); USB-UART драйвер (CH340/FTDI) — из системы.
- STM32: `platform = ststm32`; прошивка через ST-Link (`st-info`/`STM32CubeProgrammer`), DFU или J-Link.
  Если в `platformio.ini` стоит `upload_protocol = stlink` (или `dfu`/`jlink`/`openocd`), serial-порт для
  прошивки не нужен — он нужен только для чтения UART.
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

Быстрый старт на новой машине — «Настройки → Инструменты для плат»: зелёная/красная точка у каждого
инструмента, недостающие отмечаются галочкой и ставятся одной кнопкой «Скачать выбранные».
То же из агента — `board_tools` (`action: "list"`, затем `action: "install"` с `ids`).
Для диагностики — `board_doctor` (или кнопка «Проверить среду» в панели):
он показывает, что найдено, а чего нет, и что поставить.

```bash
node tests/client_smoke.mjs                    # регистрация панели, без браузера
node tests/plugin_contract.mjs --port /dev/ttyACM0   # контракт инструментов (нужна плата для части проверок)
python3 tests/monitor_loopback.py              # monitor.py на pty, без железа (нужен pyserial)
```

`tests/ui_check.mjs` — снимок панели через Playwright (нужен Chromium).

## Документация

`docs/board-lab.md` — монитор и курсоры чтения, паники, сценарии, автоопределение,
ESP32-S3 (16 МБ flash / 8 МБ PSRAM), AT32, права на serial в Linux, Windows, ограничения.
