/**
 * Squelch-delimited analog transmissions of the live demodulator (WG1).
 *
 * One open event and one closed event share a transmission id. The frequency
 * is sampled when the transmission opens and is never rewritten. Activity
 * storage is a separate sink on the "closed" payload; this module does not
 * touch the store.
 *
 * Activity hygiene (WG10). A weak far signal or noise flapping across the squelch used
 * to become one transmission per crossing. Three rules now shape what is published
 * (the "transmission" and "closed" events, so WS, Activity and identify's analog
 * evidence all see the same stream). Live audio gating is untouched.
 *  1. Merge: a squelch close only ends a segment. The audio end is `endMs = max(segment
 *     start, close - hang)`; a re-open at `t` with `t - endMs <= ANALOG_TRANSMISSION_MERGE_GAP_MS`
 *     on the same source, config identity and frequency continues the transmission (same
 *     id, start, power and tone state). Otherwise, or at `endMs + gap` (a timer, also
 *     checked on level samples), the transmission is final with `endedAt = endMs`.
 *     Stop, config, retune and max-duration closes are final at once, never merged.
 *     Tone split (R2): a resumed segment runs its own tone detector next to the
 *     transmission's; once it confirms a CTCSS tone or DCS code and the transmission's tone
 *     at the last segment end (snapshot) confirmed a different one, the held part is final
 *     at its gap end with the snapshot tone and the segment becomes a new transmission
 *     starting at its own start. An untoned or unconfirmed segment still merges (fades).
 *  2. Minimum duration: a final transmission whose summed segment audio (each segment's
 *     audio end − start, gaps excluded) is under ANALOG_TRANSMISSION_MIN_MS is suppressed
 *     (`suppressed().short`). A max-duration continuation is exempt.
 *  3. Carrier evidence: when the source reports `carrierBlocks()` (nfm/wfm in every squelch
 *     mode), one segment of the transmission needs at least ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS
 *     blocks with FM quieting (blocks of different segments never add up), else it is
 *     suppressed (`suppressed().noCarrier`). A null count at the first open (am, ssb, ...) or
 *     a failing source skips the rule; a null count later keeps the last known base.
 * The open event is held back until the transmission qualifies: on a level sample once the
 * summed audio including `now - hang - segment start` reaches ANALOG_TRANSMISSION_MIN_MS (so
 * the final audio is at least the minimum) and the carrier rule holds, or at finalisation.
 * An announced transmission is always published closed; a suppressed one emits nothing.
 */
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import {
	DCS_CODE_SET,
	DCS_MIN_AUDIO_SECONDS,
	DCS_STANDARD_CODES,
	LIVE_AUDIO_NOISE_QUIETING_DB,
} from "@wavekit/api-types"
import type {
	AnalogTransmissionCloseReason,
	AnalogTransmissionDcs,
	AnalogTransmissionEventData,
	AnalogTransmissionFrequency,
	AnalogTransmissionPayload,
	AnalogTransmissionTone,
	TunerState,
} from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"
import { ToneDetector } from "./audio-tones/tone-detector.js"
import { tuningTrustOf } from "./tuning-trust.js"
import type { TonePcmFormat } from "./audio-tones/tone-detector.js"
import {
	liveDemodSquelchGates,
	liveDemodTransmissionConfigChanged,
} from "./live-demod-activity.js"
import type { TransmissionConfigIdentity } from "./live-demod-activity.js"
import type {
	LiveAudioLevel,
	LiveDemodConfig,
	LiveDemodStatus,
	LiveDemodulator,
} from "./live-demodulator.js"

const DEFAULT_MAX_DURATION_MS = 600_000

/** WG10 activity hygiene: a re-open within this gap after the audio end continues the transmission. */
export const ANALOG_TRANSMISSION_MERGE_GAP_MS = 1500
/** WG10 activity hygiene: shorter final transmissions are not published. */
export const ANALOG_TRANSMISSION_MIN_MS = 500
/** WG10 activity hygiene: 10 ms blocks with FM quieting a nfm/wfm transmission needs. */
export const ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS = 3

/** WG10 req 3.8: consecutive open carried blocks that start a carrier span. */
export const ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS = 10
/** WG10 req 3.8: blocks the carrier block log keeps (20.48 s at 10 ms). */
export const CARRIER_LOG_CAPACITY = 2048
/** WG10 req 3.8: PCM the tracker holds until its blocks are decided. */
export const CARRIER_PCM_RING_MS = 2000
export const CARRIER_FLAG_OPEN = 1
export const CARRIER_FLAG_CARRIED = 2

/**
 * WG10 req 3.8.1: one record per measured squelch block of a pipeline run (squelch open,
 * carried), plus the run's PCM byte count, so the tracker consumes carrier evidence in block
 * order and matches PCM by output-sample position. Block `k` covers output samples
 * `[k × blockSamples, (k + 1) × blockSamples)`. Allocation-free after construction.
 */
export class CarrierBlockLog {
	readonly flags = new Uint8Array(CARRIER_LOG_CAPACITY)
	/** Increments when the run changes. */
	epoch = 0
	/** Blocks noted in this epoch. */
	blocks = 0
	/** PCM bytes noted in this epoch. */
	pcmBytes = 0
	blockSamples = 1
	blockMs = 10
	/** Called after every noted block (the tracker consumes it at once). */
	onBlock: (() => void) | null = null
	private owner: object | null = null

	note(run: object, rate: number, open: boolean, carried: boolean): void {
		this.sync(run, rate)
		this.flags[this.blocks % CARRIER_LOG_CAPACITY] =
			(open ? CARRIER_FLAG_OPEN : 0) | (carried ? CARRIER_FLAG_CARRIED : 0)
		this.blocks += 1
		const listener = this.onBlock
		if (listener === null) return
		try {
			listener()
		} catch {
			// The tracker never throws into the demodulator.
		}
	}

	notePcm(run: object, rate: number, bytes: number): void {
		this.sync(run, rate)
		this.pcmBytes += bytes
	}

	private sync(run: object, rate: number): void {
		if (run === this.owner) return
		this.owner = run
		this.epoch += 1
		this.blocks = 0
		this.pcmBytes = 0
		const r = Number.isFinite(rate) && rate > 0 ? rate : 1
		// Same rounding as ChannelSquelch (10 ms blocks).
		this.blockSamples = Math.max(1, Math.round((r * 10) / 1000))
		this.blockMs = (this.blockSamples / r) * 1000
	}
}

const FEED = 1
const DROP = 2

/** Hygiene knobs (tests; production uses the constants). */
export interface AnalogTransmissionHygiene {
	mergeGapMs: number
	minDurationMs: number
	minCarrierBlocks: number
}

export const ANALOG_TRANSMISSION_HYGIENE: Readonly<AnalogTransmissionHygiene> =
	Object.freeze({
		mergeGapMs: ANALOG_TRANSMISSION_MERGE_GAP_MS,
		minDurationMs: ANALOG_TRANSMISSION_MIN_MS,
		minCarrierBlocks: ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS,
	})

/** Transmissions the hygiene rules kept out of every output since construction. */
export interface AnalogTransmissionSuppressed {
	short: number
	noCarrier: number
}

