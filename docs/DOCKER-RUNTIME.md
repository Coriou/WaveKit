# Docker runtime

The normal WaveKit runtime is the `final-core` Docker image. It bundles Node,
the compatible DSP tools, and decoder binaries; you do not need to install
decoder software on macOS. The `app` profile starts even when the Pi or dongle
is unavailable.

## Start without hardware

From the repository root, with Docker running:

```sh
make app-up
make app-status
make app-logs
```

The default image is `wavekit:local-core`. Compose builds `final-core` if the
image is missing; the first build downloads and compiles its dependencies.
You can build it explicitly with
`docker build --target final-core -t wavekit:local-core .`, or choose another
compatible image with `WAVEKIT_APP_IMAGE=YOUR_IMAGE make app-up`.

The API is at <http://127.0.0.1:9000>, with Swagger at `/docs` and WebSocket at
`/ws`. `config/docker.yaml` starts with no sources or decoders. Empty lists are
expected; the binary tools are already inside the image. Stop the app with
`make app-down`, which removes only this app container.

The API (9000), the raw audio TCP port (8080), live audio over HTTP (8081),
digital-voice audio (8082) and the tuner relay (4713) are published on the
host's loopback interface. Port 4713 carries RTL-TCP IQ when enabled. The app reads
the selected config from `/app/config`; the repository's `config/` directory
is mounted read-only, and `decoded_calls/` is writable for recordings.

## Connect to the Pi

After the Pi's SDR-host container starts, create a private local config:

```sh
cp config/docker-pi.example.yaml config/docker-pi.local.yaml
# Edit docker-pi.local.yaml: replace every 192.0.2.10 with the Pi's actual LAN IP.
WAVEKIT_APP_CONFIG=/app/config/docker-pi.local.yaml make app-up
```

The example IP is a documentation placeholder. Update the source host and both
monitoring URLs. The source uses the Pi's rtlmux port 5555; monitoring uses
8080 and 5556. Use an IP here because `.local` mDNS names may not resolve from
the Linux container/VM even when they work on the Mac. Wi-Fi and Ethernet use
the same application configuration; use the Pi's current address.

When the Pi has both a cable and Wi-Fi, add `endpointSelection: auto` under the source's
`sdrHost`. The Pi lists every address it has, Ethernet first, and the core then moves its IQ
connection to the best one it can reach after checking that it leads to the same receiver.
This covers a common home setup where the cable sits on another subnet (for example the ISP
box) that the computer still reaches through its router: configure whichever address you
know and the core finds the cable. It is off by default for now, and it writes no tuning when
it switches. See [receiver endpoints](specs/receiver-endpoints/requirements.md).

```yaml
sources:
  - id: pi-iq
    # type, host, port and caps as in the example
    sdrHost:
      apiUrl: http://192.0.2.10:8080
      rtlmuxStatsUrl: http://192.0.2.10:5556/stats.json
      endpointSelection: auto
```

Source status then shows `endpoint.configuredHost`, `endpoint.activeHost` and the reason
(`verified ethernet endpoint`).

