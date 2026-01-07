#!/bin/sh
# Sweep Multimon Parameters Script
# Iterates over Gains for Pager Decoding using Wide Bandwidth (Decim 10)

INPUT_FILE="$1"
if [ -z "$INPUT_FILE" ]; then
    echo "Usage: $0 <input_iq_file>"
    exit 1
fi

# Fixed Input Rate
INPUT_RATE=2400000

# Sweep Parameters
# Decimations: 
# 10 (240k) - Ultra Wide to capture offset
DECIMATIONS="10"

# Gains:
# High granularity sweep including inversion
GAINS="1.0 2.0 5.0 10.0 20.0 -1.0 -2.0 -5.0 -10.0 -20.0"

echo "Starting Multimon Sweep on $INPUT_FILE..."
echo "Format: DECIMATION | GAIN | RESULT"

for decim in $DECIMATIONS; do
    for gain in $GAINS; do
        
        # Calculate intermediate rate
        rate=$((INPUT_RATE / decim))
        
        tmp_wav="/tmp/sweep_multi_${decim}_${gain}.wav"
        local_raw="sweep_raw_${decim}_${gain}.raw"
        local_wav="sweep_output.wav"
        
        # Pipeline: Convert(u8/char) -> Decimate -> FM Demod -> DC Block -> Gain -> Limit -> Convert(s16)
        # Note: Using 'cat' to pipe file into docker to avoid mount issues
        cat "$INPUT_FILE" | \
        docker exec -i wavekit-dev sh -c "csdr convert -i char -o float | \
        csdr firdecimate $decim | \
        csdr fmdemod | \
        csdr dcblock | \
        csdr gain $gain | \
        csdr limit | \
        csdr convert -i float -o s16" > "$local_raw"
        
        # Check if raw file has data
        if [ ! -s "$local_raw" ]; then
            echo "FAIL:    Decim=$decim | Gain=$gain | Raw file empty"
            rm "$local_raw"
            continue
        fi

        # Sox resample to 22050Hz for Multimon
        # Run SOX inside container to ensure codec availability/versions
        docker cp "$local_raw" wavekit-dev:/tmp/temp.raw
        
        docker exec wavekit-dev sox -t raw -r $rate -e signed -b 16 -c 1 /tmp/temp.raw -t wav -r 22050 "$tmp_wav" > /dev/null 2>&1
        
        # Run multimon-ng
        output=$(docker exec wavekit-dev multimon-ng -t wav -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -a FLEX "$tmp_wav" 2>&1 | grep -E "^(POCSAG|FLEX)" | head -n 1)
        
        if [ -n "$output" ]; then
            echo "SUCCESS: Decim=$decim ($rate Hz) | Gain=$gain | $output"
        else
            echo "FAIL:    Decim=$decim ($rate Hz) | Gain=$gain"
        fi
        
        # Cleanup
        rm "$local_raw" "$local_wav" 2>/dev/null
        docker exec wavekit-dev rm "$tmp_wav" /tmp/temp.raw 2>/dev/null
        
    done
done
