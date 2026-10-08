# Optional native development

TypeScript SDR stream processing, decoder supervision, a REST/WebSocket API,
and a terminal dashboard. IQ can come from a local USB dongle, a remote
`rtl_tcp`/rtlmux host such as a Raspberry Pi, or a recording.

The normal runtime uses the [Docker application](DOCKER-RUNTIME.md), which
bundles its decoder tools and requires no host decoder installation. The
commands below are optional native development and diagnostic paths.

## Start native development without hardware

Install Node.js 20+ and pnpm 10.28.0, then from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm start:local
```

This builds the workspace and starts the API at <http://127.0.0.1:9000> using
`config/local.yaml`. It starts with no sources or decoders and needs no Pi,
dongle, Docker, or native decoder binaries. An empty source/message list is
expected. Check `http://127.0.0.1:9000/health` and `/api/status`; Swagger UI is
available at `/docs`.

In a second terminal, run `pnpm dashboard`. Use `pnpm dev:local` for source
watching, or `make dev-local`. The dashboard also supports
`WAVEKIT_API_URL=http://127.0.0.1:3000 pnpm dashboard` for a different API port.

## Use a USB RTL-SDR dongle on macOS or Linux

Use native `rtl_tcp` to access USB. On macOS its Homebrew package is
[`librtlsdr`](https://formulae.brew.sh/formula/librtlsdr):

```sh
brew install librtlsdr
# Plug in the dongle; then leave this running in one terminal:
pnpm rtl:serve
# In another terminal:
pnpm start:rtl
# In a third terminal (optional):
pnpm dashboard
```

The source is `127.0.0.1:1234`, and the API stays on port 9000. WaveKit connects
to `rtl_tcp` once and fans out IQ internally. Connect SDR++ to WaveKit's RTL-TCP
relay on `127.0.0.1:4713` if you want a tuner client; `rtl_tcp` itself supports
one client at a time. Port 4713 carries binary IQ, not HTTP or WebSocket data.

`pnpm rtl:serve --help` lists settings. For example,
`RTL_TCP_FREQUENCY=433920000 RTL_TCP_GAIN=30 pnpm rtl:serve` starts on
433.92 MHz. If you change the sample rate, port, or initial frequency, update
the corresponding source fields in your selected config as well. API tuner
commands can retune a live source. Ctrl-C stops each foreground service.

`config/local-rtl.yaml` enables the source and relay; decoders and live audio
start disabled so missing optional tools do not prevent startup. For audio,
install the compatible `csdr` described below, then enable `liveDemod` in a copy
of the config or through the live audio API/dashboard.

Docker Desktop runs Linux in a VM and
[does not support direct USB passthrough](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/).
[OrbStack supports USB passthrough to Linux machines](https://docs.orbstack.dev/machines/),
so a supported attached dongle can be served from Linux. Native `rtl_tcp` is
also an optional bridge; Docker decoders can connect to a reachable source via
`host.docker.internal`. See [Docker runtime](DOCKER-RUNTIME.md) for the normal
container flow.

## Connect to the recovered Pi

After the Pi installer finishes, stop the local API and run `pnpm start:pi`.
This uses `config/pi.yaml`, connects to `wavekit-pi.local:5555`, and polls the
Pi's status API. The local API stays on port 9000; `pnpm dashboard` works with
all three profiles. Use `pnpm dev:pi` for development.

If the Pi has a different hostname, edit a copy of `config/pi.yaml` and select
it with `WAVEKIT_CONFIG`; update both the source host and monitoring URLs.
Decoders remain opt-in until their binaries and radio settings are configured.

## Select a configuration explicitly

```sh
cp config/local-rtl.yaml config/my-radio.yaml
# Edit sources and decoders in your copy, then:
WAVEKIT_CONFIG=./config/my-radio.yaml pnpm start
```

`WAVEKIT_CONFIG` selects a complete configuration and skips the default/custom
merge. A missing selected file fails with a clear error. Environment overrides
such as `WAVEKIT_API__PORT=9001` still take precedence. `start:local` and
`start:rtl` choose their respective profiles unless you set `WAVEKIT_CONFIG`.

Without an explicit selection, WaveKit loads `config/default.yaml` then
`config/custom.yaml` (or `/app/config` in a container). `config/dev_test.yaml`
contains the historical Pi address and container paths; it is an example for
that setup and is not selected automatically.

## Decoder capabilities

`pnpm run doctor` shows which executables are available in your current PATH;
`pnpm run doctor --json` provides the same inventory as JSON. Binary presence alone
does not validate hardware, compatible tool versions, or Python dependencies.

| Task                                  | Decoder           | Native dependencies used by WaveKit                                   |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| FM/AM/SSB listening                   | Live demodulator  | `csdr`                                                                |
| ISM sensors/remotes, full source rate | `rtl433`          | `rtl_433`                                                             |
| ISM sensors/remotes, with decimation  | `rtl433`          | `csdr`, `rtl_433`                                                     |
| Pagers/data                           | `multimon-ng`     | `csdr`, `sox`, `multimon-ng`                                          |
| DMR/P25/other digital voice           | `dsd-fme`         | `csdr`, `sox`, `dsd-fme`                                              |
| ADS-B                                 | `readsb`          | `readsb`                                                              |
| ACARS                                 | `acarsdec`        | `csdr`, `sox`, compatible stdin-capable `acarsdec`                    |
| VDL2                                  | `dumpvdl2`        | `csdr`, compatible stdin-capable `dumpvdl2`                           |
| AIS                                   | `ais-catcher`     | `csdr`, `AIS-catcher`                                                 |
| APRS/AX.25                            | `direwolf`        | `csdr`, `sox`, `direwolf`                                             |
| LoRa/Meshtastic                       | `lora-meshtastic` | `csdr`, Python wrapper, GNU Radio/gr-lora_sdr and Python dependencies |

### Native rtl433 without csdr

`rtl433` bypasses its csdr stage when `inputSampleRate` and `targetSampleRate`
match. Both values must equal the source's actual sample rate. For example,
copy `config/local-rtl.yaml` and replace its `sources` and `decoders` with:

```yaml
sources:
  - id: local-iq
    type: rtl_tcp
    host: 127.0.0.1
    port: 1234
    caps:
      kind: iq
      format: U8_IQ
      sampleRate: 2048000
      centerFreq: 433920000
      exclusive: false
decoders:
  - id: ism-sensors
    type: rtl433
    enabled: true
    sourceId: local-iq
    options:
      inputSampleRate: 2048000
      targetSampleRate: 2048000
      outputFormat: json
```

Keep the profile's other settings, including `liveDemod.enabled: false`. Start
native `rtl_tcp` at the matching frequency and sample rate:

```sh
RTL_TCP_FREQUENCY=433920000 RTL_TCP_SAMPLE_RATE=2048000 pnpm rtl:serve
# In another terminal, select your edited config:
WAVEKIT_CONFIG=./config/my-radio.yaml pnpm start
```

The decoder command is `rtl_433 -r cu8:- -s 2048000 -F json`; it processes the
full IQ stream without resampling. This example sets up the processing path;
receiving sensor messages depends on the actual signals and enabled protocols.
A Pi source can use the same decoder options with its matching source ID and
sample rate.

When used, csdr pipelines require the **jketterl/csdr v0.18+ command interface** (`csdr convert`,
`csdr firdecimate`, etc.). The older ha7ilm command interface is incompatible.
The Dockerfile builds the required tools and decoder forks. Several aviation
decoders need those forks rather than arbitrary system packages. LoRa currently
expects its wrapper at `/usr/local/bin/lora_meshtastic_decode.py`, as installed
in the container. Consult [decoder status](DECODER_STATUS.md),
[the decoder guide](DECODER-GUIDE.md), and [ADS-B setup](ADSB.md).

One dongle receives one center frequency and sample window at a time. Consumers
can share that window, but unrelated bands such as 433 MHz sensors and 1090 MHz
ADS-B require retuning between tasks or additional dongles. A `recording`
source is useful for offline testing; use raw data that matches its declared
format and sample rate. See [fixtures](../fixtures/README.md).

## Use or recover a Raspberry Pi SDR host

WaveKit runs on this computer while the Pi supplies IQ over the network. The
[`@wavekit/sdr-host` container](../packages/sdr-host/README.md) bundles `rtl_tcp`,
rtlmux, and its status API, so no host-side `rtl_tcp` installation is needed.
See [SDR host setup](SDR-HOST-SETUP.md) for installation and recovery.

When the Pi is available, copy the local RTL profile, set the source host to the
Pi's address and its port to 5555. Optionally enable the SDR host poller and
set `sdrHost.apiUrl` / `sdrHost.rtlmuxStatsUrl` to its status endpoints. Select
that config with `WAVEKIT_CONFIG`. For a directly connected dongle, select the
local RTL profile instead.

## Development

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
make help
```

Build and startup scripts build workspace libraries before using them. The
native development watcher completes an initial build before launching Node.
Container workflows and fixture tools are listed in `make help`; see
[Docker setup](DOCKER-SETUP.md) and [scripts](../scripts/README.md).
