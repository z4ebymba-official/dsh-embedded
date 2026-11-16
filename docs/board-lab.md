# Board lab — прошить, прочитать, починить, проверить

Плагин для профиля `web`, который даёт агенту (и человеку в Web UI) один и тот же набор
операций над платой. Прошивку пишет другой агент — здесь только инструмент.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `board_ports` | список serial-портов: путь, by-id, vid/pid, драйвер |
| `board_build` | PlatformIO `run` (ESP32) или `make` (AT32): успех, код, RAM/Flash, хвост вывода |
| `board_flash` | заливка: PlatformIO upload/esptool для ESP32, `make flash` для AT32; монитор останавливается на время заливки и перезапускается после |
| `board_monitor` | persistent-монитор: `start` / `read` (только новое, `waitMs`, `fromStart`, `peek`) / `stop` / `status` |
| `board_write` | отправить строку в устройство через монитор |
| `board_watch` | ждать строку по regex: стартует монитор при необходимости и возвращает `matched`, найденную строку и хвост лога; без `fromStart` — только новые строки, с ним — и история; `timeoutMs` 0.5–120 с |
| `board_info` | `esptool flash_id`: чип, revision, размер flash, PSRAM, MAC (монитор останавливается на время опроса и перезапускается со сбросом) |
| `board_decode` | декодер паник: `Guru Meditation Error`, `abort()`, `assert failed`, `Backtrace`/`MCPC` → `addr2line` по ELF проекта: функция, файл, строка; печатает, какой ELF и когда собран |
| `board_project` | текущий проект: `status` / `list` / `select` (закрепить) / `open` (открыть папку или `lib/` в файловом менеджере) |
| `board_doctor` | проверить окружение машины и получить список «чего не хватает» |
| `board_tools` | инвентарь инструментов/платформ (`list`), установка выбранных в фоне (`install`), прогресс (`status`) |
| `board_detect` | определить плату: vid/pid → `esptool flash-id` → семейство чипа → подходящий проект и env из `firmware/*/platformio.ini`; кэш «порт → проект» в `.board-lab/boards.json` |
| `board_test` | сценарный прогон по `board-tests.json` (`flash`, `build`, `watch`, `write`, `absent`, `reset`, `sleep`): шаги, тайминги, отчёт в `.board-lab/runs/<ts>/` |
| `board_cycle` | `build → flash → start monitor → собрать вывод durationMs` (или до regex) |

Все операции реализованы один раз на Host и доступны двумя путями: инструментами агента и
HTTP-маршрутами `/board-lab/*`, которые вызывает панель. Кнопка и tool не расходятся.

## Монитор: чтение без отключения

`board_monitor action=start` запускает detached-процесс `monitor.py`:

- открывает порт один раз и держит его (DTR/RTS не дёргаются, кроме явного `reset`);
- пишет всё в `.board-lab/monitor-<port>.log`;
- слушает Unix-сокет в `/tmp/board-lab-<port>.sock` (AF_UNIX ограничен ~108 байтами,
  а путь workspace содержит кириллицу, поэтому сокет в /tmp);
- `read` отдаёт байты от сохранённого offset (`.board-lab/offsets.json`) и сдвигает его;
- offset ведётся **раздельно для трёх читателей** — `agent` (инструменты `board_monitor`/`board_write`),
  `panel` (Web UI) и `watch` (`board_watch`, а также шаги сценария). Общий курсор означал бы, что
  опрос панели раз в 0.9 с съедает байты, которых ждёт агент (и наоборот); теперь живой лог панели,
  `board_watch` и агент не мешают друг другу;
- лог ротируется при 8 МиБ (`--max-log-bytes`): старый файл становится `.log.1`, а offset
  сбрасывается на 0 — читатель после ротации начинает с начала, а не теряет данные молча;
- `write` и `reset` идут в тот же процесс — второй открыватель порта не нужен.

`board_flash` после успешной заливки сам поднимает монитор с импульсом сброса и **сбрасывает
offset на текущий конец лога**, поэтому следующий `read` — это ровно boot-лог только что
залитой прошивки, без старого хвоста.

