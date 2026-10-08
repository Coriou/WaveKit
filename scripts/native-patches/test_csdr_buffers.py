#!/usr/bin/env python3
"""Native regression/measurement harness for the pinned CSDR buffer patch.

Run on Linux, outside the live app:
  python3 test_csdr_buffers.py --candidate /path/to/patched/csdr \
      --baseline /path/to/unpatched/csdr

The Dockerfile csdr-build target builds the candidate. Copy its binary into an
isolated container based on the matching runtime image, retaining the original
binary as the baseline. This harness uses only generated files and subprocesses:
no radio, network, tuner, or live application is involved.

Example from the repository root (wavekit:local-core must use the pinned CSDR):
  docker build --target csdr-build --build-arg CSDR_BUILD_JOBS=2 \
      -t wavekit:csdr-buffer-test .
  docker create --name csdr-artifact wavekit:csdr-buffer-test
  docker cp csdr-artifact:/usr/local/bin/csdr /tmp/csdr-candidate
  docker rm csdr-artifact
  docker run -d --name csdr-verify --network none --cpus 1 --memory 512m \
      --entrypoint sleep -v "$PWD/scripts/native-patches:/verification:ro" \
      wavekit:local-core 300
  docker cp /tmp/csdr-candidate csdr-verify:/tmp/csdr-candidate
  docker exec csdr-verify python3 /verification/test_csdr_buffers.py \
      --candidate /tmp/csdr-candidate --baseline /usr/local/bin/csdr
  docker rm -f csdr-verify

WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 selects 65536 input elements per CSDR CLI
process (512 KiB for complex<float>, plus its mirrored virtual mapping). Unset
keeps upstream defaults, including the FIR's 104857600-element ring. The patch
rejects invalid/undersized settings and asynchronous mode. It does not change
filter settings, the 1024-element read batch, or the upstream EOF tail policy.

Measurements compare one native process at a time. wait4 reports lifetime peak
RSS (including process startup); /proc sampling reports the native executable's
own high-water mark separately. Throughput depends on concurrent load;
this is an output-equivalence and memory test, not all-nine capacity acceptance.
"""

import argparse
import array
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


SETTING = "WAVEKIT_CSDR_BUFFER_ELEMENTS"


def native_peak_rss(pid, binary):
    try:
        if os.readlink(f"/proc/{pid}/exe") != os.path.realpath(binary):
            return 0
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except (FileNotFoundError, ProcessLookupError):
        pass
    return 0


def execute(binary, args, source, destination, setting=None, chunks=None):
    env = os.environ.copy()
    env.pop(SETTING, None)
    if setting is not None:
        env[SETTING] = str(setting)
    started = time.monotonic()
    with source.open("rb") as input_file, destination.open("wb") as output_file:
        process = subprocess.Popen(
            [binary, *args],
            stdin=subprocess.PIPE if chunks else input_file,
            stdout=output_file,
            stderr=subprocess.PIPE,
            env=env,
        )
        writer_errors = []

        def write_chunks():
            try:
                for index in range(10**9):
                    data = input_file.read(chunks[index % len(chunks)])
                    if not data:
                        break
                    process.stdin.write(data)
                    process.stdin.flush()
            except BrokenPipeError:
                pass  # A deliberate validation failure may close stdin early.
            except Exception as error:
                writer_errors.append(error)
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass

        writer = threading.Thread(target=write_chunks) if chunks else None
        if writer:
            writer.start()
        deadline = started + 45
        native_peak = 0
        try:
            while True:
                native_peak = max(native_peak, native_peak_rss(process.pid, binary))
                waited, status, usage = os.wait4(process.pid, os.WNOHANG)
                if waited:
                    break
                if time.monotonic() > deadline:
                    process.kill()
                    _, status, usage = os.wait4(process.pid, 0)
                    raise AssertionError(f"native command timed out: {args}")
                time.sleep(0.01)
        finally:
            if writer:
                writer.join(timeout=2)
                assert not writer.is_alive(), "stdin writer failed to stop"
        process.returncode = os.waitstatus_to_exitcode(status)
        stderr = process.stderr.read().decode(errors="replace")
        process.stderr.close()
        if writer_errors:
            raise writer_errors[0]
    return {
        "exit": process.returncode,
        "stderr": stderr,
        "bytes": destination.stat().st_size,
        "peakRssKiB": usage.ru_maxrss,
        "sampledNativePeakRssKiB": native_peak,
        "wallSeconds": round(time.monotonic() - started, 4),
        "userSeconds": round(usage.ru_utime, 4),
        "systemSeconds": round(usage.ru_stime, 4),
    }


