#!/usr/bin/env bash
# Test decoders against processed fixtures
# Usage: ./fixtures/test-decoders.sh [decoder...]
#
# Runs each decoder against its processed fixtures and validates output.
# Must be run inside Docker container with decoders installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSED_DIR="${SCRIPT_DIR}/processed"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }
log_test() { echo -e "${CYAN}▶${NC} $1"; }

# Test result counters
PASSED=0
FAILED=0
SKIPPED=0

# Check if running in container (decoders available)
check_environment() {
    local in_docker=false
    [[ -f /.dockerenv ]] && in_docker=true
    
    if [[ "$in_docker" == false ]]; then
        log_warn "Not running in Docker container"
        log_info "Some decoders may not be available"
        log_info "Run: docker exec -it wavekit-dev ./fixtures/test-decoders.sh"
        echo ""
    fi
}

# Run a test and record result
run_test() {
    local name="$1"
    local cmd="$2"
    local expected_pattern="$3"
    local min_lines="${4:-1}"
    
    log_test "Testing: $name"
    echo "  Command: $cmd"
    
    local output
    local exit_code=0
    
    output=$(eval "$cmd" 2>&1) || exit_code=$?
    
    local line_count
    line_count=$(echo "$output" | grep -c "$expected_pattern" || true)
    
    if [[ $exit_code -eq 0 ]] && [[ $line_count -ge $min_lines ]]; then
        log_success "$name: PASSED ($line_count matches)"
        ((PASSED++)) || true
        return 0
    else
        log_error "$name: FAILED (exit=$exit_code, matches=$line_count, expected>=$min_lines)"
        echo "  Output (first 5 lines):"
        echo "$output" | head -5 | sed 's/^/    /'
        ((FAILED++)) || true
        return 1
    fi
}

skip_test() {
    local name="$1"
    local reason="$2"
    log_warn "$name: SKIPPED - $reason"
    ((SKIPPED++)) || true
}

# =============================================================================
# Decoder-specific tests
# =============================================================================

test_dumpvdl2() {
    local fixture_dir="${PROCESSED_DIR}/dumpvdl2"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "dumpvdl2" "No processed fixtures"
        return
    fi
    
    if ! command -v dumpvdl2 &>/dev/null; then
        skip_test "dumpvdl2" "dumpvdl2 not installed"
        return
    fi
    
    # Look for IQ files (including WAV)
    local iq_file
    iq_file=$(find "$fixture_dir" -type f \( -name "*.cu8" -o -name "*.bin" -o -name "*.raw" -o -name "*.wav" \) -print -quit 2>/dev/null)
    
    if [[ -z "$iq_file" ]]; then
        skip_test "dumpvdl2" "No IQ file found"
        return
    fi
    
    log_info "Using: $(basename "$iq_file")"
    
    # For WAV files, use sox to extract raw IQ and pipe to dumpvdl2
    # WAV files from SDRangel/SigIDwiki are typically stereo (I/Q) at various sample rates
    if [[ "$iq_file" == *.wav ]]; then
        # Get sample rate from WAV header
        local wav_info
        wav_info=$(sox --info "$iq_file" 2>/dev/null || echo "")
        log_info "WAV info: $(echo "$wav_info" | grep -E 'Sample Rate|Channels' | tr '\n' ', ')"
        
        # dumpvdl2 can read WAV files directly via sox pipe
        # Convert WAV to raw U8 format (sox normalizes)
        if [[ $(echo "$wav_info" | grep -o "Sample Rate * : *[0-9]*" | awk '{print $NF}') -lt 200000 ]]; then
             skip_test "dumpvdl2" "Sample rate too low for VDL2 (< 200kHz)"
             return
        fi

        run_test "dumpvdl2 VDL2" \
            "timeout 15 sox '$iq_file' -t raw -e unsigned -b 8 - 2>/dev/null | dumpvdl2 --iq-file - --sample-format U8 --oversample 2 --output decoded:json:file:path=- 136650000 2>&1 || true" \
            '"vdl2"' \
            1
    else
        # Detect format from extension for raw files
        local sample_format="U8"
        [[ "$iq_file" == *.s16 ]] && sample_format="S16_LE"
        [[ "$iq_file" == *.f32 ]] && sample_format="F32_LE"
        
        run_test "dumpvdl2 VDL2" \
            "timeout 10 cat '$iq_file' | dumpvdl2 --iq-file - --sample-format $sample_format --oversample 2 --output decoded:json:file:path=- 136650000 2>&1 || true" \
            '"vdl2"' \
            1

    fi
}


