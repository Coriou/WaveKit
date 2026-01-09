#!/usr/bin/env bash
# Download test fixtures from manifest.yaml
# Usage: ./fixtures/download.sh [fixture_id...]
#
# If no fixture_id specified, downloads small fixtures only (< 20 MB)
# To download all: ./fixtures/download.sh --all
# To download specific: ./fixtures/download.sh sigid_pocsag sigid_vdlm2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_DIR="${SCRIPT_DIR}/raw"
MANIFEST="${SCRIPT_DIR}/manifest.yaml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# Check dependencies
check_deps() {
    local missing=()
    command -v curl &>/dev/null || missing+=("curl")
    command -v unzip &>/dev/null || missing+=("unzip")
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing dependencies: ${missing[*]}"
        exit 1
    fi
}

# Parse fixture from manifest (using grep/sed - no yq dependency)
# This is a simple parser for our specific YAML format
get_fixtures() {
    local filter="${1:-small}"
    
    # Extract fixture blocks from manifest
    # Returns: id|url|size|format lines
    awk '
        /^  - id:/ { 
            id = $3 
            url = ""; size = 0; format = ""
        }
        /source_url:/ { 
            url = $2
            gsub(/"/, "", url)
        }
        /size_mb:/ { 
            size = $2 + 0
        }
        /format:/ && !/iq_format/ { 
            format = $2
        }
        /notes:/ {
            if (url != "" && url != "null" && format != "git_repo" && format != "generated") {
                print id "|" url "|" size "|" format
            }
        }
    ' "$MANIFEST" | while IFS='|' read -r id url size format; do
        case "$filter" in
            small)
                # Only files < 20 MB
                if (( $(echo "$size < 20" | bc -l) )); then
                    echo "$id|$url|$size|$format"
                fi
                ;;
            all)
                echo "$id|$url|$size|$format"
                ;;
            *)
                # Specific fixture IDs
                for fid in $filter; do
                    if [[ "$id" == "$fid" ]]; then
                        echo "$id|$url|$size|$format"
                    fi
                done
                ;;
        esac
    done
}

download_fixture() {
    local id="$1"
    local url="$2"
    local size="$3"
    local format="$4"
    
    local filename
    filename=$(basename "$url")
    local output_path="${RAW_DIR}/${filename}"
    
    # Skip if already downloaded
    if [[ -f "$output_path" ]]; then
        log_success "$id: Already downloaded ($filename)"
        return 0
    fi
    
    log_info "$id: Downloading (~${size} MB)..."
    log_info "  URL: $url"
    
    if curl -fSL --progress-bar -o "$output_path" "$url"; then
        log_success "$id: Downloaded to $filename"
        
        # Extract if ZIP
        if [[ "$format" == "zip" ]]; then
            log_info "$id: Extracting..."
            local extract_dir="${RAW_DIR}/${id}"
            mkdir -p "$extract_dir"
            unzip -o -q "$output_path" -d "$extract_dir"
            log_success "$id: Extracted to $extract_dir/"
        fi
    else
        log_error "$id: Download failed!"
        rm -f "$output_path"
        return 1
    fi
}

clone_rtl433_tests() {
    local repo_dir="${RAW_DIR}/rtl_433_tests"
    
    if [[ -d "$repo_dir/.git" ]]; then
        log_success "rtl_433_tests: Already cloned"
        log_info "  Updating..."
        git -C "$repo_dir" pull --quiet
    else
        log_info "rtl_433_tests: Cloning test repository..."
        git clone --depth 1 https://github.com/merbanan/rtl_433_tests.git "$repo_dir"
        log_success "rtl_433_tests: Cloned"
    fi
}

main() {
    check_deps
    mkdir -p "$RAW_DIR"
    
    echo ""
    echo -e "${BLUE}WaveKit Test Fixtures Download${NC}"
    echo "================================"
    echo ""
    
    local filter="small"
    local include_rtl433=false
    
    # Parse arguments
    for arg in "$@"; do
        case "$arg" in
            --all)
                filter="all"
                include_rtl433=true
                ;;
            --rtl433)
                include_rtl433=true
                ;;
            *)
                filter="$filter $arg"
                ;;
        esac
    done
    
    if [[ "$filter" == "small" ]]; then
        log_info "Downloading small fixtures only (< 20 MB)"
        log_info "Use --all to download everything"
        echo ""
    fi
    
    # Download fixtures from manifest
    local downloaded=0
    local failed=0
    
    while IFS='|' read -r id url size format; do
        if download_fixture "$id" "$url" "$size" "$format"; then
            ((downloaded++)) || true
        else
            ((failed++)) || true
        fi
    done < <(get_fixtures "$filter")
    
    # Optionally clone rtl_433_tests
    if [[ "$include_rtl433" == true ]]; then
        clone_rtl433_tests
    fi
    
    echo ""
    echo "================================"
    log_success "Downloaded: $downloaded fixtures"
    [[ $failed -gt 0 ]] && log_error "Failed: $failed fixtures"
    echo ""
    echo "Raw files in: $RAW_DIR/"
    echo "Next step: ./fixtures/convert.sh"
}

main "$@"