export interface AnalogTransmissionSource {
	getStatus(): LiveDemodStatus
	isSquelchOpen(): boolean
	squelchHangMs(): number
	/**
	 * Set by LiveDemodulator while stop() or a transmission-closing
	 * reconfigure() emits squelch-changed(false) ahead of stopped/config-changed.
	 */
	transmissionCloseOverride?(): "stopped" | "config" | null
	/**
	 * WG10 activity hygiene: monotonic count of blocks with FM carrier evidence, or null
	 * when the pipeline has none (absent: the carrier rule is skipped).
	 */
	carrierBlocks?(): number | null
	/** WG10 req 3.8: the per-block carrier log, null exactly when `carrierBlocks()` is null. */
	carrierBlockLog?(): CarrierBlockLog | null
	on(event: "squelch-changed", listener: (open: boolean) => void): unknown
	on(event: "level", listener: (level: LiveAudioLevel) => void): unknown
	on(
		event: "config-changed",
		listener: (config: LiveDemodConfig) => void,
	): unknown
	on(event: "started", listener: () => void): unknown
	on(event: "stopped", listener: () => void): unknown
	off(event: "squelch-changed", listener: (open: boolean) => void): unknown
	off(event: "level", listener: (level: LiveAudioLevel) => void): unknown
	off(
		event: "config-changed",
		listener: (config: LiveDemodConfig) => void,
	): unknown
	off(event: "started", listener: () => void): unknown
	off(event: "stopped", listener: () => void): unknown
	on(
		event: "pcm",
		listener: (chunk: Buffer, format: TonePcmFormat) => void,
	): unknown
	off(
		event: "pcm",
		listener: (chunk: Buffer, format: TonePcmFormat) => void,
	): unknown
}

export interface AnalogTransmissionTrackerOptions {
	source: AnalogTransmissionSource
	/** Event-time frequency (tuned centre + offsetHz). Main wires the tuner. */
	frequencyAt: (
		sourceId: string,
		offsetHz: number,
	) => AnalogTransmissionFrequency | null
	now?: () => number
	randomUUID?: () => string
	/** Default 10 minutes. Checked on level samples. */
	maxDurationMs?: number
	/**
	 * One detector per open transmission. Tests inject a double; production
	 * uses {@link ToneDetector}.
	 */
	createToneDetector?: () => ToneDetectorPort
	/** WG10 activity hygiene; default {@link ANALOG_TRANSMISSION_HYGIENE}. */
	hygiene?: Partial<AnalogTransmissionHygiene>
	/** Merge-gap timer (tests inject); default an unref'd setTimeout. Returns a cancel. */
	setTimer?: (fn: () => void, ms: number) => () => void
	/** Called once per suppressed transmission (Main logs it at debug). */
	onSuppressed?: (
		reason: keyof AnalogTransmissionSuppressed,
		event: AnalogTransmissionEventData,
	) => void
}

/** The slice of {@link ToneDetector} the tracker drives. */
export interface ToneDetectorPort {
	push(pcm: Buffer, format: TonePcmFormat): void
	result(): AnalogTransmissionTone
	reset(): void
}

export interface AnalogTransmissionTrackerEvents {
	transmission: [event: AnalogTransmissionEventData]
	closed: [payload: AnalogTransmissionPayload]
}

interface OpenTransmission {
	transmissionId: string
	sourceId: string
	startedAtMs: number
	startedAt: string
	frequency: AnalogTransmissionFrequency | null
	modulation: AnalogTransmissionEventData["modulation"]
	bandwidthHz: number
	squelchMode: "manual" | "auto" | "noise"
	/** WG7 req 2.4: the quieting threshold in effect (noise mode only). */
	noiseQuietingDb: number | undefined
	thresholdDbfs: number
	config: TransmissionConfigIdentity
	peak: number | null
	powerSum: number
	powerCount: number
	detector: ToneDetectorPort
	/** Whole PCM samples fed while open, in seconds. */
	audioSeconds: number
	/** Trailing bytes that do not yet form a sample. */
	audioRemainder: number
	/** WG10 hygiene: a squelch segment is open (false in the merge gap). */
	segmentOpen: boolean
	segmentStartMs: number
	/** Audio end of the last closed segment (valid in the merge gap). */
	gapEndMs: number
	/** The open event was published. */
	announced: boolean
	/** Most carrier blocks of one closed segment (segments never add up). */
	bestSegmentCarrier: number
	/** Summed audio of closed segments (audio end − segment start), ms. */
	audioMs: number
	/** A max-duration continuation: exempt from the minimum duration. */
	continuation: boolean
	/** Tone at the last segment end (null tone when none was confirmed). */
	segmentEndTone: AnalogTransmissionTone | null
	/** A resumed segment that may still split off on a different confirmed tone. */
	split: SegmentSplit | null
	/** Last known source count (the open segment's base); null when the rule does not apply. */
	carrierBase: number | null
	/** The carrier rule applies (the source reported a count at the first open). */
	carrierRequired: boolean
	cancelTimer: (() => void) | null
	/** WG10 req 3.8: delimited by carrier spans (block log path). */
	carrierSpans: boolean
	/** Carrier end of the open span (block time), ms. */
	spanEndMs: number
	/** First block whose PCM this transmission's detector takes. */
	feedFromBlock: number
}

/** The held part of a transmission while a resumed segment may split off (WG10 R2). */
interface SegmentSplit {
	/** The transmission's tone at the last segment end: the held part's tone on a split. */
	heldTone: AnalogTransmissionTone
	heldGapEndMs: number
	heldAudioMs: number
	heldBestSegmentCarrier: number
	heldPeak: number | null
	heldPowerSum: number
	heldPowerCount: number
	/** This segment only. */
	detector: ToneDetectorPort
	audioSeconds: number
	audioRemainder: number
	peak: number | null
	powerSum: number
	powerCount: number
	/** First block whose PCM the segment detector takes (carrier path). */
	feedFromBlock: number
}

type AssertExtends<T extends U, U> = T
type _LiveDemodulatorIsAnalogSource = AssertExtends<
	LiveDemodulator,
	AnalogTransmissionSource
>

/** The tuner state fields the analog frequency port reads. */
type TunerFrequencyState = Pick<
	TunerState,
	"frequency" | "controlMode" | "unknownFields" | "declaredOnlyFields"
>

/**
 * Event-time frequency port from the tuner (WG1 req 3.4): the tuned centre
 * plus the demodulator offset. Trust follows the shared fail-closed rule
 * (`tuningTrustOf`, WG9 req 3.1): `unverified` while frequency or sample rate
 * is unknown or only declared, else "relay" for external control and
 * "commanded" for internal. The optional `writtenOnConnection` (the tuner
 * controller's `tuningWrittenOnConnection`, WG9 req 3.2) demotes a label to
 * `unverified` when it reports false. Null when the source has no tuner state
 * or its centre is a placeholder the core never commanded or observed.
 */
export function tunerFrequencyAt(
	getState: (sourceId: string) => TunerFrequencyState | undefined,
	writtenOnConnection?: (sourceId: string) => boolean,
): AnalogTransmissionTrackerOptions["frequencyAt"] {
	return (sourceId, offsetHz) => {
		const state = getState(sourceId)
		if (
			typeof state !== "object" ||
			state === null ||
			!Number.isFinite(state.frequency) ||
			(Array.isArray(state.unknownFields) &&
				state.unknownFields.includes("frequency"))
		)
			return null
		let tuningTrust = tuningTrustOf(state)
		if (
			tuningTrust !== "unverified" &&
			writtenOnConnection !== undefined &&
			writtenOnConnection(sourceId) !== true
		)
			tuningTrust = "unverified"
		return { hz: state.frequency + offsetHz, tuningTrust }
	}
}

