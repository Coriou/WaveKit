#!/usr/bin/env bash
# WaveKit SDR Host - Docker setup script
# Usage:
#   ./install-docker.sh
#   ./install-docker.sh --yes --no-blacklist

set -euo pipefail
trap 'printf "[wavekit] ERROR on line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

SCRIPT_VERSION="2026.01.12"
ASSUME_YES=false
SKIP_BLACKLIST=false
INSTALL_USER=""

SUPPORTED_ARCH=("arm64" "amd64")
SUPPORTED_OS=("debian" "ubuntu" "raspbian")

if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
	RED="$(printf '\033[0;31m')"
	GREEN="$(printf '\033[0;32m')"
	YELLOW="$(printf '\033[0;33m')"
	RESET="$(printf '\033[0m')"
else
	RED=""
	GREEN=""
	YELLOW=""
	RESET=""
fi

log() {
	printf "%s[wavekit]%s %s\n" "$GREEN" "$RESET" "$*"
}

warn() {
	printf "%s[wavekit]%s %s\n" "$YELLOW" "$RESET" "$*"
}

error() {
	printf "%s[wavekit]%s %s\n" "$RED" "$RESET" "$*" >&2
}

usage() {
	cat <<'EOF'
WaveKit SDR Host - Docker setup

This script installs Docker Engine and Docker Compose (plugin),
and optionally blacklists RTL-SDR kernel drivers that conflict with rtl_tcp.

Options:
  -y, --yes           Run non-interactively with defaults
  --no-blacklist      Skip RTL-SDR driver blacklist step
  --target-user USER  Existing normal user; required when installing as root
  -h, --help          Show this help
EOF
}

confirm() {
	local prompt="$1"
	local default="${2:-Y}"
	local reply=""

	if [ "${ASSUME_YES}" = true ]; then
		return 0
	fi

	if [ ! -t 0 ]; then
		return 0
	fi

	read -r -p "${prompt} [${default}] " reply
	if [ -z "${reply}" ]; then
		reply="${default}"
	fi

	case "${reply}" in
		y|Y|yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		-y|--yes)
			ASSUME_YES=true
			shift
			;;
		--no-blacklist)
			SKIP_BLACKLIST=true
			shift
			;;
		--target-user)
			[ "$#" -ge 2 ] && [ -n "$2" ] || { error "--target-user requires a username"; exit 1; }
			INSTALL_USER="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			error "Unknown option: $1"
			usage
			exit 1
			;;
	esac
done

printf "\nWaveKit SDR Host - Docker setup (v%s)\n\n" "$SCRIPT_VERSION"

INSTALL_UID="$(id -u)"
if [ "$INSTALL_UID" -eq 0 ] && [ -z "$INSTALL_USER" ]; then
	error "Root installation requires --target-user with the configured normal Pi user."
	exit 1
fi
INSTALL_USER="${INSTALL_USER:-$(id -un)}"
if ! [[ "$INSTALL_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || ! id "$INSTALL_USER" >/dev/null 2>&1 || [ "$(id -u "$INSTALL_USER")" -eq 0 ]; then
	error "--target-user must identify an existing normal user, not root."
	exit 1
fi
if [ "$INSTALL_UID" -ne 0 ] && [ "$INSTALL_USER" != "$(id -un)" ]; then
	error "A normal-user installation must target the current user."
	exit 1
fi

if [ "$INSTALL_UID" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
	error "sudo is required to install Docker. Please install sudo and retry."
	exit 1
fi

run_privileged() {
	if [ "$INSTALL_UID" -eq 0 ]; then
		"$@"
	else
		sudo "$@"
	fi
}

if [ ! -f /etc/os-release ]; then
	error "Unable to detect OS (missing /etc/os-release)."
	exit 1
fi

. /etc/os-release
OS_ID="${ID:-unknown}"
OS_VERSION="${VERSION_ID:-unknown}"

os_supported=false
for os in "${SUPPORTED_OS[@]}"; do
	if [ "$OS_ID" = "$os" ]; then
		os_supported=true
		break
	fi
done

if [ "$os_supported" = false ]; then
	warn "This script is tested on Debian/Ubuntu/Raspberry Pi OS."
	warn "Detected OS: ${OS_ID} ${OS_VERSION}"
	if ! confirm "Continue anyway?" "N"; then
		exit 1
	fi
fi

ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m || echo unknown)"
case "$ARCH" in
	aarch64) ARCH="arm64" ;;
	x86_64) ARCH="amd64" ;;
esac

arch_supported=false
for a in "${SUPPORTED_ARCH[@]}"; do
	if [ "$ARCH" = "$a" ]; then
		arch_supported=true
		break
	fi
done

