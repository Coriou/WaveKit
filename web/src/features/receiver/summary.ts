// Receiver island wording. Pure.
import type {
	ExtendedSourceStatus,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import { formatRate } from "../format.ts"

/** True when the core never commanded nor observed `field` (its value is a placeholder). */
export function isUnknown(tuner: TunerState, field: TunerStateField): boolean {
	return tuner.unknownFields?.includes(field) ?? false
}

/** "29.7 dB", "Auto gain", or "Gain unknown" when the core never set or saw it. */
export function gainText(tuner: TunerState): string {
	if (isUnknown(tuner, "gainMode") && isUnknown(tuner, "gain"))
		return "Gain unknown"
	if (!isUnknown(tuner, "gainMode") && tuner.gainMode === "agc")
		return "Auto gain"
	if (isUnknown(tuner, "gain")) return "Gain unknown"
	return `${(tuner.gain / 10).toFixed(1)} dB`
}

/**
 * "On", "Off", or "Unknown" for an on/off tuner setting. A core that never commanded the dongle (a
 * fresh rtl_tcp session) lists it in unknownFields with a placeholder value (agcMode: true).
 */
export function switchText(
	tuner: TunerState,
	field: "agcMode" | "biasTee" | "offsetTuning" | "testMode",
): string {
	if (isUnknown(tuner, field)) return "Unknown"
	return tuner[field] ? "On" : "Off"
}

/** The head's one line: "2.4 MS/s · 29.7 dB". */
export function receiverSummary(
	tuner: TunerState | undefined,
	source: ExtendedSourceStatus | undefined,
): string {
	if (!tuner && !source) return "No receiver"
	if (!tuner) return source?.connected ? "Connected" : "Offline"
	const parts = [formatRate(tuner.sampleRate), gainText(tuner)]
	if (tuner.agcMode && !isUnknown(tuner, "agcMode")) parts.push("AGC")
	if (source && !source.connected) parts.unshift("Offline")
	return parts.join(" · ")
}

/** A name for the source: its id, made readable ("pi-receiver" → "Pi receiver"). */
export function sourceTitle(
	source: ExtendedSourceStatus | undefined,
	tuner: TunerState | undefined,
): string {
	const id = source?.id ?? tuner?.sourceId
	if (!id) return "Receiver"
	const words = id.replace(/[-_]+/g, " ").trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}
