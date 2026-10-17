import type {
	Classification,
	Hypothesis,
	Identity,
	ProtocolFamily,
	ScannerClass,
	ScannerProtocol,
} from "../types.js"
import type { TrackSnapshot } from "../../spectrum/types.js"

/**
 * Spectral-tier classification (spec §6.2): a coarse class from OBW, shape, envelope ACF and burst
 * length, then a ranked protocol hypothesis list multiplied by bandplan priors and cut to the job's
 * protocols. The channel tier (Task 41) refines it after the channelizer lands.
 */

const WIDEBAND_OBW_HZ = 25_000
const TDMA_ACF30_MAX = -0.5
const TDMA_ACF60_MIN = 0.5
const BURST_MAX_BLOCKS = 4
const FSK4_6K25_MAX_HZ = 5500
const FSK4_12K5_MAX_HZ = 10_500
const FSK2_WIDE_MAX_HZ = 14_000
const GMSK_MIN_HZ = 4000
const ANALOG_MIN_HZ = 7500
const ANALOG_MAX_HZ = 18_000
const DEFAULT_RBW_HZ = 1000
const LEAK_MIN_DB = 20

export const CLASS_HYPOTHESES: Readonly<
	Record<ScannerClass, readonly Hypothesis[]>
> = {
	"tdma-ms": [{ protocol: "dmr", score: 0.9 }],
	"fsk4-12k5": [
		{ protocol: "dmr", score: 0.55 },
		{ protocol: "ysf", score: 0.45 },
		{ protocol: "p25p1", score: 0.4 },
		{ protocol: "nxdn96", score: 0.3 },
	],
	"fsk4-6k25": [
		{ protocol: "nxdn48", score: 0.5 },
		{ protocol: "dpmr", score: 0.5 },
	],
	"gmsk-narrow": [
		{ protocol: "dstar", score: 0.6 },
		{ protocol: "digital-unknown", score: 0.2 },
	],
	"fsk2-wide": [
		{ protocol: "pocsag", score: 0.6 },
		{ protocol: "flex", score: 0.4 },
	],
	"afsk-fm": [
		{ protocol: "aprs", score: 0.7 },
		{ protocol: "analog-fm", score: 0.3 },
	],
	"analog-fm": [
		{ protocol: "analog-fm", score: 0.6 },
		{ protocol: "aprs", score: 0.2 },
	],
	"ook-burst": [
		{ protocol: "ism", score: 0.6 },
		{ protocol: "digital-unknown", score: 0.1 },
	],
	carrier: [{ protocol: "carrier", score: 0.8 }],
	wideband: [{ protocol: "unknown", score: 0.3 }],
	unknown: [
		{ protocol: "unknown", score: 0.3 },
		{ protocol: "digital-unknown", score: 0.2 },
	],
}

const FAMILY: Readonly<Record<ScannerProtocol, ProtocolFamily>> = {
	"analog-fm": "analog",
	"analog-am": "analog",
	dmr: "digital-voice",
	p25p1: "digital-voice",
	p25p2: "digital-voice",
	nxdn48: "digital-voice",
	nxdn96: "digital-voice",
	ysf: "digital-voice",
	dstar: "digital-voice",
	dpmr: "digital-voice",
	pocsag: "pager",
	flex: "pager",
	aprs: "packet",
	ism: "ism",
	"digital-unknown": "unknown",
	carrier: "carrier",
	unknown: "unknown",
	// WG7 req 1.1: packet data named from running decoders (ambient evidence only).
	ais: "packet",
	acars: "packet",
	vdl2: "packet",
	lora: "packet",
}

export function familyOf(p: ScannerProtocol): ProtocolFamily {
	return FAMILY[p]
}

export function classOf(
	track: TrackSnapshot,
	opts: { allowBurst?: boolean } = {},
): ScannerClass {
	if (track.obwHz > WIDEBAND_OBW_HZ) return "wideband"
	if (track.spectralShape === "narrow") return "carrier"
	if (
		track.acf30 !== undefined &&
		track.acf60 !== undefined &&
		track.acf30 <= TDMA_ACF30_MAX &&
		track.acf60 >= TDMA_ACF60_MIN
	) {
		return "tdma-ms"
	}
	if ((opts.allowBurst ?? true) && track.blocks <= BURST_MAX_BLOCKS)
		return "ook-burst"
	if (track.spectralShape === "flat") {
		if (track.obwHz <= FSK4_6K25_MAX_HZ) return "fsk4-6k25"
		if (track.obwHz <= FSK4_12K5_MAX_HZ) return "fsk4-12k5"
		if (track.obwHz <= FSK2_WIDE_MAX_HZ) return "fsk2-wide"
		return "unknown"
	}
	if (track.obwHz >= GMSK_MIN_HZ && track.obwHz < ANALOG_MIN_HZ)
		return "gmsk-narrow"
	if (track.obwHz >= ANALOG_MIN_HZ && track.obwHz <= ANALOG_MAX_HZ)
		return "analog-fm"
	return "unknown"
}

/** Multiply by priors (missing = 1), zero everything outside a non-empty job protocol list, clamp, sort. */
export function applyPriors(
	h: readonly Hypothesis[],
	ctx: {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	},
): Hypothesis[] {
	const only = ctx.protocols.length > 0 ? new Set(ctx.protocols) : null
	const out: Hypothesis[] = []
	for (const x of h) {
		if (only && !only.has(x.protocol)) continue
		const score = Math.min(
			1,
			Math.max(0, x.score * (ctx.priors[x.protocol] ?? 1)),
		)
		if (score > 0) out.push({ protocol: x.protocol, score })
	}
	return out.sort(
		(a, b) => b.score - a.score || a.protocol.localeCompare(b.protocol),
	)
}

export function classifySpectral(
	track: TrackSnapshot,
	ctx: {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	},
): Classification {
	const cls = classOf(track, { allowBurst: (ctx.priors.ism ?? 1) >= 1 })
	return {
		class: cls,
		hypotheses: applyPriors(CLASS_HYPOTHESES[cls], ctx),
		tier: "spectral",
	}
}

/**
 * Spec §6.2 caps: `adjacent-leak` when the track's decoded identity is also decoded ≥ 20 dB stronger
 * at another frequency in the window; `suspected-intermod` when the centre is within ±1 RBW of
 * 2f1 − f2 for two other tracks that are both stronger.
 */
export function leakOrIntermod(
	track: TrackSnapshot,
	others: TrackSnapshot[],
	decodedIdentityAt: (
		identity: Identity,
	) => { centreHz: number; peakDbfs: number }[],
	opts: { identity?: Identity; rbwHz?: number } = {},
): Classification["cap"] {
	const rbw = opts.rbwHz ?? DEFAULT_RBW_HZ
	if (opts.identity) {
		const apart = Math.max(rbw, track.obwHz / 2)
		const leak = decodedIdentityAt(opts.identity).some(
			o =>
				Math.abs(o.centreHz - track.centreHz) > apart &&
				o.peakDbfs - track.peakDbfs >= LEAK_MIN_DB,
		)
		if (leak) return "adjacent-leak"
	}
	const stronger = others.filter(
		o => o.trackId !== track.trackId && o.peakDbfs > track.peakDbfs,
	)
	for (const a of stronger) {
		for (const b of stronger) {
			if (a === b) continue
			if (Math.abs(2 * a.centreHz - b.centreHz - track.centreHz) <= rbw)
				return "suspected-intermod"
		}
	}
	return undefined
}
