/**
 * dsd-fme decode margin versus CNR on standard-shaped 4FSK (dsd-fme-margin.ts).
 * A measurement, not a regression test: it runs only with WAVEKIT_MARGIN=1,
 * prints a markdown table per frequency error and writes it, with every
 * point as JSON, to WAVEKIT_MARGIN_OUT (default: a file in the OS tmp dir).
 *
 *   WAVEKIT_MARGIN=1 WAVEKIT_SYNTH_IMAGE=<core image> \
 *     pnpm exec vitest run --maxWorkers=1 tests/integration/dsd-fme-margin.test.ts
 *
 * Without WAVEKIT_SYNTH_IMAGE it uses the host's dsd-fme and sox (and csdr
 * when installed; otherwise the csdr FM head runs in-process). The host
 * builds wavekit-chan from native/ unless WAVEKIT_CHAN_BIN is set.
 * Narrower or wider runs: WAVEKIT_MARGIN_SIGNALS, _VARIANTS (comma-separated
 * names; default "before,after", the others are listed in VARIANTS),
 * _CNR (dB list), _ERROR_HZ (frequency error list), _SEEDS (count), _PHASE
 * (symbol clock phase, symbolPhase below), _RATE
 * (capture rate: 1024000, the default, at +162.5 kHz, or 2400000 at
 * -287.5 kHz, the chain tests' two captures).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	dmrCallDibits,
	dmrFrequency,
} from "../../scripts/fixtures/dmr-4fsk.mjs"
import {
	dpmrCallDibits,
	dpmrFrequency,
} from "../../scripts/fixtures/dpmr-4fsk.mjs"
import { dstarFrequency } from "../../scripts/fixtures/dstar-gmsk.mjs"
import { AIR_SHAPES, EASY_SHAPE } from "../../scripts/fixtures/fsk-iq.mjs"
import { receiveFilterTaps } from "../../src/decoders/builtin/dsd-fme-filter.js"
import type { PulseShape } from "../../scripts/fixtures/fsk-iq.mjs"
import {
	nxdnCallDibits,
	nxdnFrequency,
} from "../../scripts/fixtures/nxdn-4fsk.mjs"
import {
	p25CallDibits,
	p25Frequency,
} from "../../scripts/fixtures/p25-c4fm.mjs"
import {
	ysfOversDibits,
	ysfOversFrequency,
} from "../../scripts/fixtures/ysf-c4fm.mjs"
import { SYNTHETIC } from "../helpers/synthetic-decodes.js"
import {
	marginTable,
	measurePoint,
	type MarginPoint,
	type MarginSignal,
	type MarginVariant,
} from "./dsd-fme-margin.js"
import { toolAvailable } from "./synthetic-chain.js"
import {
	buildWavekitChan,
	wavekitChanBuildUnavailable,
} from "./wavekit-chan-build.js"

const ENABLED = process.env["WAVEKIT_MARGIN"] === "1"
const list = (name: string) =>
	process.env[name]
		?.split(",")
		.map(s => s.trim())
		.filter(s => s !== "")
const CNRS = (list("WAVEKIT_MARGIN_CNR") ?? ["10", "15", "20", "30"]).map(
	Number,
)
const ERRORS_HZ = (list("WAVEKIT_MARGIN_ERROR_HZ") ?? ["0", "1000"]).map(Number)
const SEEDS = Number(process.env["WAVEKIT_MARGIN_SEEDS"] ?? "3")
/**
 * Symbol clock phase of seed n (WAVEKIT_MARGIN_PHASE: "spread", the default,
 * or a fixed fraction of a symbol). Spread: 0 for seed 1, then steps of the
 * golden ratio, so any number of seeds covers the symbol evenly. dsd-fme
 * corrects timing only by whole samples, so a fixed phase measures one
 * receiver timing offset, and the captures put it at a different one each.
 */
const PHASE = process.env["WAVEKIT_MARGIN_PHASE"] ?? "spread"
const symbolPhase = (seed: number) =>
	PHASE === "spread" ? ((seed - 1) * 0.618_034) % 1 : Number(PHASE)

const count = (lines: string[], pattern: RegExp) =>
	lines.filter(line => pattern.test(line)).length