Файлы состояния (`.board-lab/`): `monitor-<port>.log`, `monitor-<port>.json` (pid, baud, ошибки),
`monitor-<port>.sock` → /tmp (chmod 0600), `offsets.json` (`{"<port>": {"agent": N, "panel": M, "watch": K}}`;
старый формат с числом читается и разворачивается во все курсоры).

Сокет-команды (`status`/`write`/`stop`) не блокируются, пока порт занят esptool: попытка
открыть порт повторяется с паузой 1 с в фоне, а не внутри обработчика команды.

### watch: только новые строки

`board_watch` читает лог своим курсором (`watch`) и без `fromStart` **не матчит историю**:
курсор ставится на текущий конец лога, поэтому `READY` от прошлой загрузки не даёт ложного
совпадения. `fromStart: true` наоборот сначала просматривает весь лог (один дамп до 1 МиБ) и
только потом ждёт новое — дамп не повторяется от опроса к опросу.

### start и fromStart не двигают историю назад

`start` с `reset: 'esp'` запоминает размер лога до запуска и ставит оба курсора на него, так что
следующий `read` — только свежий boot, даже если в старом логе оставался непрочитанный хвост.
`read` с `fromStart: true` работает как дамп: курсор **не** откатывается назад (раньше лог
повторялся при следующем чтении). Байты, накопившиеся в tty до открытия порта, отбрасываются
(`reset_input_buffer`), иначе лог начинался с рваной строки. Если порт открыть не удалось,
`start` возвращает `ok: false` и не оставляет ни state, ни сокета, ни пустого файла лога;
`read` на остановленном мониторе помечает вывод как буфер (`running: false`).

## Паники: сразу функция и строка

`board_decode` берёт текст паники (`text`) или хвост лога порта и прогоняет адреса через
`addr2line` того тулчейна, который собрал проект:

```
board_decode project=firmware/esp32s3-touch-tm1637 port=/dev/ttyACM0 text="Guru Meditation Error: ... Backtrace: 0x42009ac8:0x3fcebd50"
→ LoadProhibited on core 0 — 0x42009ac8 app_main at cores/esp32/main.cpp:89
```

Параметры: `project`, `env`, `text`, `port`, `elf` (явный ELF, если прошивка не из
`firmware/`). В ответе — `summary`, `exception`, `core`, `frames` (символ + файл:строка),
`elf` и `elfModified`: если ELF старее исходников или это другая сборка, это видно сразу,
а не приписывается «магии» декодера. AT32 не декодируется (архитектура другая) — вернётся
понятная ошибка.

`board_watch` сам вызывает декодер, когда в пойманном тексте есть паника: в ответе появляются
`panic: true` и `decode`. `board_flash` делает то же для boot-лога, если прошивка сразу упала.

## Сценарии: одна команда вместо десяти

`board_test` читает `<project>/board-tests.json`:

```json
{
  "name": "touch smoke",
  "steps": [
    { "flash": {} },
    { "watch": { "pattern": "READY", "timeoutMs": 20000 } },
    { "write": { "text": "PING" } },
    { "watch": { "pattern": "PONG", "timeoutMs": 5000 } },
    { "absent": { "pattern": "Guru Meditation", "withinMs": 1000 } }
  ]
}
```

Шаги: `flash`, `build`, `watch`, `write`, `absent`, `reset`, `sleep`. Каждый шаг получает
✓/✗, тайминг и найденную строку; по умолчанию прогон останавливается на первой ошибке
(`continueOnFailure`). Отчёт и `uart.log` пишутся в `.board-lab/runs/<timestamp>/`, а
`ok: false` в ответе — это готовый ненулевой смысл для CI.

Особенность шага `watch`: он смотрит на **последние 64 КиБ** лога, а не строго «с этого
момента». Иначе `write PING` → мгновенный `PONG` и boot-баннер, который печатается, пока
`flash` ещё возвращается, оказывались «до начала ожидания» и сценарий ложно падал.

## Автоопределение платы

`board_detect` отвечает на вопрос «что подключено и чем это шить»:

1. vid/pid порта — известный мост (Espressif, CP210x, CH340, AT32 DFU, ST-Link);
2. `esptool flash-id` — семейство чипа (`esp32s3`, `esp32`, `esp32c3`, `at32`);
3. `board = …` из `firmware/*/platformio.ini` + `default_envs` — подходящий проект и env.