export function toActivityPayload(
	event: AnalogTransmissionEventData,
): AnalogTransmissionPayload {
	if (
		event.state !== "closed" ||
		event.endedAt === null ||
		event.durationMs === null ||
		event.closeReason === null
	) {
		throw new WaveKitError(
			"Analog transmission payload requires a closed event",
			"ANALOG_TRANSMISSION_OPEN",
		)
	}
	return {
		transmissionId: event.transmissionId,
		sourceId: event.sourceId,
		startedAt: event.startedAt,
		endedAt: event.endedAt,
		durationMs: event.durationMs,
		frequency:
			event.frequency === null
				? null
				: { hz: event.frequency.hz, tuningTrust: event.frequency.tuningTrust },
		modulation: event.modulation,
		bandwidthHz: event.bandwidthHz,
		squelchMode: event.squelchMode,
		...(event.noiseQuietingDb === undefined
			? {}
			: { noiseQuietingDb: event.noiseQuietingDb }),
		thresholdDbfs: event.thresholdDbfs,
		peakChannelPowerDbfs: event.peakChannelPowerDbfs,
		meanChannelPowerDbfs: event.meanChannelPowerDbfs,
		closeReason: event.closeReason,
		...(event.tone === undefined
			? {}
			: {
					tone: {
						ctcssHz: event.tone.ctcssHz,
						dtmf: event.tone.dtmf,
						dcs: copyDcs(event.tone.dcs),
					},
				}),
	}
}

/** Defensive fresh copy of a detector-supplied DCS; anything malformed becomes null. */
function copyDcs(value: unknown): AnalogTransmissionDcs | null {
	if (typeof value !== "object" || value === null) return null
	const { code, polarity } = value as { code?: unknown; polarity?: unknown }
	if (typeof code !== "string" || !/^[0-7]{3}$/.test(code)) return null
	if (DCS_CODE_SET === "standard" && !DCS_STANDARD_CODES.includes(code))
		return null
	if (polarity !== "normal" && polarity !== "inverted") return null
	return { code, polarity }
}

export class AnalogTransmissionTracker extends EventEmitter<AnalogTransmissionTrackerEvents> {
	private readonly source: AnalogTransmissionSource
	private readonly frequencyAt: AnalogTransmissionTrackerOptions["frequencyAt"]
	private readonly now: () => number
	private readonly newId: () => string
	private readonly maxDurationMs: number
	private readonly createToneDetector: () => ToneDetectorPort
	private transmission: OpenTransmission | null = null
	private attached = false
	private pcmAttached = false
	private toneErrorCount = 0
	private toneBroken = false
	private readonly hygiene: AnalogTransmissionHygiene
	private readonly setTimer: (fn: () => void, ms: number) => () => void
	private readonly onSuppressed: AnalogTransmissionTrackerOptions["onSuppressed"]
	private readonly suppressedCounts: AnalogTransmissionSuppressed = {
		short: 0,
		noCarrier: 0,
	}
	// WG10 req 3.8 carrier path state (block log).
	private readonly carrierWanted: boolean
	private carrierEpoch = -1
	private carrierAnchorMs = 0
	private carrierBlockMs = 10
	private carrierBlockSamples = 1
	private carrierCursor = 0
	private runLen = 0
	private runStart = 0
	private uncarried = 0
	private inSpan = false
	private discardedRunCount = 0
	private readonly decisions = new Uint8Array(CARRIER_LOG_CAPACITY)
	private pcmRing: Buffer | null = null
	private pcmRingRate = 0
	private pcmRingWidth = 0
	private pcmFormat: TonePcmFormat | null = null
	/** Epoch byte position of the ring head, ring offset of the head, bytes held. */
	private pcmHead = 0
	private pcmHeadOff = 0
	private pcmLen = 0
	/** Epoch byte position after the last accepted chunk. */
	private pcmEnd = 0
	private hookedLog: CarrierBlockLog | null = null

	constructor(options: AnalogTransmissionTrackerOptions) {
		super()
		this.source = options.source
		this.frequencyAt = options.frequencyAt
		this.now = options.now ?? (() => Date.now())
		this.newId = options.randomUUID ?? randomUUID
		this.createToneDetector =
			options.createToneDetector ?? (() => new ToneDetector())
		const max = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
		this.maxDurationMs =
			Number.isFinite(max) && max >= 0 ? max : DEFAULT_MAX_DURATION_MS
		this.hygiene = {
			mergeGapMs: knob(
				options.hygiene?.mergeGapMs,
				ANALOG_TRANSMISSION_MERGE_GAP_MS,
			),
			minDurationMs: knob(
				options.hygiene?.minDurationMs,
				ANALOG_TRANSMISSION_MIN_MS,
			),
			minCarrierBlocks: knob(
				options.hygiene?.minCarrierBlocks,
				ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS,
			),
		}
		this.setTimer = options.setTimer ?? defaultTimer
		this.onSuppressed = options.onSuppressed
		this.carrierWanted = typeof this.source.carrierBlockLog === "function"
	}

	/** WG10 req 3.8: carried runs shorter than a span that were dropped, since construction. */
	discardedRuns(): number {
		return this.discardedRunCount
	}

	/** WG10 activity hygiene: transmissions suppressed (short, no carrier) since construction. */
	suppressed(): AnalogTransmissionSuppressed {
		return { ...this.suppressedCounts }
	}

	/** Detector failures since this tracker was constructed. Each forces a null tone. */
	toneErrors(): number {
		return this.toneErrorCount
	}

	start(): void {
		if (this.attached) return
		this.attached = true
		this.source.on("squelch-changed", this.handleSquelch)
		this.source.on("level", this.handleLevel)
		this.source.on("config-changed", this.handleConfig)
		this.source.on("stopped", this.handleStopped)
		if (this.carrierWanted) {
			this.attachPcm()
			this.readLog()
		}
	}

	/** Closes an open transmission with "stopped" (a merge-gap one at its end), then detaches. */
	stop(): void {
		try {
			if (this.transmission)
				this.guard(() => {
					this.drainCarrier()
					this.close("stopped", this.clock())
				})
		} finally {
			this.detach()
		}
	}

	/**
	 * WG10 R2 (identify): the held transmission while its open segment has not yet reached the
	 * minimum audio (so not announced and still able to qualify), else null. Shape of an open event.
	 */
	pending(): AnalogTransmissionEventData | null {
		const open = this.transmission
		if (!open || open.announced || !open.segmentOpen || open.continuation)
			return null
		if (this.audioSoFar(open, this.clock()) >= this.hygiene.minDurationMs)
			return null
		return this.openEvent(open)
	}

	/** The announced transmission (also while in its merge gap), else null. */
	current(): AnalogTransmissionEventData | null {
		const open = this.transmission
		if (!open || !open.announced) return null
		return this.openEvent(open)
	}

	private readonly handleSquelch = (open: boolean): void => {
		this.guard(() => {
			if (this.readLog() !== null) {
				// WG10 req 3.8: squelch edges only prompt the block log, except a teardown
				// edge (stop or a transmission-closing reconfigure), which closes at once.
				this.drainCarrier()
				if (open || this.transmission === null) return
				const reason = this.squelchCloseReason()
				if (reason !== "squelch")
					this.close(
						this.transmission.segmentOpen ? reason : "squelch",
						this.clock(),
					)
				return
			}
			const now = this.clock()
			if (open) {
				const held = this.transmission
				if (held && held.segmentOpen) return
				if (!this.canOpen()) return
				if (held) {
					if (this.canMerge(held, now)) {
						this.resumeSegment(held, now)
						return
					}
					this.close("squelch", now)
				}
				this.openTransmission(now)
				return
			}
			const held = this.transmission
			if (!held || !held.segmentOpen) return
			const reason = this.squelchCloseReason()
			if (reason !== "squelch") {
				this.close(reason, now)
				return
			}
			this.endSegment(held, now)
		})
	}

