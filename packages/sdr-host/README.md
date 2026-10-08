# @wavekit/sdr-host

RTL-SDR dongle host with rtlmux fanout and unified status API.

## Overview

`wavekit-sdr-host` is a Docker container that runs on the RTL-SDR dongle host (typically a Raspberry Pi), providing:

- **USB dongle management** via librtlsdr
- **Upstream IQ source** (`rtl_tcp` bound to localhost)
- **Fanout multiplexing** (`rtlmux` exposed to LAN)
- **Unified status API** for health, dongle info, and client stats

The image contains `rtl_tcp` and librtlsdr. The Pi only needs a supported
64-bit Linux OS, Docker, and the USB dongle; do not install a separate host
`rtl_tcp` service that would compete for the device.

## Recover a Pi 3 Model B with a fresh SD card

The Pi supplies IQ while WaveKit and its decoders run on your main computer.
Use **Raspberry Pi OS Lite (64-bit)**: this image supports `linux/arm64` and
`linux/amd64`, and does not support a 32-bit `armhf` userland.

1. Open [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your
   computer. Select the Pi model, Raspberry Pi OS Lite (64-bit), and the SD
   card. Check the selected card's identity before writing it.
2. In Imager's customisation settings, set a hostname such as `wavekit-sdr`,
   your username, the local timezone/country, and SSH with your public key.
   Configure **Wi-Fi for normal use**: enter your network name and password
   locally in Imager. The original Pi 3 Model B supports
   [2.4 GHz Wi-Fi only](https://github.com/raspberrypi/documentation/blob/master/documentation/asciidoc/computers/getting-started/setting-up.adoc),
   so choose a network that offers that band. These steps are described in the
   [official headless setup instructions](https://www.raspberrypi.com/documentation/computers/getting-started.html).
3. Write and verify the card, eject it, then put it in the Pi. Connect the
   dongle and a suitable power supply. The Pi joins the configured Wi-Fi on
   boot. Ethernet remains supported: plug in a cable as a fallback if Wi-Fi
   setup fails or streaming is unreliable; the same container and WaveKit
   configuration work over either network interface. At 2.048 Msps the raw U8
   IQ stream is about 4 MB/s, so verify continuous streaming on your Wi-Fi.
4. SSH to the hostname (or the IP shown by your router), then check the OS:

   ```sh
   ssh YOUR_USER@wavekit-sdr.local
   dpkg --print-architecture
   # Must print arm64.
   ```

5. Follow the managed installation below. Reboot or log out/in after Docker
   group and USB driver changes before starting the container. `install` sets
   up the host; `update` pulls and starts the application. For an unattended
   host installation, the manager also accepts `install --yes`.
6. After starting the container, check its API on the Pi:

   ```sh
   ~/.local/bin/wavekit-sdr-host health
   curl -fsS http://localhost:8080/health
   ```

For WaveKit on your main computer, use the [Docker runtime](../../docs/DOCKER-RUNTIME.md).
Copy `config/docker-pi.example.yaml` to `config/docker-pi.local.yaml`, replace
the example source host and monitoring addresses with the Pi's LAN IP, then run
`WAVEKIT_APP_CONFIG=/app/config/docker-pi.local.yaml make app-up`. The API and
decoder tools stay in Docker. Set the source's `caps.sampleRate` to match
`SDR_HOST_RTL_TCP__SAMPLE_RATE`.

The compose file rotates container logs (`10 MB` per file, three files) to
limit SD-card writes and disk growth. Keep the manager's `.env` file and your
WaveKit configuration backed up on your main computer. Hardware streaming and
fresh-card recovery still need verification on the actual Pi.

### If the registry image cannot be pulled

An anonymous pull of `ghcr.io/coriou/wavekit-sdr-host:latest` returned HTTP 401
during the local audit. Authenticate if you have access, or build from this
checkout. The portable bundle includes an ARM64 image, compose configuration,
and installer. It needs no registry login and no native `rtl_tcp` installation:

```sh
# On your computer, from the repository root (build may take a while):
make sdr-host-bundle
# If wavekit-sdr-host:pi-local is already built:
make sdr-host-bundle SDR_HOST_BUNDLE_ARGS=--skip-build

# Copy the bundle and install on the Pi:
scp -r output/pi-bundle YOUR_USER@wavekit-sdr.local:~/
ssh YOUR_USER@wavekit-sdr.local
cd ~/pi-bundle
bash setup.sh
```

Run `setup.sh` as the normal Pi user with sudo available. It verifies the
archive, installs/prepares the host once, loads the image, and starts Compose
with `--pull never`. It uses sudo for Docker if your new group membership is
not active yet. Internet is needed for system packages on a fresh OS. Existing
`.env` settings survive reruns; the loaded image tag is selected explicitly.
The bundle lives under gitignored `output/` and contains no account keys.
`SHA256SUMS` covers the image and installation payload. Staging verifies the
source and copied bundle; setup verifies it again before changing the host.
Checksums detect damaged or incomplete copies, not an untrusted publisher.
Rebuild older bundles without a manifest with `make sdr-host-bundle` (add
`SDR_HOST_BUNDLE_ARGS=--skip-build` to reuse an existing ARM64 image).

### Dedicated WaveKit installer

The intended fresh-card workflow is **WaveKit in Imager → customize → write →
boot**. Open the dedicated catalog from the repository root:

```sh
make sdr-host-imager
```

This requires Raspberry Pi Imager 2 and a built image catalog at
`output/pi-image/os-list.json`. To use a catalog stored elsewhere:

```sh
make sdr-host-imager SDR_HOST_IMAGER_ARGS='--manifest /path/to/os-list.json'
```

On macOS the launcher runs Imager directly from `/Applications` or
`~/Applications`, keeping startup errors and crash status visible in Terminal.
Keep that terminal open until Imager closes. For an installation elsewhere, pass
`--executable /path/to/rpi-imager`. A started process or successful exit does not
confirm that a window appeared or a card was written. If no window appears,
check the terminal diagnostics before proceeding.

The catalog contains only the WaveKit image entry. Choose the Pi model and SD
card, configure the hostname, normal account, Wi-Fi and SSH public key, then
write and verify. The catalog preserves Imager's customization metadata;
selecting the image through plain **Use custom** does not provide that metadata.
See [Imager's customization documentation](https://github.com/raspberrypi/rpi-imager/blob/main/doc/os_customisation_formats.md).

The flashable image embeds the receiver bundle and first-boot service. It must
pass physical clean-card acceptance before being considered release-ready.
First boot still needs internet to install system packages. No separate payload
staging or SSH installation command is part of this workflow.

To build the SD image, first create the ARM64 bundle with `make sdr-host-bundle`.
Install Python 3, `xz` and e2fsprogs (`debugfs` and `e2fsck`) on the build computer,
then supply a pristine Raspberry Pi OS Lite ARM64 `.img.xz` and its trusted
**decompressed image** SHA-256 from the OS publisher:

```sh
make sdr-host-image SDR_HOST_IMAGE_ARGS='--base /path/to/raspios-lite.img.xz --base-sha256 TRUSTED_RAW_IMAGE_SHA256'
make sdr-host-imager
```

The builder works on temporary regular files without mounting partitions or
writing an SD card. It verifies the base and bundle, embeds setup into the root
filesystem, checks that filesystem and emits the image, Imager catalog and build
hashes under `output/pi-image/`. Imager owns the actual device write and verification.
The first-boot service runs after cloud-init creates the configured account;
credentials remain specific to each operator's Imager customization.
The bootstrap checks cloud-init's structured completion status. It allows the
specific missing `cc_netplan_nm_patch` warning observed with Raspberry Pi OS
2026-10-06 and Imager 2.0.11.1, recording it in the setup log; other cloud-init
errors or warnings stop setup for review. Network, SSH and receiver checks
remain required even when setup reports completion.

### Stage automatic installation onto stock Pi OS

The lower-level stock-image path is **Imager → stage → eject → boot**.
No SSH session or manual command on the Pi is required for installation or
normal streaming. SSH is optional diagnostic/maintenance access. Configure
public-key authentication in Imager to avoid repeated password entry; WaveKit
does not require an SSH control socket or passwordless sudo.

For a fresh card written with Imager's **cloudinit-rpi** format, the staging
helper can add installation to the existing `user-data`. Run this on your main
computer **after Imager has finished writing and verifying**, while the card's
boot partition is mounted. If Imager ejected the card, reconnect it first.

```sh
# Replace the mount path with the card's actual boot partition:
node packages/sdr-host/scripts/stage-pi-boot.mjs \
  --boot /Volumes/bootfs --dry-run
node packages/sdr-host/scripts/stage-pi-boot.mjs \
  --boot /Volumes/bootfs
```

If you did not add your SSH public key in Imager, stage it explicitly:

```sh
node packages/sdr-host/scripts/stage-pi-boot.mjs \
  --boot /Volumes/bootfs --ssh-public-key ~/.ssh/id_ed25519.pub --dry-run
node packages/sdr-host/scripts/stage-pi-boot.mjs \
  --boot /Volumes/bootfs --ssh-public-key ~/.ssh/id_ed25519.pub
```

This validates and appends one public key to the explicitly named Imager user,
retaining existing keys and password/sudo policy. It validates Ed25519, RSA or
ECDSA public keys locally, rejects private keys, and omits the key's comment. Never
copy the private identity onto the card. For an unresolved `default` user,
configure the public key in Imager instead. After boot, ordinary
`ssh YOUR_USER@wavekit-sdr.local` uses your local key/agent; an encrypted key may
still require unlocking. Keep SSH host-key verification enabled. A freshly
rewritten card has a new host identity: verify it before replacing a saved key.

The helper requires an explicit mount, checks the expected Raspberry Pi files
and `#cloud-config`, copies `output/pi-bundle`, and appends its own bootstrap.
It preserves Imager's Wi-Fi/login settings and existing commands, and does not
print credentials. If user-data does not identify one normal user, pass
`--user YOUR_IMAGER_USERNAME`; it never guesses the name of a `default` user.
It neither flashes nor erases the card.
Staging verifies a temporary copy before replacing the bundle and `user-data`.
Reruns retain custom bundle files such as `.env`; existing bundle destinations
must be real directories. Keep the card mounted until staging exits successfully.

On the Pi, cloud-init runs the bootstrap as root. It copies the bundle into the
configured user's writable home, then runs `setup.sh --target-user USER` as
root. This installs Docker and adds that normal user to the Docker group without
changing their sudo/password policy. Passwordless sudo is not required. The
boot partition receives `wavekit-setup.status` (`running`, `complete`, or
`failed`) and `wavekit-setup.log`; the system log is
`/var/log/wavekit-firstboot.log`. `complete` means installation and Compose
startup completed; confirm `/health` with the dongle connected before treating
hardware streaming as verified.
Automated first-boot tests execute the generated bootstrap with temporary paths
and mocked account/privilege commands. They verify status, logs, retries, and
completion markers; physical card boot and dongle streaming require Pi testing.

Plain raw-image writes without cloud-init configuration need the manual
`bash setup.sh` flow. Once staging succeeds, eject the card and boot the Pi;
first boot needs working Wi-Fi or Ethernet and internet for system packages.

For recovery on an already configured Pi, generate the same bootstrap with
`node packages/sdr-host/scripts/stage-pi-boot.mjs --bootstrap-out output/pi-setup/wavekit-firstboot.sh --user YOUR_IMAGER_USERNAME`.
Copy corrected bundle files to `/boot/firmware/wavekit-pi-bundle` before
running that bootstrap as root: it copies the boot bundle into the user's home.
For manual installation, use `bash setup.sh` as the normal user, or
`sudo bash setup.sh --target-user YOUR_IMAGER_USERNAME` for one root invocation.
Neither flow changes sudoers or requires the user to have passwordless sudo.

### Headless setup checks

A completed headless installation should satisfy these checks:

- SSH accepts the login/key configured in Imager.
- The Pi joins the configured 2.4 GHz Wi-Fi network; Ethernet can also obtain
  an address from the router without changing the application configuration.
- The configured hostname resolves through mDNS where supported, or the
  router's IP address works directly.
- Cloud-init runs installation as root automatically, retaining the normal
  user's password/sudo policy. `wavekit-setup.status` reports `complete`.
- The status API responds, and `/health` becomes healthy with a working dongle
  connected. WaveKit receives IQ from the Pi on port 5555.

For a clean-card acceptance run, record the checkout commit, bundle checksum,
Pi model, OS version, network and elapsed time from power-on to healthy API.
For the dedicated WaveKit image, start from Imager's verified write, eject, and
boot directly: no post-write staging or SSH installation is permitted in this
acceptance run. The stock-image staging flow above is a separate workflow.
Any manual repair on the Pi is an installer failure to fix and retest from a
fresh write, even if it makes that particular boot work. Confirm that a reboot
starts the receiver automatically and that unplugging/reconnecting the dongle
recovers without reinstalling. Keep passwords, private keys and Wi-Fi credentials
out of acceptance reports.

SD writing is performed on the computer and does not depend on the Pi's power
supply. Record power events during first boot separately from installer errors;
measure sustained IQ throughput and loss as a separate streaming acceptance run.

`build-pi-bundle.sh --image <tag> --skip-build` can reuse another local image;
the script rejects images that are not Linux ARM64. You can also transfer an
image manually. A Pi 3 has limited memory; building on the Mac avoids a source
build on the Pi:

```sh
# On your computer, from the WaveKit repository root:
docker buildx build --platform linux/arm64 \
  -f packages/sdr-host/Dockerfile -t wavekit-sdr-host:local --load .
docker save -o /tmp/wavekit-sdr-host-arm64.tar wavekit-sdr-host:local
scp /tmp/wavekit-sdr-host-arm64.tar YOUR_USER@wavekit-sdr.local:/tmp/

# On the Pi, after installing Docker and logging back in:
docker load -i /tmp/wavekit-sdr-host-arm64.tar
~/.local/bin/wavekit-sdr-host up --image wavekit-sdr-host:local
rm /tmp/wavekit-sdr-host-arm64.tar
```

Alternatively, build directly on a 64-bit Linux host with
`docker build -f packages/sdr-host/Dockerfile -t wavekit-sdr-host:local .` from
the repository root. Use `up` for a locally built image; `update` attempts a
registry pull. Builds require network access to upstream source repositories.
If you are testing uncommitted changes, copy the checkout's manager, installer,
and compose file to the Pi; the download commands below fetch the published
version from GitHub.

## Quick Start

Choose **one** of the two options below.

### Option A — Managed (Recommended)

Run this on the SDR host (Pi), not your build machine.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host

~/.local/bin/wavekit-sdr-host install
~/.local/bin/wavekit-sdr-host update
```

From the repo, `make sdr-host-install` and `make sdr-host-update` run the same pipeline.

The script stores config in `~/.config/wavekit-sdr-host/` and creates a `.env` file you can edit.

The installer will offer to blacklist DVB drivers and recommend a reboot.

To update the manager script later:

```bash
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host
```

### Option B — DIY (Manual)

Run these steps on the SDR host (Pi), not your build machine.

Do these steps yourself (this is what the scripts automate):

1. Install Docker + Compose and add your user to the `docker` group.
2. Blacklist DVB drivers so the dongle is free.
3. Create a `docker-compose.yml` and run `docker compose up -d`.
4. Point WaveKit to `tcp://<this-host-ip>:5555`.

## Configuration

All configuration via environment variables with `SDR_HOST_` prefix:

| Variable                         | Default                   | Description                         |
| -------------------------------- | ------------------------- | ----------------------------------- |
| `SDR_HOST_RTL_TCP__SAMPLE_RATE`  | `2048000`                 | Sample rate in Hz                   |
| `SDR_HOST_RTL_TCP__FREQUENCY`    | `446524920`               | Initial center frequency in Hz      |
| `SDR_HOST_RTL_TCP__BUFFER`       | `15`                      | Number of USB transfer buffers (-b) |
| `SDR_HOST_RTL_TCP__AGC`          | `false`                   | Enable tuner AGC                    |
| `SDR_HOST_RTL_TCP__GAIN`         | `49`                      | Manual gain in dB                   |
| `SDR_HOST_RTL_TCP__PPM`          | `0`                       | PPM correction                      |
| `SDR_HOST_RTL_TCP__DEVICE_INDEX` | `0`                       | USB device index                    |
| `SDR_HOST_RTLMUX__PORT`          | `5555`                    | IQ stream port                      |
| `SDR_HOST_API__PORT`             | `8080`                    | Status API port                     |
| `SDR_HOST_API__CORS_ORIGINS`     | (none)                    | Extra browser origins, comma list   |
| `WAVEKIT_HOST_STATUS_DIR`        | `/var/lib/wavekit/status` | Host dir with setup.json (compose)  |
| `SDR_HOST_LOGGING__LEVEL`        | `info`                    | Log level                           |

AGC is off by default to match common RTL-SDR setups. When `SDR_HOST_RTL_TCP__AGC` is `true`, manual gain is ignored.
The defaults use gain 49 dB, 446.524920 MHz, and 15 asynchronous USB transfer
buffers, matching the rtl-sdr library default. `-b` counts buffers; it does not
set their size in bytes. The former value of 512 can exhaust the Pi's USB transfer
memory and prevent IQ streaming.

## Dev Workflow

Preferred (from repo root):

```bash
make sdr-host-build
make sdr-host-build-multi
```

### Note on GHCR "unknown/unknown"

When publishing multi-arch images, Docker Buildx/BuildKit can also push a **provenance attestation** alongside the real `linux/amd64` + `linux/arm64` images.
GitHub Container Registry may display this extra artifact as OS/Arch `unknown/unknown`.

In this repo, provenance is **disabled by default** for `make sdr-host-build-multi` to keep the GHCR UI to just `amd64` + `arm64`.
If you want provenance anyway:

```bash
WAVEKIT_PROVENANCE=true make sdr-host-build-multi
# or
bash ./packages/sdr-host/scripts/build-publish.sh --multi-arch --provenance
```

Build and publish a new image directly (handles buildx for multi-arch):

```bash
bash ./packages/sdr-host/scripts/build-publish.sh --multi-arch
```

Single-arch (Pi only):

```bash
bash ./packages/sdr-host/scripts/build-publish.sh --platform linux/arm64
```

To avoid repeating your GH owner, add this to a repo-local `.env` or `.env.local` (ignored by git):

```bash
WAVEKIT_GH_OWNER=coriou
```

## Maintenance

Preferred (from repo root):

```bash
make sdr-host-clean
```

Free disk space on the host directly:

```bash
bash ./packages/sdr-host/scripts/docker-cleanup.sh --aggressive --volumes
```

## Status page and API

Open `http://<pi-host>:8080/` for the read-only operator page: upstream sample
flow, receiver chain, power, host readouts and first-boot setup. It is a few
static files served from memory (gzip, ETag revalidation, strict same-origin
CSP), polls every 3 s while visible, and pauses when the tab is hidden. See
[the setup guide](../../docs/SDR-HOST-SETUP.md#status-page) for what each part means.

### GET /health

Returns service health status (200 OK or 503 Service Unavailable) from USB and
process presence, unchanged for the Docker healthcheck. The informational
`sampling` field carries the upstream sampling state; it does not affect the
verdict.

### GET /api/status

Returns dongle info, process states and the legacy `rtlmux.stats` shape, plus:

- `sampling` (`SdrHostSampling`): `streaming` only while rtlmux's upstream byte
  count grows by real sample data within 10 s; `waiting`, `stale`,
  `disconnected` or `unknown` otherwise. Zero downstream clients never implies
  sampling stopped. Counter and PID resets start a new baseline.
- `delivery` (`SdrHostDelivery`): per-client queued rate and bytes rtlmux
  dropped for clients more than 4 MiB behind.
- `samplingHistory`: per-poll upstream rate for the last five minutes.

rtlmux stats are polled every 2 s, one request at a time with a 1.5 s timeout;
cached values turn stale after 6 s and are dropped after 30 s.

### GET /api/host

Pi host telemetry (`SdrHostTelemetry`), sampled in the background so requests
cost no I/O. Every section is a `Reading` with `state` (`ok`, `stale`,
`unavailable`), `scope` (`host`, `container`, `docker-storage`, `service`),
age and a `reason` when unavailable. The container is not privileged:
throttling flags are reported unavailable, and under-voltage history covers only
what the service observed since it started.

### GET /api/fix

Returns copy-paste fix commands when issues are detected.

## Ports

| Port | Service | Description                            |
| ---- | ------- | -------------------------------------- |
| 5555 | rtlmux  | IQ data stream (WaveKit connects here) |
| 5556 | rtlmux  | Stats HTTP endpoint                    |
| 8080 | API     | Status page, health and status API     |

## Troubleshooting

```bash
# Check health
curl http://localhost:8080/health

# Get full status
curl http://localhost:8080/api/status

# View rtlmux stats
curl http://localhost:5556/stats.json

# View logs
docker compose logs -f
```

Make shortcuts (from repo root):

```bash
make sdr-host-health
make sdr-host-logs
```
