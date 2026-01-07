#!/bin/sh
# Sweep IQ Parameters Script
# Iterates over Decimation Rates, Gains, and Inversion to find decodable parameters.

INPUT_FILE="$1"
if [ -z "$INPUT_FILE" ]; then
    echo "Usage: $0 <input_iq_file>"
    exit 1
fi

# Fixed Input Rate
INPUT_RATE=2400000

# Sweep Parameters
# Decimations: 
# 192 (12.5k) - Target NFM
# 100 (24k) - Wide
# 50 (48k) - Very Wide
# 160 (15k) - Intermediate
DECIMATIONS="192 100 50 160"

# Gains:
# 1.0, 5.0, 10.0, -1.0 (Inverted), -5.0 (Inverted High)
GAINS="1.0 5.0 10.0 -1.0 -10.0"

echo "Starting Sweep on $INPUT_FILE..."
echo "Format: DECIMATION | GAIN | RESULT"

for decim in $DECIMATIONS; do
    for gain in $GAINS; do
        
        # Calculate intermediate rate
        rate=$((INPUT_RATE / decim))
        
        # Generate WAV
        # Note: We must run the pipeline in the container to use csdr
        # But we want to script the loop here.
        # We will generate a temporary unique file name
        
        tmp_wav="/tmp/sweep_${decim}_${gain}.wav"
        local_wav="sweep_output.wav"
        
        # Construct pipeline command
        # U8 -> Float -> FirDecimate -> FM Demod -> DC Block -> Gain -> Limit -> S16LE
        # Then Sox resample to 48k for DSD-FME
        
        cat "$INPUT_FILE" | \
        docker exec -i wavekit-dev sh -c "csdr convert -i char -o float | \
        csdr firdecimate $decim | \
        csdr fmdemod | \
        csdr dcblock | \
        csdr gain $gain | \
        csdr limit | \
        csdr convert -i float -o s16" > sweep_raw.tmp
        
        # Sox resample to 48k WAV
        sox -t raw -r $rate -e signed -b 16 -c 1 sweep_raw.tmp -r 48000 "$local_wav" > /dev/null 2>&1
        
        # Run DSD-FME on the produced WAV inside container
        # Copy WAV to container first
        docker cp "$local_wav" wavekit-dev:"$tmp_wav"
        
        # Run DSD
        output=$(docker exec wavekit-dev dsd-fme -i "$tmp_wav" -fa -o null 2>&1 | grep -o "Sync:.*" | head -n 1)
        
        if [ -n "$output" ]; then
            echo "SUCCESS: Decim=$decim ($rate Hz) | Gain=$gain | $output"
        else
            echo "FAIL:    Decim=$decim ($rate Hz) | Gain=$gain"
        fi
        
        # Cleanup
        rm sweep_raw.tmp "$local_wav"
        docker exec wavekit-dev rm "$tmp_wav"
        
    done
done
