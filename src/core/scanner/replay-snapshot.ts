/**
 * Offline decode of a stored wideband CU8 snapshot (the `POST /api/sources/:id/iq-snapshot`
 * format) through the product's own replay chain, planned here and run by
 * `scripts/decode-snapshot.ts`. Pure: no process, no file.
 *
 * The chain is the scanner's, step for step:
 *  1. `wavekit-iqcap run` (buildRunArgs, the service's ring, bound and capture bandwidth) takes the
 *     snapshot on stdin and writes one 48 kHz cf32 capture per channel and window, the channel
 *     shifted to DC by the tool's NCO (`offsetHz` = channel − snapshot centre).
 *  2. `wavekit-iqcap replay` (replayToolArgs, the shapes of probeReplayShapes) filters each capture
 *     to the decoder's channel: cf32 at 48 kHz for acarsdec, U8 at 105 kHz for dumpvdl2.
 *  3. The decoder runs with the replay transport's configuration (buildProbeConfig on
 *     createReplayTransport) and every line is judged by interpretRasterReplay.
 */
import { spawn } from "node:child_process"
import { buildRunArgs, realTimers } from "../iq-capture/process.js"
import { replayRateHz } from "../iq-capture/rates.js"
import { probeReplayShapes } from "../iq-capture/shapes.js"
import { captureBandwidthHz, replayOutputBytes } from "../iq-capture/service.js"
import { WaveKitError } from "../../utils/errors.js"
import {
	IQ_CAPTURE_BYTES_PER_SAMPLE,
	IQ_CAPTURE_MAX_MS,
	IQ_CAPTURE_PREROLL_MAX_MS,
	IQ_CAPTURE_RATE_HZ,
} from "./iq-capture-contract.js"
import { rasterChannelOf } from "./replay-channel.js"
import type { ScannerProtocol } from "./types.js"

export const SNAPSHOT_DECODERS = ["acarsdec", "dumpvdl2"] as const
export type SnapshotDecoder = (typeof SNAPSHOT_DECODERS)[number]

export const SNAPSHOT_PROTOCOL: Readonly<
	Record<SnapshotDecoder, ScannerProtocol>
> = Object.freeze({ acarsdec: "acars", dumpvdl2: "vdl2" })

/** Source rates `wavekit-iqcap run` accepts (dsp.rs MIN_SAMPLE_RATE, MAX_SAMPLE_RATE), inclusive. */
export const SNAPSHOT_MIN_RATE_HZ = 96_000
export const SNAPSHOT_MAX_RATE_HZ = 20_000_000

/**
 * The largest snapshot the API writes (IQ_SNAPSHOT_MAX_BYTES): 10 s × 2 400 000 samples/s × 2 B =
 * 48 000 000 B. A larger file is refused, so a plan has at most ceil(10 s / 4 s) = 3 windows at
 * 2.4 Msps (and never more than 48 000 000 / (2 × 96 000 × 4) = 62.5, i.e. 63, at the slowest rate).
 */
export const SNAPSHOT_MAX_BYTES = 10 * 2_400_000 * 2

/**
 * The shortest window decoded: 100 ms, the capture store's floor (IQ_CAPTURE_MIN_SAMPLES =
 * 48 000 / 10 samples at 48 kHz). A shorter tail is skipped and reported.
 */
export const SNAPSHOT_MIN_WINDOW_MS = 100

export interface SnapshotWindow {
	index: number
	/** First byte of the window in the file (whole CU8 samples, 2 B each). */
	startByte: number
	bytes: number
	samples: number
	/** The capture's `maxMs`: floor(samples × 1000 / rate), so the capture completes by its budget. */
	maxMs: number
}

export interface SnapshotChannel {
	channelHz: number
	/** Channel − snapshot centre: the capture command's `offsetHz`. */
	offsetHz: number
}

export interface SnapshotDecodePlan {
	decoder: SnapshotDecoder
	protocol: ScannerProtocol
	rateHz: number
	centreHz: number
	captureBandwidthHz: number
	/** Largest |offsetHz| the capture tool accepts: rate / 2 − capture bandwidth / 2 (inclusive). */
	maxOffsetHz: number
	windows: SnapshotWindow[]
	/** Bytes past the last whole window (a tail shorter than SNAPSHOT_MIN_WINDOW_MS). */
	skippedTailBytes: number
	channels: SnapshotChannel[]
	/** `wavekit-iqcap run` arguments (work directory paths supplied by the caller). */
	runArgs(outDir: string, anchor: string): string[]
	/** `wavekit-iqcap replay` arguments for one capture file. */
	replayArgs(capturePath: string): string[]
	/** The replay's output: its rate, format and exact byte count for a capture of `fileBytes`. */
	replayOutput(fileBytes: number): {
		rateHz: number
		format: "cf32" | "cu8"
		bytes: number
	}
}

export interface SnapshotDecodeInput {
	fileBytes: number
	rateHz: number
	centreHz: number
	channelsHz: readonly number[]
	decoder: SnapshotDecoder
}

function invalid(message: string): never {
	throw new WaveKitError(message, "SNAPSHOT_DECODE_INVALID")
}

/**
 * `wavekit-iqcap replay` arguments after `--in <file>` for a 48 kHz capture: the decoder's shape,
 * then `--out-rate` when the decoder's clock differs from 48 kHz (dumpvdl2 105 000) and
 * `--format cu8` for the U8 readers (dumpvdl2). The same flags the capture service passes
 * (service.ts doOpenReplay) for a 48 kHz capture.
 */
