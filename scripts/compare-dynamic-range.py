#!/usr/bin/env python3
"""Compare dynamic range between old and new IQ captures."""

import numpy as np
import os
import sys


def analyze_file(filepath: str) -> dict:
    """Analyze an IQ file and return dynamic range info."""
    iq = np.fromfile(filepath, dtype=np.uint8)
    i = iq[0::2].astype(float) - 127.5
    q = iq[1::2].astype(float) - 127.5
    i_range = max(abs(i.max()), abs(i.min()))
    q_range = max(abs(q.max()), abs(q.min()))
    dyn_range = max(i_range, q_range) / 127.5 * 100
    return {
        "i_min": i.min(),
        "i_max": i.max(),
        "q_min": q.min(),
        "q_max": q.max(),
        "dyn_range": dyn_range,
    }


def main():
    output_dir = "/output"

    # Find AGC-enabled captures (today's 2047* captures)
    agc_files = sorted([f for f in os.listdir(output_dir) if f.startswith("iq_auto_20260108_2047")])

    print("=" * 70)
    print("AGC-enabled captures (gain=0):")
    print("=" * 70)
    for f in agc_files:
        info = analyze_file(os.path.join(output_dir, f))
        print(f"{f}:")
        print(f"  I range: {info['i_min']:.1f} to {info['i_max']:.1f}")
        print(f"  Q range: {info['q_min']:.1f} to {info['q_max']:.1f}")
        print(f"  Dynamic range: {info['dyn_range']:.1f}%")
        print()

    # Compare with old capture
    old_file = "iq_auto_20260108_183338.u8"
    old_path = os.path.join(output_dir, old_file)
    if os.path.exists(old_path):
        print("=" * 70)
        print("Old capture (fixed gain=49.6):")
        print("=" * 70)
        info = analyze_file(old_path)
        print(f"{old_file}:")
        print(f"  I range: {info['i_min']:.1f} to {info['i_max']:.1f}")
        print(f"  Q range: {info['q_min']:.1f} to {info['q_max']:.1f}")
        print(f"  Dynamic range: {info['dyn_range']:.1f}%")


if __name__ == "__main__":
    main()
