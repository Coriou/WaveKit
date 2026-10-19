/**
 * Analog replay trial runner (scanner redesign req 5.3, 5.4).
 *
 * `IqCaptureService.openAnalyze` spawns `wavekit-iqcap analyze`. This module
 * does not spawn: it reads that child's 8 kHz s16le audio and its one event,
 * runs a fresh `ToneDetector` in slices of at most 4 096 samples with a
 * `setImmediate` between slices, and classifies. A missing `openAnalyze` is
 * `unavailable`. A null open is `capture-gone`. Abort kills the child and
 * ends `cancelled`. Anything malformed or thrown fails closed (`analyze-failed`
 * or `no-sync`): never `decoded` or `heard`. The child is killed on every
 * return, including success (the service's kill is a no-op once the child
 * has exited).
 *
 * AM quieting compares `carrierDb` with `floorDb`. The design names "the
 * capture's floor" and does not name the estimator. `floorDb` is the 10th
 * percentile of the frame `carrierDb` values (linear interpolation, rank
 * `0.1 * (n - 1)`). An empty capture uses 0, which cannot by itself pass
 * the AM carrier test. NFM does not read `floorDb`; it is still finite so a
 * later schema check can keep the result.
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
import { parseAnalyzeEvent } from "./protocol.js"

/** One turn of the tone pass. Req 5.3 and the hot-path budget. */
const SLICE_SAMPLES = 4_096
const SLICE_BYTES = SLICE_SAMPLES * 2
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
 * 10th percentile of finite `carrierDb`. Rank `0.1 * (n - 1)` with linear
 * interpolation. No finite carrier → 0.
 */
export function captureFloorDb(frames: readonly AnalogTrialFrame[]): number {
	const values: number[] = []
	for (const frame of frames) {
		const db = frame?.carrierDb
		if (typeof db === "number" && Number.isFinite(db)) values.push(db)
	}
	if (values.length === 0) return 0
	values.sort((a, b) => a - b)
	const rank = 0.1 * (values.length - 1)
	const lo = Math.floor(rank)
	const hi = Math.ceil(rank)
	const left = values[lo] ?? 0
	const right = values[hi] ?? left
	const floor = left + (right - left) * (rank - lo)
	return Number.isFinite(floor) ? floor : 0
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
			setImmediate(step)
		}

		const step = (): void => {
			scheduled = false
			if (settled) return
			if (signal.aborted) {
				finish(false)
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
