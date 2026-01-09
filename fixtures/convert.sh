#!/usr/bin/env bash
# Convert downloaded fixtures to decoder-ready formats
# Usage: ./fixtures/convert.sh [fixture_id...]
#
# Conversions performed:
# - WAV IQ wrappers → raw IQ samples
# - High sample rate → decimated to decoder preferences
# - IQ → FM demod audio (for multimon-ng, dsd-fme)
# - IQ → AM demod audio (for acarsdec)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_DIR="${SCRIPT_DIR}/raw"
PROCESSED_DIR="${SCRIPT_DIR}/processed"

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

check_deps() {
    local missing=()
    command -v sox &>/dev/null || missing+=("sox")
    command -v sox &>/dev/null || missing+=("sox")
    
    # csdr is optional but recommended
    if ! command -v csdr &>/dev/null; then
        log_warn "csdr not found - some conversions will be skipped"
        log_warn "Install: https://github.com/jketterl/csdr"
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing[*]}"
        log_info "Install with: brew install ${missing[*]}"
        exit 1
    fi
}

# Extract raw IQ from WAV wrapper (SDRuno/SDRangel style)
# WAV files contain IQ data as stereo (I=left, Q=right)
wav_to_raw() {
    local input="$1"
    local output="$2"
    local format="${3:-f32le}"  # Default to float32
    
    log_info "  Converting WAV to raw $format..."
    
    case "$format" in
        cu8)
            # Convert to unsigned 8-bit complex
            sox "$input" -t raw -e unsigned -b 8 "$output"
            ;;
        cs16|s16le)
            # Convert to signed 16-bit little-endian
            sox "$input" -t raw -e signed -b 16 -L "$output"
            ;;
        f32le)
            # Convert to float32 little-endian
            sox "$input" -t raw -e floating-point -b 32 -L "$output"
            ;;
        *)
            log_error "Unknown format: $format"
            return 1
            ;;
    esac
}

# FM demodulate IQ to audio
fm_demod() {
    local input="$1"
    local output="$2"
    local sample_rate="${3:-48000}"
    
    if ! command -v csdr &>/dev/null; then
        log_warn "  csdr not available, skipping FM demod"
        return 1
    fi
    
    log_info "  FM demodulating to ${sample_rate}Hz audio..."
    
    # csdr pipeline: convert → fm demod → resample → convert to s16
    # Input assumed to be float32 complex
    csdr fmdemod_quadri_cf < "$input" | \
    csdr convert_f_s16 > "$output"
}

# Convert specific fixture types
convert_sigid_pocsag() {
    local src_dir="${RAW_DIR}/sigid_pocsag"
    local dest_dir="${PROCESSED_DIR}/multimon-ng"
    mkdir -p "$dest_dir"
    
    log_info "sigid_pocsag: Converting for multimon-ng..."
    
    # Find the extracted IQ file
    local iq_file
    iq_file=$(find "$src_dir" -name "*.raw" -o -name "*.bin" -o -name "*.cu8" 2>/dev/null | head -1)
    
    if [[ -z "$iq_file" ]]; then
        # Try WAV files
        iq_file=$(find "$src_dir" -name "*.wav" 2>/dev/null | head -1)
    fi
    
    if [[ -z "$iq_file" ]]; then
        log_warn "sigid_pocsag: No IQ file found in $src_dir"
        log_info "  Contents: $(ls "$src_dir" 2>/dev/null || echo 'empty')"
        return 1
    fi
    
    log_info "  Found: $(basename "$iq_file")"
    
    # Copy raw file for inspection
    cp "$iq_file" "$dest_dir/pocsag_raw.bin"
    
    # If WAV, extract raw
    if [[ "$iq_file" == *.wav ]]; then
        wav_to_raw "$iq_file" "$dest_dir/pocsag_iq.f32" "f32le"
        log_success "sigid_pocsag: Prepared IQ file"
    else
        cp "$iq_file" "$dest_dir/pocsag_iq.cu8"
        log_success "sigid_pocsag: Copied raw IQ file"
    fi
}

