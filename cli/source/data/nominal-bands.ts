export type NominalBand =
	| { kind: "tuned"; label: "tuned" }
	| { kind: "channels"; channelsMHz: readonly number[]; label: string }

const TUNED: NominalBand = { kind: "tuned", label: "tuned" }

/** CLI-owned nominal table keyed by decoder TYPE (spec §10.9). Replaced by the API band when request 2 lands. */
export const NOMINAL_BANDS: Readonly<Record<string, NominalBand>> = {
	readsb: { kind: "channels", channelsMHz: [1090.0], label: "1090.000" },
	"ais-catcher": {
		kind: "channels",
		channelsMHz: [161.975, 162.025],
		label: "161.975/162.025",
	},
	acarsdec: {
		kind: "channels",
		channelsMHz: [131.55, 131.725, 131.825],
		label: "131.550–131.825",
	},
	dumpvdl2: {
		kind: "channels",
		channelsMHz: [136.65, 136.7, 136.975],
		label: "136.650–136.975",
	},
	direwolf: {
		kind: "channels",
		channelsMHz: [144.39, 144.8],
		label: "144.390/144.800",
	},
	rtl433: { kind: "channels", channelsMHz: [433.92], label: "433.920" },
	"lora-meshtastic": {
		kind: "channels",
		channelsMHz: [869.525, 906.875],
		label: "869.525/906.875",
	},
	"dsd-fme": TUNED,
	"multimon-ng": TUNED,
}

export function bandFor(type: string): NominalBand | undefined {
	return NOMINAL_BANDS[type]
}

export type BandOrigin = "configured" | "nominal"

export interface DecoderBand {
	band: NominalBand
	/** Rendered next to the band so membership never reads as measured (T7). */
	origin: BandOrigin
}

export interface BandSubject {
	type: string
	targetFrequenciesHz?: readonly number[]
}

const mhz3 = (mhz: number): string => mhz.toFixed(3)

/**
 * R15: configured `targetFrequenciesHz` (core request 2) win over the nominal
 * table, which stays the fallback. Non-finite or non-positive targets are ignored.
 */
export function decoderBand(d: BandSubject): DecoderBand | undefined {
	const targets = (d.targetFrequenciesHz ?? []).filter(
		hz => Number.isFinite(hz) && hz > 0,
	)
	if (targets.length > 0) {
		const channelsMHz = [...new Set(targets)]
			.sort((a, b) => a - b)
			.map(hz => hz / 1e6)
		const lo = channelsMHz[0] ?? 0
		const hi = channelsMHz[channelsMHz.length - 1] ?? lo
		const label =
			channelsMHz.length === 1 ? mhz3(lo) : `${mhz3(lo)}–${mhz3(hi)}`
		return {
			band: { kind: "channels", channelsMHz, label },
			origin: "configured",
		}
	}
	const band = bandFor(d.type)
	return band ? { band, origin: "nominal" } : undefined
}
