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
/**
 * A steady line (an unmodulated carrier, a clock harmonic) is a `carrier` when it is on at least
 * 90 % of the time (keyed CW at about 50 % and data bursts stay `unknown`) and its spectrum is a
 * carrier's (`carrierLine`).
 */
export const CARRIER_STEADY_DUTY_MIN = 0.9
/**
 * `carrierLine`: a carrier's -20 dB width is at most 4 bins of the track's own FFT (inclusive).
 * A Hann-windowed pure tone with at least 20 dB SNR reads 3 bins on a bin centre (the ±2-bin
 * neighbours are window zeros) and 4 bins half a bin off (±1.5 bins at -15.4 dB): 3 000 or
 * 4 000 Hz at 1.024 Msps with 1 024 bins (1 000 Hz), 3 516 or 4 688 Hz at 2.4 Msps with 2 048
 * bins (1 171.875 Hz). A Hz cut can never hold both rates; bins do.
 */
export const CARRIER_LINE_MAX_BINS = 4
/**
 * `carrierLine`, peaked shape: a pure tone on a bin centre has its ±1 neighbours at -6.02 dB, so
 * noise can lift them over the -6 dB line: 3 bins at -6 dB (shape `peaked`, not `narrow`). A
 * peaked line is a carrier only when its -6 dB width is known and at most 3 bins; with the width
 * unknown it keeps the pre-existing path (its digital trials).
 */
export const CARRIER_PEAKED_MAX_BINS_6DB = 3
/**
 * `carrierLine`, flat shape: a tone 3 bins wide reads `flat` or `peaked` by noise alone (its ±1
 * neighbours sit at -6.02 dB, right at the flat-top median line). Narrow digital flat tops (dPMR,
 * NXDN48: about 4 kHz occupied) are wider than 3 bins at -20 dB at every default bin up to
 * 4 000 / 3 = 1 333 Hz (1 000 Hz at 1.024 and 2.048 Msps, 1 171.875 Hz at 2.4 Msps). So a flat
 * line is a carrier only at most 3 bins wide at -20 dB with a known -6 dB width.
 */
export const CARRIER_FLAT_MAX_BINS = 3
/** Bin width assumed when a track does not carry its own (Hz): the engine's default RBW. */
export const CARRIER_DEFAULT_BIN_HZ = DEFAULT_RBW_HZ

/**
 * One shared rule: does this measurement read as a carrier line (an unmodulated tone)? Used by
 * classOf's steady-carrier rule, `steadyLine` (LO-locked spurs) and the carrier-aware analog row.
 * - The -20 dB width is at most `CARRIER_LINE_MAX_BINS` bins of `binHz` (the track's FFT bin,
 *   sample rate / FFT size; `CARRIER_DEFAULT_BIN_HZ` when absent or malformed).
 * - The shape separates narrow digital (dPMR, NXDN48: 4FSK flat tops about 4 kHz wide) from a
 *   tone: `narrow` (at most 2 bins at -6 dB) is a carrier; `peaked` only with a known -6 dB width
 *   (`obw6Hz`) of at most `CARRIER_PEAKED_MAX_BINS_6DB` bins; `flat` only with a known -6 dB width
 *   and at most `CARRIER_FLAT_MAX_BINS` bins at -20 dB. With the -6 dB width unknown, peaked and
 *   flat lines keep the pre-existing path.
 * - `spectralShape` undefined: the caller already judged the shape (an observation whose class
 *   vote is `carrier`); only the width decides.
 * Non-finite or non-positive widths are not a carrier line (the safe answer: today's path).
 */
export function carrierLine(line: {
	obwHz: number
	spectralShape?: TrackSnapshot["spectralShape"] | undefined
	obw6Hz?: number | undefined
	binHz?: number | undefined
}): boolean {
	const bin =
		typeof line.binHz === "number" &&
		Number.isFinite(line.binHz) &&
		line.binHz > 0
			? line.binHz
			: CARRIER_DEFAULT_BIN_HZ
	if (!(Number.isFinite(line.obwHz) && line.obwHz > 0)) return false
	if (!withinBins(line.obwHz, CARRIER_LINE_MAX_BINS, bin)) return false
	switch (line.spectralShape) {
		case undefined:
		case "narrow":
			return true
		case "flat":
			return (
				known6(line.obw6Hz) &&
				withinBins(line.obwHz, CARRIER_FLAT_MAX_BINS, bin)
			)
		case "peaked":
			return (
				known6(line.obw6Hz) &&
				withinBins(line.obw6Hz, CARRIER_PEAKED_MAX_BINS_6DB, bin)
			)
		default:
			return false
	}
}

function known6(hz: number | undefined): hz is number {
	return typeof hz === "number" && Number.isFinite(hz) && hz > 0
}

