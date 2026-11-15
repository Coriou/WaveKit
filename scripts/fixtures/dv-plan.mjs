/**
 * Transmission plans for the digital voice capture harness
 * (tests/integration/dv-capture.ts): a timeline of overs with true key-up and
 * key-down, the carrier off (noise only, once fmCu8 adds it) between them,
 * per protocol. The other generators are kind to the decoder (settle bursts,
 * duplicate headers, a 0.1 s lead); a plan is not: an over starts at its
 * first header (or mid-superframe, `lateEntry`, DMR) and ends at its last
 * frame, with or without its terminator.
 *
 * The plan is the truth: `transmissionPlan` returns each over as sent (its
 * start and end in ms of the frequency trace, its slot and identities, the
 * checked frames it carries), and the harness scores the decoder's calls
 * against them.
 *
 * Times: an over's `startMs` is rounded to the protocol's frame (DMR 60 ms)
 * or symbol; its length to whole frames, at least one header, one voice frame
 * and (when sent) the terminator: DMR to the nearest burst (at most 30 ms
 * long), the others down to whole superframes (never longer than asked, so a
 * 0.2 s gap stays a gap). Returned times include shapeFrequency's
 * `padSymbols` lead (8 symbols), so they are times in `freq` and `envelope`.
 */
import { dmrPlanDibits } from "./dmr-4fsk.mjs"
import { dpmrCallDibits } from "./dpmr-4fsk.mjs"
import { dstarBits } from "./dstar-gmsk.mjs"
import { AIR_SHAPES, shapeFrequency } from "./fsk-iq.mjs"
import { NXDN_RATES, nxdnCallDibits } from "./nxdn-4fsk.mjs"
import { p25CallDibits, p25Deviation, p25TduDibits } from "./p25-c4fm.mjs"
import { ysfCallDibits, ysfHeaderDibits } from "./ysf-c4fm.mjs"

/** The symbol of carrier-off time in a plan (deviation 0, envelope 0). */
export const KEYED_OFF = 4
/** shapeFrequency's lead and tail (symbols). */
export const PAD_SYMBOLS = 8

export const DV_PROTOCOLS = ["dmr", "dstar", "ysf", "p25", "nxdn48", "dpmr"]

/** Made-up identities, the chain tests' own (tests/helpers/synthetic-decodes.ts SYNTHETIC). */
const DEFAULT_IDS = {
	dmr: { talkgroup: 4321, source: 1_234_567 },
	dstar: { my: "N0CALL" },
	ysf: { src: "N0CALL" },
	p25: { talkgroup: 4321, source: 1_234_567 },
	nxdn48: { talkgroup: 5678, source: 1234 },
	dpmr: { talkgroup: 1234, source: 5678 },
}

const dpmrId = n => String(n).padStart(7, "0")

/**
 * One over of a non-DMR protocol as symbols from its key-up, with the frames
 * that carry a checked field (as dsd-fme-margin.test.ts counts them).
 */