	private readonly handleLevel = (level: LiveAudioLevel): void => {
		this.guard(() => {
			if (this.readLog() !== null) this.drainCarrier()
			if (this.transmission?.carrierSpans === true) {
				this.carrierLevel(level)
				return
			}
			const open = this.transmission
			if (!open) return
			const now = this.clock()
			if (!open.segmentOpen) {
				if (now - open.gapEndMs > this.hygiene.mergeGapMs)
					this.close("squelch", now)
				return
			}
			this.notePower(open, level.channelPowerDbfs)
			this.splitIfToneChanged(open, now)
			const current = this.transmission
			if (current === null) return
			this.announceIfQualified(current, now)
			if (now - current.startedAtMs >= this.maxDurationMs) {
				this.close("max-duration", now)
				// m5: the continuation is exempt from the minimum duration (carrier rule applies).
				this.reopenIfHeld(now, true)
				return
			}
			if (this.frequencyDrifted(current)) {
				this.close("retune", now)
				this.reopenIfHeld(now)
			}
		})
	}

	private readonly handleConfig = (config: LiveDemodConfig): void => {
		this.guard(() => {
			this.drainCarrier()
			const open = this.transmission
			if (!open) return
			if (!this.configClosesTransmission(open, config)) return
			this.close(open.segmentOpen ? "config" : "squelch", this.clock())
		})
	}

	private readonly handlePcm = (chunk: Buffer, format: TonePcmFormat): void => {
		const log = this.carrierWanted ? this.readLog() : null
		if (log !== null) {
			this.guard(() => {
				this.carrierPcm(log, chunk, format)
			})
			return
		}
		const open = this.transmission
		if (!open || !open.segmentOpen || this.toneBroken) return
		this.noteAudio(open, chunk, format)
		try {
			open.detector.push(chunk, format)
		} catch {
			this.toneErrorCount += 1
			this.toneBroken = true
		}
		const split = open.split
		if (split === null || this.toneBroken) return
		const counter = {
			audioSeconds: split.audioSeconds,
			audioRemainder: split.audioRemainder,
		}
		this.noteAudio(counter, chunk, format)
		split.audioSeconds = counter.audioSeconds
		split.audioRemainder = counter.audioRemainder
		try {
			split.detector.push(chunk, format)
		} catch {
			// A failing segment detector only loses the split; the transmission's tone stands.
			open.split = null
			return
		}
		this.guard(() => {
			this.splitIfToneChanged(open, this.clock())
		})
	}

	private readonly handleStopped = (): void => {
		this.guard(() => {
			this.drainCarrier()
			const open = this.transmission
			if (!open) return
			this.close(open.segmentOpen ? "stopped" : "squelch", this.clock())
		})
	}

	private detach(): void {
		if (this.hookedLog !== null && this.hookedLog.onBlock === this.blockHook)
			this.hookedLog.onBlock = null
		this.hookedLog = null
		const wasAttached = this.attached
		this.attached = false
		this.detachPcm()
		this.attached = wasAttached
		const held = this.transmission
		if (held) {
			// Detached while a transmission is held: drop it without output (stop() closed it first).
			this.transmission = null
			this.cancelGapTimer(held)
		}
		if (!this.attached) return
		this.attached = false
		this.source.off("squelch-changed", this.handleSquelch)
		this.source.off("level", this.handleLevel)
		this.source.off("config-changed", this.handleConfig)
		this.source.off("stopped", this.handleStopped)
	}

	private attachPcm(): void {
		if (this.pcmAttached) return
		this.pcmAttached = true
		this.source.on("pcm", this.handlePcm)
	}

	private detachPcm(): void {
		if (!this.pcmAttached) return
		if (this.carrierWanted && this.attached) return
		this.pcmAttached = false
		this.source.off("pcm", this.handlePcm)
	}

	private canOpen(): boolean {
		try {
			const status = this.source.getStatus()
			return status.running && liveDemodSquelchGates(status.config)
		} catch {
			return false
		}
	}

	private squelchIsOpen(): boolean {
		try {
			return this.source.isSquelchOpen()
		} catch {
			return false
		}
	}

	private squelchCloseReason(): AnalogTransmissionCloseReason {
		try {
			const override = this.source.transmissionCloseOverride?.() ?? null
			if (override === "stopped" || override === "config") return override
		} catch {
			// A broken hint still closes; the edge itself was a squelch close.
		}
		return "squelch"
	}

	private openTransmission(
		now: number,
		continuation = false,
		carrier: { startBlock: number; endMs: number } | null = null,
	): void {
		let status: LiveDemodStatus
		try {
			status = this.source.getStatus()
		} catch {
			return
		}
		const offsetHz = status.config.offsetHz ?? 0
		const frequency = this.sampleFrequency(status.sourceId, offsetHz)
		const threshold = status.thresholdDbfs
		const squelchMode = status.config.squelchMode ?? "manual"
		this.toneBroken = false
		const detector = this.makeDetector()
		this.transmission = {
			transmissionId: this.newId(),
			sourceId: status.sourceId,
			startedAtMs: now,
			startedAt: new Date(now).toISOString(),
			frequency,
			modulation: status.config.modulation,
			bandwidthHz: status.config.bandwidth,
			squelchMode,
			noiseQuietingDb:
				squelchMode === "noise"
					? (status.config.noiseQuietingDb ??
						LIVE_AUDIO_NOISE_QUIETING_DB.default)
					: undefined,
			thresholdDbfs:
				typeof threshold === "number" && Number.isFinite(threshold)
					? threshold
					: status.config.squelch,
			config: configIdentity(status.config),
			peak: null,
			powerSum: 0,
			powerCount: 0,
			detector,
			audioSeconds: 0,
			audioRemainder: 0,
			segmentOpen: true,
			segmentStartMs: now,
			gapEndMs: now,
			announced: false,
			bestSegmentCarrier: 0,
			audioMs: 0,
			continuation,
			segmentEndTone: null,
			split: null,
			carrierBase: null,
			carrierRequired: false,
			cancelTimer: null,
			carrierSpans: carrier !== null,
			spanEndMs: carrier?.endMs ?? now,
			feedFromBlock: carrier?.startBlock ?? 0,
		}
		// WG10 req 3.8.6: on the carrier path the span rule implies the 3.7 carrier rule.
		const base = carrier === null ? this.readCarrierBlocks() : null
		this.transmission.carrierBase = base
		this.transmission.carrierRequired = base !== null
		this.attachPcm()
		this.announceIfQualified(this.transmission, now)
	}

	/**
	 * Final close. In the merge gap the transmission ended at its last segment's audio end
	 * with reason "squelch", whatever `reason` asked. Publishes only a qualified transmission.
	 */
	private close(asked: AnalogTransmissionCloseReason, closeAt: number): void {
		let reason = asked
		const open = this.transmission
		if (!open) return
		this.transmission = null
		this.cancelGapTimer(open)
		this.detachPcm()
		let endedMs: number
		if (open.segmentOpen) {
			this.collectCarrier(open)
			// Only a squelch close happens a hang after the last above-threshold
			// block; retune, max-duration, stop and config end at the close itself.
			endedMs = open.carrierSpans
				? reason === "squelch"
					? open.spanEndMs
					: Math.max(open.segmentStartMs, closeAt)
				: reason === "squelch"
					? Math.max(open.segmentStartMs, closeAt - this.hangMs())
					: closeAt
			open.audioMs += Math.max(0, endedMs - open.segmentStartMs)
		} else {
			reason = "squelch"
			endedMs = open.gapEndMs
		}
		this.finalise(open, reason, endedMs, this.finishTone(open))
	}

	/** Publishes a final transmission when announced or qualified, else counts the suppression. */
	private finalise(
		open: OpenTransmission,
		reason: AnalogTransmissionCloseReason,
		endedMs: number,
		tone: AnalogTransmissionTone,
	): void {
		const event = this.closedEvent(open, reason, endedMs, tone)
		const rejected = open.announced ? null : this.rejection(open)
		if (rejected !== null) {
			this.suppressedCounts[rejected] += 1
			try {
				this.onSuppressed?.(rejected, event)
			} catch {
				// A broken observer never blocks the tracker.
			}
			return
		}
		if (!open.announced) {
			open.announced = true
			this.publish(this.openEvent(open))
		}
		this.publish(event)
	}