const P25_SUPERFRAMES = 10
const YSF_OVERS = 3
const NXDN_SUPERFRAMES = 6
const DPMR_SUPERFRAMES = 8
const DSTAR_SUPERFRAMES = 8
const DMR_SUPERFRAMES = 5
/** Fictional DMR identities. */
const DMR_CALL = {
	talkgroup: 4321,
	source: 1_234_567,
	superframes: DMR_SUPERFRAMES,
}

/**
 * The signals, each with its standard transmit filter, its symbols delayed by
 * `delaySymbols` (the transmitter's symbol clock phase against the samples).
 */
function signals(delaySymbols: number): MarginSignal[] {
	const at = (shape: PulseShape): PulseShape => ({ ...shape, delaySymbols })
	const ysf = (name: string, shape: PulseShape): MarginSignal => {
		const overs = Array.from({ length: YSF_OVERS }, () => SYNTHETIC.ysf)
		return {
			name,
			mode: "auto",
			freq: ysfOversFrequency(overs, { shape: at(shape) }),
			dibits: ysfOversDibits(overs),
			// Header, 7 V/D2 frames and terminator per over, each with its FICH CRC.
			frames: 9 * YSF_OVERS,
			checked: lines => count(lines, /Sync: [+-]YSF .*\b(HC|CC|TC) FN: \d\/\d/),
		}
	}
	const nxdn = (variant: "nxdn48" | "nxdn96"): MarginSignal => {
		const call = { ...SYNTHETIC.nxdn, superframes: NXDN_SUPERFRAMES }
		return {
			name: variant.toUpperCase(),
			mode: variant === "nxdn96" ? "nxdn" : "nxdn48",
			freq: nxdnFrequency(call, { variant, shape: at(AIR_SHAPES.nxdn) }),
			dibits: nxdnCallDibits(call),
			// Voice frames: each SACCH part prints "PF n/4" only when its CRC6 passes.
			frames: 4 * NXDN_SUPERFRAMES,
			checked: lines =>
				count(lines, /NXDN(48|96) .*Voice .*RAN 05 PF [1-4]\/4/),
		}
	}
	const p25 = { ...SYNTHETIC.p25, superframes: P25_SUPERFRAMES }
	const dpmr = { ...SYNTHETIC.dpmr, superframes: DPMR_SUPERFRAMES }
	const p25Signal = (name: string, shape: PulseShape): MarginSignal => ({
		name,
		mode: "auto",
		freq: p25Frequency(p25, { shape: at(shape) }),
		dibits: p25CallDibits(p25),
		// LDU1 link control, printed only after its RS(24,12,13) check.
		frames: P25_SUPERFRAMES,
		checked: lines =>
			count(lines, /Group Voice Channel User - Group 4321 Source 1234567/),
	})
	return [
		{
			name: "DMR",
			mode: "auto",
			freq: dmrFrequency(DMR_CALL, { shape: at(AIR_SHAPES.dmr) }),
			dibits: dmrCallDibits(DMR_CALL),
			// The call's link control: 2 Voice LC headers and 2 terminators
			// (RS(12,9)) and one embedded LC per superframe (5-bit checksum).
			frames: 4 + DMR_SUPERFRAMES,
			// A failed check prints the same line with "(CRC ERR)" or "FEC ERR".
			checked: lines =>
				count(lines, /^ ?SLOT 1 TGT=4321 SRC=1234567 (?!.*ERR)/),
		},
		p25Signal("P25 (C4FM)", AIR_SHAPES.p25),
		// Wider than any standard (the chain tests' easy shaping): how a
		// transmitter that filters less fares.
		p25Signal("P25 (RC 0.5)", EASY_SHAPE),
		ysf("YSF (RC 0.5)", EASY_SHAPE),
		p25Signal("P25 (RC)", AIR_SHAPES.p25Rc),
		ysf("YSF (RRC)", AIR_SHAPES.ysf),
		ysf("YSF (C4FM)", AIR_SHAPES.ysfC4fm),
		nxdn("nxdn48"),
		nxdn("nxdn96"),
		{
			name: "dPMR",
			mode: "dpmr",
			freq: dpmrFrequency(dpmr, { shape: at(AIR_SHAPES.dpmr) }),
			dibits: dpmrCallDibits(dpmr),
			// Two control channels per superframe, the channel code CRC7-checked.
			frames: 2 * DPMR_SUPERFRAMES,
			checked: lines => count(lines, / Channel Code=05/),
		},
		{
			name: "D-STAR",
			mode: "auto",
			freq: dstarFrequency(SYNTHETIC.dstar, {
				superframes: DSTAR_SUPERFRAMES,
			}),
			// GMSK, two-level: no 4FSK symbol capture to compare; no phase.
			dibits: [],
			// One voice sync line per superframe, with the checked header's callsign.
			frames: DSTAR_SUPERFRAMES,
			checked: lines => count(lines, /DSTAR VOICE .*SRC: N0CALL/),
		},
	]
}