const BUILDERS = {
	ysf: (over, ids, k) => {
		// 100 ms frames: header, V/D type 2 frames (FT up to 7), terminator.
		const vd = Math.max(1, Math.floor(over.durationMs / 100) - 2)
		// The most V/D frames up to vd as FT (1 to 8) times superframes.
		let frames = 1
		let superframes = vd
		for (let f = 2; f <= 8; f++)
			if (f * Math.floor(vd / f) > frames * superframes) {
				frames = f
				superframes = Math.floor(vd / f)
			}
		const call = { dest: "ALL", src: ids.src, dgid: 21, seed: 5 + k }
		let symbols = ysfCallDibits({
			...call,
			frames,
			superframes,
			coldKeyUp: true,
		})
		const terminator = over.terminator ?? true
		if (!terminator)
			symbols = symbols.slice(
				0,
				symbols.length - ysfHeaderDibits({ fi: 2, ...call }).length,
			)
		return {
			symbols,
			frames: 1 + frames * superframes + (terminator ? 1 : 0),
			terminator,
		}
	},
	p25: (over, ids) => {
		// HDU (about 82 ms), LDU1/LDU2 pairs of 360 ms, TDU.
		const superframes = Math.max(1, Math.floor((over.durationMs - 100) / 360))
		const nac = 0x2a5
		let symbols = p25CallDibits({ nac, ...ids, superframes, coldKeyUp: true })
		const terminator = over.terminator ?? true
		if (!terminator)
			symbols = symbols.slice(0, symbols.length - p25TduDibits({ nac }).length)
		return { symbols, frames: superframes, terminator }
	},
	nxdn48: (over, ids, k) => {
		// One FACCH1 VCALL frame, superframes of 4 frames of 80 ms, the TX_REL frame.
		const terminator = over.terminator ?? true
		const ends = terminator ? 160 : 80
		const superframes = Math.max(1, Math.floor((over.durationMs - ends) / 320))
		return {
			symbols: nxdnCallDibits({
				ran: 5,
				source: ids.source,
				destination: ids.talkgroup,
				superframes,
				release: terminator,
				seed: 9 + k,
				coldKeyUp: true,
			}),
			frames: 4 * superframes,
			terminator,
		}
	},
	dpmr: (over, ids, k) => {
		// Superframes of 4 frames of 80 ms; the generator sends no end frame.
		const superframes = Math.max(1, Math.floor(over.durationMs / 320))
		return {
			symbols: dpmrCallDibits({
				calledId: dpmrId(ids.talkgroup),
				callingId: dpmrId(ids.source),
				colourCode: 5,
				superframes,
				seed: 13 + k,
				coldKeyUp: true,
			}),
			frames: 2 * superframes,
			terminator: false,
		}
	},
	dstar: (over, ids) => {
		// Preamble and radio header (about 160 ms), superframes of 420 ms, terminator.
		const superframes = Math.max(1, Math.floor((over.durationMs - 160) / 420))
		const header = {
			rpt2: "DIRECT",
			rpt1: "DIRECT",
			ur: "CQCQCQ",
			my: ids.my,
			suffix: "TEST",
		}
		return {
			symbols: dstarBits(header, { superframes }),
			frames: superframes,
			terminator: true,
		}
	},
}

/** Symbol rate, transmit filter and deviation per protocol. */
const AIR = {
	dmr: {
		symbolRate: 4800,
		shape: AIR_SHAPES.dmr,
		deviationHz: d => [648, 1944, -648, -1944, 0][d],
	},
	ysf: {
		symbolRate: 4800,
		shape: AIR_SHAPES.ysf,
		deviationHz: d => [600, 1800, -600, -1800, 0][d],
	},
	p25: {
		symbolRate: 4800,
		shape: AIR_SHAPES.p25,
		deviationHz: d => (d === KEYED_OFF ? 0 : p25Deviation(d)),
	},
	nxdn48: {
		symbolRate: NXDN_RATES.nxdn48.symbolRate,
		shape: AIR_SHAPES.nxdn,
		deviationHz: d => [350, 1050, -350, -1050, 0][d],
	},
	dpmr: {
		symbolRate: 2400,
		shape: AIR_SHAPES.dpmr,
		deviationHz: d => [350, 1050, -350, -1050, 0][d],
	},
	dstar: {
		symbolRate: 4800,
		shape: { shaping: "gauss", bt: 0.5 },
		deviationHz: b => (b === KEYED_OFF ? 0 : b ? -1200 : 1200),
	},
}

/**
 * Carrier amplitude (0 to 1) per sample of a plan's frequency trace: full
 * where the symbol is keyed, a raised-cosine ramp of `rampSeconds` just
 * outside, off otherwise (the same rule as dmrDirectEnvelope).
 */
export function keyedEnvelope(
	symbols,
	{
		symbolRate,
		rateHz = 48_000,
		rampSeconds = 0.00125,
		padSymbols = PAD_SYMBOLS,
	},
) {
	const sps = rateHz / symbolRate
	const n = Math.ceil((symbols.length + 2 * padSymbols) * sps)
	const on = new Uint8Array(n)
	for (let i = 0; i < n; i++) {
		const k = Math.floor(i / sps) - padSymbols
		on[i] = k >= 0 && k < symbols.length && symbols[k] !== KEYED_OFF ? 1 : 0
	}
	const ramp = Math.max(1, Math.round(rampSeconds * rateHz))
	const rise = d => 0.5 + 0.5 * Math.cos((Math.PI * d) / ramp)
	const out = new Float64Array(n)
	let last = -Infinity
	for (let i = 0; i < n; i++) {
		if (on[i]) {
			out[i] = 1
			last = i
		} else if (i - last <= ramp) out[i] = rise(i - last)
	}
	let next = Infinity
	for (let i = n - 1; i >= 0; i--) {
		if (on[i]) next = i
		else if (next - i <= ramp) out[i] = Math.max(out[i], rise(next - i))
	}
	return out
}