	/** Ends the open segment on a squelch close and waits a merge gap for a re-open. */
	private endSegment(open: OpenTransmission, closeAt: number): void {
		this.collectCarrier(open)
		open.segmentOpen = false
		open.split = null
		open.gapEndMs = Math.max(open.segmentStartMs, closeAt - this.hangMs())
		open.audioMs += open.gapEndMs - open.segmentStartMs
		open.segmentEndTone = this.snapshotTone(open)
		this.detachPcm()
		if (this.hygiene.mergeGapMs <= 0) {
			this.close("squelch", closeAt)
			return
		}
		// +1 ms: a re-open exactly at the gap still merges (the bound is inclusive).
		const delay = Math.max(
			0,
			open.gapEndMs + this.hygiene.mergeGapMs + 1 - closeAt,
		)
		try {
			open.cancelTimer = this.setTimer(() => {
				this.guard(() => {
					if (this.transmission !== open || open.segmentOpen) return
					open.cancelTimer = null
					this.close("squelch", this.clock())
				})
			}, delay)
		} catch {
			// No timer: level samples, the next open, stop or config still finalise it.
			open.cancelTimer = null
		}
	}

	/** Same source, config identity and frequency, and the re-open within the merge gap. */
	private canMerge(open: OpenTransmission, now: number): boolean {
		if (now - open.gapEndMs > this.hygiene.mergeGapMs) return false
		let status: LiveDemodStatus
		try {
			status = this.source.getStatus()
		} catch {
			return false
		}
		if (status.sourceId !== open.sourceId) return false
		if (
			liveDemodTransmissionConfigChanged(
				open.config,
				status.config,
				open.sourceId,
			)
		)
			return false
		return !this.frequencyDrifted(open)
	}

	private resumeSegment(open: OpenTransmission, now: number): void {
		this.cancelGapTimer(open)
		open.segmentOpen = true
		open.segmentStartMs = now
		// m4: a null count on resume (pipeline restart) keeps the last known base.
		if (open.carrierRequired)
			open.carrierBase = this.readCarrierBlocks() ?? open.carrierBase
		open.split = null
		const heldTone = open.segmentEndTone
		if (heldTone !== null && toneKeys(heldTone).length > 0) {
			const detector = this.makeSegmentDetector()
			if (detector !== null)
				open.split = {
					heldTone,
					heldGapEndMs: open.gapEndMs,
					heldAudioMs: open.audioMs,
					heldBestSegmentCarrier: open.bestSegmentCarrier,
					heldPeak: open.peak,
					heldPowerSum: open.powerSum,
					heldPowerCount: open.powerCount,
					detector,
					audioSeconds: 0,
					audioRemainder: 0,
					peak: null,
					powerSum: 0,
					powerCount: 0,
					feedFromBlock: open.feedFromBlock,
				}
		}
		this.attachPcm()
		this.announceIfQualified(open, now)
	}

	/**
	 * WG10 R2 (M2): once the resumed segment confirms a CTCSS tone or DCS code the held part
	 * did not have (and the held part confirmed one), the held part is final at its gap end
	 * with its snapshot tone and the segment continues as a new transmission from its start.
	 */
	private splitIfToneChanged(open: OpenTransmission, now: number): void {
		const split = open.split
		if (split === null || this.transmission !== open || !open.segmentOpen)
			return
		const segmentTone = gatedTone(split.detector, split.audioSeconds)
		if (segmentTone === null || !tonesDiffer(split.heldTone, segmentTone))
			return
		const held: OpenTransmission = {
			...open,
			segmentOpen: false,
			gapEndMs: split.heldGapEndMs,
			audioMs: split.heldAudioMs,
			bestSegmentCarrier: split.heldBestSegmentCarrier,
			peak: split.heldPeak,
			powerSum: split.heldPowerSum,
			powerCount: split.heldPowerCount,
			split: null,
			cancelTimer: null,
		}
		const next: OpenTransmission = {
			...open,
			transmissionId: this.newId(),
			startedAtMs: open.segmentStartMs,
			startedAt: new Date(open.segmentStartMs).toISOString(),
			peak: split.peak,
			powerSum: split.powerSum,
			powerCount: split.powerCount,
			detector: split.detector,
			audioSeconds: split.audioSeconds,
			audioRemainder: split.audioRemainder,
			gapEndMs: open.segmentStartMs,
			announced: false,
			bestSegmentCarrier: 0,
			audioMs: 0,
			continuation: false,
			segmentEndTone: null,
			split: null,
			cancelTimer: null,
			feedFromBlock: split.feedFromBlock,
		}
		this.transmission = next
		this.finalise(held, "squelch", split.heldGapEndMs, split.heldTone)
		if (this.transmission === next) this.announceIfQualified(next, now)
	}

	// ---- WG10 req 3.8: carrier path (block log) ----

	private readLog(): CarrierBlockLog | null {
		if (!this.carrierWanted) return null
		let log: CarrierBlockLog | null
		try {
			log = this.source.carrierBlockLog?.() ?? null
		} catch {
			return null
		}
		if (log !== null && log.onBlock !== this.blockHook && this.attached) {
			log.onBlock = this.blockHook
			this.hookedLog = log
		}
		return log
	}

	private readonly blockHook = (): void => {
		this.guard(() => {
			this.drainCarrier()
		})
	}

	private blockTime(block: number): number {
		return this.carrierAnchorMs + block * this.carrierBlockMs
	}

	/** Consumes every new block of the log in order, then the PCM those blocks decide. */
	private drainCarrier(): void {
		const log = this.readLog()
		if (log === null) return
		if (log.epoch !== this.carrierEpoch) this.resetCarrier(log, 0)
		this.refineAnchor(log)
		const end = log.blocks
		if (end - this.carrierCursor > CARRIER_LOG_CAPACITY) {
			// Blocks overwritten before they were read: a break in the evidence.
			this.runLen = 0
			if (this.inSpan) this.endSpan()
			this.carrierCursor = end - CARRIER_LOG_CAPACITY
		}
		while (this.carrierCursor < end) {
			const k = this.carrierCursor
			this.carrierCursor = k + 1
			this.carrierBlock(k, log.flags[k % CARRIER_LOG_CAPACITY] ?? 0)
		}
		this.drainPcm()
	}

	private resetCarrier(log: CarrierBlockLog, pendingPcm: number): void {
		if (this.inSpan) this.endSpan()
		this.carrierEpoch = log.epoch
		this.carrierBlockMs = log.blockMs
		this.carrierBlockSamples = log.blockSamples
		this.carrierAnchorMs = this.clock() - log.blocks * log.blockMs
		this.carrierCursor = Math.max(0, log.blocks - CARRIER_LOG_CAPACITY)
		this.runLen = 0
		this.uncarried = 0
		this.decisions.fill(0)
		this.pcmEnd = log.pcmBytes - pendingPcm
		this.pcmHead = this.pcmEnd
		this.pcmHeadOff = 0
		this.pcmLen = 0
	}

	/**
	 * Blocks are logged no earlier than their stream time, so `clock - blocks × blockMs` only
	 * overestimates the run's start; the least estimate seen while idle is the anchor (3.8.1).
	 */
	private refineAnchor(log: CarrierBlockLog): void {
		// Only while idle, so the times of a span and its transmission share one anchor.
		if (this.transmission !== null || this.inSpan || this.runLen > 0) return
		const estimate = this.clock() - log.blocks * log.blockMs
		if (estimate < this.carrierAnchorMs) this.carrierAnchorMs = estimate
	}