convert_sigid_vdlm2() {
    local src_dir="${RAW_DIR}/sigid_vdlm2"
    local dest_dir="${PROCESSED_DIR}/dumpvdl2"
    mkdir -p "$dest_dir"
    
    log_info "sigid_vdlm2: Converting for dumpvdl2..."
    
    local iq_file
    iq_file=$(find "$src_dir" -type f \( -name "*.raw" -o -name "*.bin" -o -name "*.cu8" -o -name "*.wav" \) 2>/dev/null | head -1)
    
    if [[ -z "$iq_file" ]]; then
        log_warn "sigid_vdlm2: No IQ file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$iq_file")"
    
    # dumpvdl2 can read various formats directly
    local ext="${iq_file##*.}"
    cp "$iq_file" "$dest_dir/vdlm2_iq.${ext}"
    
    log_success "sigid_vdlm2: Prepared for dumpvdl2"
}

convert_sigid_flex() {
    local src_dir="${RAW_DIR}/sigid_flex"
    local dest_dir="${PROCESSED_DIR}/multimon-ng"
    mkdir -p "$dest_dir"
    
    log_info "sigid_flex: Converting for multimon-ng..."
    
    local iq_file
    iq_file=$(find "$src_dir" -type f \( -name "*.raw" -o -name "*.bin" -o -name "*.cu8" -o -name "*.wav" \) 2>/dev/null | head -1)
    
    if [[ -z "$iq_file" ]]; then
        log_warn "sigid_flex: No IQ file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$iq_file")"
    cp "$iq_file" "$dest_dir/flex_iq.$(basename "${iq_file##*.}")"
    
    log_success "sigid_flex: Prepared for multimon-ng"
}

convert_sdrangel_dsd() {
    local src_dir="${RAW_DIR}/sdrangel_dsd"
    local dest_dir="${PROCESSED_DIR}/dsd-fme"
    mkdir -p "$dest_dir"
    
    log_info "sdrangel_dsd: Converting for dsd-fme..."
    
    local wav_file
    wav_file=$(find "$src_dir" -name "*.wav" 2>/dev/null | head -1)
    
    if [[ -z "$wav_file" ]]; then
        log_warn "sdrangel_dsd: No WAV file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$wav_file")"
    
    # Extract raw IQ from WAV
    wav_to_raw "$wav_file" "$dest_dir/dsd_iq.s16" "s16le"
    
    log_success "sdrangel_dsd: Prepared for dsd-fme"
}

convert_sdrplay_ais() {
    local src_dir="${RAW_DIR}/sdrplay_ais"
    local dest_dir="${PROCESSED_DIR}/ais-catcher"
    mkdir -p "$dest_dir"
    
    log_info "sdrplay_ais: Converting for ais-catcher..."
    
    local wav_file
    wav_file=$(find "$src_dir" -name "*.wav" 2>/dev/null | head -1)
    
    if [[ -z "$wav_file" ]]; then
        log_warn "sdrplay_ais: No WAV file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$wav_file")"
    
    # AIS-catcher can read WAV directly
    cp "$wav_file" "$dest_dir/ais.wav"
    
    log_success "sdrplay_ais: Prepared for ais-catcher"
}

convert_sdrangel_adsb() {
    local src_dir="${RAW_DIR}/sdrangel_adsb"
    local dest_dir="${PROCESSED_DIR}/readsb"
    mkdir -p "$dest_dir"
    
    log_info "sdrangel_adsb: Converting for readsb..."
    
    local wav_file
    wav_file=$(find "$src_dir" -name "*.wav" 2>/dev/null | head -1)
    
    if [[ -z "$wav_file" ]]; then
        log_warn "sdrangel_adsb: No WAV file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$wav_file")"
    
    # readsb expects raw IQ, usually signed 16-bit (SC16)
    # Using sox to strip WAV header and ensure SC16 format
    wav_to_raw "$wav_file" "$dest_dir/adsb_iq.sc16" "s16le"
    
    log_success "sdrangel_adsb: Prepared for readsb"
}