/**
 * Chains compared. "before" is the chain without the receive filter, the
 * base command line (tests/unit/decoders/dsd-fme-filter.test.ts pins it);
 * "after" is today's default. The others document alternatives that were
 * measured: a slow DC blocker for carrier frequency error (sox highpass
 * 2 Hz), dsd-fme without its own input filters (-l), wider 4800 symbols/s
 * low-passes (lp3500, lp4000: -6 dB at 3.5 / 4 kHz), the matched root
 * raised cosine 0.2 at 4800 symbols/s instead of the low-pass (it cut more
 * noise but left YSF a frame error floor on strong signals).
 */
const VARIANTS: MarginVariant[] = [
	{ name: "before", options: { receiveFilter: false } },
	{ name: "after", options: {} },
	{ name: "after+hp2", options: {}, soxEffects: "highpass -1 2" },
	{ name: "after-l", options: {}, dsdArgs: ["-l"] },
	...[3500, 4000].map(
		(hz): MarginVariant => ({
			name: `lp${hz}`,
			options: { receiveFilter: false },
			soxEffects: `sinc -t 1000 -${hz}`,
		}),
	),
	{
		name: "rrc4800",
		options: { receiveFilter: false },
		soxEffects: `fir ${receiveFilterTaps(4800, 48_000)
			.map(t => t.toFixed(7))
			.join(" ")}`,
	},
]

const CRATE = resolve(__dirname, "../../native/wavekit-chan")
let CHAN = process.env["WAVEKIT_CHAN_BIN"] ?? ""
let TARGET = ""
let ROOT = ""
const chanUnavailable =
	ENABLED && CHAN === "" ? wavekitChanBuildUnavailable(CRATE) : undefined

describe.skipIf(
	!ENABLED ||
		!toolAvailable("dsd-fme", ["-h"]) ||
		chanUnavailable !== undefined,
)("dsd-fme decode margin on standard-shaped 4FSK", () => {
	beforeAll(async () => {
		ROOT = mkdtempSync(join(tmpdir(), "wk-margin-"))
		if (CHAN === "") {
			TARGET = mkdtempSync(join(tmpdir(), "wavekit-chan-target-"))
			CHAN = await buildWavekitChan(CRATE, TARGET)
		}
	}, 600_000)
	afterAll(() => {
		if (TARGET) rmSync(TARGET, { recursive: true, force: true })
		if (ROOT) rmSync(ROOT, { recursive: true, force: true })
	})

	it("measures FER and SER per protocol, chain, CNR and frequency error", async () => {
		const onlySignals = list("WAVEKIT_MARGIN_SIGNALS")
		const onlyVariants = list("WAVEKIT_MARGIN_VARIANTS") ?? ["before", "after"]
		const variants = VARIANTS.filter(v => onlyVariants.includes(v.name))
		const points: MarginPoint[] = []
		for (let seed = 1; seed <= SEEDS; seed++) {
			const chosen = signals(symbolPhase(seed)).filter(
				s => onlySignals === undefined || onlySignals.includes(s.name),
			)
			for (const signal of chosen)
				for (const variant of variants)
					for (const errorHz of ERRORS_HZ)
						for (const cnrDb of CNRS)
							points.push(
								await measurePoint(CHAN, ROOT, signal, variant, {
									cnrDb,
									errorHz,
									seed: 1000 * seed + cnrDb,
								}),
							)
		}
		const tables = ERRORS_HZ.map(
			e =>
				`### Frequency error ${e} Hz: FER (SER)\n\n${marginTable(points, e)}`,
		).join("\n\n")
		const out =
			process.env["WAVEKIT_MARGIN_OUT"] ??
			join(tmpdir(), `dsd-fme-margin-${Date.now()}.md`)
		writeFileSync(
			out,
			`${tables}\n\n<!--\n${JSON.stringify(points, null, 1)}\n-->\n`,
		)
		process.stdout.write(`\n${tables}\n\nwritten to ${out}\n`)
		expect(points.length).toBeGreaterThan(0)
	}, 3_600_000)
})