	private hangBlocks(): number {
		return Math.max(1, Math.ceil(this.hangMs() / this.carrierBlockMs))
	}

	private carrierBlock(k: number, flags: number): void {
		const live =
			(flags & (CARRIER_FLAG_OPEN | CARRIER_FLAG_CARRIED)) ===
			(CARRIER_FLAG_OPEN | CARRIER_FLAG_CARRIED)
		const endMs = this.blockTime(k + 1)
		if (live) {
			if (this.runLen === 0) this.runStart = k
			this.runLen += 1
			this.uncarried = 0
			if (this.inSpan) {
				this.decisions[k % CARRIER_LOG_CAPACITY] = FEED
				const open = this.transmission
				if (open !== null && open.carrierSpans && open.segmentOpen) {
					open.spanEndMs = endMs
					this.announceIfQualified(open, endMs)
				}
			} else if (this.runLen >= ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS) {
				for (let i = this.runStart; i <= k; i++)
					this.decisions[i % CARRIER_LOG_CAPACITY] = FEED
				this.startSpan(this.runStart, endMs)
			}
		} else {
			if (!this.inSpan && this.runLen > 0) {
				for (let i = this.runStart; i < k; i++)
					this.decisions[i % CARRIER_LOG_CAPACITY] = DROP
				this.discardedRunCount += 1
			}
			this.runLen = 0
			this.decisions[k % CARRIER_LOG_CAPACITY] = DROP
			if (this.inSpan) {
				this.uncarried += 1
				if (
					(flags & CARRIER_FLAG_OPEN) === 0 ||
					this.uncarried >= this.hangBlocks()
				)
					this.endSpan()
			}
		}
		if (!this.inSpan) this.finaliseIfDue(endMs)
	}

	/** A span qualified: merge into the held transmission or open a new one at its start. */
	private startSpan(startBlock: number, endMs: number): void {
		this.inSpan = true
		this.uncarried = 0
		const startMs = this.blockTime(startBlock)
		const held = this.transmission
		if (held !== null) {
			if (
				held.carrierSpans &&
				!held.segmentOpen &&
				startMs - held.gapEndMs <= this.hygiene.mergeGapMs &&
				this.canMerge(held, startMs)
			) {
				held.spanEndMs = endMs
				this.resumeSegment(held, startMs)
				if (held.split !== null) held.split.feedFromBlock = startBlock
				return
			}
			this.close("squelch", startMs)
		}
		this.openSpanTransmission(startBlock, endMs, false)
	}

	private openSpanTransmission(
		startBlock: number,
		endMs: number,
		continuation: boolean,
	): void {
		if (!this.canOpen()) return
		const startMs = this.blockTime(startBlock)
		this.openTransmission(startMs, continuation, { startBlock, endMs })
	}

	/** Ends the open span at its carrier end; the held transmission waits a merge gap. */
	private endSpan(): void {
		this.inSpan = false
		this.uncarried = 0
		const open = this.transmission
		if (open === null || !open.carrierSpans || !open.segmentOpen) return
		open.segmentOpen = false
		open.split = null
		open.gapEndMs = open.spanEndMs
		open.audioMs += Math.max(0, open.spanEndMs - open.segmentStartMs)
		open.segmentEndTone = this.snapshotTone(open)
	}

	/** Final once past the merge gap, unless a run started inside the gap is still provisional. */
	private finaliseIfDue(endMs: number): void {
		const open = this.transmission
		if (open === null || !open.carrierSpans || open.segmentOpen) return
		if (endMs - open.gapEndMs <= this.hygiene.mergeGapMs) return
		if (
			this.runLen > 0 &&
			this.blockTime(this.runStart) - open.gapEndMs <= this.hygiene.mergeGapMs
		)
			return
		this.drainPcm()
		if (this.transmission === open) this.close("squelch", endMs)
	}

	/** Level samples on the carrier path: power, tone split, announce, max duration, retune. */
	private carrierLevel(level: LiveAudioLevel): void {
		const open = this.transmission
		if (open === null || !open.segmentOpen) return
		const now = this.clock()
		this.notePower(open, level.channelPowerDbfs)
		this.splitIfToneChanged(open, now)
		const current = this.transmission
		if (current === null) return
		this.announceIfQualified(current, now)
		const next = this.carrierCursor
		if (now - current.startedAtMs >= this.maxDurationMs) {
			this.close("max-duration", now)
			if (this.inSpan)
				this.openTransmission(now, true, {
					startBlock: next,
					endMs: now,
				})
			return
		}
		if (this.frequencyDrifted(current)) {
			this.close("retune", now)
			if (this.inSpan && this.canOpen())
				this.openTransmission(now, false, { startBlock: next, endMs: now })
		}
	}

	private carrierPcm(
		log: CarrierBlockLog,
		chunk: Buffer,
		format: TonePcmFormat,
	): void {
		if (log.epoch !== this.carrierEpoch) this.resetCarrier(log, chunk.length)
		this.pcmFormat = format
		const width = format.format === "s16le" ? 2 : 4
		if (this.pcmRingRate !== format.rate || this.pcmRingWidth !== width) {
			const bytes =
				Math.max(1, Math.ceil((format.rate * CARRIER_PCM_RING_MS) / 1000)) *
				width
			this.pcmRing = Buffer.alloc(bytes)
			this.pcmRingRate = format.rate
			this.pcmRingWidth = width
			this.pcmHead = this.pcmEnd
			this.pcmHeadOff = 0
			this.pcmLen = 0
		}
		const start = log.pcmBytes - chunk.length
		if (start !== this.pcmEnd) {
			// Not counted by the log (not this run's audio): ignore it.
			if (log.pcmBytes === this.pcmEnd) return
			// A gap or overlap: restart the ring at this chunk.
			this.pcmHead = start
			this.pcmHeadOff = 0
			this.pcmLen = 0
		}
		this.pcmEnd = log.pcmBytes
		this.appendPcm(chunk)
		this.drainCarrier()
	}

	private appendPcm(chunk: Buffer): void {
		const ring = this.pcmRing
		if (ring === null) return
		const cap = ring.length
		let from = 0
		if (chunk.length > cap) {
			from = chunk.length - cap
			this.pcmHead += this.pcmLen + from
			this.pcmHeadOff = 0
			this.pcmLen = 0
		}
		const n = chunk.length - from
		const over = this.pcmLen + n - cap
		if (over > 0) {
			// Oldest bytes leave unfed (their blocks never got decided in time).
			this.pcmHead += over
			this.pcmHeadOff = (this.pcmHeadOff + over) % cap
			this.pcmLen -= over
		}
		const write = (this.pcmHeadOff + this.pcmLen) % cap
		const first = Math.min(n, cap - write)
		chunk.copy(ring, write, from, from + first)
		if (first < n) chunk.copy(ring, 0, from + first, chunk.length)
		this.pcmLen += n
	}

	/** Feeds or drops buffered PCM whose blocks are decided, cut at block boundaries. */
	private drainPcm(): void {
		const ring = this.pcmRing
		const format = this.pcmFormat
		if (ring === null || format === null || this.pcmLen === 0) return
		const width = this.pcmRingWidth
		const blockBytes = this.carrierBlockSamples * width
		const decidedEnd =
			!this.inSpan && this.runLen > 0 ? this.runStart : this.carrierCursor
		const oldest = this.carrierCursor - CARRIER_LOG_CAPACITY
		while (this.pcmLen > 0) {
			const block = Math.floor(this.pcmHead / blockBytes)
			if (block >= decidedEnd) return
			// Whole samples only: a split sample waits for its remaining bytes.
			const held = this.pcmLen - ((this.pcmHead + this.pcmLen) % width)
			const n = Math.min(held, (block + 1) * blockBytes - this.pcmHead)
			if (n <= 0) return
			if (
				block >= oldest &&
				this.decisions[block % CARRIER_LOG_CAPACITY] === FEED
			)
				this.feedPiece(ring, block, n, format)
			this.pcmHead += n
			this.pcmHeadOff = (this.pcmHeadOff + n) % ring.length
			this.pcmLen -= n
		}
	}

