/**
 * Squelch-delimited analog transmissions of the live demodulator (WG1).
 *
 * One open event and one closed event share a transmission id. The frequency
 * is sampled when the transmission opens and is never rewritten. Activity
 * storage is a separate sink on the "closed" payload; this module does not
 * touch the store.
 */
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import type {
	AnalogTransmissionCloseReason,
	AnalogTransmissionEventData,
	AnalogTransmissionFrequency,
	AnalogTransmissionPayload,
	TunerState,
} from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"
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

export interface AnalogTransmissionSource {
	getStatus(): LiveDemodStatus
	isSquelchOpen(): boolean
	squelchHangMs(): number
	/**
	 * Set by LiveDemodulator while stop() or a transmission-closing
	 * reconfigure() emits squelch-changed(false) ahead of stopped/config-changed.
	 */
	transmissionCloseOverride?(): "stopped" | "config" | null
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
	squelchMode: "manual" | "auto"
	thresholdDbfs: number
	config: TransmissionConfigIdentity
	peak: number | null
	powerSum: number
	powerCount: number
}

type AssertExtends<T extends U, U> = T
type _LiveDemodulatorIsAnalogSource = AssertExtends<
	LiveDemodulator,
	AnalogTransmissionSource
>

/**
 * Event-time frequency port from the tuner (WG1 req 3.4): the tuned centre
 * plus the demodulator offset. Trust follows the spectrum engine's rule
 * (external control is "relay", otherwise "commanded"). Null when the source
 * has no tuner state or its centre is a placeholder the core never commanded
 * or observed.
 */
export function tunerFrequencyAt(
	getState: (
		sourceId: string,
	) =>
		| Pick<TunerState, "frequency" | "controlMode" | "unknownFields">
		| undefined,
): AnalogTransmissionTrackerOptions["frequencyAt"] {
	return (sourceId, offsetHz) => {
		const state = getState(sourceId)
		if (!state || state.unknownFields?.includes("frequency")) return null
		return {
			hz: state.frequency + offsetHz,
			tuningTrust: state.controlMode === "external" ? "relay" : "commanded",
		}
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
		thresholdDbfs: event.thresholdDbfs,
		peakChannelPowerDbfs: event.peakChannelPowerDbfs,
		meanChannelPowerDbfs: event.meanChannelPowerDbfs,
		closeReason: event.closeReason,
	}
}

export class AnalogTransmissionTracker extends EventEmitter<AnalogTransmissionTrackerEvents> {
	private readonly source: AnalogTransmissionSource
	private readonly frequencyAt: AnalogTransmissionTrackerOptions["frequencyAt"]
	private readonly now: () => number
	private readonly newId: () => string
	private readonly maxDurationMs: number
	private transmission: OpenTransmission | null = null
	private attached = false

	constructor(options: AnalogTransmissionTrackerOptions) {
		super()
		this.source = options.source
		this.frequencyAt = options.frequencyAt
		this.now = options.now ?? (() => Date.now())
		this.newId = options.randomUUID ?? randomUUID
		const max = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
		this.maxDurationMs =
			Number.isFinite(max) && max >= 0 ? max : DEFAULT_MAX_DURATION_MS
	}

	start(): void {
		if (this.attached) return
		this.attached = true
		this.source.on("squelch-changed", this.handleSquelch)
		this.source.on("level", this.handleLevel)
		this.source.on("config-changed", this.handleConfig)
		this.source.on("stopped", this.handleStopped)
	}

	/** Closes an open transmission with "stopped", then detaches. */
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

	current(): AnalogTransmissionEventData | null {
		const open = this.transmission
		if (!open) return null
		return this.openEvent(open)
	}

	private readonly handleSquelch = (open: boolean): void => {
		this.guard(() => {
			const now = this.clock()
			if (open) {
				if (this.transmission || !this.canOpen()) return
				this.openTransmission(now)
				return
			}
			if (!this.transmission) return
			this.close(this.squelchCloseReason(), now)
		})
	}

	private readonly handleLevel = (level: LiveAudioLevel): void => {
		this.guard(() => {
			const open = this.transmission
			if (!open) return
			this.notePower(open, level.channelPowerDbfs)
			const now = this.clock()
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
			if (!liveDemodTransmissionConfigChanged(open.config, config)) return
			this.close("config", this.clock())
		})
	}

	private readonly handleStopped = (): void => {
		this.guard(() => {
			if (!this.transmission) return
			this.close("stopped", this.clock())
		})
	}

	private detach(): void {
		if (!this.attached) return
		this.attached = false
		this.source.off("squelch-changed", this.handleSquelch)
		this.source.off("level", this.handleLevel)
		this.source.off("config-changed", this.handleConfig)
		this.source.off("stopped", this.handleStopped)
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
		this.transmission = {
			transmissionId: this.newId(),
			sourceId: status.sourceId,
			startedAtMs: now,
			startedAt: new Date(now).toISOString(),
			frequency,
			modulation: status.config.modulation,
			bandwidthHz: status.config.bandwidth,
			squelchMode: status.config.squelchMode ?? "manual",
			thresholdDbfs:
				typeof threshold === "number" && Number.isFinite(threshold)
					? threshold
					: status.config.squelch,
			config: configIdentity(status.config),
			peak: null,
			powerSum: 0,
			powerCount: 0,
		}
		this.publish(this.openEvent(this.transmission))
	}

	private close(reason: AnalogTransmissionCloseReason, closeAt: number): void {
		const open = this.transmission
		if (!open) return
		this.transmission = null
		// Only a squelch close happens a hang after the last above-threshold
		// block; retune, max-duration, stop and config end at the close itself.
		const endedMs =
			reason === "squelch"
				? Math.max(open.startedAtMs, closeAt - this.hangMs())
				: closeAt
		const event = this.closedEvent(open, reason, endedMs)
		this.publish(event)
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
			thresholdDbfs: open.thresholdDbfs,
			peakChannelPowerDbfs: open.peak,
			meanChannelPowerDbfs: meanOf(open),
			closeReason: reason,
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
