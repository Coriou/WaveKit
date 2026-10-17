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
 *  2. Minimum duration: a final transmission with `durationMs < ANALOG_TRANSMISSION_MIN_MS`
 *     is suppressed (`suppressed().short`).
 *  3. Carrier evidence: when the source reports `carrierBlocks()` (nfm/wfm in every squelch
 *     mode), a transmission needs at least ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS blocks
 *     with FM quieting while its segments were open, else it is suppressed
 *     (`suppressed().noCarrier`). A null count (am, ssb, ...) or a failing source skips the rule.
 * The open event is held back until the transmission qualifies: on a level sample once
 * `now - hang - start >= ANALOG_TRANSMISSION_MIN_MS` (so the final duration is at least
 * the minimum) and the carrier rule holds, or at finalisation. An announced transmission
 * is always published closed; a suppressed one emits nothing.
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
	/** Carrier blocks of closed segments. */
	carrierBlocks: number
	/** Source count at the open segment's start; null when the rule does not apply. */
	carrierBase: number | null
	/** The carrier rule applies (the source reported a count at the first open). */
	carrierRequired: boolean
	cancelTimer: (() => void) | null
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
	}

	/** Closes an open transmission with "stopped" (a merge-gap one at its end), then detaches. */
	stop(): void {
		try {
			if (this.transmission)
				this.guard(() => {
					this.close("stopped", this.clock())
				})
		} finally {
			this.detach()
		}
	}

	/** The announced transmission (also while in its merge gap), else null. */
	current(): AnalogTransmissionEventData | null {
		const open = this.transmission
		if (!open || !open.announced) return null
		return this.openEvent(open)
	}

	private readonly handleSquelch = (open: boolean): void => {
		this.guard(() => {
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
			const open = this.transmission
			if (!open) return
			const now = this.clock()
			if (!open.segmentOpen) {
				if (now - open.gapEndMs > this.hygiene.mergeGapMs)
					this.close("squelch", now)
				return
			}
			this.notePower(open, level.channelPowerDbfs)
			this.announceIfQualified(open, now)
			if (now - open.startedAtMs >= this.maxDurationMs) {
				this.close("max-duration", now)
				this.reopenIfHeld(now)
				return
			}
			if (this.frequencyDrifted(open)) {
				this.close("retune", now)
				this.reopenIfHeld(now)
			}
		})
	}

	private readonly handleConfig = (config: LiveDemodConfig): void => {
		this.guard(() => {
			const open = this.transmission
			if (!open) return
			if (!this.configClosesTransmission(open, config)) return
			this.close(open.segmentOpen ? "config" : "squelch", this.clock())
		})
	}

	private readonly handlePcm = (chunk: Buffer, format: TonePcmFormat): void => {
		const open = this.transmission
		if (!open || !open.segmentOpen || this.toneBroken) return
		this.noteAudio(open, chunk, format)
		try {
			open.detector.push(chunk, format)
		} catch {
			this.toneErrorCount += 1
			this.toneBroken = true
		}
	}

	private readonly handleStopped = (): void => {
		this.guard(() => {
			const open = this.transmission
			if (!open) return
			this.close(open.segmentOpen ? "stopped" : "squelch", this.clock())
		})
	}

	private detach(): void {
		this.detachPcm()
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

	private openTransmission(now: number): void {
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
			carrierBlocks: 0,
			carrierBase: null,
			carrierRequired: false,
			cancelTimer: null,
		}
		const base = this.readCarrierBlocks()
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
			endedMs =
				reason === "squelch"
					? Math.max(open.segmentStartMs, closeAt - this.hangMs())
					: closeAt
		} else {
			reason = "squelch"
			endedMs = open.gapEndMs
		}
		const tone = this.finishTone(open)
		const event = this.closedEvent(open, reason, endedMs, tone)
		const rejected = open.announced ? null : this.rejection(open, endedMs)
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
		open.gapEndMs = Math.max(open.segmentStartMs, closeAt - this.hangMs())
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
		open.carrierBase = open.carrierRequired ? this.readCarrierBlocks() : null
		this.attachPcm()
		this.announceIfQualified(open, now)
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

	/** Adds the open segment's carrier blocks (a failing or reset count adds none). */
	private collectCarrier(open: OpenTransmission): void {
		if (!open.carrierRequired || open.carrierBase === null) return
		const nowCount = this.readCarrierBlocks()
		if (nowCount !== null && nowCount >= open.carrierBase)
			open.carrierBlocks += nowCount - open.carrierBase
		open.carrierBase = nowCount
	}

	private carrierSoFar(open: OpenTransmission): number {
		let total = open.carrierBlocks
		if (open.segmentOpen && open.carrierBase !== null) {
			const nowCount = this.readCarrierBlocks()
			if (nowCount !== null && nowCount >= open.carrierBase)
				total += nowCount - open.carrierBase
		}
		return total
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
		endedMs: number,
	): keyof AnalogTransmissionSuppressed | null {
		if (endedMs - open.startedAtMs < this.hygiene.minDurationMs) return "short"
		if (
			open.carrierRequired &&
			open.carrierBlocks < this.hygiene.minCarrierBlocks
		)
			return "noCarrier"
		return null
	}

	/**
	 * Publishes the open event once the final duration is bound to reach the minimum (the
	 * audio end is at least `now - hang` while a segment is open) and the carrier rule holds.
	 */
	private announceIfQualified(open: OpenTransmission, now: number): void {
		if (open.announced || !open.segmentOpen) return
		if (
			this.hygiene.minDurationMs > 0 &&
			now - this.hangMs() - open.startedAtMs < this.hygiene.minDurationMs
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

	private reopenIfHeld(now: number): void {
		if (this.transmission || !this.attached) return
		if (!this.squelchIsOpen() || !this.canOpen()) return
		this.openTransmission(now)
	}

	private notePower(open: OpenTransmission, power: number | null): void {
		if (typeof power !== "number" || !Number.isFinite(power)) return
		open.powerCount += 1
		open.powerSum += power
		if (open.peak === null || power > open.peak) open.peak = power
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
		open: OpenTransmission,
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
			const tone = open.detector.result()
			const dcs =
				open.audioSeconds < DCS_MIN_AUDIO_SECONDS ? null : copyDcs(tone.dcs)
			if (open.audioSeconds < 0.75) {
				return { ctcssHz: null, dtmf: tone.dtmf, dcs }
			}
			return { ctcssHz: tone.ctcssHz, dtmf: tone.dtmf, dcs }
		} catch {
			this.toneErrorCount += 1
			return { ctcssHz: null, dtmf: null, dcs: null }
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
