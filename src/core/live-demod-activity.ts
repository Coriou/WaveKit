import type { OperatorActivityPort } from "./scanner/auto-resume.js"
import type { LiveDemodConfig, LiveDemodStatus } from "./live-demodulator.js"

/**
 * Manual mode gates only when the threshold is non-zero. Squelch 0 stays open
 * for the whole run, so it is not operator activity and not a transmission.
 */
export function liveDemodSquelchGates(config: {
	squelchMode?: "manual" | "auto" | undefined
	squelch: number
}): boolean {
	return config.squelchMode === "auto" || config.squelch !== 0
}

/** Fields whose change ends an open analog transmission with reason `config`. */
export interface TransmissionConfigIdentity {
	sourceId?: string | undefined
	modulation: LiveDemodConfig["modulation"]
	bandwidth: number
	offsetHz?: number | undefined
	squelchMode?: "manual" | "auto" | undefined
}

/**
 * True when a live-demod config change must end an open transmission.
 * Threshold-only edits (including `squelch` and `autoMarginDb`) do not.
 * `offsetHz` and `squelchMode` use the same defaults the demodulator applies.
 */
export function liveDemodTransmissionConfigChanged(
	previous: TransmissionConfigIdentity,
	next: TransmissionConfigIdentity,
): boolean {
	return (
		previous.sourceId !== next.sourceId ||
		previous.modulation !== next.modulation ||
		previous.bandwidth !== next.bandwidth ||
		(previous.offsetHz ?? 0) !== (next.offsetHz ?? 0) ||
		(previous.squelchMode ?? "manual") !== (next.squelchMode ?? "manual")
	)
}

const CHANGE_EVENTS = [
	"squelch-changed",
	"client-connected",
	"client-disconnected",
	"config-changed",
	"started",
	"stopped",
] as const

type ChangeEvent = (typeof CHANGE_EVENTS)[number]

/** The slice of LiveDemodulator this port reads. */
export interface ActivitySource {
	getStatus(): LiveDemodStatus
	isSquelchOpen(): boolean
	on(event: ChangeEvent, listener: () => void): unknown
	off(event: ChangeEvent, listener: () => void): unknown
}

/**
 * Scanner auto-resume port backed by the live demodulator.
 *
 * Audio holds the resume timer only while someone is listening (at least one
 * audio client) through a squelch that actually gates: manual mode with a
 * non-zero threshold, or auto mode. Squelch 0 is open for the whole run, so
 * counting it would hold an always-on demodulator forever and no scan would
 * resume. No recorder reports activity yet, so `recording` stays false.
 */
export function liveDemodOperatorActivity(
	liveDemod: ActivitySource,
): OperatorActivityPort {
	return {
		current: () => {
			const status = liveDemod.getStatus()
			const gated = liveDemodSquelchGates(status.config)
			return {
				audio:
					status.running &&
					gated &&
					status.clientCount > 0 &&
					liveDemod.isSquelchOpen(),
				recording: false,
				sourceId: status.sourceId,
			}
		},
		onChange: callback => {
			const changed = () => callback()
			for (const event of CHANGE_EVENTS) liveDemod.on(event, changed)
			return () => {
				for (const event of CHANGE_EVENTS) liveDemod.off(event, changed)
			}
		},
	}
}
