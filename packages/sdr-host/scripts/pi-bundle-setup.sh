#!/usr/bin/env bash
# Included in the portable bundle. Run on the Pi, never on the build machine.
set -euo pipefail
TARGET_USER=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--target-user)
			[ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--target-user requires a username" >&2; exit 1; }
			TARGET_USER="$2"; shift 2 ;;
		-h|--help)
			echo "Usage: bash setup.sh [--target-user USER] (explicit normal user required when run as root)"
			exit 0 ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

if [ "$(uname -s)" != Linux ]; then
	echo "Run this bundle on the Pi with 64-bit Linux; it cannot access a dongle on macOS." >&2
	exit 1
fi
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
if [ "$ARCH" != arm64 ] && [ "$ARCH" != aarch64 ]; then
	echo "This bundle needs a 64-bit ARM userland (arm64); detected ${ARCH}." >&2
	exit 1
fi
SETUP_UID="$(id -u)"
if [ "$SETUP_UID" -eq 0 ] && [ -z "$TARGET_USER" ]; then
	echo "Root setup requires --target-user with the configured normal Pi user." >&2
	exit 1
fi
TARGET_USER="${TARGET_USER:-$(id -un)}"
if ! [[ "$TARGET_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || ! id "$TARGET_USER" >/dev/null 2>&1 || [ "$(id -u "$TARGET_USER")" -eq 0 ]; then
	echo "--target-user must identify an existing normal user, not root." >&2
	exit 1
fi
if [ "$SETUP_UID" -ne 0 ] && [ "$TARGET_USER" != "$(id -un)" ]; then
	echo "A normal-user setup must target the current user." >&2
	exit 1
fi

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BUNDLE_DIR"
for file in IMAGE.txt wavekit-sdr-host-image.tar.gz docker-compose.yml install-docker.sh setup.sh .env.example SHA256SUMS; do
	[ -f "$file" ] || { echo "Bundle is incomplete: missing $file" >&2; exit 1; }
done

# Check the payload before installing packages or changing Docker/USB settings.
for file in IMAGE.txt wavekit-sdr-host-image.tar.gz docker-compose.yml install-docker.sh setup.sh .env.example; do
	awk -v name="$file" '$2 == name { count++ } END { exit count != 1 }' SHA256SUMS || {
		echo "Bundle checksum entry missing or duplicated: $file" >&2; exit 1;
	}
done
sha256sum --check --strict SHA256SUMS
gzip -t wavekit-sdr-host-image.tar.gz
if [ ! -f .host-prepared ] || ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
	INSTALL_ARGS=(--yes)
	if [ "$SETUP_UID" -eq 0 ]; then INSTALL_ARGS+=(--target-user "$TARGET_USER"); fi
	bash ./install-docker.sh "${INSTALL_ARGS[@]}"
	touch .host-prepared
fi

export WAVEKIT_SDR_HOST_IMAGE="$(cat IMAGE.txt)"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
	if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
		# Newly added docker group membership is unavailable in this login session.
		DOCKER=(sudo env "WAVEKIT_SDR_HOST_IMAGE=${WAVEKIT_SDR_HOST_IMAGE}" docker)
	else
		echo "Docker daemon is unavailable. Start Docker, then retry bash setup.sh." >&2
		exit 1
	fi
fi

[ -f .env ] || cp .env.example .env
"${DOCKER[@]}" load -i wavekit-sdr-host-image.tar.gz
"${DOCKER[@]}" compose -f docker-compose.yml up -d --pull never
"${DOCKER[@]}" compose -f docker-compose.yml ps
if [ "$SETUP_UID" -eq 0 ]; then
	chown "$TARGET_USER:$(id -gn "$TARGET_USER")" .env .host-prepared
fi
printf '\n[wavekit] SDR host started from the bundled image.\n'
printf '[wavekit] IQ port 5555, API http://<pi-ip>:8080/health (unless changed in .env).\n'
printf '[wavekit] Verify health with the dongle connected; use docker compose logs for errors.\n'
printf '[wavekit] Log out/in for Docker group access; reboot if USB driver changes need it.\n'