export function replayToolArgs(
	decoderType: SnapshotDecoder,
	shape: { bandwidthHz: number; transitionHz: number },
): string[] {
	const outRate = replayRateHz(decoderType, IQ_CAPTURE_RATE_HZ)
	return [
		"--bandwidth",
		String(shape.bandwidthHz),
		"--transition",
		String(shape.transitionHz),
		...(outRate !== IQ_CAPTURE_RATE_HZ ? ["--out-rate", String(outRate)] : []),
		...(decoderType === "dumpvdl2" ? ["--format", "cu8"] : []),
	]
}

/** Plans the decode, or throws SNAPSHOT_DECODE_INVALID naming the first violated bound. */
export function planSnapshotDecode(
	input: SnapshotDecodeInput,
): SnapshotDecodePlan {
	const { fileBytes, rateHz, centreHz, decoder } = input
	if (!SNAPSHOT_DECODERS.includes(decoder))
		invalid(`decoder must be one of ${SNAPSHOT_DECODERS.join(", ")}`)
	const protocol = SNAPSHOT_PROTOCOL[decoder]
	if (
		!Number.isSafeInteger(rateHz) ||
		rateHz < SNAPSHOT_MIN_RATE_HZ ||
		rateHz > SNAPSHOT_MAX_RATE_HZ
	)
		invalid(
			`rate must be a whole number of Hz in ${SNAPSHOT_MIN_RATE_HZ}..${SNAPSHOT_MAX_RATE_HZ}`,
		)
	if (!Number.isSafeInteger(centreHz) || centreHz <= 0)
		invalid("centre must be a positive whole number of Hz")
	if (!Number.isSafeInteger(fileBytes) || fileBytes <= 0 || fileBytes % 2 !== 0)
		invalid("the file must hold whole CU8 samples (an even, non-zero size)")
	if (fileBytes > SNAPSHOT_MAX_BYTES)
		invalid(`the file exceeds ${SNAPSHOT_MAX_BYTES} bytes (10 s at 2.4 Msps)`)

	const shapes = probeReplayShapes()
	const shape = shapes[decoder]
	if (!shape) invalid(`no replay shape for ${decoder}`)
	const bandwidthHz = captureBandwidthHz(shapes)
	const maxOffsetHz = rateHz / 2 - bandwidthHz / 2

	if (input.channelsHz.length === 0) invalid("give at least one channel")
	const seen = new Set<number>()
	const channels: SnapshotChannel[] = []
	for (const channelHz of input.channelsHz) {
		if (!Number.isSafeInteger(channelHz) || channelHz <= 0)
			invalid("every channel must be a positive whole number of Hz")
		if (seen.has(channelHz)) invalid(`channel ${channelHz} is given twice`)
		seen.add(channelHz)
		// The decode is attributed at a raster channel (replayChannelHz): offline input must be one.
		if (rasterChannelOf(protocol, channelHz) !== channelHz)
			invalid(
				`channel ${channelHz} is not a 25 kHz ${protocol.toUpperCase()} channel in 117.975-137 MHz`,
			)
		const offsetHz = channelHz - centreHz
		if (Math.abs(offsetHz) > maxOffsetHz)
			invalid(
				`channel ${channelHz} is ${offsetHz} Hz from the centre; the capture reaches ±${maxOffsetHz} Hz at ${rateHz} S/s`,
			)
		channels.push({ channelHz, offsetHz })
	}

	// One capture holds at most IQ_CAPTURE_MAX_MS: rate × 4 samples (rate is a whole number).
	const totalSamples = fileBytes / 2
	const perWindow = (rateHz * IQ_CAPTURE_MAX_MS) / 1000
	const minSamples = Math.ceil((rateHz * SNAPSHOT_MIN_WINDOW_MS) / 1000)
	const windows: SnapshotWindow[] = []
	let skippedTailBytes = 0
	for (let start = 0, index = 0; start < totalSamples; start += perWindow) {
		const samples = Math.min(perWindow, totalSamples - start)
		if (samples < minSamples) {
			skippedTailBytes = samples * 2
			break
		}
		windows.push({
			index: index++,
			startByte: start * 2,
			bytes: samples * 2,
			samples,
			maxMs: Math.floor((samples * 1000) / rateHz),
		})
	}
	if (windows.length === 0)
		invalid(
			`the file is shorter than ${SNAPSHOT_MIN_WINDOW_MS} ms at ${rateHz} S/s`,
		)

	const replayFlags = replayToolArgs(decoder, shape)
	const outRateHz = replayRateHz(decoder, IQ_CAPTURE_RATE_HZ)
	return {
		decoder,
		protocol,
		rateHz,
		centreHz,
		captureBandwidthHz: bandwidthHz,
		maxOffsetHz,
		windows,
		skippedTailBytes,
		channels,
		runArgs: (outDir, anchor) =>
			// buildRunArgs reads only the argument fields; spawn, env and timers are never used.
			buildRunArgs({
				binaryPath: "",
				spawn,
				env: {},
				timers: realTimers,
				sampleRateHz: rateHz,
				ringMs: IQ_CAPTURE_PREROLL_MAX_MS,
				outDir,
				maxMs: IQ_CAPTURE_MAX_MS,
				bandwidthHz,
				anchor,
			}),
		replayArgs: capturePath => ["replay", "--in", capturePath, ...replayFlags],
		replayOutput: captureBytes => {
			if (captureBytes % IQ_CAPTURE_BYTES_PER_SAMPLE !== 0)
				invalid("a capture file must hold whole cf32 samples")
			const cf32 = replayOutputBytes(
				captureBytes,
				IQ_CAPTURE_RATE_HZ,
				outRateHz,
			)
			// U8 has 2 bytes per complex sample instead of cf32's 8.
			return decoder === "dumpvdl2"
				? { rateHz: outRateHz, format: "cu8", bytes: cf32 / 4 }
				: { rateHz: outRateHz, format: "cf32", bytes: cf32 }
		},
	}
}