The Pi acquires and relays IQ; the laptop's WaveKit container runs DSP and
decoders. The example profile has `decoders: []`, but an empty list does not mean no
decoders: WaveKit adds every built-in decoder from its catalogue, enabled, and each one
starts when its band falls inside the tuned window. Set `decoderPolicy.catalogue: false` to
turn that off and run only the decoders you list, or switch single decoders off in
Settings › Decoders. `decoderPolicy.efficiency.activity` bounds the paging and digital-voice
channels chosen by activity (see [DECODER-GUIDE.md](DECODER-GUIDE.md#troubleshooting)).

Source REST status includes `activity`: `waiting`, `streaming`, `stale`, `paused`,
`disconnected`, or `ended`. It reflects payload delivered into the core, excluding
RTL-TCP headers, with a 10-second freshness deadline. `paused` means intentional
backpressure; `ended` means recording playback finished or failed (see `lastError`).
`connected` remains transport state, and `available` remains assignment capacity.
Neither implies sampling. `bytesReceived` is cumulative transport traffic; it
includes headers and survives automatic reconnects. Activity freshness resets on
reconnect. Fresh samples do not prove loss-free delivery or correct RF decoding.

These fields do not change health probe semantics.

`WAVEKIT_APP_CONFIG` selects the full configuration. Use an absolute container
path such as `/app/config/your-radio.local.yaml`; a Mac filesystem path is not
valid inside the container. Docker-specific API overrides bind the server to
`0.0.0.0:9000` inside the container while host publishing stays on loopback.
Changing this environment variable and running `make app-up` recreates the app
with the selected config.

Environment overrides can target existing YAML array entries by zero-based index:
`WAVEKIT_SOURCES__0__HOST=192.0.2.10` or
`WAVEKIT_DECODERS__0__ENABLED=false`. Nested values use another separator, for
example `WAVEKIT_SOURCES__0__CAPS__SAMPLE_RATE=1024000`. Other entries and fields
are retained. Indices must already exist; create sources/decoders in YAML first.
The older `WAVEKIT_SOURCES_0_HOST` spelling also works. Array overrides use indices,
not source IDs. If changing a receiver address, update its monitoring URLs too.

Decoders and live audio are opt-in. Add the desired decoder configuration for
the captured band, with `sourceId: pi-iq`, or enable `liveDemod`. Consult
[the decoder guide](DECODER-GUIDE.md) and [decoder status](DECODER_STATUS.md).
One physical dongle still receives one frequency window at a time.

### When the Pi source does not connect or drops samples

These were seen together on a Mac on 2026-11-01; check them in this order.

- **macOS blocks the local network.** Every LAN address, the router included, fails with
  `No route to host` or a timeout while the internet still works. macOS asks each app for
  Local Network access: allow it in System Settings › Privacy & Security › Local Network for
  the Docker app (OrbStack or Docker Desktop) and, for a native core, for your terminal. Restart
  that app if the toggle does not take effect. To test from inside the container, replace
  `PI_IP` and run `docker exec wavekit-app bash -c '</dev/tcp/PI_IP/5555' && echo ok`; it only
  opens a connection and sends nothing.
- **The source was paused in an earlier run.** The log says
  `Source feed is paused; not connecting`. A pause is kept in `<stateDir>/source-feed.json` and survives restarts. The
  container and a native core share it, since compose mounts `./data` as `/app/data`. Resume from
  the web app or with `POST /api/sources/<id>/resume`.
- **The core is on the Pi's Wi-Fi while its cable is idle.** `.local` names only resolve on the
  network you are on, so a computer on a different subnet from the Pi's cable learns the Wi-Fi
  address. Compare the source's `activeHost` with the Pi's `endpoints` in its `/api/status`, and
  set `endpointSelection: auto` (above).
- **The computer's own Wi-Fi is the limit.** A full 2.4 Msps stream needs about 4.8 MB/s and two
  cores on one Pi need twice that. The Pi's `/api/status` reports drops per client under
  `delivery.clients`. If its link is healthy and only one client drops, look at that computer's
  path: Wi-Fi repeaters and mesh hops add latency and loss that the Pi cannot fix.
- **Several cores share one dongle.** Each core shows the tuning in its own config until
  something tells it otherwise, and the Pi's status reports its launch frequency, not the live
  one. If another core tuned the dongle, the spectrum and decoders here are mislabelled. Pause
  this core's source to hand the dongle over. Fixing this is planned:
  [shared receiver research](RESEARCH-2026-11-01-SHARED-RECEIVER.md).

## Use a directly connected USB dongle

Keep WaveKit and its decoders in Docker. USB access depends on the Linux host
or VM used by your container runtime:

- On a Linux host, the SDR-host container can access `/dev/bus/usb` directly.
- [OrbStack supports USB passthrough to machines and containers](https://docs.orbstack.dev/features/usb)
  and lists RTL-SDR Blog v3 among its tested devices. Use the container flow
  below for a dongle plugged into this Mac.
- [Docker Desktop does not provide direct USB passthrough](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/).
  A reachable `rtl_tcp` bridge is another source option.

### OrbStack or Linux: fully containerized USB source

On OrbStack, use its Devices tab to identify and attach **only the RTL-SDR
dongle** to Linux. Keep the SD-card reader on the Mac. The CLI offers the same
selection:

```sh
orb usb list
orb usb info <RTL_SDR_DEVICE_ID>
orb usb attach <RTL_SDR_DEVICE_ID>

docker compose -f compose.yaml -f compose.usb.yaml --profile app up -d --build
```

On a Linux host, plug in the dongle and use the same Compose command. The USB
override starts a containerized SDR host, mounts the Linux USB bus with device
access, and selects `/app/config/docker-usb.yaml` for the app. All SDR/DSP and
decoder binaries run in containers. No host `rtl_tcp` or decoder installation
is needed.

The app stays on <http://127.0.0.1:9000>; the USB SDR-host status API is published
on <http://127.0.0.1:18080>. IQ is shared over the Docker network. The app starts
even if no dongle is connected; check the SDR-host status for hardware errors.
The first build compiles the host image as well as the core app.

```sh
# Follow both containers:
docker compose -f compose.yaml -f compose.usb.yaml --profile app logs -f --tail=100
# Stop and remove these two containers:
docker compose -f compose.yaml -f compose.usb.yaml --profile app \
  rm -sf wavekit-app wavekit-usb-sdr-host
```

### Optional reachable bridge

`config/docker-usb-bridge.yaml` connects to `host.docker.internal:1234` when a
runtime needs an external bridge:

```sh
# Start a USB-accessible rtl_tcp bridge first, then:
WAVEKIT_APP_CONFIG=/app/config/docker-usb-bridge.yaml make app-up
```

The bridge must listen on an interface reachable from the container. A server
restricted to loopback may not be reachable through the Docker gateway; test
reachability for your runtime. If the bridge runs in another Linux machine,
copy the config and replace the host with that machine's reachable address.
Keep the configured sample rate and center frequency consistent with the
bridge. A working USB attachment and live RF decoding require hardware testing.

## Optional native development

Native Node/watch scripts are described in [local setup](LOCAL-SETUP.md). The
web app and the optional terminal dashboard are not bundled in `final-core`; run
them with Node/pnpm on the host (see [Using the web app](WEB-APP.md)). The API,
DSP tools, and decoders run in Docker.
`pnpm run doctor` inventories
executables on the machine where you run it; it is not a requirement to install
those tools on macOS for Docker operation. The separate
[Pi installer](../packages/sdr-host/README.md) bundles its own `rtl_tcp`.