	private feedPiece(
		ring: Buffer,
		block: number,
		n: number,
		format: TonePcmFormat,
	): void {
		const open = this.transmission
		if (open === null || !open.carrierSpans || this.toneBroken) return
		const off = this.pcmHeadOff
		const first = Math.min(n, ring.length - off)
		this.feedRange(open, block, ring.subarray(off, off + first), format)
		if (first < n)
			this.feedRange(open, block, ring.subarray(0, n - first), format)
		this.splitIfToneChanged(open, this.clock())
	}

	private feedRange(
		open: OpenTransmission,
		block: number,
		piece: Buffer,
		format: TonePcmFormat,
	): void {
		if (block >= open.feedFromBlock) {
			this.noteAudio(open, piece, format)
			try {
				open.detector.push(piece, format)
			} catch {
				this.toneErrorCount += 1
				this.toneBroken = true
				return
			}
		}
		const split = open.split
		if (split === null || block < split.feedFromBlock) return
		this.noteAudio(split, piece, format)
		try {
			split.detector.push(piece, format)
		} catch {
			open.split = null
		}
	}

	private cancelGapTimer(open: OpenTransmission): void {
		const cancel = open.cancelTimer
		open.cancelTimer = null
		if (cancel === null) return
		try {
			cancel()
		} catch {
			// The timer callback re-checks the state anyway.
		}
	}

	/**
	 * Ends the open segment's carrier count: keeps the best single segment (a failing or reset
	 * count adds none; a null count keeps the last known base).
	 */
	private collectCarrier(open: OpenTransmission): void {
		if (!open.carrierRequired || open.carrierBase === null) return
		const nowCount = this.readCarrierBlocks()
		if (nowCount === null) return
		if (nowCount >= open.carrierBase)
			open.bestSegmentCarrier = Math.max(
				open.bestSegmentCarrier,
				nowCount - open.carrierBase,
			)
		open.carrierBase = nowCount
	}

	/** Best single-segment carrier count so far, the open segment included. */
	private carrierSoFar(open: OpenTransmission): number {
		let best = open.bestSegmentCarrier
		if (open.segmentOpen && open.carrierBase !== null) {
			const nowCount = this.readCarrierBlocks()
			if (nowCount !== null && nowCount >= open.carrierBase)
				best = Math.max(best, nowCount - open.carrierBase)
		}
		return best
	}

	/** Summed audio so far: closed segments plus the open one up to `now - hang`. */
	private audioSoFar(open: OpenTransmission, now: number): number {
		if (!open.segmentOpen) return open.audioMs
		if (open.carrierSpans)
			return open.audioMs + Math.max(0, open.spanEndMs - open.segmentStartMs)
		return open.audioMs + Math.max(0, now - this.hangMs() - open.segmentStartMs)
	}

	private readCarrierBlocks(): number | null {
		try {
			const count = this.source.carrierBlocks?.() ?? null
			return typeof count === "number" && Number.isFinite(count) ? count : null
		} catch {
			return null
		}
	}

	/** Why a final transmission is not published, or null when it qualifies. */
	private rejection(
		open: OpenTransmission,
	): keyof AnalogTransmissionSuppressed | null {
		if (!open.continuation && open.audioMs < this.hygiene.minDurationMs)
			return "short"
		if (
			open.carrierRequired &&
			open.bestSegmentCarrier < this.hygiene.minCarrierBlocks
		)
			return "noCarrier"
		return null
	}

	/**
	 * Publishes the open event once the summed audio is bound to reach the minimum (the
	 * open segment's audio end is at least `now - hang`) and the carrier rule holds.
	 */
	private announceIfQualified(open: OpenTransmission, now: number): void {
		if (open.announced || !open.segmentOpen) return
		if (
			!open.continuation &&
			this.hygiene.minDurationMs > 0 &&
			this.audioSoFar(open, now) < this.hygiene.minDurationMs
		)
			return
		if (
			open.carrierRequired &&
			this.carrierSoFar(open) < this.hygiene.minCarrierBlocks
		)
			return
		open.announced = true
		this.publish(this.openEvent(open))
	}

	private reopenIfHeld(now: number, continuation = false): void {
		if (this.transmission || !this.attached) return
		if (!this.squelchIsOpen() || !this.canOpen()) return
		this.openTransmission(now, continuation)
	}

	private notePower(open: OpenTransmission, power: number | null): void {
		if (typeof power !== "number" || !Number.isFinite(power)) return
		addPower(open, power)
		if (open.split !== null) addPower(open.split, power)
	}

	private frequencyDrifted(open: OpenTransmission): boolean {
		let status: LiveDemodStatus
		try {
			status = this.source.getStatus()
		} catch {
			return false
		}
		const next = this.sampleFrequency(
			status.sourceId,
			status.config.offsetHz ?? 0,
		)
		if ((open.frequency === null) !== (next === null)) return true
		if (open.frequency === null || next === null) return false
		return Math.abs(open.frequency.hz - next.hz) > 1
	}

	private sampleFrequency(
		sourceId: string,
		offsetHz: number,
	): AnalogTransmissionFrequency | null {
		try {
			const frequency = this.frequencyAt(sourceId, offsetHz)
			if (frequency === null) return null
			if (typeof frequency.hz !== "number" || !Number.isFinite(frequency.hz))
				return null
			const trust = frequency.tuningTrust
			if (trust !== "commanded" && trust !== "relay" && trust !== "unverified")
				return null
			return { hz: frequency.hz, tuningTrust: trust }
		} catch {
			return null
		}
	}

	/**
	 * Absent `sourceId` means the source this transmission opened on (WG2 req
	 * 7.7). A status source that has since moved is a real source change: the
	 * omitted id now resolves somewhere else.
	 */
	private configClosesTransmission(
		open: OpenTransmission,
		config: LiveDemodConfig,
	): boolean {
		try {
			if (this.source.getStatus().sourceId !== open.sourceId) return true
		} catch {
			// A status failure still honours the config identity below.
		}
		return liveDemodTransmissionConfigChanged(
			open.config,
			config,
			open.sourceId,
		)
	}

	private hangMs(): number {
		try {
			const hang = this.source.squelchHangMs()
			if (!Number.isFinite(hang) || hang < 0) return 0
			return hang
		} catch {
			return 0
		}
	}

	private clock(): number {
		try {
			const now = this.now()
			if (Number.isFinite(now)) return now
		} catch {
			// Fall through to the wall clock.
		}
		return Date.now()
	}

	private openEvent(open: OpenTransmission): AnalogTransmissionEventData {
		return {
			transmissionId: open.transmissionId,
			sourceId: open.sourceId,
			state: "open",
			startedAt: open.startedAt,
			endedAt: null,
			durationMs: null,
			frequency: copyFrequency(open.frequency),
			modulation: open.modulation,
			bandwidthHz: open.bandwidthHz,
			squelchMode: open.squelchMode,
			...(open.noiseQuietingDb === undefined
				? {}
				: { noiseQuietingDb: open.noiseQuietingDb }),
			thresholdDbfs: open.thresholdDbfs,
			peakChannelPowerDbfs: open.peak,
			meanChannelPowerDbfs: meanOf(open),
			closeReason: null,
		}
	}