Ответ: `chip`, `family`, `flashSize`, `psram`, `mac`, `project`, `env`, `confidence`
(`high` — одна семья и кэш/единственный кандидат, `medium` — несколько кандидатов,
`none` — не опознано) и `candidates`. Результат запоминается в `.board-lab/boards.json`
по by-id (или vid:pid), поэтому следующий вызов и панель уже знают проект.

`board_flash` без `project` использует это же определение: кэш → опрос чипа → единственный
подходящий проект. Если кандидатов несколько, инструмент честно перечисляет их и просит
указать `project`, а не угадывает. AT32 с J-Link/ST-Link шьётся без serial-порта (порт нужен
только ESP32 и `make`-проектам без probe).

## AVR (Arduino Uno / Nano / Mega)

AVR-платы прошиваются через PlatformIO: `platform = atmelavr`, `board = uno`, `framework = arduino`;
PlatformIO сам вызывает avrdude и сам находит порт. Скорость 115200, на платах с CH340/FTDI нужен
системный драйвер (Windows — CH341SER, Linux — `ch341`/`ftdi_sio`).

Особенности, которые уже учтены:

- **Нет chip id до прошивки.** AVR не умеет отдавать идентификатор по serial, поэтому
  `board_detect` для портов Arduino (VID `2341`/`2a03`) возвращает family `avr` и просит указать
  проект, а не гадает. Для кэша (`boards.json`) после успешной прошивки проект запоминается.
- **Сброс при открытии порта.** Монитор открывает порт с `dsrdtr=False`, поэтому не дёргает DTR и не
  перезагружает плату; прошивка перезапускает монитор с импульсом сброса, чтобы поймать баннер.
- **Uno/Nano**: 32 КБ flash, 2 КБ SRAM — большие баннеры и `String` лучше не лить.

Готовый пример: `firmware/arduino-uno-hello` (баннер, heartbeat, PING/HELLO/RESET, `board-tests.json`).

## STM32 (F1/F4/G0/G4/L4/H7)

STM32 прошивается через `platform = ststm32`. Способ задаётся в `platformio.ini`:

```ini
[env:bluepill]
platform = ststm32
board = bluepill_f103c8
framework = arduino        ; или stm32cube, cmsis
upload_protocol = stlink   ; stlink | dfu | jlink | openocd | cmsis-dap
```

- **Probe-протоколы не требуют serial-порта.** Если `upload_protocol` — `stlink`, `dfu`, `jlink`,
  `openocd` или `cmsis-dap`, `board_flash` не ищет порт и не падает с «no serial port»; `--upload-port`
  добавляется только когда порт реально есть.
- **`board_info` для STM32** читает `st-info --probe` (пакет stlink-tools): dev-type, chipid, flash, SRAM.
  Если инструментов нет — возвращает family `stm32` и подсказку.
- **UART** обычно висит на USB-UART переходнике (PA9/PA10 → COMx). Монитор работает как с любым портом.
- **DFU**: `upload_protocol = dfu` использует встроенный загрузчик (BOOT0 прижат к 3.3 В при старте).

Готовый пример: `firmware/stm32f103-hello` (USART1 PA9/PA10, PING/HELLO/RESET, сценарий).

## ESP32-S3 (WROOM-1-N16R8)

`firmware/esp32s3-hello/platformio.ini`:

```ini
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
board_build.flash_size = 16MB
board_upload.flash_size = 16MB
board_build.partitions = default_16MB.csv  ; таблица разделов должна совпадать с реальным flash
board_build.arduino.memory_type = qio_opi  ; PSRAM (OPI) + QIO flash
flash_mode = qio
upload_speed = 921600
build_flags =
    -DCORE_DEBUG_LEVEL=0
    -DARDUINO_USB_MODE=1                   ; USB-Serial-JTAG как консоль
    -DARDUINO_USB_CDC_ON_BOOT=1
```

Плата видна как `/dev/ttyACM0` (`303a:1001`) и в ROM-загрузчике, и в приложении — esptool
делает автосброс по DTR/RTS, отдельное «держи BOOT» не нужно.

