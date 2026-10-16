// Demodulation modes of the Tuner island (live-audio `modulation`) and their bandwidth ranges (Tuner board).
import type { LiveAudioConfig } from "@wavekit/api-types"

export type Modulation = LiveAudioConfig["modulation"]

export interface ModeSpec {
	id: Modulation
	label: string
	/** Bandwidth slider [min, max, step, default] in Hz; null for RAW (no channel filter). */
	bw: readonly [number, number, number, number] | null
}

export const MODES: readonly ModeSpec[] = [
	{ id: "nfm", label: "NFM", bw: [5000, 25_000, 500, 12_500] },
	{ id: "am", label: "AM", bw: [3000, 20_000, 500, 10_000] },
	{ id: "wfm", label: "WFM", bw: [50_000, 250_000, 5000, 150_000] },
	{ id: "usb", label: "USB", bw: [1500, 4000, 100, 2400] },
	{ id: "lsb", label: "LSB", bw: [1500, 4000, 100, 2400] },
	{ id: "cw", label: "CW", bw: [100, 1000, 50, 500] },
	{ id: "raw", label: "RAW", bw: null },
]

export function modeSpec(id: Modulation): ModeSpec {
	return (
		MODES.find(m => m.id === id) ?? {
			id,
			label: id.toUpperCase(),
			bw: [1000, 250_000, 500, 12_500],
		}
	)
}

/** A band plan mode ("nfm", "NFM", "fm") as a live-audio modulation, if it is one. */
export function modulationOf(
	mode: string | null | undefined,
): Modulation | null {
	if (!mode) return null
	const m = mode.toLowerCase()
	if (m === "fm") return "nfm"
	return MODES.some(x => x.id === m) || m === "dsb" ? (m as Modulation) : null
}