/** `hz` is at most `bins` bins of `binHz` (inclusive; widths are whole bins, so 1 ppm slack). */
function withinBins(hz: number, bins: number, binHz: number): boolean {
	return hz <= bins * binHz * (1 + 1e-6)
}

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
		// Scanner-redesign 3.12: narrow FM voice often measures as fsk4-12k5.
		{ protocol: "analog-fm", score: 0.3 },
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
	// Detection-quality 1.17: a voice-modulated AM carrier (see `isAmVoice`).
	"analog-am": [
		{ protocol: "analog-am", score: 0.7 },
		{ protocol: "carrier", score: 0.2 },
	],
	"ook-burst": [
		{ protocol: "ism", score: 0.6 },
		{ protocol: "digital-unknown", score: 0.1 },
	],
	carrier: [{ protocol: "carrier", score: 0.8 }],
	wideband: [
		{ protocol: "unknown", score: 0.3 },
		{ protocol: "analog-fm", score: 0.3 },
	],
	unknown: [
		{ protocol: "unknown", score: 0.3 },
		{ protocol: "digital-unknown", score: 0.2 },
	],
}

/**
 * (pager classification): inside a paging range (the covering band plan lists `pocsag`
 * or `flex`, so its prior is at least 1) the classes a pager burst measures as get pager
 * hypotheses ahead of the class's digital-voice ones. A 1200/2400 Bd POCSAG or FLEX burst with
 * ±4.5 kHz deviation (about 9 kHz tone spacing) measures as `fsk2-wide`, as `fsk4-12k5` when its
 * occupied bandwidth reads at or below 10.5 kHz, or as `analog-fm` when its spectrum is not flat.
 * Scores: each pager score is above the class's first non-pager score (`fsk4-12k5`: pocsag 0.6 and flex
 * 0.56 > dmr 0.55; `analog-fm`: pocsag 0.65 and flex 0.62 >
 * analog-fm 0.6), so under equal priors (a range listing
 * both) the pager trial still comes first; outside a paging range nothing is added.
 */
export const PAGER_RANGE_HYPOTHESES: Readonly<
	Partial<Record<ScannerClass, readonly Hypothesis[]>>
> = {
	"fsk2-wide": [
		{ protocol: "pocsag", score: 0.6 },
		{ protocol: "flex", score: 0.4 },
	],
	"fsk4-12k5": [
		{ protocol: "pocsag", score: 0.6 },
		{ protocol: "flex", score: 0.56 },
	],
	"analog-fm": [
		{ protocol: "pocsag", score: 0.65 },
		{ protocol: "flex", score: 0.62 },
	],
}

/** A range lists `p` when its prior is a finite number of at least 1 (malformed: not listed). */
function listedIn(
	priors: Partial<Record<ScannerProtocol, number>>,
	p: ScannerProtocol,
): boolean {
	const v = priors[p]
	return typeof v === "number" && Number.isFinite(v) && v >= 1
}

/** True when the priors come from a range that lists a pager protocol (prior at least 1). */
export function inPagerRange(
	priors: Partial<Record<ScannerProtocol, number>>,
): boolean {
	return listedIn(priors, "pocsag") || listedIn(priors, "flex")
}

/**
 * Detection-quality 1.17 (AM voice): the -20 dB OBW window of a voice-modulated AM carrier. The
 * carrier holds most of the power, so its -6 dB width is a carrier's (shape `narrow`, at most 2
 * bins); the speech sidebands (300 to 3 000 Hz each side) widen the -20 dB OBW. A Hann-windowed
 * unmodulated carrier stays inside its main lobe (±2 bins): at most 4 bins, measured 3 to 4 bins
 * from 10 to 30 dB. The engine's default bin (`defaultFftSize`: fs / 1 000 rounded to a power of
 * two) is 1 000 / √2 to 1 000 × √2 = 0.71 to 1.41 kHz, so a carrier reads at most 4 × 1.41 =
 * 5.66 kHz; 6 000 Hz is past that. AM voice (sidebands to 3 kHz each side) measured 6 to 7 kHz
 * from 10 to 20 dB. 12 500 Hz = half a 25 kHz AM channel, past ±3 kHz audio plus drift.
 */
export const AM_VOICE_MIN_OBW_HZ = 6_000
export const AM_VOICE_MAX_OBW_HZ = 12_500

/**
 * Detection-quality 1.17: hypotheses of a voice-modulated AM carrier. `analog-am` first; the
 * carrier stays a weak second (a carrier with a nearby spur can widen its OBW too).
 */
export const AM_VOICE_HYPOTHESES: readonly Hypothesis[] =
	CLASS_HYPOTHESES["analog-am"]

