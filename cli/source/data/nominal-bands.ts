import type { BandAssessment } from "./types.js"

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

/** Types come from the server: own keys only, so "constructor" or "__proto__" find nothing (R65 M2, R30). */
export function bandFor(type: string): NominalBand | undefined {
	return Object.hasOwn(NOMINAL_BANDS, type) ? NOMINAL_BANDS[type] : undefined
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
	if (ch.length === 0) return "?"
	if (ch.length === 1) return mhz3(ch[0] ?? 0)
	if (band.join === "alternatives") return ch.map(mhz3).join("/")
	return `${mhz3(Math.min(...ch))}${range}${mhz3(Math.max(...ch))}`
}

/**
 * Where the band comes from: core's bandAssessment basis (R84), `core` when
 * core sent targets with no basis this CLI knows, else configured targets or
 * the nominal table (older cores).
 */
export type BandOrigin =
	| "configured"
	| "protocol"
	| "decoder-default"
	| "core"
	| "nominal"

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
	bandAssessment?: BandAssessment
}

/** All-or-nothing like the guards: one malformed target discards the list. */
function validTargets(
	t: readonly number[] | undefined,
): readonly number[] | undefined {
	if (t === undefined || t.length === 0) return undefined
	return t.every(hz => Number.isFinite(hz) && hz > 0) ? t : undefined
}

const BASIS: Readonly<Record<string, BandOrigin>> = {
	configured: "configured",
	protocol: "protocol",
	"decoder-default": "decoder-default",
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every(x => b.includes(x))

function channelsFrom(
	targetsHz: readonly number[],
	nominal: NominalBand | undefined,
): ChannelBand {
	const channelsMHz = [...new Set(targetsHz)]
		.sort((a, b) => a - b)
		.map(hz => hz / 1e6)
	// Core's protocol list for AIS still reads as the table's alternatives.
	const join =
		nominal?.kind === "channels" && sameSet(channelsMHz, nominal.channelsMHz)
			? nominal.join
			: "span"
	return { kind: "channels", channelsMHz, join }
}

/**
 * R84: core's bandAssessment targets win, labelled by their basis. R15
 * (older cores): configured `targetFrequenciesHz` win over the nominal table for
 * channel decoders. R40: tuned types (dsd-fme, multimon-ng) always
 * demodulate the window centre, because core never applies their frequency
 * option, so they stay `tuned` and the targets are only annotated.
 */
export function decoderBand(d: BandSubject): DecoderBand | undefined {
	const nominal = bandFor(d.type)
	const targets = validTargets(d.targetFrequenciesHz)
	if (nominal?.kind === "tuned") {
		return targets
			? { band: nominal, origin: "nominal", ignoredTargetsHz: targets }
			: { band: nominal, origin: "nominal" }
	}
	const core = d.bandAssessment
	const coreTargets = validTargets(core?.targetsHz)
	if (coreTargets) {
		const basis = core?.basis
		return {
			band: channelsFrom(coreTargets, nominal),
			origin:
				basis !== undefined && Object.hasOwn(BASIS, basis)
					? (BASIS[basis] ?? "core")
					: "core",
		}
	}
	if (targets) {
		return { band: channelsFrom(targets, undefined), origin: "configured" }
	}
	return nominal ? { band: nominal, origin: "nominal" } : undefined
}

/** Decoder-detail annotation for ignored targets, e.g. `configured 446.525 MHz (not applied by this decoder)`. */
export function configuredNote(b: DecoderBand): string | null {
	const t = b.ignoredTargetsHz
	if (t === undefined || t.length === 0) return null
	return `configured ${t.map(hz => mhz3(hz / 1e6)).join(", ")} MHz (not applied by this decoder)`
}