	private closedEvent(
		open: OpenTransmission,
		reason: AnalogTransmissionCloseReason,
		endedMs: number,
		tone: AnalogTransmissionTone,
	): AnalogTransmissionEventData {
		return {
			transmissionId: open.transmissionId,
			sourceId: open.sourceId,
			state: "closed",
			startedAt: open.startedAt,
			endedAt: new Date(endedMs).toISOString(),
			durationMs: endedMs - open.startedAtMs,
			frequency: copyFrequency(open.frequency),
			modulation: open.modulation,
			bandwidthHz: open.bandwidthHz,
			squelchMode: open.squelchMode,
			...(open.noiseQuietingDb === undefined
				? {}
				: { noiseQuietingDb: open.noiseQuietingDb }),
			thresholdDbfs: open.thresholdDbfs,
			peakChannelPowerDbfs: open.peak,
			meanChannelPowerDbfs: meanOf(open),
			closeReason: reason,
			tone,
		}
	}

	private makeDetector(): ToneDetectorPort {
		try {
			return this.createToneDetector()
		} catch {
			this.toneErrorCount += 1
			this.toneBroken = true
			return {
				push() {},
				result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
				reset() {},
			}
		}
	}

	private noteAudio(
		open: { audioSeconds: number; audioRemainder: number },
		chunk: Buffer,
		format: TonePcmFormat,
	): void {
		if (!(format.rate > 0)) return
		const width = format.format === "s16le" ? 2 : 4
		open.audioRemainder += chunk.length
		const samples = Math.floor(open.audioRemainder / width)
		open.audioRemainder -= samples * width
		open.audioSeconds += samples / format.rate
	}

	private finishTone(open: OpenTransmission): AnalogTransmissionTone {
		if (this.toneBroken) return { ctcssHz: null, dtmf: null, dcs: null }
		try {
			return gateTone(open.detector.result(), open.audioSeconds)
		} catch {
			this.toneErrorCount += 1
			return { ctcssHz: null, dtmf: null, dcs: null }
		}
	}

	/** The transmission's tone at a segment end (split reference); a failure is no tone. */
	private snapshotTone(open: OpenTransmission): AnalogTransmissionTone | null {
		if (this.toneBroken) return null
		return gatedTone(open.detector, open.audioSeconds)
	}

	/** A fresh detector for a resumed segment; a failing factory means no split. */
	private makeSegmentDetector(): ToneDetectorPort | null {
		try {
			return this.createToneDetector()
		} catch {
			return null
		}
	}

	private publish(event: AnalogTransmissionEventData): void {
		try {
			this.emit("transmission", event)
		} catch {
			// A subscriber must not block the matching closed event or the source.
		}
		if (event.state !== "closed") return
		try {
			this.emit("closed", toActivityPayload(event))
		} catch {
			// Same rule: never throw into the live-demodulator emitter.
		}
	}

	/** Source handlers must not throw into the live demodulator. */
	private guard(fn: () => void): void {
		try {
			fn()
		} catch {
			// Drop the update. State was left consistent by close-before-emit.
		}
	}
}

/** CTCSS needs 0.75 s and DCS DCS_MIN_AUDIO_SECONDS of audio; a malformed DCS is none. */
function gateTone(
	tone: AnalogTransmissionTone,
	audioSeconds: number,
): AnalogTransmissionTone {
	const dcs = audioSeconds < DCS_MIN_AUDIO_SECONDS ? null : copyDcs(tone.dcs)
	if (audioSeconds < 0.75) return { ctcssHz: null, dtmf: tone.dtmf, dcs }
	return { ctcssHz: tone.ctcssHz, dtmf: tone.dtmf, dcs }
}

/** Gated detector result, or null when the detector throws. */
function gatedTone(
	detector: ToneDetectorPort,
	audioSeconds: number,
): AnalogTransmissionTone | null {
	try {
		return gateTone(detector.result(), audioSeconds)
	} catch {
		return null
	}
}

/** Confirmed CTCSS / DCS identities of a tone ("c:88.5", "d:023:normal"). */
function toneKeys(tone: AnalogTransmissionTone): string[] {
	const keys: string[] = []
	if (typeof tone.ctcssHz === "number" && Number.isFinite(tone.ctcssHz))
		keys.push(`c:${tone.ctcssHz}`)
	const dcs = tone.dcs
	if (dcs !== null && dcs !== undefined)
		keys.push(`d:${dcs.code}:${dcs.polarity}`)
	return keys
}

/** Both sides confirmed a tone and none is shared: a different speaker (M2). */
function tonesDiffer(
	held: AnalogTransmissionTone,
	segment: AnalogTransmissionTone,
): boolean {
	const a = toneKeys(held)
	const b = toneKeys(segment)
	if (a.length === 0 || b.length === 0) return false
	return !b.some(k => a.includes(k))
}

function addPower(
	into: { peak: number | null; powerSum: number; powerCount: number },
	power: number,
): void {
	into.powerCount += 1
	into.powerSum += power
	if (into.peak === null || power > into.peak) into.peak = power
}

/** A finite non-negative override, else the default. */
function knob(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: fallback
}

function defaultTimer(fn: () => void, ms: number): () => void {
	const handle = setTimeout(fn, ms)
	handle.unref()
	return () => {
		clearTimeout(handle)
	}
}

function meanOf(open: OpenTransmission): number | null {
	if (open.powerCount === 0) return null
	return open.powerSum / open.powerCount
}

function copyFrequency(
	frequency: AnalogTransmissionFrequency | null,
): AnalogTransmissionFrequency | null {
	if (frequency === null) return null
	return { hz: frequency.hz, tuningTrust: frequency.tuningTrust }
}

function configIdentity(config: LiveDemodConfig): TransmissionConfigIdentity {
	return {
		modulation: config.modulation,
		bandwidth: config.bandwidth,
		...(config.sourceId === undefined ? {} : { sourceId: config.sourceId }),
		...(config.offsetHz === undefined ? {} : { offsetHz: config.offsetHz }),
		...(config.squelchMode === undefined
			? {}
			: { squelchMode: config.squelchMode }),
	}
}

export interface AnalogTransmissionWiring {
	source: AnalogTransmissionSource
	frequencyAt: AnalogTransmissionTrackerOptions["frequencyAt"]
	/** WebSocket delivery of open and closed events (live-audio channel). */
	broadcast: (event: AnalogTransmissionEventData) => void
	/**
	 * Read at each close, so a runtime that becomes ready or closes later is
	 * honoured. Null while Activity is disabled, unavailable or closed.
	 */
	sink: () => ((payload: AnalogTransmissionPayload) => void) | null
	now?: () => number
	randomUUID?: () => string
	/** WG10 activity hygiene: one call per suppressed transmission (Main logs at debug). */
	onSuppressed?: AnalogTransmissionTrackerOptions["onSuppressed"]
}

/**
 * Builds and starts the tracker with its WS and Activity outputs (WG1 req
 * 3.2, 3.9, 4.1, 4.5). `stop()` on the result closes an open transmission and
 * still delivers both outputs, so call it before Activity and the API close.
 */
export function wireAnalogTransmissions(
	wiring: AnalogTransmissionWiring,
): AnalogTransmissionTracker {
	const tracker = new AnalogTransmissionTracker({
		source: wiring.source,
		frequencyAt: wiring.frequencyAt,
		...(wiring.now ? { now: wiring.now } : {}),
		...(wiring.randomUUID ? { randomUUID: wiring.randomUUID } : {}),
		...(wiring.onSuppressed ? { onSuppressed: wiring.onSuppressed } : {}),
	})
	tracker.on("transmission", event => {
		wiring.broadcast(event)
	})
	tracker.on("closed", payload => {
		wiring.sink()?.(payload)
	})
	tracker.start()
	return tracker
}