/**
 * A timeline of overs of one protocol: `overs` are `{ startMs, durationMs,
 * slot?, ids?, terminator?, headers?, lateEntry? }` (slot, headers and
 * lateEntry: DMR only), `tailMs` of carrier-off after the last. DMR takes
 * `dmrMode` ("direct" or "repeater") and `hangMs` (repeater hang time).
 * `shape` overrides the protocol's transmit filter (`delaySymbols`: the
 * transmitter's symbol clock phase). `trace: false` skips the frequency
 * trace and envelope (both empty): the overs and symbols only.
 *
 * Returns the symbols, the frequency trace and carrier envelope at `rateHz`,
 * and the overs as sent (the truth): index, protocol, slot (DMR) or null,
 * start and end ms in the trace, identities, checked frames, terminator.
 */
export function transmissionPlan(
	overs,
	{
		protocol,
		dmrMode = "direct",
		hangMs = 0,
		tailMs = 0,
		rateHz = 48_000,
		shape,
		trace = true,
	},
) {
	const air = AIR[protocol]
	if (air === undefined) throw new Error(`no plan for protocol ${protocol}`)
	const { symbolRate } = air
	const toMs = s => ((s + PAD_SYMBOLS) / symbolRate) * 1000
	const sent = []
	let symbols
	if (protocol === "dmr") {
		const plan = dmrPlanDibits(
			overs.map(o => ({ ...o, ...DEFAULT_IDS.dmr, ...o.ids })),
			{ mode: dmrMode, hangMs },
		)
		symbols = plan.dibits
		plan.overs.forEach((o, index) =>
			sent.push({
				index,
				protocol,
				slot: o.slot,
				startMs: toMs((o.startMs / 1000) * symbolRate),
				endMs: toMs((o.endMs / 1000) * symbolRate),
				ids: { talkgroup: o.talkgroup, source: o.source },
				frames: o.frames,
				terminator: o.terminator,
			}),
		)
	} else {
		symbols = []
		overs.forEach((over, index) => {
			const ids = { ...DEFAULT_IDS[protocol], ...over.ids }
			const built = BUILDERS[protocol](over, ids, index)
			const start = Math.round((over.startMs / 1000) * symbolRate)
			if (start < symbols.length)
				throw new Error(`over ${index} starts before over ${index - 1} ends`)
			while (symbols.length < start) symbols.push(KEYED_OFF)
			symbols.push(...built.symbols)
			sent.push({
				index,
				protocol,
				slot: null,
				startMs: toMs(start),
				endMs: toMs(symbols.length),
				ids,
				frames: built.frames,
				terminator: built.terminator,
			})
		})
	}
	const tail = Math.round((tailMs / 1000) * symbolRate)
	for (let i = 0; i < tail; i++) symbols.push(KEYED_OFF)
	const filter = { ...air.shape, ...shape }
	const freq = trace
		? shapeFrequency(symbols, {
				symbolRate,
				rateHz,
				...filter,
				padSymbols: PAD_SYMBOLS,
				deviationHz: air.deviationHz,
			})
		: new Float64Array(0)
	const envelope = trace
		? keyedEnvelope(symbols, { symbolRate, rateHz })
		: new Float64Array(0)
	return {
		protocol,
		symbolRate,
		symbols,
		freq,
		envelope,
		overs: sent,
		durationMs: ((symbols.length + 2 * PAD_SYMBOLS) / symbolRate) * 1000,
	}
}

/**
 * Over lengths of the length scenes (design: 0.5, 1, 2, 3 and 10 s), and
 * the gaps of the back-to-back scenes (0.2, 0.7 and 1.5 s, 2 s overs).
 */
