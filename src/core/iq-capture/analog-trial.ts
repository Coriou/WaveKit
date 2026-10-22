/**
 * Analog replay trial runner (scanner redesign req 5.3, 5.4).
 *
 * `IqCaptureService.openAnalyze` spawns `wavekit-iqcap analyze`. This module
 * does not spawn: it reads that child's 8 kHz s16le audio and its one event,
 * runs a fresh `ToneDetector` in slices of {@link ANALOG_TONE_SLICE_SAMPLES}
 * samples. One shared queue runs a single slice per turn (`setImmediate`),
 * so concurrent trials interleave instead of stacking their slices on one
 * event-loop turn. A missing `openAnalyze` is `unavailable`. A null open is
 * `capture-gone`. Abort kills the child and ends `cancelled`. Anything
 * malformed or thrown fails closed (`analyze-failed` or `no-sync`): never
 * `decoded` or `heard`. The child is killed on every return, including
 * success (the service's kill is a no-op once the child has exited).
 *
 * An odd s16le length is an incomplete sample. Audio must be exactly
 * `frames * 400 + ceil(gapSamples / 6)` samples, the length `analyze`
 * writes. Anything else is `analyze-failed`.
 *
 * AM quieting compares `carrierDb` with `floorDb`. The floor is not a
 * percentile of this capture's carrier: on a continuous transmission that
 * percentile is the signal, and the signal is never 6 dB above itself.
 * `hfNoiseDb` is discriminator power against full-scale noise and does not
 * move when the capture is scaled. The noise power in dBFS is
 * `carrierDb + hfNoiseDb`. See `captureFloorDb`.
 */
import { setImmediate } from "node:timers"
import type { Readable } from "node:stream"
import {
	DCS_BIT_RATE_BPS,
	DCS_MIN_AUDIO_SECONDS,
	DCS_MIN_WORDS,
	DCS_STANDARD_CODES,
	type AnalogTransmissionDcs,
} from "@wavekit/api-types"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import {
	AUDIO_TONE_RATE_HZ,
	type ToneDetector,
} from "../audio-tones/tone-detector.js"
import { isCtcssToneHz } from "../audio-tones/ctcss.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { IqCapturePort } from "../scanner/iq-capture-contract.js"
import type {
	AnalogTrialFrame,
	AnalogTrialMode,
	AnalogTrialOutcome,
	AnalogTrialResult,
	AnalogTrialRunner,
	AnalogTrialStats,
	AnalogTrialTones,
	AnalyzeEvent,
} from "../scanner/scanner-redesign-contract.js"
import { classifyAnalogTrial, isVoice } from "../scanner/analog-trial.js"
import { analyzeAudioMatchesFrames, parseAnalyzeEvent } from "./protocol.js"

/**
 * One turn of the tone pass. A 4 096-sample push measured about 2 ms, and a
 * burst of six of those on one event-loop turn was ~13.5 ms. 512 samples is
 * about an eighth of that push. The shared queue runs one slice per turn.
 * Measured cost: analyze 14-22 ms CPU per 4 s capture, tone pass 21-33 ms,
 * burst-of-6 event-loop p99 about 2 ms.
 */
export const ANALOG_TONE_SLICE_SAMPLES = 512
const SLICE_BYTES = ANALOG_TONE_SLICE_SAMPLES * 2
/** One DCS word is 23 bits. Three words is the WG6 confirmation. */
const DCS_WORD_BITS = 23

const DCS_CODES: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)

/**
 * CTCSS and DCS both need the WG2/WG6 audio minimum. DCS also needs
 * `DCS_MIN_WORDS` words; the detector withholds a code until then, and this
 * gate still requires enough audio to have held that many words.
 */
const MIN_DCS_SECONDS = Math.max(
	DCS_MIN_AUDIO_SECONDS,
	(DCS_WORD_BITS * DCS_MIN_WORDS) / DCS_BIT_RATE_BPS,
)

export interface AnalogTrialRunnerDeps {
	port: IqCapturePort
	tones: () => ToneDetector
	logger: Logger
}