if [ "$arch_supported" = false ]; then
	error "Unsupported architecture: ${ARCH}. WaveKit images support arm64 and amd64."
	error "For Raspberry Pi, install Raspberry Pi OS Lite (64-bit) on a compatible model."
	exit 1
fi

NEEDED_PKGS=()
for pkg in ca-certificates curl gnupg; do
	if ! dpkg -s "$pkg" >/dev/null 2>&1; then
		NEEDED_PKGS+=("$pkg")
	fi
done

if [ "${#NEEDED_PKGS[@]}" -gt 0 ]; then
	log "Installing prerequisites: ${NEEDED_PKGS[*]}"
	run_privileged apt-get update -y
	run_privileged apt-get install -y --no-install-recommends "${NEEDED_PKGS[@]}"
else
	log "Prerequisites already installed."
fi

if command -v docker >/dev/null 2>&1; then
	log "Docker already installed: $(docker --version)"
else
	log "Installing Docker Engine (official convenience script)."
	curl -fsSL https://get.docker.com | run_privileged sh
fi

run_privileged systemctl enable --now docker >/dev/null 2>&1 || true

DAEMON_JSON="/etc/docker/daemon.json"
if [ ! -f "$DAEMON_JSON" ]; then
	log "Configuring Docker log rotation."
	cat <<'EOF' | run_privileged tee "$DAEMON_JSON" >/dev/null
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
	run_privileged chmod 644 "$DAEMON_JSON"
	run_privileged systemctl restart docker >/dev/null 2>&1 || true
else
	warn "Docker daemon config already exists. Leaving ${DAEMON_JSON} unchanged."
fi

if ! id -nG "$INSTALL_USER" | grep -qw docker; then
	if confirm "Add ${INSTALL_USER} to the docker group (no sudo needed for Docker)?" "Y"; then
		run_privileged usermod -aG docker "$INSTALL_USER"
		warn "Please log out and log back in for group changes to take effect."
	fi
fi

if docker compose version >/dev/null 2>&1; then
	log "Docker Compose plugin detected."
else
	log "Installing Docker Compose plugin."
	run_privileged apt-get install -y --no-install-recommends docker-compose-plugin
fi

if [ -r /proc/sys/net/ipv6/bindv6only ]; then
	BINDV6ONLY="$(cat /proc/sys/net/ipv6/bindv6only 2>/dev/null || echo 0)"
	if [ "${BINDV6ONLY}" != "0" ]; then
		warn "IPv6 sockets are set to IPv6-only (net.ipv6.bindv6only=1)."
		warn "rtlmux uses IPv6 sockets and needs dual-stack to serve IPv4 clients."
		if confirm "Set net.ipv6.bindv6only=0 (recommended)?" "Y"; then
			run_privileged sysctl -w net.ipv6.bindv6only=0 >/dev/null
			echo "net.ipv6.bindv6only=0" | run_privileged tee /etc/sysctl.d/99-wavekit.conf >/dev/null
			log "Saved to /etc/sysctl.d/99-wavekit.conf"
		fi
	fi
fi

if [ "$SKIP_BLACKLIST" = false ]; then
	if confirm "Blacklist RTL-SDR DVB kernel drivers (recommended)?" "Y"; then
		BLACKLIST_FILE="/etc/modprobe.d/wavekit-rtl-sdr-blacklist.conf"
		BLOCKED_MODULES=(
			"rtl2832_sdr"
			"dvb_usb_rtl2832u"
			"dvb_usb_rtl28xxu"
			"dvb_usb_v2"
			"r820t"
			"rtl2830"
			"rtl2832"
			"rtl2838"
			"dvb_core"
		)

		log "Writing blacklist to ${BLACKLIST_FILE}"
		for module in "${BLOCKED_MODULES[@]}"; do
			if ! grep -q "^blacklist ${module}$" "$BLACKLIST_FILE" 2>/dev/null; then
				printf "blacklist %s\n" "$module" | run_privileged tee -a "$BLACKLIST_FILE" >/dev/null
				printf "install %s /bin/false\n" "$module" | run_privileged tee -a "$BLACKLIST_FILE" >/dev/null
			fi
			run_privileged modprobe -r "$module" >/dev/null 2>&1 || true
		done

		if command -v depmod >/dev/null 2>&1; then
			run_privileged depmod -a >/dev/null 2>&1 || true
		fi

		if command -v update-initramfs >/dev/null 2>&1; then
			run_privileged update-initramfs -u >/dev/null 2>&1 || true
		fi

		warn "A reboot is recommended to ensure driver changes take effect."
	fi
fi

printf "\n"
log "Docker setup complete."
printf "\nNext steps:\n"
printf "  1) Reboot or log out/in if prompted above\n"
printf "  2) Deploy WaveKit SDR Host with docker compose\n"
printf "\n"
