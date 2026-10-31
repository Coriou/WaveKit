// Receiver island wording. Pure.
import type {
	ExtendedSourceStatus,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import { formatMHz, formatRate } from "../format.ts"

/** True when the core never commanded nor observed `field` (its value is a placeholder). */
export function isUnknown(tuner: TunerState, field: TunerStateField): boolean {
	return tuner.unknownFields?.includes(field) ?? false
}

/**
 * True when the core measured `field` from the stream (an adopted sample rate after a plain resume of
 * a paused feed): the value is what the receiver delivers, though nothing wrote it.
 */
export function isMeasured(tuner: TunerState, field: TunerStateField): boolean {
	return (
		isUnknown(tuner, field) && (tuner.measuredFields?.includes(field) ?? false)
	)
}

/** A placeholder with nothing behind it: no last known value to show. */
function hasValue(hz: number): boolean {
	return Number.isFinite(hz) && hz > 0
}

/**
 * The Centre row: "145.000 MHz", or after a plain resume (another client may have retuned the receiver)
 * "last known 145.000 MHz · unverified", or "Unknown" when the core has no value.
 */
export function centreText(tuner: TunerState | undefined): string {
	if (!tuner) return "—"
	const text = `${formatMHz(tuner.frequency)} MHz`
	if (!isUnknown(tuner, "frequency")) return text
	return hasValue(tuner.frequency)
		? `last known ${text} · unverified`
		: "Unknown"
}

/**
 * The sample rate in words: "2.4 MS/s"; "2.16 MS/s · measured" when the core adopted the rate it
 * measures; "last known 2.4 MS/s · unverified" when nothing backs it; `unknown` without a value.
 */
export function rateText(tuner: TunerState, unknown = "Unknown"): string {
	const text = formatRate(tuner.sampleRate)
	if (!isUnknown(tuner, "sampleRate")) return text
	if (!hasValue(tuner.sampleRate)) return unknown
	return isMeasured(tuner, "sampleRate")
		? `${text} · measured`
		: `last known ${text} · unverified`
}

/** Under the rate control while the rate is unverified: what the shown rate is and how to set one. */
export function rateDoubtNote(tuner: TunerState): string | null {
	if (!isUnknown(tuner, "sampleRate")) return null
	if (!hasValue(tuner.sampleRate)) return "Rate unknown: pick a rate to set it."
	const rate = formatRate(tuner.sampleRate)
	return isMeasured(tuner, "sampleRate")
		? `Measured from the stream: ${rate}. Nothing has set it; pick a rate to set it.`
		: `Unverified: another client may have changed it. Last known ${rate}; pick a rate to set it.`
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

/** The head's one line: "2.4 MS/s · 29.7 dB" (the rate as rateText words it). */
export function receiverSummary(
	tuner: TunerState | undefined,
	source: ExtendedSourceStatus | undefined,
): string {
	if (!tuner && !source) return "No receiver"
	if (!tuner) return source?.connected ? "Connected" : "Offline"
	const parts = [rateText(tuner, "Rate unknown"), gainText(tuner)]
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