/**
 * Detection-quality 1.17: inside a range that lists `analog-am`, is this track a voice-modulated
 * AM carrier rather than a bare carrier? A carrier-shaped (`narrow`) track with a -20 dB OBW in
 * [`AM_VOICE_MIN_OBW_HZ`, `AM_VOICE_MAX_OBW_HZ`]; in a range listing AM but not FM (airband),
 * a `peaked` track in that window too (a carrier on a bin centre spreads its -6 dB width to 3
 * bins). Flat tops (data such as VDL2), bursts (at most 4 blocks) and any non-finite or
 * malformed field: false, the safe answer (today's class).
 */
export function isAmVoice(
	track: TrackSnapshot,
	priors: Partial<Record<ScannerProtocol, number>>,
): boolean {
	if (typeof track !== "object" || track === null) return false
	if (typeof priors !== "object" || priors === null) return false
	if (!listedIn(priors, "analog-am")) return false
	const obw = track.obwHz
	if (typeof obw !== "number" || !Number.isFinite(obw)) return false
	if (obw < AM_VOICE_MIN_OBW_HZ || obw > AM_VOICE_MAX_OBW_HZ) return false
	if (
		typeof track.blocks !== "number" ||
		!Number.isFinite(track.blocks) ||
		track.blocks <= BURST_MAX_BLOCKS
	)
		return false
	if (track.spectralShape === "narrow") return true
	return track.spectralShape === "peaked" && !listedIn(priors, "analog-fm")
}

/**
 * The class's hypotheses, plus the pager ones inside a paging range (a pager score replaces a
 * lower score of the same protocol). Unknown or malformed priors add nothing (the safe answer:
 * today's list).
 */
export function classHypotheses(
	cls: ScannerClass,
	priors: Partial<Record<ScannerProtocol, number>>,
): readonly Hypothesis[] {
	const base = CLASS_HYPOTHESES[cls]
	const pager = PAGER_RANGE_HYPOTHESES[cls]
	if (pager === undefined || !inPagerRange(priors)) return base
	const out = new Map<ScannerProtocol, number>()
	for (const h of [...pager, ...base])
		out.set(h.protocol, Math.max(out.get(h.protocol) ?? 0, h.score))
	return [...out].map(([protocol, score]) => ({ protocol, score }))
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
	adsb: "packet",
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
	// Two FSK tones (a pager or a narrow ISM sensor): data, not FM voice, whatever the hump shape.
	if (track.fsk2 === true) return "fsk2-wide"
	// A steady carrier line (`carrierLine`), before the flat-top branch: a 3-bin tone can read flat.
	if (steadyLine(track) === true) return "carrier"
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

/**
 * A steady narrow line (the steady-carrier class rule and the LO-locked spur rule): a carrier line
 * (`carrierLine`: at most 4 bins at -20 dB, not a flat top), over `BURST_MAX_BLOCKS` (4) blocks and
 * on at least `CARRIER_STEADY_DUTY_MIN` (90 %) of the time. Keyed CW, data bursts, narrow digital
 * flat tops and anything modulated wider are not. `undefined` while the track has 4 blocks or fewer
 * (too young to tell); non-finite width or duty is not a steady line.
 */
export function steadyLine(track: {
	obwHz: number
	blocks: number
	dutyCycle: number
	spectralShape?: TrackSnapshot["spectralShape"] | undefined
	obw6Hz?: number | undefined
	binHz?: number | undefined
}): boolean | undefined {
	if (!Number.isFinite(track.obwHz) || !Number.isFinite(track.dutyCycle))
		return false
	if (!carrierLine({ ...track, spectralShape: track.spectralShape ?? "flat" }))
		return false
	if (!(track.blocks > BURST_MAX_BLOCKS)) return undefined
	return track.dutyCycle >= CARRIER_STEADY_DUTY_MIN
}

/** Priors order hypotheses; even an out-of-band protocol remains eligible. */
export function protocolPrior(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0.001, value)
		: 1
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
			Math.max(0, x.score * protocolPrior(ctx.priors[x.protocol])),
		)
		if (score > 0) out.push({ protocol: x.protocol, score })
	}
	return out.sort(
		(a, b) => b.score - a.score || a.protocol.localeCompare(b.protocol),
	)
}

/**
 * Measurement and trial order only. The result does not set a discovery's
 * protocol, family or confidence; `labelFromEvidence` does that.
 */
export function classifySpectral(
	track: TrackSnapshot,
	ctx: {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	},
): Classification {
	// Detection-quality 1.17: a voice-modulated AM carrier is not a bare `carrier`; its class is
	// `analog-am` and the hypotheses lead with AM.
	if (isAmVoice(track, ctx.priors))
		return {
			class: "analog-am",
			hypotheses: applyPriors(AM_VOICE_HYPOTHESES, ctx),
			tier: "spectral",
		}
	const cls = classOf(track, { allowBurst: (ctx.priors.ism ?? 1) >= 1 })
	return {
		class: cls,
		hypotheses: applyPriors(classHypotheses(cls, ctx.priors), ctx),
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
