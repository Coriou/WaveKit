#!/usr/bin/env bash
# Download + verify fixtures from manifest v2 (addendum §8).
# Usage: ./fixtures/download.sh [--all] [--rtl433] [fixture_id...]
#   default: every non-large fixture; --all includes large ones.
#   --rtl433 (separate on purpose) also clones/pulls merbanan/rtl_433_tests; a failure exits 1.
# Env: WAVEKIT_FIXTURES_MANIFEST (default fixtures/manifest.yaml)
#      WAVEKIT_FIXTURES_DIR      (default fixtures/; files land at <dir>/<file>)
#      WAVEKIT_PRIVATE_FIXTURES_DIR  path or https:// base for private captures
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WAVEKIT_FIXTURES_MANIFEST="${WAVEKIT_FIXTURES_MANIFEST:-${SCRIPT_DIR}/manifest.yaml}"
OUT_DIR="${WAVEKIT_FIXTURES_DIR:-${SCRIPT_DIR}}"
CACHE_DIR="${OUT_DIR}/raw/.archives"

log_info() { echo "info: $1"; }
log_warn() { echo "warn: $1" >&2; }
log_error() { echo "error: $1" >&2; }

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
	else shasum -a 256 "$1" | awk '{print $1}'; fi
}

fetch_url() { # url dest
	curl -fsSL --retry 2 -o "$2.part" "$1" && mv "$2.part" "$2"
}

# Returns 0 ok, 1 failed, 2 skipped.
fetch_fixture() {
	local id="$1" kind="$2" url="$3" member="$4" transform="$5" file="$6" sha="$7" archive_sha="$8"
	local target="${OUT_DIR}/${file}"
	mkdir -p "$(dirname "$target")" "$CACHE_DIR"
	if [[ -f "$target" && "$(sha256_of "$target")" == "$sha" ]]; then
		log_info "$id: present and verified"; return 0
	fi
	rm -f "$target.part"
	case "$kind" in
	public)
		local archive="${CACHE_DIR}/${id}.download"
		if [[ ! -f "$archive" || "$(sha256_of "$archive")" != "$archive_sha" ]]; then
			log_info "$id: downloading $url"
			fetch_url "$url" "$archive" || { log_error "$id: download failed"; return 1; }
		fi
		if [[ "$(sha256_of "$archive")" != "$archive_sha" ]]; then
			log_error "$id: archive sha256 mismatch"; return 1
		fi
		if [[ -n "$member" ]]; then unzip -p "$archive" "$member" > "$target.part"
		else cp "$archive" "$target.part"; fi
		if [[ "$transform" == "wav-to-cu8" ]]; then
			"${SCRIPT_DIR}/convert.sh" --wav-to-cu8 "$target.part" "$target.part.cu8"
			mv "$target.part.cu8" "$target.part"
		fi
		;;
	private)
		local base="${WAVEKIT_PRIVATE_FIXTURES_DIR:-}"
		if [[ -z "$base" ]]; then
			log_warn "$id: private fixture skipped (set WAVEKIT_PRIVATE_FIXTURES_DIR)"; return 2
		fi
		local name; name="$(basename "$file")"
		if [[ "$base" =~ ^https:// ]]; then fetch_url "$base/$name" "$target.part" || { log_error "$id: private download failed"; return 1; }
		else cp "$base/$name" "$target.part" || { log_error "$id: $base/$name not readable"; return 1; }; fi
		;;
	*) log_error "$id: unknown fetch kind '$kind'"; return 1 ;;
	esac
	local actual; actual="$(sha256_of "$target.part")"
	if [[ "$actual" != "$sha" ]]; then
		log_error "$id: sha256 mismatch (expected $sha, got $actual)"; rm -f "$target.part"; return 1
	fi
	mv "$target.part" "$target"
	log_info "$id: verified ${file}"
}

clone_rtl433_tests() { # returns 0 ok, 1 failed (never git's own exit code)
	local repo_dir="${OUT_DIR}/raw/rtl_433_tests"
	if [[ -d "$repo_dir/.git" ]]; then
		git -C "$repo_dir" pull --quiet || { log_error "rtl_433_tests: pull failed (offline?)"; return 1; }
	else
		git clone --depth 1 https://github.com/merbanan/rtl_433_tests.git "$repo_dir" || { log_error "rtl_433_tests: clone failed (offline?)"; return 1; }
	fi
}

main() {
	command -v curl >/dev/null || { log_error "curl missing"; exit 1; }
	command -v node >/dev/null || { log_error "node missing"; exit 1; }
	local all=false rtl433=false ids=()
	for arg in "$@"; do
		case "$arg" in
		--all) all=true ;;
		--rtl433) rtl433=true ;;
		*) ids+=("$arg") ;;
		esac
	done
	# Captured up front: a process substitution would swallow a bad-manifest exit.
	local listing
	listing="$(node "${SCRIPT_DIR}/manifest-query.mjs" list)" || { log_error "cannot read $WAVEKIT_FIXTURES_MANIFEST"; exit 1; }
	local failed=0
	while IFS='|' read -r id kind url member transform file sha archive_sha large; do
		[[ -z "$id" ]] && continue
		if [[ ${#ids[@]} -gt 0 ]]; then
			local wanted=false; for w in "${ids[@]}"; do [[ "$w" == "$id" ]] && wanted=true; done
			$wanted || continue
		elif [[ "$large" == "true" && "$all" != true ]]; then
			log_info "$id: large, skipped (use --all)"; continue
		fi
		set +e; fetch_fixture "$id" "$kind" "$url" "$member" "$transform" "$file" "$sha" "$archive_sha"; local rc=$?; set -e
		[[ $rc -eq 1 ]] && failed=$((failed + 1))
	done <<< "$listing"
	if [[ "$rtl433" == true ]]; then
		set +e; clone_rtl433_tests; local clone_rc=$?; set -e
		[[ $clone_rc -ne 0 ]] && failed=$((failed + 1))
	fi
	[[ $failed -gt 0 ]] && { log_error "$failed fixture(s) failed"; exit 1; }
	exit 0
}

main "$@"
