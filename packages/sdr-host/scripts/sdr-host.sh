#!/usr/bin/env bash
# WaveKit SDR Host - manage container on a host (Pi, etc.)

set -euo pipefail
trap 'printf "[wavekit] ERROR on line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

CONFIG_DIR="${WAVEKIT_SDR_HOST_HOME:-$HOME/.config/wavekit-sdr-host}"
COMPOSE_FILE="${CONFIG_DIR}/docker-compose.yml"
ENV_FILE="${CONFIG_DIR}/.env"
COMPOSE_URL="${WAVEKIT_SDR_HOST_COMPOSE_URL:-https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/docker-compose.yml}"
INSTALL_URL="${WAVEKIT_SDR_HOST_INSTALL_URL:-https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/install-docker.sh}"
IMAGE_DEFAULT="ghcr.io/coriou/wavekit-sdr-host:latest"

usage() {
	cat <<'EOF'
WaveKit SDR Host - Host Manager

Usage:
  ./sdr-host.sh <command> [options]

Commands:
  install         Install Docker (delegates to install-docker.sh)
  init            Prepare config directory + compose + env file
  up              Start container (pulls if needed)
  update          Pull latest image + recreate container
  down            Stop container
  restart         Restart container
  status          Show container status
  logs            Tail container logs
  health          Print health + status + stats endpoints
  compose-update  Refresh compose file from GitHub

Options:
  --image <tag>   Persist image tag in env file
  -h, --help      Show help

Config:
  - Compose:  ~/.config/wavekit-sdr-host/docker-compose.yml
  - Env file: ~/.config/wavekit-sdr-host/.env
EOF
}

log() {
	printf "[wavekit] %s\n" "$*"
}

fail() {
	printf "[wavekit] %s\n" "$*" >&2
	exit 1
}

ensure_docker() {
	if ! command -v docker >/dev/null 2>&1; then
		fail "Docker not found. Run: ./sdr-host.sh install"
	fi
	if ! docker compose version >/dev/null 2>&1; then
		fail "Docker Compose not available. Run: ./sdr-host.sh install"
	fi
}

ensure_config_dir() {
	mkdir -p "$CONFIG_DIR"
}

set_env_key() {
	local key="$1"
	local value="$2"
	if [ -f "$ENV_FILE" ] && grep -q "^${key}=" "$ENV_FILE"; then
		sed -i "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
	else
		printf "%s=%s\n" "$key" "$value" >> "$ENV_FILE"
	fi
}

ensure_env_file() {
	if [ -f "$ENV_FILE" ]; then
		return
	fi
	log "Creating env file: ${ENV_FILE}"
	cat <<EOF > "$ENV_FILE"
WAVEKIT_SDR_HOST_IMAGE=${IMAGE_DEFAULT}
SDR_HOST_RTL_TCP__SAMPLE_RATE=2048000
SDR_HOST_RTL_TCP__FREQUENCY=446524920
SDR_HOST_RTL_TCP__BUFFER=512
SDR_HOST_RTL_TCP__AGC=false
SDR_HOST_RTL_TCP__GAIN=49
SDR_HOST_RTL_TCP__PPM=0
SDR_HOST_RTL_TCP__DEVICE_INDEX=0
SDR_HOST_RTLMUX__PORT=5555
SDR_HOST_API__PORT=8080
SDR_HOST_LOGGING__LEVEL=info
EOF
}

ensure_compose_file() {
	if [ -f "$COMPOSE_FILE" ]; then
		return
	fi

	if [ -f "${REPO_ROOT}/packages/sdr-host/docker-compose.yml" ]; then
		log "Copying compose file from repo."
		cp "${REPO_ROOT}/packages/sdr-host/docker-compose.yml" "$COMPOSE_FILE"
		return
	fi

	log "Downloading compose file."
	curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"
}

compose_cmd() {
	(
		cd "$CONFIG_DIR"
		docker compose -f "$COMPOSE_FILE" "$@"
	)
}

remove_existing_container() {
	if docker ps -a --format "{{.Names}}" | grep -qx "wavekit-sdr-host"; then
		log "Removing existing container: wavekit-sdr-host"
		docker rm -f wavekit-sdr-host >/dev/null
	fi
}

COMMAND="${1:-help}"
shift || true

IMAGE_OVERRIDE=""
while [ "${1:-}" != "" ]; do
	case "$1" in
		--image)
			IMAGE_OVERRIDE="${2:-}"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			fail "Unknown option: $1"
			;;
	esac
done

case "$COMMAND" in
	install)
		if [ -f "${SCRIPT_DIR}/install-docker.sh" ]; then
			bash "${SCRIPT_DIR}/install-docker.sh"
		else
			log "Downloading install script."
			tmp_dir="$(mktemp -d)"
			curl -fsSL "$INSTALL_URL" -o "${tmp_dir}/install-docker.sh"
			bash "${tmp_dir}/install-docker.sh"
			rm -rf "$tmp_dir"
		fi
		;;
	init)
		ensure_config_dir
		ensure_env_file
		ensure_compose_file
		if [ -n "$IMAGE_OVERRIDE" ]; then
			set_env_key "WAVEKIT_SDR_HOST_IMAGE" "$IMAGE_OVERRIDE"
		fi
		log "Config ready in ${CONFIG_DIR}"
		;;
	compose-update)
		ensure_config_dir
		log "Refreshing compose file."
		curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"
		;;
	up)
		ensure_docker
		ensure_config_dir
		ensure_env_file
		ensure_compose_file
		if [ -n "$IMAGE_OVERRIDE" ]; then
			set_env_key "WAVEKIT_SDR_HOST_IMAGE" "$IMAGE_OVERRIDE"
		fi
		remove_existing_container
		compose_cmd up -d
		;;
	update)
		ensure_docker
		ensure_config_dir
		ensure_env_file
		ensure_compose_file
		if [ -n "$IMAGE_OVERRIDE" ]; then
			set_env_key "WAVEKIT_SDR_HOST_IMAGE" "$IMAGE_OVERRIDE"
		fi
		compose_cmd pull
		remove_existing_container
		compose_cmd up -d --force-recreate
		;;
	down)
		ensure_docker
		compose_cmd down
		;;
	restart)
		ensure_docker
		compose_cmd restart
		;;
	status)
		ensure_docker
		compose_cmd ps
		;;
	logs)
		ensure_docker
		compose_cmd logs -f --tail=200
		;;
	health)
		curl -fsS http://localhost:8080/health || true
		curl -fsS http://localhost:8080/api/status || true
		curl -fsS http://localhost:5556/stats.json || true
		;;
	help|*)
		usage
		;;
esac