`board_info` на этом модуле: `Chip type: ESP32-S3 (QFN56) revision v0.2`,
`Embedded PSRAM 8MB (AP_3v3)`, `Detected flash size: 16MB`, MAC `44:1b:f6:ff:a6:c0` —
16 МБ flash и 8 МБ PSRAM, а не 4 МБ/0, как у «обычного» devkit-пресета.

Если таблица разделов не совпадает с размером flash, плата уходит в boot-loop с
`partition 3 invalid ... exceeds flash chip size 0x400000` — это признак `default.csv`
(8 МБ) на 4 МБ модуле или `default_16MB.csv` на 16 МБ.

### PSRAM: чем мерить

IDF инициализирует PSRAM на boot (`esp_psram_get_size()` = 8192 КБ,
`heap_caps_get_free_size(MALLOC_CAP_SPIRAM)` ≈ 8189 КБ), но Arduino-обёртка
`psramInit()`/`psramFound()` в этой сборке возвращает false: прекомпилированные
`framework-arduinoespressif32-esp32s3-libs` для `qio_opi` содержат `CONFIG_SPIRAM`,
а объект `esp32-hal-psram.c`, собранный PlatformIO из исходников, всё равно получается
со stub-реализацией. На железо это не влияет — PSRAM работает, — но `ps_malloc()`
из Arduino-ядра полагаться нельзя. В своей прошивке используйте IDF API:

```cpp
#include <esp_psram.h>
#include <esp_heap_caps.h>

if (esp_psram_is_initialized()) {
  void *p = heap_caps_malloc(1024 * 1024, MALLOC_CAP_SPIRAM);
}
```

Баннер `firmware/esp32s3-hello` печатает обе правды: размер PSRAM и свободную PSRAM-кучу.

## AT32F403A/407

- Сборка: `make` + `arm-none-eabi-gcc` из PlatformIO-пакета, BSP Artery лежит в `vendor/`.
- Прошивка: `flash.sh` выбирает J-Link / DFU / OpenOCD; переопределяется `AT32_FLASH=...`.
- USART1: PA9/PA10, 115200 8N1.

## Windows

- Корень workspace: `<workspace>/board-lab` → `<workspace>`; конфиг `workspaceRoot` нужен только для нестандартной раскладки.
- Интерпретатор: конфиг `python` → PlatformIO venv (`%USERPROFILE%\.platformio\penv\Scripts\python.exe`) → `python` из `PATH`. Если в workspace есть `.toolchain/pylib`, он приоритетнее venv и `PYTHONPATH` указывает на него.
- Порты: pyserial через тот же интерпретатор (даёт `COM3`, описание и VID/PID); при отсутствии pyserial — `reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM`.
- Монитор: control-канал — TCP на `127.0.0.1` (порт пишется в `monitor-*.json` как `tcpPort`), `AF_UNIX` не используется. Остановка: `stop` по TCP, затем `taskkill /T /F`.
- Сборка: ESP32 — `pio run -d <dir> -t upload --upload-port COMx`; AT32 — `make` из MSYS2 + `arm-none-eabi-gcc` в `PATH`.
- Ограничение: монитор запускается как обычный дочерний процесс (без `detached`), поэтому при выходе из DSH он завершится; следующий вызов `board_monitor` поднимет его снова.

## Права на serial (Linux)

`/dev/ttyACM0` создаётся как `root:dialout 0660`, поэтому без правила esptool получает
`Permission denied`. Одноразово:

```bash
sudo tee /etc/udev/rules.d/99-dsh-serial.rules >/dev/null <<'EOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0666", GROUP="plugdev"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
```

Без перелогина и без перезапуска dsh.

## Текущий проект и библиотеки

Каждый проект — обычная папка `firmware/<имя>/` с `platformio.ini` (или `Makefile`). Рядом
с `src/` у PlatformIO есть `lib/`: положите туда библиотеку — и следующая сборка её подхватит,
ничего прописывать не нужно. Кнопка «Библиотеки» в панели создаёт `lib/` и открывает её.

Выбранный проект хранится в `.board-lab/current.json` (`project`, `env`). Это единственный
источник истины и для панели, и для агента:

