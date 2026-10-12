import type { OperatorActivityPort } from "./scanner/auto-resume.js"
import type { LiveDemodStatus } from "./live-demodulator.js"

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
			const gated =
				status.config.squelchMode === "auto" || status.config.squelch !== 0
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
