// Which Receiver island controls apply, why one is off, and what a failed write means. Pure.
//
// Receiver capabilities list every command the core implements with its transport applicability;
// they never claim the hardware supports one (physical support is always unknown on rtl_tcp). So a
// control is disabled only for a reason the core states (not an rtl_tcp source, command missing) or
// a tuner fact the gain table gives (offset tuning exists on the E4000 only).
import { RECEIVER_SAMPLE_RATE_PRESETS_HZ } from "@wavekit/api-types"
import type {
	ExtendedSourceStatus,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import type {
	CapsEntry,
	ControlError,
	ReceiverCaps,
	TunerRelayView,
} from "../../data/index.ts"

export type ReceiverControlId =
	| "gain"
	| "agcMode"
	| "sampleRate"
	| "ppm"
	| "biasTee"
	| "directSampling"
	| "offsetTuning"

export interface ControlAvailability {
	enabled: boolean
	/** Why it is disabled, or a caveat on an enabled one. */
	reason: string | null
}

export interface ReceiverLock {
	locked: boolean
	reason: string | null
	/** Control was released to an external client: POST control-mode internal takes it back. */
	canReclaim: boolean
}

/** Capability control ids each island control needs (gain needs gain mode too). */
const CAPS_IDS: Record<ReceiverControlId, readonly string[]> = {
	gain: ["gainMode", "gain"],
	agcMode: ["agcMode"],
	sampleRate: ["sampleRate"],
	ppm: ["ppm"],
	biasTee: ["biasTee"],
	directSampling: ["directSampling"],
	offsetTuning: ["offsetTuning"],
}

/** The tuner named by the capabilities' gain table, else null. */
export function tunerName(caps: ReceiverCaps | null): string | null {
	return caps?.gainTable?.state === "suggested" ? caps.gainTable.tuner : null
}

export function controlAvailability(
	id: ReceiverControlId,
	caps: ReceiverCaps | null,
): ControlAvailability {
	if (caps) {
		for (const capsId of CAPS_IDS[id]) {
			const control = caps.controls.find(c => c.id === capsId)
			if (!control)
				return { enabled: false, reason: "This core does not offer it" }
			if (control.transport.state !== "applicable")
				return {
					enabled: false,
					reason: "Not an rtl_tcp source: WaveKit cannot command it",
				}
		}
	}
	const tuner = tunerName(caps)
	if (id === "offsetTuning") {
		if (tuner !== null && tuner !== "E4000")
			return {
				enabled: false,
				reason: `Only E4000 tuners have offset tuning; this one is ${tuner}`,
			}
		return { enabled: true, reason: null }
	}
	if (id === "biasTee")
		return {
			enabled: true,
			reason: "Only dongles with a bias-T circuit (RTL-SDR Blog V3 and later)",
		}
	if (id === "directSampling")
		return {
			enabled: true,
			reason: "HF below 24 MHz; Q branch on RTL-SDR Blog V3 dongles",
		}
	return { enabled: true, reason: null }
}

/**
 * Why the whole panel cannot change the tuner, if it cannot: a protected core without a session,
 * control released to an external rtl_tcp client (SDR++ through the relay), or an offline source.
 */
export function receiverLock(input: {
	tuner: TunerState | undefined
	source: ExtendedSourceStatus | undefined
	readOnly: boolean
	relay: TunerRelayView | null
	/** The receiver feed is paused (feed.ts): nothing reaches the tuner until it resumes. */
	paused?: boolean
}): ReceiverLock {
	const { tuner, source, readOnly, relay } = input
	if (!tuner)
		return {
			locked: true,
			reason: "No tuner-controlled source",
			canReclaim: false,
		}
	if (readOnly)
		return {
			locked: true,
			reason: "Read-only: sign in to this core to change receiver settings.",
			canReclaim: false,
		}
	if (tuner.controlMode === "external") {
		const viaRelay = relay?.enabled && relay.sourceId === tuner.sourceId
		const who = relay?.controlClientRemote
			? `An rtl_tcp client at ${relay.controlClientRemote}`
			: viaRelay && relay.clientsConnected > 0
				? "An rtl_tcp client on the relay"
				: "An external client (SDR++)"
		return {
			locked: true,
			reason: `${who} has the tuner: WaveKit sends no commands until it takes control back.`,
			canReclaim: true,
		}
	}
	if (input.paused === true)
		return {
			locked: true,
			reason: "Receiver paused: resume it to change the tuner.",
			canReclaim: false,
		}
	if (source && !source.connected)
		return {
			locked: true,
			reason: "Receiver offline: the core cannot send tuner commands.",
			canReclaim: false,
		}
	return { locked: false, reason: null, canReclaim: false }
}

/** The line under the controls on who has the tuner (canvas: "WaveKit has control..."). */
export function controlNote(
	tuner: TunerState | undefined,
	relay: TunerRelayView | null,
): string | null {
	if (!tuner || tuner.controlMode !== "internal") return null
	if (relay?.enabled && relay.listening && relay.sourceId === tuner.sourceId)
		return relay.controlPolicy === "exclusive"
			? `WaveKit has control. SDR++ can take over through the relay on port ${relay.port}.`
			: `WaveKit has control. SDR++ on the relay (port ${relay.port}) shares it.`
	return "WaveKit has control of this receiver."
}

/** Sample rates to offer: the capabilities' presets, else the RTL-SDR presets; plus the current. */
export function sampleRateOptions(
	caps: ReceiverCaps | null,
	current: number | null,
): number[] {
	const presets = caps?.sampleRatePresets
	const base =
		presets?.state === "suggested"
			? presets.valuesHz
			: presets?.state === "not-applicable"
				? []
				: RECEIVER_SAMPLE_RATE_PRESETS_HZ
	const out = new Set(base)
	if (current !== null && out.size > 0) out.add(current)
	return [...out].sort((a, b) => a - b)
}

/** "2.4", "1.024", "0.25": the canvas's MS/s labels. */
export function rateLabel(hz: number): string {
	return String(Math.round(hz / 1000) / 1000)
}

/** Canvas: above 2.4 MS/s a network link may drop samples. */
export function rateWarning(hz: number): string | null {
	return hz > 2_400_000
		? "Above 2.4 MS/s the link may drop samples. Watch the throughput."
		: null
}

/** A note when the capabilities could not be read (the panel falls back to RTL-SDR defaults). */
export function capsNote(entry: CapsEntry | undefined): string | null {
	if (!entry || entry.status !== "error") return null
	return "Receiver capabilities unavailable: showing the RTL-SDR defaults."
}

export function isUnknownField(
	tuner: TunerState,
	field: TunerStateField,
): boolean {
	return tuner.unknownFields?.includes(field) ?? false
}

/** A failed write, in the panel's words. */
export function controlErrorText(error: ControlError): string {
	switch (error.code) {
		case "TUNER_CONTROL_EXTERNAL":
			return "An external client has the tuner: take control back first."
		case "TUNER_VALIDATION_ERROR":
			return `The core refused it: ${error.message}`
		case "TUNER_SOURCE_NOT_FOUND":
			return "The core no longer has this tuner source."
		case "AUTH_REQUIRED":
			return "Sign in to this core to change receiver settings."
		case "CSRF_REQUIRED":
			return "The session check failed: reload the page and try again."
		case "ORIGIN_FORBIDDEN":
		case "HOST_FORBIDDEN":
			return "The core refuses requests from this address."
		case "ACCESS_UNAVAILABLE":
			return "The core's access service is unavailable; try again shortly."
		case "RESPONSE_INVALID":
			return "The core answered something unexpected."
		case "NETWORK_ERROR":
			return "The core did not answer. Check the connection."
	}
	if (error.status === 0)
		return "The core did not answer. Check the connection."
	if (error.status === 400 && error.code === "VALIDATION_ERROR")
		return `The core refused the request: ${error.message}`
	return error.message
}