1. `board_project status` показывает текущий проект, его плату и env;
2. `board_project select firmware/<имя>` закрепляет проект (это же делает выбор в списке
   «Проект» в панели и `board_detect`, когда уверенность `high`);
3. `board_flash` **без `project`** берёт закреплённый проект — даже если проектов на эту
   плату несколько. Если закреплённого нет, работает прежняя логика: кэш порта → уникальное
   семейство чипа → ошибка со списком кандидатов;
4. `board_project open` открывает папку проекта (или `lib/`, `src/`) в проводнике/файловом
   менеджере — так же, как кнопки «Открыть папку» и «Библиотеки».

Приоритет: закреплённый проект → кэш «порт → проект» → единственный проект семейства.
Если несколько проектов собираются под одну плату и закреплённого нет, `board_flash` честно
отказывается угадывать и перечисляет кандидатов.

## Панель

Сайдбар → «Лаборатория плат». Раскладка: сверху карточка «Плата» (проект, порт, скорость,
`Собрать` / `Прошить` / `Прогнать тесты` / `Определить плату` / `Проверить среду`), под ней
живой лог, справа колонка «Проект» (папка, путь, плата и env, кнопки `Открыть папку` и
`Библиотеки`), «Устройство» (порт, USB id, чип, ревизия, flash, PSRAM, MAC, кнопка
`Инфо о чипе`) и «Команды» (`PING`, `HELLO`, `VERSION`, `MODE 1`, `MODE 2`, `Сброс`). Внизу — «Прогон
сценария»: последний `board_test`, время каждого шага и путь к отчёту.

Лог опрашивает монитор каждые 0.9 с и дописывает новое; «Отправить» пишет в устройство.
Пока вкладка скрыта, опрос замирает и не накладывается сам на себя. Плашка о проблеме с
портом появляется только после двух подряд неудачных опросов (одиночный опрос во время
прошивки или `board_info` — норма, порт в этот момент занят esptool), а зависшее состояние
монитора отмечается бейджем «монитор завис».

В логе есть фильтр по подстроке (строки разбиваются по `\n`, поэтому фильтр не тащит
соседние heartbeat-строки), «Копировать» и «Очистить». Пустой лог показывает подсказку из
трёх шагов: определить плату → прошить → смотреть вывод. Выбор проекта и порта запоминается.

## Проверено на железе (ESP32-S3 Super Mini)

- `board_info`: ESP32-S3 rev v0.2, 16 МБ flash, 8 МБ PSRAM, MAC `44:1b:f6:ff:a6:c0`.
- Прошивка по USB-JTAG: `SUCCESS`, ~7 с, образ 16 МБ (`default_16MB.csv`).
- Boot-лог после заливки: `flash: 16384 KB`, `psram: 8192 KB`, `psram heap: 8189 KB`, `READY`.
- Инкрементальные чтения: второй `read` вернул только новые heartbeat-строки.
- `write PING` → в логе `PONG`.
- `board_watch pattern=PONG` в параллель с опросом панели: `matched: true` — курсоры
  `agent` и `panel` независимы, панель не съедает строку у агента.
- Прошивка при работающем мониторе: остановка → заливка → перезапуск → свежий banner.
- UI в headless Chromium: живой лог, «Инфо о чипе», PING → PONG, фильтр по строке,
  ошибок консоли нет.

## Контракт инструментов и «живость» монитора

Результат каждого инструмента проверяется Harness'ом по объявленной `output.schema`
(`additionalProperties: false`) и должен переживать JSON-сериализацию. Поэтому в
`index.js` все ответы собираются через `compact()`: `undefined`/`null` не попадают в
результат, а любые новые поля сначала объявляются в схеме. Именно нарушение этого
контракта давало `tool "board_monitor" returned invalid output`.

Монитор считается живым только если живы **оба** признака: процесс (`kill(pid, 0)`,
`EPERM` тоже считается живым) и сокет. Файл состояния, переживший свой процесс
(`kill -9`, падение, перезагрузка), больше не выдаётся за работающий монитор:
`status` показывает `stopped (stale state)`, `read` без новых байт говорит, что
монитор не запущен, а `start` заново поднимает процесс и затирает остатки.