export const DV_OVER_MS = [500, 1000, 2000, 3000, 10_000]
export const DV_GAPS_MS = [200, 700, 1500]
/** Noise before the first over: the receiver hunts sync on noise first. */
export const DV_LEAD_MS = 1000
/**
 * Carrier-off between the overs of a length scene, and after a scene's last
 * over: more than the adapter's 4 s call timeout plus one 500 ms timer period
 * (4 500 ms), so a missed terminator ends its call before the next over.
 */
export const DV_APART_MS = 5000
/** A repeater's hang time in the repeater scenes (design: 3 s). */
export const DV_HANG_MS = 3000
/** A second radio's identities (the "other radio" gaps, slot 2). */
export const DV_OTHER = { talkgroup: 4322, source: 7_654_321 }

/** Overs back to back, `apart` (one gap, or one per pair) from each other. */
function sequence(lengths, apart, extra = () => ({})) {
	let at = DV_LEAD_MS
	return lengths.map((durationMs, i) => {
		const over = { startMs: at, durationMs, ...extra(i) }
		at += durationMs + (Array.isArray(apart) ? (apart[i] ?? 0) : apart)
		return over
	})
}

const dmrScenes = mode => {
	const repeater = mode === "repeater"
	const base = {
		protocol: "dmr",
		dmrMode: mode,
		hangMs: repeater ? DV_HANG_MS : 0,
		tailMs: DV_APART_MS,
	}
	const gaps = [2000, 2000, 2000, 2000]
	const scenes = [
		{
			...base,
			name: `dmr-${mode}-lengths`,
			overs: sequence(DV_OVER_MS, DV_APART_MS),
		},
		{
			...base,
			name: `dmr-${mode}-gaps-same`,
			overs: sequence(gaps, DV_GAPS_MS),
		},
		{
			...base,
			name: `dmr-${mode}-gaps-other`,
			overs: sequence(gaps, DV_GAPS_MS, i => (i % 2 ? { ids: DV_OTHER } : {})),
		},
		{
			// Joins at voice burst C: no header, the first superframe incomplete.
			...base,
			name: `dmr-${mode}-late-entry`,
			overs: sequence([3000], 0, () => ({ lateEntry: 2 })),
		},
		{
			...base,
			name: repeater ? "dmr-repeater-hang-no-tlc" : "dmr-direct-no-terminator",
			overs: sequence([1000, 3000], DV_APART_MS, () => ({ terminator: false })),
		},
	]
	if (repeater)
		scenes.push({
			// Slot 2 busy with another radio's over while slot 1 talks.
			...base,
			name: "dmr-repeater-two-slots",
			overs: [
				{ startMs: DV_LEAD_MS, durationMs: 3000, slot: 1 },
				{
					startMs: DV_LEAD_MS + 1000,
					durationMs: 3000,
					slot: 2,
					ids: DV_OTHER,
				},
			],
		})
	return scenes
}

/**
 * The scenes of the design's measurement grid, as plan inputs: DMR direct
 * and repeater (lengths, back-to-back same and other radio, late entry, a
 * missing terminator, two busy slots), and for D-STAR, YSF, P25, NXDN48 and
 * dPMR the length and back-to-back scenes. Every over is a cold key-up (one
 * header, no settle).
 */
export const DV_SCENES = [
	...dmrScenes("direct"),
	...dmrScenes("repeater"),
	...["dstar", "ysf", "p25", "nxdn48", "dpmr"].flatMap(protocol => [
		{
			name: `${protocol}-lengths`,
			protocol,
			tailMs: DV_APART_MS,
			overs: sequence(DV_OVER_MS, DV_APART_MS),
		},
		{
			name: `${protocol}-gaps`,
			protocol,
			tailMs: DV_APART_MS,
			overs: sequence([2000, 2000, 2000, 2000], DV_GAPS_MS),
		},
	]),
]

/** A scene's plan (`options`: rateHz, shape, trace). */
export function scenePlan(scene, options = {}) {
	return transmissionPlan(scene.overs, {
		protocol: scene.protocol,
		dmrMode: scene.dmrMode,
		hangMs: scene.hangMs ?? 0,
		tailMs: scene.tailMs ?? 0,
		...options,
	})
}