test_multimon_ng() {
    local fixture_dir="${PROCESSED_DIR}/multimon-ng"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "multimon-ng" "No processed fixtures"
        return
    fi
    
    if ! command -v multimon-ng &>/dev/null; then
        skip_test "multimon-ng" "multimon-ng not installed"
        return
    fi
    
    # For multimon-ng, we need FM-demodulated audio
    # If only IQ available, skip (need csdr pipeline)
    local audio_file
    audio_file=$(find "$fixture_dir" \( -name "*.wav" -o -name "*.s16" \) -print -quit 2>/dev/null)
    
    if [[ -z "$audio_file" ]]; then
        log_info "multimon-ng: IQ files found, need FM demod"
        log_info "  Try: csdr fmdemod_quadri_cf < iq.f32 | csdr convert_f_s16 > audio.s16"
        skip_test "multimon-ng" "No audio file (FM demod needed)"
        return
    fi
    
    # Test POCSAG decoding
    run_test "multimon-ng POCSAG" \
        "timeout 10 multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 '$audio_file' 2>&1 || true" \
        'POCSAG' \
        1
}

test_ais_catcher() {
    local fixture_dir="${PROCESSED_DIR}/ais-catcher"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "ais-catcher" "No processed fixtures"
        return
    fi
    
    if ! command -v AIS-catcher &>/dev/null; then
        skip_test "ais-catcher" "AIS-catcher not installed"
        return
    fi
    
    local wav_file
    wav_file=$(find "$fixture_dir" -name "*.wav" -print -quit 2>/dev/null)
    
    if [[ -z "$wav_file" ]]; then
        skip_test "ais-catcher" "No WAV file found"
        return
    fi
    
    # AIS-catcher can read WAV files directly
    run_test "ais-catcher AIS" \
        "timeout 30 AIS-catcher -r '$wav_file' -o 0 2>&1 || true" \
        'AIVDM\|!AIVDM' \
        1
}

test_dsd_fme() {
    local fixture_dir="${PROCESSED_DIR}/dsd-fme"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "dsd-fme" "No processed fixtures"
        return
    fi
    
    if ! command -v dsd-fme &>/dev/null; then
        skip_test "dsd-fme" "dsd-fme not installed"
        return
    fi
    
    log_info "dsd-fme: Requires FM-demodulated audio input"
    skip_test "dsd-fme" "Complex pipeline needed (FM demod → dsd-fme)"
}

test_rtl433() {
    local fixture_dir="${PROCESSED_DIR}/rtl433"
    local tests_dir="${SCRIPT_DIR}/raw/rtl_433_tests"
    
    if ! command -v rtl_433 &>/dev/null; then
        skip_test "rtl_433" "rtl_433 not installed"
        return
    fi
    
    # Check for rtl_433_tests repo
    if [[ -d "$tests_dir" ]]; then
        # Find a sample CU8 file (safely)
        local sample
        sample=$(find "$tests_dir" -name "*.cu8" -print -quit 2>/dev/null)
        
        if [[ -n "$sample" ]]; then
            # Avoid pipefail causing 141 error when head closes pipe
            run_test "rtl_433 sample" \
                "(set +o pipefail; timeout 10 rtl_433 -r '$sample' -F json 2>&1 | head -20) || true" \
                '"model"' \
                1
            return
        fi
    fi

    
    skip_test "rtl_433" "No test samples (run: ./download.sh --rtl433)"
}