convert_sigid_acars() {
    local src_dir="${RAW_DIR}/sigid_acars"
    local dest_dir="${PROCESSED_DIR}/acarsdec"
    mkdir -p "$dest_dir"
    
    log_info "sigid_acars: Converting for acarsdec..."
    
    local wav_file
    wav_file=$(find "$src_dir" -name "*.wav" 2>/dev/null | head -1)
    
    if [[ -z "$wav_file" ]]; then
        log_warn "sigid_acars: No WAV file found"
        return 1
    fi
    
    log_info "  Found: $(basename "$wav_file")"
    
    if ! command -v csdr &>/dev/null; then
        log_warn "  csdr not available, skipping AM demod"
        return 1
    fi
    
    # ACARS needs AM demodulation
    # Pipeline: WAV -> float IQ -> AM demod -> float audio -> int16 audio -> WAV
    
    local raw_iq="$dest_dir/temp_iq.f32"
    local raw_audio="$dest_dir/temp_audio.f32"
    local out_wav="$dest_dir/acars_audio.wav"
    
    log_info "  Converting to raw IQ..."
    wav_to_raw "$wav_file" "$raw_iq" "f32le"
    
    log_info "  AM demodulating..."
    # amdemod_cf: Complex Float -> Float (AM magnitude)
    csdr amdemod < "$raw_iq" > "$raw_audio"
    
    log_info "  Creating output WAV..."
    # Convert float audio to WAV (resample to 48kHz for acarsdec compatibility, needs mult of 12k)
    sox -t raw -e floating-point -b 32 -c 1 -r 135498 "$raw_audio" -r 48000 "$out_wav"
    
    rm -f "$raw_iq" "$raw_audio"
    log_success "sigid_acars: Prepared for acarsdec"
}

convert_sdrplay_acars() {
    local src_dir="${RAW_DIR}/sdrplay_acars"
    local dest_dir="${PROCESSED_DIR}/acarsdec"
    mkdir -p "$dest_dir"
    
    log_info "sdrplay_acars: Converting for acarsdec..."
    # Similar to sigid_acars but verifying sample rate
    # Todo: Implementation pending successful download
    log_warn "sdrplay_acars: Implementation pending"
}

list_downloaded() {
    echo ""
    log_info "Downloaded fixtures:"
    for dir in "$RAW_DIR"/*/; do
        if [[ -d "$dir" ]]; then
            local name=$(basename "$dir")
            local size=$(du -sh "$dir" 2>/dev/null | cut -f1)
            echo "  - $name ($size)"
        fi
    done
}

main() {
    check_deps
    mkdir -p "$PROCESSED_DIR"
    
    echo ""
    echo -e "${BLUE}WaveKit Fixture Conversion${NC}"
    echo "==========================="
    echo ""
    
    local fixtures=("$@")
    
    # If no args, process all downloaded
    if [[ ${#fixtures[@]} -eq 0 ]]; then
        list_downloaded
        echo ""
        
        # Process each downloaded fixture
        [[ -d "${RAW_DIR}/sigid_pocsag" ]] && convert_sigid_pocsag
        [[ -d "${RAW_DIR}/sigid_vdlm2" ]] && convert_sigid_vdlm2
        [[ -d "${RAW_DIR}/sigid_flex" ]] && convert_sigid_flex
        [[ -d "${RAW_DIR}/sdrangel_dsd" ]] && convert_sdrangel_dsd
        [[ -d "${RAW_DIR}/sdrplay_ais" ]] && convert_sdrplay_ais
        [[ -d "${RAW_DIR}/sdrangel_adsb" ]] && convert_sdrangel_adsb
        [[ -d "${RAW_DIR}/sigid_acars" ]] && convert_sigid_acars
    else
        # Process specified fixtures
        for fixture in "${fixtures[@]}"; do
            case "$fixture" in
                sigid_pocsag) convert_sigid_pocsag ;;
                sigid_vdlm2) convert_sigid_vdlm2 ;;
                sigid_flex) convert_sigid_flex ;;
                sdrangel_dsd) convert_sdrangel_dsd ;;
                sdrplay_ais) convert_sdrplay_ais ;;
                sdrangel_adsb) convert_sdrangel_adsb ;;
                sigid_acars) convert_sigid_acars ;;
                *) log_warn "Unknown fixture: $fixture" ;;
            esac
        done
    fi
    
    echo ""
    echo "==========================="
    log_info "Processed files in: $PROCESSED_DIR/"
    ls -la "$PROCESSED_DIR"/*/ 2>/dev/null || echo "  (none yet)"

    echo ""
    echo "Next step: ./fixtures/test-decoders.sh"
}

main "$@"