interface AnalyzeHandle {
	audio: Readable
	event: Promise<unknown>
	kill: () => void
}

interface ToneFeed {
	samples: number
	failed: boolean
}

export function createAnalogTrialRunner(
	deps: AnalogTrialRunnerDeps,
): AnalogTrialRunner {
	const log = createComponentLogger(deps.logger, "AnalogTrial")
	return {
		run(captureId, mode, signal) {
			return runTrial(deps, log, captureId, mode, signal)
		},
	}
}

async function runTrial(
	deps: AnalogTrialRunnerDeps,
	log: Logger,
	captureId: unknown,
	mode: unknown,
	signal: unknown,
): Promise<AnalogTrialResult> {
	const trialMode = mode === "am" ? "am" : "nfm"
	if (mode !== "nfm" && mode !== "am")
		return failed(trialMode, "analyze-failed")
	if (typeof captureId !== "string" || captureId.length === 0)
		return failed(trialMode, "capture-gone")
	if (!isAbortSignal(signal)) return failed(trialMode, "cancelled")
	if (signal.aborted) return failed(trialMode, "cancelled")
	const open = deps.port.openAnalyze
	if (typeof open !== "function") return failed(trialMode, "unavailable")

	let opened: unknown
	try {
		opened = open.call(deps.port, captureId, mode)
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial analyze could not start")
		return failed(trialMode, "analyze-failed")
	}
	if (opened == null) return failed(trialMode, "capture-gone")
	const handle = adopt(opened)
	if (handle === null) {
		releaseUnknown(opened, log)
		return failed(trialMode, "analyze-failed")
	}

	let released = false
	const release = (): void => {
		if (released) return
		released = true
		releaseHandle(handle, log)
	}
	const aborted = whenAborted(signal)
	try {
		if (signal.aborted) return failed(trialMode, "cancelled")
		let detector: ToneDetector
		try {
			detector = deps.tones()
		} catch (err: unknown) {
			logFailure(log, err, "Analog trial tone pass failed")
			return failed(trialMode, "analyze-failed")
		}
		if (!isDetector(detector)) return failed(trialMode, "analyze-failed")
		const feed = feedAudio(handle.audio, detector, signal)
		const event = handle.event.then(
			(value: unknown) => ({ ok: true as const, value }),
			(err: unknown) => ({ ok: false as const, err }),
		)
		// A failed audio stream must not wait on an event that never arrives:
		// the child is released in `finally`.
		const audioFailed = feed.then(audio =>
			audio.failed ? { kind: "audio-failed" as const } : null,
		)
		const raced = await Promise.race([
			Promise.all([feed, event]).then(([audio, ev]) => ({
				kind: "done" as const,
				audio,
				ev,
			})),
			audioFailed.then(failedAudio =>
				failedAudio === null ? new Promise<never>(() => {}) : failedAudio,
			),
			aborted.promise.then(() => ({ kind: "aborted" as const })),
		])
		if (raced.kind === "aborted" || signal.aborted)
			return failed(trialMode, "cancelled")
		if (raced.kind === "audio-failed")
			return failed(trialMode, "analyze-failed")
		if (raced.audio.failed || !raced.ev.ok) {
			if (!raced.ev.ok)
				logFailure(log, raced.ev.err, "Analog trial analyze failed")
			return failed(trialMode, "analyze-failed")
		}
		return decide(trialMode, raced.ev.value, raced.audio.samples, detector, log)
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial analyze failed")
		if (isAbortSignal(signal) && signal.aborted)
			return failed(trialMode, "cancelled")
		return failed(trialMode, "analyze-failed")
	} finally {
		aborted.stop()
		release()
	}
}

/**
 * A parsed analysis is classified. Anything that is not one valid event
 * line, including an `error` event, is `analyze-failed` and carries no tone
 * and no stats, so a bad frame cannot become `decoded` or `heard`.
 */
