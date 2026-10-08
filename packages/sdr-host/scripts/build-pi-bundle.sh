#!/usr/bin/env bash
# Produce a portable Pi installer with an ARM64 image; never writes an SD card.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
IMAGE="wavekit-sdr-host:pi-local"
OUTPUT="${REPO_ROOT}/output/pi-bundle"
SKIP_BUILD=false

usage() {
	cat <<'EOF'
Usage: bash packages/sdr-host/scripts/build-pi-bundle.sh [options]
  --skip-build       Reuse an existing local ARM64 image
  --image <tag>      Local image tag (default wavekit-sdr-host:pi-local)
  --output <dir>     Bundle directory (default output/pi-bundle)
  -h, --help         Show help

Copy the resulting directory to a 64-bit Linux Pi, then run bash setup.sh there.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--skip-build) SKIP_BUILD=true; shift ;;
		--image|--output)
			[ "$#" -ge 2 ] && [ -n "$2" ] || { echo "$1 requires a value" >&2; exit 1; }
			if [ "$1" = --image ]; then IMAGE="$2"; else OUTPUT="$2"; fi
			shift 2
			;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
	esac
done

# Keep the saved image name usable in both Compose interpolation and IMAGE.txt.
if ! [[ "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$ ]]; then
	echo "--image must be a local Docker image tag without spaces or shell characters" >&2
	exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "Docker is required to create the bundle" >&2; exit 1; }

if [ "$SKIP_BUILD" = false ]; then
	cd "$REPO_ROOT"
	docker buildx build --platform linux/arm64 --load \
		-f packages/sdr-host/Dockerfile -t "$IMAGE" .
fi

PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")"
if [ "$PLATFORM" != linux/arm64 ]; then
	echo "Expected linux/arm64, but ${IMAGE} is ${PLATFORM}. Build it for the Pi first." >&2
	exit 1
fi

mkdir -p "$OUTPUT"
ARCHIVE_TMP="$(mktemp "${OUTPUT}/.image.XXXXXX")"
trap 'rm -f "$ARCHIVE_TMP"' EXIT
docker save "$IMAGE" | gzip > "$ARCHIVE_TMP"
mv "$ARCHIVE_TMP" "${OUTPUT}/wavekit-sdr-host-image.tar.gz"
cp "${REPO_ROOT}/packages/sdr-host/docker-compose.yml" "${OUTPUT}/docker-compose.yml"
cp "${SCRIPT_DIR}/install-docker.sh" "${OUTPUT}/install-docker.sh"
cp "${SCRIPT_DIR}/pi-bundle-setup.sh" "${OUTPUT}/setup.sh"
chmod +x "${OUTPUT}/setup.sh" "${OUTPUT}/install-docker.sh"
printf '%s\n' "$IMAGE" > "${OUTPUT}/IMAGE.txt"
printf 'WAVEKIT_SDR_HOST_IMAGE=%s\n' "$IMAGE" > "${OUTPUT}/.env.example"
cat > "${OUTPUT}/README.txt" <<'EOF'
WaveKit SDR host bundle (Linux ARM64 / Raspberry Pi OS Lite 64-bit)

Copy this whole directory to the Pi, preserving its contents. On the Pi:
  cd pi-bundle
  bash setup.sh

Run as a normal user with sudo. Setup installs Docker if needed, prepares USB
drivers with install-docker.sh, loads the bundled image, and starts Compose.
Root/headless installation requires: bash setup.sh --target-user YOUR_USER
That user must already exist. The installer retains the user's sudo policy.
Internet is needed to install system packages, but no registry pull is needed.
No native host rtl_tcp installation is required. Plug in the RTL-SDR dongle.

Edit .env (created on first setup) for gain, frequency, rate, and port overrides.
The IQ stream is on port 5555, stats on 5556, status API on 8080 by default.
On your main computer, configure WaveKit to connect to this Pi's IP and port 5555.

Container logs rotate at 10 MB per file, three files. Check status/logs with:
  sudo docker compose ps
  sudo docker compose logs --tail=100
  curl -fsS http://localhost:8080/health

Log out/in after installation to use docker without sudo. Reboot if USB driver
changes have not taken effect. Actual dongle streaming requires hardware testing.
EOF
printf '[wavekit] ARM64 bundle ready: %s\n' "$OUTPUT"
printf '[wavekit] Copy that directory to the Pi, then run bash setup.sh on the Pi.\n'
