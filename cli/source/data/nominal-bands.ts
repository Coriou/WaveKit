export interface TunedBand {
	kind: "tuned"
}

export interface ChannelBand {
	kind: "channels"
	channelsMHz: readonly number[]
	/** "alternatives" renders `a/b` (regional options); "span" renders `lo–hi` (a channel set). */
	join: "alternatives" | "span"
}

export type NominalBand = TunedBand | ChannelBand

const TUNED: TunedBand = { kind: "tuned" }

/** CLI-owned nominal table keyed by decoder TYPE (spec §10.9). */
export const NOMINAL_BANDS: Readonly<Record<string, NominalBand>> = {
	readsb: { kind: "channels", channelsMHz: [1090.0], join: "alternatives" },
	"ais-catcher": {
		kind: "channels",
		channelsMHz: [161.975, 162.025],
		join: "alternatives",
	},
	acarsdec: {
		kind: "channels",
		channelsMHz: [131.55, 131.725, 131.825],
		join: "span",
	},
	dumpvdl2: {
		kind: "channels",
		channelsMHz: [136.65, 136.7, 136.975],
		join: "span",
	},
	direwolf: {
		kind: "channels",
		channelsMHz: [144.39, 144.8],
		join: "alternatives",
	},
	rtl433: { kind: "channels", channelsMHz: [433.92], join: "alternatives" },
	"lora-meshtastic": {
		kind: "channels",
		channelsMHz: [869.525, 906.875],
		join: "alternatives",
	},
	"dsd-fme": TUNED,
	"multimon-ng": TUNED,
}

export function bandFor(type: string): NominalBand | undefined {
	return NOMINAL_BANDS[type]
}

const mhz3 = (mhz: number): string => mhz.toFixed(3)

/**
 * Render-time label (spec §10.9): `tuned`, `1090.000`, `161.975/162.025`, or
 * `131.550–131.825`. `range` is the glyph-table range mark (`glyphs().range`),
 * passed in so the data layer stays free of UI state.
 */
export function bandLabel(band: NominalBand, range: string): string {
	if (band.kind === "tuned") return "tuned"
	const ch = band.channelsMHz
	if (ch.length <= 1) return mhz3(ch[0] ?? 0)
	if (band.join === "alternatives") return ch.map(mhz3).join("/")
	return `${mhz3(Math.min(...ch))}${range}${mhz3(Math.max(...ch))}`
}

export type BandOrigin = "configured" | "nominal"

export interface DecoderBand {
	band: NominalBand
	/** Rendered next to the band so membership never reads as measured (T7). */
	origin: BandOrigin
	/** R40: configured targets of a tuned decoder, which core never applies. Annotation only. */
	ignoredTargetsHz?: readonly number[]
}

export interface BandSubject {
	type: string
	targetFrequenciesHz?: readonly number[]
}

/** All-or-nothing like the guards: one malformed target discards the list. */
function validTargets(d: BandSubject): readonly number[] | undefined {
	const t = d.targetFrequenciesHz
	if (t === undefined || t.length === 0) return undefined
	return t.every(hz => Number.isFinite(hz) && hz > 0) ? t : undefined
}

/**
 * R15: configured `targetFrequenciesHz` win over the nominal table for
 * channel decoders. R40: tuned types (dsd-fme, multimon-ng) always
 * demodulate the window centre, because core never applies their frequency
 * option, so they stay `tuned` and the targets are only annotated.
 */
export function decoderBand(d: BandSubject): DecoderBand | undefined {
	const nominal = bandFor(d.type)
	const targets = validTargets(d)
	if (nominal?.kind === "tuned") {
		return targets
			? { band: nominal, origin: "nominal", ignoredTargetsHz: targets }
			: { band: nominal, origin: "nominal" }
	}
	if (targets) {
		const channelsMHz = [...new Set(targets)]
			.sort((a, b) => a - b)
			.map(hz => hz / 1e6)
		return {
			band: { kind: "channels", channelsMHz, join: "span" },
			origin: "configured",
		}
	}
	return nominal ? { band: nominal, origin: "nominal" } : undefined
}

/** Decoder-detail annotation for ignored targets, e.g. `configured 446.525 MHz (not applied by this decoder)`. */
export function configuredNote(b: DecoderBand): string | null {
	const t = b.ignoredTargetsHz
	if (t === undefined || t.length === 0) return null
	return `configured ${t.map(hz => mhz3(hz / 1e6)).join(", ")} MHz (not applied by this decoder)`
}