def assert_same(left, right):
    with left.open("rb") as a, right.open("rb") as b:
        while True:
            x, y = a.read(65536), b.read(65536)
            assert x == y, f"output mismatch: {left.name} / {right.name}"
            if not x:
                break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--memory-mib", type=int, default=64)
    options = parser.parse_args()
    assert sys.platform.startswith("linux"), "RSS units and wait4 checks require Linux"
    assert 32 <= options.memory_mib <= 256

    with tempfile.TemporaryDirectory(prefix="wavekit-csdr-buffer-") as directory:
        root = Path(directory)
        samples = 1_048_589  # Crosses the reduced ring many times, with a tail.
        cycles = 1 / 1024
        period = array.array("f")
        for index in range(1024):
            phase = 2 * math.pi * cycles * index
            period.extend((0.5 * math.cos(phase), 0.5 * math.sin(phase)))
        period_bytes = period.tobytes()
        tone = root / "tone.cf32"
        with tone.open("wb") as output:
            for _ in range(samples // 1024):
                output.write(period_bytes)
            output.write(period_bytes[: (samples % 1024) * 8])

        report = {"equivalence": [], "validationCases": 0}
        cases = [(2, "0.05"), (43, "0.05"), (43, "0.012"), (85, "0.05")]
        for factor, transition in cases:
            args = ["firdecimate", str(factor), transition]
            baseline, default, bounded = [root / name for name in ("baseline", "default", "bounded")]
            original = execute(options.baseline, args, tone, baseline)
            unchanged = execute(options.candidate, args, tone, default)
            limited = execute(options.candidate, args, tone, bounded, 65536)
            assert original["exit"] == unchanged["exit"] == limited["exit"] == 0
            assert_same(baseline, default)
            assert_same(baseline, bounded)
            # Match the pinned filter-length and finite-stream tail semantics.
            transition_float = struct.unpack("f", struct.pack("f", float(transition)))[0]
            taps = int(4 / transition_float)
            if taps % 2 == 0:
                taps += 1
            assert limited["bytes"] == ((samples - taps) // factor) * 8
            values = array.array("f", bounded.read_bytes())
            expected_delta = 2 * math.pi * cycles * factor
            errors = []
            for index in range(2, min(len(values), 20000), 2):
                previous = complex(values[index - 2], values[index - 1])
                current = complex(values[index], values[index + 1])
                delta = current * previous.conjugate()
                angle = math.atan2(delta.imag, delta.real)
                errors.append(abs(math.remainder(angle - expected_delta, 2 * math.pi)))
            assert max(errors) < 1e-5, "complex tone phase progression changed"
            report["equivalence"].append({"factor": factor, "transition": transition, "bytes": limited["bytes"]})

        # Odd byte writes exercise partial complex elements as the small ring wraps.
        fragmented = root / "fragmented.cf32"
        fragmented.write_bytes(tone.read_bytes()[: 65539 * 8])
        args = ["firdecimate", "43", "0.012"]
        reference, output = root / "reference", root / "fragmented-output"
        assert execute(options.baseline, args, fragmented, reference)["exit"] == 0
        assert execute(options.candidate, args, fragmented, output, 2048, [17, 1023, 8191])["exit"] == 0
        assert_same(reference, output)

        # One actual CU8 -> complex-float -> FIR -> CU8 path, matching rtl_433.
        cu8 = root / "input.cu8"
        cu8.write_bytes(bytes((n * 73 + 29) % 256 for n in range(131078)))
        results = []
        for binary, setting in [(options.baseline, None), (options.candidate, 65536)]:
            current = cu8
            for index, args in enumerate([
                ["convert", "-i", "char", "-o", "float"],
                ["firdecimate", "2", "0.05"],
                ["convert", "-i", "float", "-o", "char"],
            ]):
                output = root / f"cu8-{len(results)}-{index}"
                assert execute(binary, args, current, output, setting)["exit"] == 0
                current = output
            results.append(current)
        assert_same(*results)

        # An unrelated command retains its unmodified default environment/path.
        args = ["fft", "4096", "4096"]
        reference, output = root / "fft-reference", root / "fft-output"
        assert execute(options.baseline, args, fragmented, reference)["exit"] == 0
        assert execute(options.candidate, args, fragmented, output)["exit"] == 0
        assert_same(reference, output)

        output = root / "invalid-output"
        invalid = ["", "0", "2047", "10485761", "NaN", "-1", "1.5", "1e4", " 65536", "999999999999999999999"]
        for setting in invalid:
            result = execute(options.candidate, ["convert", "-i", "char", "-o", "float"], cu8, output, setting)
            assert result["exit"] > 0 and SETTING in result["stderr"], result
            assert result["bytes"] == 0
            report["validationCases"] += 1
        for setting, args in [
            (65536, ["--async", "firdecimate", "43", "0.05"]),
            (2048, ["firdecimate", "4096", "0.05"]),
            (65536, ["firdecimate", "43", "0.000001"]),
            (65536, ["firdecimate", "0", "0.05"]),
            (65536, ["firdecimate", "43", "0"]),
            (2048, ["fft", "32768", "32768"]),
        ]:
            result = execute(options.candidate, args, tone, output, setting)
            assert result["exit"] > 0 and SETTING in result["stderr"], result
            report["validationCases"] += 1

        # Sequential peak RSS comparison; more input than the opt-in ring can hold.
        large = root / "memory.cf32"
        with large.open("wb") as output:
            for _ in range(options.memory_mib * 1024 * 1024 // len(period_bytes)):
                output.write(period_bytes)
        args = ["firdecimate", "43", "0.012"]
        reference, output = root / "memory-reference", root / "memory-output"
        original = execute(options.baseline, args, large, reference)
        limited = execute(options.candidate, args, large, output, 65536)
        assert original["exit"] == limited["exit"] == 0
        assert_same(reference, output)
        assert limited["peakRssKiB"] < 32 * 1024, limited
        assert 0 < limited["sampledNativePeakRssKiB"] < 16 * 1024, limited
        assert original["peakRssKiB"] > limited["peakRssKiB"] * 2, (original, limited)
        report["memory"] = {"inputMiB": options.memory_mib, "baseline": original, "bounded": limited}

        # A consumer that stops reading must block the pipeline, not grow memory.
        env = os.environ.copy()
        env[SETTING] = "65536"
        with large.open("rb") as input_file:
            process = subprocess.Popen(
                [options.candidate, "firdecimate", "2", "0.05"],
                stdin=input_file, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            )
            peaks = []
            try:
                for _ in range(10):
                    time.sleep(0.05)
                    assert process.poll() is None, "blocked consumer unexpectedly exited"
                    peaks.append(native_peak_rss(process.pid, options.candidate))
                assert min(peaks) > 0 and max(peaks) < 16 * 1024, peaks
                assert max(peaks) - min(peaks) < 1024, peaks
            finally:
                process.terminate()
                process.communicate(timeout=5)
            report["blockedConsumerPeakRssKiB"] = max(peaks)
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
