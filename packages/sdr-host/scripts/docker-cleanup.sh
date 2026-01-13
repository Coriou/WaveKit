#!/usr/bin/env bash
# WaveKit SDR Host - Docker cleanup helper

set -euo pipefail

MODE="safe"
INCLUDE_VOLUMES=false
PRUNE_BUILD_CACHE=false
FORCE=false

usage() {
	cat <<'EOF'
WaveKit Docker Cleanup

Usage:
  ./docker-cleanup.sh [options]

Options:
  --aggressive     Remove all unused images (equivalent to docker system prune -a)
  --volumes        Also prune unused volumes
  --build-cache    Prune build cache (docker builder prune -a)
  --force          Skip confirmation prompts
  -h, --help       Show help
EOF
}

confirm() {
	local prompt="$1"
	if [ "$FORCE" = true ]; then
		return 0
	fi
	read -r -p "${prompt} [y/N] " reply
	case "${reply}" in
		y|Y|yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

while [ "${1:-}" != "" ]; do
	case "$1" in
		--aggressive)
			MODE="aggressive"
			shift
			;;
		--volumes)
			INCLUDE_VOLUMES=true
			shift
			;;
		--build-cache)
			PRUNE_BUILD_CACHE=true
			shift
			;;
		--force)
			FORCE=true
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "[wavekit] Unknown option: $1" >&2
			exit 1
			;;
	esac
done

if ! command -v docker >/dev/null 2>&1; then
	echo "[wavekit] Docker not found." >&2
	exit 1
fi

echo "[wavekit] Docker disk usage:"
docker system df
echo

if [ "$MODE" = "aggressive" ]; then
	if confirm "Remove all unused images and containers?"; then
		docker system prune -a -f
	fi
else
	if confirm "Remove unused containers, networks, and dangling images?"; then
		docker system prune -f
	fi
fi

if [ "$INCLUDE_VOLUMES" = true ]; then
	if confirm "Remove unused volumes?"; then
		docker volume prune -f
	fi
fi

if [ "$PRUNE_BUILD_CACHE" = true ]; then
	if confirm "Remove build cache?"; then
		docker builder prune -a -f
	fi
fi

echo "[wavekit] Cleanup complete."
