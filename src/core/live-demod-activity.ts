import type {
	LiveAudioSquelchMode,
	LiveAudioSquelchSetting,
} from "@wavekit/api-types"
import type { OperatorActivityPort } from "./scanner/auto-resume.js"
import type { LiveDemodConfig, LiveDemodStatus } from "./live-demodulator.js"

/**
 * Manual mode gates only when the threshold is non-zero. Squelch 0 stays open
 * for the whole run, so it is not operator activity and not a transmission.
 * Auto, open (Listen: detects at the auto threshold) and (WG7 req 2.4) noise mode always gate.
 * Open on the Rust engine does not gate: the engine has no detect-only stage yet and plays
 * ungated, so its gate stays open for the whole run like the old manual 0.
 */
export function liveDemodSquelchGates(
	config: {
		squelchMode?: LiveAudioSquelchSetting | undefined
		squelch: number
	},
	engine?: "csdr" | "rust",
): boolean {
	if (config.squelchMode === "open") return engine !== "rust"
	return (
		config.squelchMode === "auto" ||
		config.squelchMode === "noise" ||
		config.squelch !== 0
	)
}

/** Fields whose change ends an open analog transmission with reason `config`. */
export interface TransmissionConfigIdentity {
	sourceId?: string | undefined
	modulation: LiveDemodConfig["modulation"]
	bandwidth: number
	offsetHz?: number | undefined
	squelchMode?: LiveAudioSquelchSetting | undefined
}

/** Listen: the detection a squelch setting runs (open detects as auto); absent is manual. */
export function liveDemodDetectionMode(
	mode: LiveAudioSquelchSetting | undefined,
): LiveAudioSquelchMode {
	return mode === undefined ? "manual" : mode === "open" ? "auto" : mode
}

/**
 * True when a live-demod config change must end an open transmission.
 * Threshold-only edits (including `squelch` and `autoMarginDb`) do not.
 * `offsetHz` and `squelchMode` use the same defaults the demodulator applies.
 *
 * An absent `sourceId` means the resolved default (`resolvedSourceId`, the
 * demodulator status source). It is the same source as an explicit id equal
 * to that default (WG2 req 7.7). Callers that omit the resolved id keep the
 * old string comparison.
 */
export function liveDemodTransmissionConfigChanged(
	previous: TransmissionConfigIdentity,
	next: TransmissionConfigIdentity,
	resolvedSourceId?: string,
): boolean {
	return (
		effectiveSourceId(previous.sourceId, resolvedSourceId) !==
			effectiveSourceId(next.sourceId, resolvedSourceId) ||
		previous.modulation !== next.modulation ||
		previous.bandwidth !== next.bandwidth ||
		(previous.offsetHz ?? 0) !== (next.offsetHz ?? 0) ||
		liveDemodDetectionMode(previous.squelchMode) !==
			liveDemodDetectionMode(next.squelchMode)
	)
}

function effectiveSourceId(
	configured: string | undefined,
	resolved: string | undefined,
): string | undefined {
	if (configured !== undefined) return configured
	return resolved
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
 * non-zero threshold, auto mode, noise mode or open on csdr. Squelch 0 and open on
 * Rust are open for the whole run, so counting them would hold an always-on
 * demodulator forever and no scan would resume. No recorder reports activity yet,
 * so `recording` stays false.
 */
export function liveDemodOperatorActivity(
	liveDemod: ActivitySource,
): OperatorActivityPort {
	return {
		current: () => {
			const status = liveDemod.getStatus()
			const gated = liveDemodSquelchGates(status.config, status.engine)
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