Если прошивка перестала вычитывать порт, `board_write` возвращает осмысленную
ошибку («write timed out: the device is not reading the port…») вместо голого
`Write timeout` из pyserial.

```bash
node tests/plugin_contract.mjs              # схемы + жизненный цикл на pty
node tests/plugin_contract.mjs --port /dev/ttyACM0   # ещё и живая плата
```

## Ограничения

- AT32 на железе не проверялся — нет пробника (J-Link/ST-Link/CMSIS-DAP).
- Arduino `psramInit()`/`ps_malloc()` в этой сборке не работают (см. раздел про PSRAM);
  сама PSRAM инициализирована IDF — используйте `esp_psram_*`/`heap_caps_*`.
- Монитор — один процесс на порт; параллельные читатели не теряют данные (курсоры
  `agent` и `panel` раздельные), но оба читают один и тот же лог, так что порядок
  строк между ними не гарантирован.
- `board_cycle` не ждёт появления конкретной строки дольше `durationMs`/`untilPattern`;
  для точного ожидания используйте `board_watch`.

## Если плагин сломал Web UI

Клиентский плагин, у которого `apply` бросил исключение, останавливает boot страницы
(«Failed to load plugins») — так устроен boot-аудит. Восстановление:

```bash
dsh plugin --profile web remove @local/board-lab
```

Перед повторной установкой прогоняйте `tests/client_smoke.mjs` и `tests/ui_check.mjs`.

## Агент «Платальщик»: минимальный набор инструментов

Платы — отдельная дисциплина, и держать её в основной сессии дорого: у главного
агента ~70 инструментов и большой системный промпт. Поэтому для железа заведён
отдельный пресет `board` (бандл `tools/board-agent`) и участник отряда
«Лаборатория плат» → «Платальщик».

Состав:

| Что | Зачем |
|---|---|
| `board_ports`, `board_detect`, `board_info` | что подключено и что за чип |
| `board_build`, `board_flash`, `board_monitor`, `board_write`, `board_cycle`, `board_watch` | цикл прошивки и UART |
| `board_decode` | паника → функция и строка |
| `board_test` | регрессия по `board-tests.json` |
| `read`, `write`, `edit`, `glob`, `grep` | правки в `firmware/` |
| `memos_*` | память проекта |

Пресет не наследует глобальные инструменты автоматически — наоборот, они видны
всем агентам, и пресет лишь добавляет свои. Поэтому набор сужает плагин
`@local/board-agent`: `ctx.tools.restrict({ deny })` скрывает всё лишнее.

Список запрещённых имён вычисляется на месте, а не хардкодится.
`tools.restrict()` падает на любом имени, которого нет в restrictable-наборе
скоупа, и одно лишнее имя делает пресет нерабочим. Поэтому плагин сначала
делает пробный вызов с заведомо неизвестным именем, разбирает из текста ошибки
`known global tools: …` и запрещает только пересечение с этим набором. Если
сообщение не распознано — ограничение не применяется вовсе: лучше лишние
инструменты, чем сломанный пресет.

Форма `allow` для этой задачи не подходит: она фильтрует и унаследованные
инструменты пресета, из-за чего файловые `read/write/edit/glob/grep` исчезают
вместе с лишними. `deny` их не трогает.

Проверено на живой сессии: у «Платальщика» ровно 23 инструмента — 11 `board_*`,
`read/read_image/write/edit/glob/grep` и 6 `memos_*`. `board_ports` и
`board_info` отвечают, `working_directory` скрыт. Один диагностический шаг
стоит ~6–7 тыс. токенов вместо ~22 тыс. у обычного пресета.

Вызов — по наитию из основной сессии: скилл `board-lab-delegation` описывает,
когда делегировать и что писать в задаче. Один вызов:

```text
squads_run_member(squadId: "c8e53049-5a8c-4905-90b9-621a27db124b",
                  memberId: "e1fb9217-2caf-4444-874c-d219d917bc15",
                  firstMessage: "Прошей firmware/esp32s3-touch-tm1637 и проверь PING→PONG")
```

Изменения пресета применяются только после перезапуска `dsh web`: реестр
пресетов держит бандл в памяти.