function decide(
	mode: AnalogTrialMode,
	raw: unknown,
	samples: number,
	detector: ToneDetector,
	log: Logger,
): AnalogTrialResult {
	let tones: AnalogTrialTones
	try {
		tones = qualifyTones(detector, samples)
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial tone pass failed")
		return failed(mode, "analyze-failed")
	}
	const parsed = parseEvent(raw)
	if (parsed === null || parsed.event === "error")
		return failed(mode, "analyze-failed")
	if (
		!analyzeAudioMatchesFrames(samples, parsed.frames.length, parsed.gapSamples)
	)
		return failed(mode, "analyze-failed")
	const stats: AnalogTrialStats = {
		mode,
		frames: parsed.frames,
		gapSamples: parsed.gapSamples,
		floorDb: captureFloorDb(parsed.frames),
	}
	let outcome: AnalogTrialOutcome
	let voice = false
	try {
		outcome = classifyAnalogTrial(stats, tones)
		voice = outcome === "no-sync" ? false : isVoice(stats)
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial analyze failed")
		return failed(mode, "analyze-failed")
	}
	if (outcome !== "decoded" && outcome !== "heard") {
		return {
			outcome,
			mode,
			voice,
			tones,
			stats,
		}
	}
	// The classifier already applied the rules. Refuse a positive outcome
	// whose tones or stats would not survive the replay schema.
	if (outcome === "decoded" && tones.ctcssHz === null && tones.dcs === null)
		return failed(mode, "analyze-failed")
	return { outcome, mode, voice, tones, stats }
}

function qualifyTones(
	detector: ToneDetector,
	samples: number,
): AnalogTrialTones {
	const seconds =
		Number.isFinite(samples) && samples > 0 ? samples / AUDIO_TONE_RATE_HZ : 0
	const audioSeconds = Number.isFinite(seconds) ? seconds : 0
	const raw = detector.result()
	if (audioSeconds < DCS_MIN_AUDIO_SECONDS)
		return { ctcssHz: null, dcs: null, audioSeconds }
	const hz = raw.ctcssHz
	const ctcssHz =
		typeof hz === "number" && Number.isFinite(hz) && isCtcssToneHz(hz)
			? hz
			: null
	const dcs = audioSeconds >= MIN_DCS_SECONDS ? copyDcs(raw.dcs) : null
	return { ctcssHz, dcs, audioSeconds }
}

function copyDcs(dcs: unknown): AnalogTransmissionDcs | null {
	if (dcs === null || typeof dcs !== "object") return null
	const rec = dcs as { code?: unknown; polarity?: unknown }
	if (typeof rec.code !== "string" || !DCS_CODES.has(rec.code)) return null
	if (rec.polarity !== "normal" && rec.polarity !== "inverted") return null
	return { code: rec.code, polarity: rec.polarity }
}

/**
 * Carrier dBFS of complex Gaussian noise with σ = 1.
 *
 * `block_power_dbfs` is `10 log10(mean(I² + Q²))`, and `|z| = 1` is 0 dBFS.
 * That noise has mean power `E[I² + Q²] = 2`, so its carrier sits at
 * `10 log10(2)` dBFS. It is the level of the σ = 1 calibration stream, not
 * an anchor for {@link captureFloorDb}: `hfNoiseDb` stays near 0 at every
 * amplitude, so a fixed anchor does not follow a quieter capture.
 */
export const RECEIVER_NOISE_CARRIER_DBFS = 10 * Math.log10(2)

/**
 * AM noise floor in dBFS. `hfNoiseDb` is `10 log10(hfPower / fullNoise)` and
 * is about 0 when the discriminator is full noise, at every input level.
 * Adding it to `carrierDb` is the noise power under that frame: pure noise
 * has `floorDb ≈ carrierDb` and does not clear `floorDb + 6`; a quieted AM
 * carrier sits above the floor by its quieting. Scaling the capture shifts
 * every `carrierDb` by the same amount and leaves `hfNoiseDb` put, so the
 * comparison does not change. No finite pair yields 0. NFM does not read
 * `floorDb`. The analyze event is unchanged: both numbers are already on
 * each frame.
 */
