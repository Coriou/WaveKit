#!/usr/bin/env bash
# Build and publish wavekit-sdr-host image (supports multi-arch via buildx)

set -euo pipefail
trap 'printf "[wavekit] ERROR on line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

BUILDER="${BUILDER:-wavekit-builder}"
TAG="latest"
PLATFORMS="linux/arm64"
IMAGE=""
PUSH=true
PROVENANCE=false

usage() {
	cat <<'EOF'
WaveKit SDR Host - Build & Publish

Usage:
  ./build-publish.sh [options]

Options:
  --image <name>       Full image tag (e.g. ghcr.io/user/wavekit-sdr-host:latest)
  --tag <tag>          Tag to use with default image name (default: latest)
  --platform <list>    Platform list (default: linux/arm64)
  --multi-arch         Build linux/amd64 + linux/arm64
  --load               Load into local Docker instead of --push (single-arch only)
  --provenance         Enable BuildKit provenance attestation (may show as OS/Arch: unknown/unknown in GHCR)
  --no-provenance      Disable provenance attestation (default)
  --builder <name>     Buildx builder name (default: wavekit-builder)
  -h, --help           Show help

Environment:
  WAVEKIT_GH_OWNER     Default GHCR owner (auto-loaded from .env/.env.local)
  WAVEKIT_PROVENANCE   Set to 'true' to enable provenance by default
EOF
}

log() {
	printf "[wavekit] %s\n" "$*"
}

fail() {
	printf "[wavekit] %s\n" "$*" >&2
	exit 1
}

load_env() {
	local env_file
	for env_file in "${REPO_ROOT}/.env" "${REPO_ROOT}/.env.local"; do
		if [ -f "$env_file" ]; then
			set +u
			# shellcheck disable=SC1090
			. "$env_file"
			set -u
		fi
	done
}

guess_owner() {
	local url owner
	url="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
	owner="$(printf '%s' "$url" | sed -n 's#.*github.com[:/]\([^/]*\)/.*#\1#p')"
	printf '%s' "$owner"
}

load_env

if [ "${WAVEKIT_PROVENANCE:-}" != "" ]; then
	PROVENANCE="${WAVEKIT_PROVENANCE}"
fi

while [ "${1:-}" != "" ]; do
	case "$1" in
		--image)
			IMAGE="${2:-}"
			shift 2
			;;
		--tag)
			TAG="${2:-}"
			shift 2
			;;
		--platform)
			PLATFORMS="${2:-}"
			shift 2
			;;
		--multi-arch)
			PLATFORMS="linux/amd64,linux/arm64"
			shift
			;;
		--load)
			PUSH=false
			shift
			;;
		--provenance)
			PROVENANCE=true
			shift
			;;
		--no-provenance)
			PROVENANCE=false
			shift
			;;
		--builder)
			BUILDER="${2:-}"
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


if [ -z "$IMAGE" ]; then
	OWNER="${WAVEKIT_GH_OWNER:-$(guess_owner)}"
	if [ -z "$OWNER" ]; then
		OWNER="coriou"
	fi
	IMAGE="ghcr.io/${OWNER}/wavekit-sdr-host:${TAG}"
fi

if [ "$PUSH" = false ] && printf '%s' "$PLATFORMS" | grep -q ','; then
	fail "--load only supports single-platform builds. Use --push for multi-arch."
fi

ensure_builder() {
	local driver
	if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
		log "Creating buildx builder: ${BUILDER}"
		docker buildx create --name "$BUILDER" --driver docker-container --use >/dev/null
	else
		docker buildx use "$BUILDER" >/dev/null
	fi

	driver="$(docker buildx inspect "$BUILDER" | awk -F': ' '/Driver:/ {print $2}')"
	if [ "$driver" = "docker" ] && printf '%s' "$PLATFORMS" | grep -q ','; then
		local multi_builder="${BUILDER}-multi"
		log "Current builder uses docker driver; creating ${multi_builder} for multi-arch."
		if ! docker buildx inspect "$multi_builder" >/dev/null 2>&1; then
			docker buildx create --name "$multi_builder" --driver docker-container --use >/dev/null
		else
			docker buildx use "$multi_builder" >/dev/null
		fi
		BUILDER="$multi_builder"
	fi
}

ensure_builder

log "Building image: ${IMAGE}"
log "Platforms: ${PLATFORMS}"
log "Builder: ${BUILDER}"

supports_buildx_provenance() {
	docker buildx build --help 2>/dev/null | grep -q -- "--provenance" || return 1
}

BUILD_ARGS=(
	"--platform" "$PLATFORMS"
	"-f" "${REPO_ROOT}/packages/sdr-host/Dockerfile"
	"-t" "$IMAGE"
)

if [ "$PUSH" = true ]; then
	BUILD_ARGS+=("--push")
	if supports_buildx_provenance; then
		BUILD_ARGS+=("--provenance=${PROVENANCE}")
	fi
else
	BUILD_ARGS+=("--load")
fi

docker buildx build "${BUILD_ARGS[@]}" "${REPO_ROOT}"
