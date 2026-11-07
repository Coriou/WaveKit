import { describe, expect, it } from "vitest"
import type { ScannerClass } from "../../../../../src/core/scanner/types.js"
import { yieldToRpc } from "../../spectrum/pipeline-harness.js"
import {
	MATRIX_SNRS_DB,
	matrixCell,
	productionClass,
	runVisit,
	SIGNALS,
} from "./classifier-signals.js"

/**
 * Spectral class confusion matrix: synthetic emissions at 8, 12, 16, 20 and 30 dB channel SNR
 * through the real pipeline and the class the scanner computes for each snapshot. Each row states,
 * per SNR, how many of its two 3 s visits reached `analog-fm` (what the recorder follows), and
 * which classes its settled snapshots (20 blocks or more) may take.
 *
 * Some digital rows do reach `analog-fm` by width: a mean spectrum that reads peaked and 7.5 kHz
 * wide or more. That is not speech evidence and the speech reading neither adds nor removes those
 * cells, so they stay stated here as they are. A voice under-modulated to 20 % of a 2.5 kHz limiter
 * cannot be told from narrow digital by the spectrum: it stays digital, and the recorder's own audio
 * check keeps it.
 *
 * `matrixCell` takes the classifier as a parameter, so another classifier can be compared.
 */

const SEEDS = [1, 2]
const VISIT_S = 3

interface Row {
	readonly voiced: readonly [number, number, number, number, number]
	readonly settled: readonly ScannerClass[]
}

const EXPECTED: Readonly<Record<string, Row>> = {
	voice: { voiced: [2, 2, 2, 2, 2], settled: ["analog-fm", "gmsk-narrow"] },
	"voice-narrow": {
		voiced: [1, 2, 0, 1, 2],
		settled: ["analog-fm", "gmsk-narrow"],
	},
	"voice-quiet": {
		voiced: [0, 0, 0, 0, 0],
		settled: ["fsk4-6k25", "gmsk-narrow"],
	},
	"voice-ctcss": { voiced: [2, 2, 2, 2, 2], settled: ["analog-fm"] },
	"dmr-slot": { voiced: [0, 0, 0, 2, 1], settled: ["tdma-ms"] },
	"dmr-repeater": {
		voiced: [0, 0, 2, 2, 0],
		settled: ["analog-fm", "fsk4-12k5"],
	},
	dpmr: { voiced: [0, 0, 0, 0, 0], settled: ["fsk4-6k25", "gmsk-narrow"] },
	nxdn48: { voiced: [0, 0, 0, 0, 0], settled: ["fsk4-6k25", "gmsk-narrow"] },
	nxdn96: {
		voiced: [0, 0, 1, 2, 0],
		settled: ["analog-fm", "fsk4-12k5", "fsk4-6k25", "gmsk-narrow"],
	},
	dstar: {
		voiced: [0, 0, 0, 0, 0],
		settled: ["fsk4-12k5", "fsk4-6k25", "gmsk-narrow"],
	},
	ysf: { voiced: [0, 0, 0, 0, 0], settled: ["fsk2-wide", "fsk4-12k5"] },
	p25: { voiced: [0, 0, 2, 0, 0], settled: ["analog-fm", "fsk4-12k5"] },
	pocsag: { voiced: [0, 0, 0, 0, 0], settled: ["carrier", "fsk2-wide"] },
	"gmsk-9600": {
		voiced: [0, 0, 1, 0, 0],
		settled: ["fsk2-wide", "fsk4-12k5"],
	},
	"aprs-burst": { voiced: [2, 2, 2, 2, 2], settled: ["analog-fm"] },
	"carrier-on-bin": {
		voiced: [0, 0, 0, 0, 0],
		settled: ["carrier", "fsk4-6k25"],
	},
	"carrier-off-bin": { voiced: [0, 0, 0, 0, 0], settled: ["carrier"] },
	"carrier-drift": { voiced: [0, 0, 0, 0, 0], settled: ["carrier"] },
	"carrier-fast-drift": {
		voiced: [0, 0, 0, 0, 0],
		settled: ["carrier", "fsk4-6k25"],
	},
}

describe("spectral class confusion matrix", () => {
	it("states an expectation for every signal", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(
			SIGNALS.map(s => s.name).sort(),
		)
	})

	describe.each(SIGNALS)("$name", signal => {
		it.each(MATRIX_SNRS_DB.map((snrDb, column) => ({ snrDb, column })))(
			"at $snrDb dB",
			async ({ snrDb, column }) => {
				await yieldToRpc()
				const row = EXPECTED[signal.name]!
				const cell = matrixCell(signal, snrDb, SEEDS, VISIT_S)
				expect(cell.visitsVoiced).toBe(row.voiced[column])
				for (const cls of cell.settled) expect(row.settled).toContain(cls)
			},
			120_000,
		)
	})

	it("noise alone gives no voice", () => {
		for (const seed of SEEDS)
			for (const track of runVisit(null, 0, seed, VISIT_S))
				expect(productionClass(track)).not.toBe("analog-fm")
	}, 60_000)
})