export function captureFloorDb(frames: readonly AnalogTrialFrame[]): number {
	const values: number[] = []
	for (const frame of frames) {
		const carrier = frame?.carrierDb
		const hf = frame?.hfNoiseDb
		if (typeof carrier !== "number" || !Number.isFinite(carrier)) continue
		if (typeof hf !== "number" || !Number.isFinite(hf)) continue
		const power = carrier + hf
		if (Number.isFinite(power)) values.push(power)
	}
	const mid = medianOf(values)
	if (mid === null) return 0
	return Number.isFinite(mid) ? mid : 0
}

function medianOf(values: number[]): number | null {
	if (values.length === 0) return null
	values.sort((a, b) => a - b)
	const mid = values.length >> 1
	if (values.length % 2 === 1) return values[mid] ?? null
	const left = values[mid - 1]
	const right = values[mid]
	if (left === undefined || right === undefined) return null
	const mean = (left + right) / 2
	return Number.isFinite(mean) ? mean : null
}

function parseEvent(raw: unknown): AnalyzeEvent | null {
	let line: string
	try {
		if (raw === null || typeof raw !== "object") return null
		line = JSON.stringify(raw)
	} catch {
		return null
	}
	if (typeof line !== "string" || line.length === 0) return null
	try {
		return parseAnalyzeEvent(line)
	} catch {
		return null
	}
}

/**
 * One slice from every in-flight tone pass, then yield. Concurrent passes
 * share the queue, so six trials do not run six slices before the event
 * loop can turn.
 */
const sliceJobs: Array<() => void> = []
let slicePumpScheduled = false

function enqueueSlice(job: () => void): void {
	sliceJobs.push(job)
	if (slicePumpScheduled) return
	slicePumpScheduled = true
	setImmediate(runSlice)
}

function runSlice(): void {
	slicePumpScheduled = false
	const job = sliceJobs.shift()
	if (!job) return
	job()
	if (sliceJobs.length > 0 && !slicePumpScheduled) {
		slicePumpScheduled = true
		setImmediate(runSlice)
	}
}

function feedAudio(
	audio: Readable,
	detector: ToneDetector,
	signal: AbortSignal,
): Promise<ToneFeed> {
	return new Promise(resolve => {
		let settled = false
		let samples = 0
		let pending = Buffer.alloc(0)
		let ended = false
		let scheduled = false

		const finish = (failed: boolean): void => {
			if (settled) return
			settled = true
			audio.removeListener("data", onData)
			audio.removeListener("end", onEnd)
			audio.removeListener("error", onError)
			audio.removeListener("close", onClose)
			resolve({ samples, failed })
		}

		const schedule = (): void => {
			if (scheduled || settled) return
			scheduled = true
			enqueueSlice(step)
		}

		const step = (): void => {
			scheduled = false
			if (settled) return
			if (signal.aborted) {
				finish(false)
				return
			}
			// A finished stream with a leftover byte is not a whole sample.
			if (ended && pending.length % 2 !== 0 && pending.length < 2) {
				finish(true)
				return
			}
			const even = pending.length - (pending.length % 2)
			if (even >= SLICE_BYTES || (ended && even >= 2)) {
				const n = Math.min(SLICE_BYTES, even)
				const slice = Buffer.from(pending.subarray(0, n))
				pending = Buffer.from(pending.subarray(n))
				try {
					detector.push(slice, {
						rate: AUDIO_TONE_RATE_HZ,
						format: "s16le",
					})
				} catch {
					finish(true)
					return
				}
				samples += n / 2
				schedule()
				return
			}
			if (ended && pending.length % 2 !== 0) {
				finish(true)
				return
			}
			if (ended) {
				finish(false)
				return
			}
			if (typeof audio.resume === "function") audio.resume()
		}

		const onData = (chunk: unknown): void => {
			if (settled) return
			const buf = asBuffer(chunk)
			if (buf === null) {
				finish(true)
				return
			}
			pending =
				pending.length === 0 ? Buffer.from(buf) : Buffer.concat([pending, buf])
			if (typeof audio.pause === "function") audio.pause()
			schedule()
		}
		const onEnd = (): void => {
			ended = true
			schedule()
		}
		const onError = (): void => {
			finish(true)
		}
		const onClose = (): void => {
			ended = true
			schedule()
		}

		audio.on("data", onData)
		audio.on("end", onEnd)
		audio.on("error", onError)
		audio.on("close", onClose)
		if (audio.readableEnded === true) ended = true
		if (typeof audio.resume === "function") audio.resume()
		if (ended) schedule()
	})
}