test_readsb() {
    local fixture_dir="${PROCESSED_DIR}/readsb"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "readsb" "No processed fixtures"
        return
    fi
    
    if ! command -v readsb &>/dev/null; then
        skip_test "readsb" "readsb not installed"
        return
    fi
    
    # Try to find SC16 file
    local iq_file
    iq_file=$(find "$fixture_dir" -name "*.sc16" -print -quit 2>/dev/null)
    
    if [[ -z "$iq_file" ]]; then
        skip_test "readsb" "No SC16 IQ file found"
        return
    fi
    
    log_info "Using: $(basename "$iq_file")"

    # Run readsb with SC16 input
    # --ifile-format SC16 if supported, otherwise assumes SC16 by default or auto-detect
    # Providing --iformat SC16 to be explicit
    run_test "readsb ADS-B" \
        "timeout 15 readsb --device-type ifile --ifile '$iq_file' --iformat SC16 --throttle --quiet --stats-every 10 2>&1 || true" \
        'messages' \
        1
}


test_acarsdec() {
    local fixture_dir="${PROCESSED_DIR}/acarsdec"
    
    if [[ ! -d "$fixture_dir" ]]; then
        skip_test "acarsdec" "No processed fixtures"
        return
    fi
    
    if ! command -v acarsdec &>/dev/null; then
        skip_test "acarsdec" "acarsdec not installed"
        return
    fi
    
    local wav_file
    wav_file=$(find "$fixture_dir" -name "*.wav" -print -quit 2>/dev/null)
    
    if [[ -z "$wav_file" ]]; then
        skip_test "acarsdec" "No WAV file found"
        return
    fi
    
    log_info "Using: $(basename "$wav_file")"
    
    # Run acarsdec with audio input
    # acarsdec --sndfile <file.wav> --output json:file:path=-
    run_test "acarsdec ACARS" \
        "timeout 15 acarsdec -v --sndfile '$wav_file' --output json:file:path=- 2>&1 || true" \
        '"text"' \
        1
}

test_direwolf() {
    if ! command -v gen_packets &>/dev/null || ! command -v atest &>/dev/null; then
        skip_test "direwolf" "gen_packets/atest not installed"
        return
    fi
    
    local test_wav="/tmp/direwolf_test.wav"
    
    # Generate test APRS packets
    log_info "direwolf: Generating test APRS packets..."
    gen_packets -o "$test_wav" -n 10 2>/dev/null
    
    run_test "direwolf APRS" \
        "atest '$test_wav' 2>&1 | head -20" \
        'decoded' \
        1
    
    rm -f "$test_wav"
}

# =============================================================================
# Main
# =============================================================================

show_summary() {
    echo ""
    echo "============================================"
    echo -e "${BLUE}Test Summary${NC}"
    echo "============================================"
    echo -e "  ${GREEN}Passed${NC}:  $PASSED"
    echo -e "  ${RED}Failed${NC}:  $FAILED"
    echo -e "  ${YELLOW}Skipped${NC}: $SKIPPED"
    echo ""
    
    if [[ $FAILED -gt 0 ]]; then
        echo -e "${RED}Some tests failed!${NC}"
        return 1
    elif [[ $PASSED -eq 0 ]]; then
        echo -e "${YELLOW}No tests passed. Check fixture preparation.${NC}"
        return 1
    else
        echo -e "${GREEN}All executed tests passed!${NC}"
        return 0
    fi
}

main() {
    check_environment
    
    echo ""
    echo -e "${BLUE}WaveKit Decoder Tests${NC}"
    echo "====================="
    echo ""
    
    local decoders=("$@")
    
    # If no args, test all
    if [[ ${#decoders[@]} -eq 0 ]]; then
        decoders=(dumpvdl2 multimon-ng ais-catcher dsd-fme rtl433 readsb acarsdec direwolf)
    fi
    
    for decoder in "${decoders[@]}"; do
        echo ""
        echo -e "${CYAN}━━━ $decoder ━━━${NC}"
        case "$decoder" in
            dumpvdl2) test_dumpvdl2 ;;
            multimon-ng) test_multimon_ng ;;
            ais-catcher) test_ais_catcher ;;
            dsd-fme) test_dsd_fme ;;
            rtl433|rtl_433) test_rtl433 ;;
            readsb) test_readsb ;;
            acarsdec) test_acarsdec ;;
            direwolf) test_direwolf ;;
            *) log_warn "Unknown decoder: $decoder" ;;
        esac
    done
    
    show_summary
}

main "$@"
