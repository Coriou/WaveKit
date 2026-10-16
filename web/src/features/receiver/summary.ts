// Receiver island wording. Pure.
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import { formatRate } from "../format.ts"

/** "29.7 dB", "Auto gain", or "Gain unknown" when the core never set or saw it. */
export function gainText(tuner: TunerState): string {
	if (tuner.unknownFields?.includes("gain")) return "Gain unknown"
	if (tuner.gainMode === "agc") return "Auto gain"
	return `${(tuner.gain / 10).toFixed(1)} dB`
}

/** The head's one line: "2.4 MS/s · 29.7 dB". */
export function receiverSummary(
	tuner: TunerState | undefined,
	source: ExtendedSourceStatus | undefined,
): string {
	if (!tuner && !source) return "No receiver"
	if (!tuner) return source?.connected ? "Connected" : "Offline"
	const parts = [formatRate(tuner.sampleRate), gainText(tuner)]
	if (tuner.agcMode) parts.push("AGC")
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