function asBuffer(chunk: unknown): Buffer | null {
	if (Buffer.isBuffer(chunk)) return chunk
	if (chunk instanceof Uint8Array) return Buffer.from(chunk)
	return null
}

function adopt(opened: unknown): AnalyzeHandle | null {
	if (opened === null || typeof opened !== "object") return null
	const rec = opened as {
		audio?: unknown
		event?: unknown
		kill?: unknown
	}
	if (!isReadable(rec.audio)) return null
	if (rec.event === null || typeof rec.event !== "object") return null
	const then = (rec.event as { then?: unknown }).then
	if (typeof then !== "function") return null
	if (typeof rec.kill !== "function") return null
	return {
		audio: rec.audio,
		event: rec.event as Promise<unknown>,
		kill: rec.kill as () => void,
	}
}

function isReadable(value: unknown): value is Readable {
	if (value === null || typeof value !== "object") return false
	const rec = value as { on?: unknown; resume?: unknown }
	return typeof rec.on === "function"
}

function isDetector(value: unknown): value is ToneDetector {
	if (value === null || typeof value !== "object") return false
	const rec = value as { push?: unknown; result?: unknown }
	return typeof rec.push === "function" && typeof rec.result === "function"
}

function isAbortSignal(value: unknown): value is AbortSignal {
	if (value === null || typeof value !== "object") return false
	const rec = value as {
		aborted?: unknown
		addEventListener?: unknown
		removeEventListener?: unknown
	}
	return (
		typeof rec.aborted === "boolean" &&
		typeof rec.addEventListener === "function" &&
		typeof rec.removeEventListener === "function"
	)
}

function whenAborted(signal: AbortSignal): {
	promise: Promise<void>
	stop: () => void
} {
	let stop = (): void => {}
	const promise = new Promise<void>(resolve => {
		if (signal.aborted) {
			resolve()
			return
		}
		const onAbort = (): void => resolve()
		signal.addEventListener("abort", onAbort, { once: true })
		stop = () => signal.removeEventListener("abort", onAbort)
	})
	return { promise, stop }
}

function releaseHandle(handle: AnalyzeHandle, log: Logger): void {
	try {
		handle.audio.on("error", () => {})
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial release failed")
	}
	try {
		handle.kill()
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial release failed")
	}
	try {
		if (typeof handle.audio.destroy === "function") handle.audio.destroy()
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial release failed")
	}
}

function releaseUnknown(opened: unknown, log: Logger): void {
	if (opened === null || typeof opened !== "object") return
	const kill = (opened as { kill?: unknown }).kill
	if (typeof kill !== "function") return
	try {
		kill.call(opened)
	} catch (err: unknown) {
		logFailure(log, err, "Analog trial release failed")
	}
}

function failed(
	mode: AnalogTrialMode,
	error: NonNullable<AnalogTrialResult["error"]>,
): AnalogTrialResult {
	return {
		outcome: "no-sync",
		mode,
		voice: false,
		tones: { ctcssHz: null, dcs: null, audioSeconds: 0 },
		stats: null,
		error,
	}
}

function logFailure(log: Logger, err: unknown, message: string): void {
	try {
		log.warn({ err: safeErrorFields(err) }, message)
	} catch {
		// A broken logger must not reject a trial that has already failed closed.
	}
}
