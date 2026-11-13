/**
 * The lone-voice scene matrix: a sweep records each voice whole, a lone 28 s ID beside the
 * neighbours and lines a band holds, through the production composition (runScene: the in-process
 * fake source, spectrum pipeline, ScannerService, JobRunner, SweepScheduler and wideband recorder,
 * real wiring). Every row runs settled (the harness's `settled`: the engine's IQ batch flushed
 * each chunk, the recorder unbudgeted, the store's operations and the job runner's chains awaited
 * before the next chunk), so a row runs the same on every run whatever the host's load.
 *
 * Each row scores each ID by the files attributed to it (TargetReport.wavSeconds). An ID is whole
 * when one file holds at least WHOLE_ID_S of it. The bar is the lane base's: where the base
 * scheduler records an ID whole the row asserts one file of at least WHOLE_ID_S per ID; where the
 * base itself splits, the row asserts no fewer IDs whole than the base (its numbers in the row's
 * comment).
 *
 * Layout: two hops (a 1.4 MHz range), the IDs on hop 1, 100 437 Hz above its centre. A row that
 * places its landing has a decoy voice on hop 0: its voice hold keeps hop 0 until it ends, the
 * sweep leaves about 0.8 s after, and hop 1's listening starts a settle later (LANDING_MS). Settle
 * 1000 ms, the production value for a network source (config/default.yaml
 * `sweep.settleMs.network`; the harness's source is rtl_tcp). Where a row needs a label the
 * pipeline gives no synthetic carrier (an analog-labelled line, a line hinted as voice to come, a
 * line probed for a decoder's confirmation), the job runner's hints for that line's track are
 * overridden on their way to the scheduler (Row.line); everything else is the composition's own.
 * Synthetic signals only; a report's numbers, no wall clock.
 *
 * Each row runs about 1.5 times its world's length on a loaded host, so the rows are grouped in
 * describe blocks a run selects with `-t` (each block well under 10 min). MATRIX_OUT, when set,
 * names a file each row appends its per-ID files to (one JSON line), for the base/head table.
 */
import { appendFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	runScene,
	type Emitter,
	type SceneReport,
	type Span,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
/** Two hops of 1 024 000 Hz windows: CENTRE_HZ and HOP1_HZ (asserted per row). */
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_000_000 }
const HOP1_HZ = CENTRE_HZ + 800_000
const ID_HZ = HOP1_HZ + 100_437
/** On hop 0 only. */
const DECOY_HZ = CENTRE_HZ - 200_437
/** sweep.settleMs.network in config/default.yaml. */
const SETTLE_MS = 1_000
const ID_MS = 28_000
const ID_AMP = 0.25
/** 6 dB under the ID. */
const NEIGHBOUR_AMP = 0.125
/** On a channel: within half a 12.5 kHz channel of its frequency. */
const SAME_CHANNEL_HZ = 6_250
/**
 * A whole ID's file: 28 s less a landing's lag and the recorder's 1 s pre-roll room (the bar
 * sweep-neighbour-hold-move uses).
 */
const WHOLE_ID_S = 25
/** Files finalise within a few seconds of an ID's end (the 2 s hang and the 1 s look). */
const TAIL_MS = 6_000
/** The decoy keys once the first sweep visited both hops (2 × (1000 settle + dwell) < 4000). */
const DECOY_FROM_MS = 4_000
/**
 * The decoy's end for a landing on hop 1 at LANDING_MS: the leave about 0.8 s after the decoy's
 * end, then the 1000 ms settle (12 150 + 800 + 1000 = 13 950).
 */
const DECOY_TO_MS = 12_150
const LANDING_MS = 13_950
/** A confirm hold's length when the job runner gave none (a probe for a decoder's answer). */
const CONFIRM_HOLD_MS = 3_000

interface Hints {
	followOnAir?: boolean
	voiceLater?: boolean
}
interface SchedulerInternals {
	onTrack(
		track: { centreHz: number },
		needsConfirm: boolean,
		confirmHoldMs: number,
		hints?: Hints,
	): unknown[]
	/** The scheduler's frequency memory (its evidence per frequency). */
	memory: { centreHz: number; evidence: string }[]
}

interface Row {
	name: string
	/** Synthetic emitters besides the decoy. */
	emitters: Emitter[]
	/** The IDs the row scores, each on its own frequency. */
	ids: (Span & { hz: number })[]
	/** A decoy on hop 0 (`decoyHz`) from DECOY_FROM_MS to `decoyToMs`, placing the landing. */
	decoy?: { hz: number; toMs: number; fromMs?: number }
	/** A line whose track's hints are overridden on their way to the scheduler. */
	line?: { hz: number; hints?: Hints; confirm?: boolean }
	/**
	 * Ms of the scene at which the line's frequency must be known as traffic (the scheduler's
	 * memory of it), asserted: the row's premise.
	 */
	lineTrafficAtMs?: number
	durationMs: number
	range?: { startHz: number; endHz: number }
	hops?: number
}

interface RowResult {
	perId: number[][]
	whole: boolean[]
	r: SceneReport
	report: string
}

const near = (hz: number, to: number): boolean =>
	Math.abs(hz - to) < SAME_CHANNEL_HZ

async function runRow(row: Row): Promise<RowResult> {
	const decoy: Emitter[] =
		row.decoy === undefined
			? []
			: [
					{
						hz: row.decoy.hz,
						kind: "voice",
						fromMs: row.decoy.fromMs ?? DECOY_FROM_MS,
						toMs: row.decoy.toMs,
					},
				]
	let hinted = 0
	/** The line's frequency's evidence at Row.lineTrafficAtMs (null: no memory of it). */
	let lineEvidence: string | null | undefined
	const started = Date.now()
	const r = await runScene({
		centreHz: CENTRE_HZ,
		ranges: [row.range ?? RANGE],
		durationMs: row.durationMs,
		settleMs: SETTLE_MS,
		// Each chunk's work settled before the next: the same on every run.
		settled: true,
		emitters: [...decoy, ...row.emitters],
		targets: row.ids.map((s, i) => ({ ...s, label: `id${i + 1}` })),
		onWorld: w => {
			const line = row.line
			if (line === undefined) return
			let patched = false
			let elapsed = 0
			const chunk = w.advance.bind(w)
			w.advance = async ms => {
				for (let t = 0; t < ms; t += 25) {
					const s = w.scheduler() as unknown as SchedulerInternals | undefined
					const at = row.lineTrafficAtMs
					if (at !== undefined && lineEvidence === undefined && elapsed >= at)
						lineEvidence =
							s?.memory.find(m => near(m.centreHz, line.hz))?.evidence ?? null
					elapsed += 25
					if (!patched && s !== undefined) {
						patched = true
						const onTrack = s.onTrack.bind(s)
						s.onTrack = (track, needsConfirm, holdMs, hints = {}) => {
							if (!near(track.centreHz, line.hz))
								return onTrack(track, needsConfirm, holdMs, hints)
							hinted++
							const confirm = line.confirm ?? needsConfirm
							return onTrack(
								track,
								confirm,
								confirm && holdMs === 0 ? CONFIRM_HOLD_MS : holdMs,
								{ ...hints, ...line.hints },
							)
						}
					}
					await chunk(25)
				}
			}
		},
	})
	const perId = r.targets.map(t => t.wavSeconds)
	const whole = perId.map(f => f.some(s => s >= WHOLE_ID_S))
	const report = JSON.stringify({
		row: row.name,
		hops: r.hops,
		perId,
		files: r.wavFiles,
		holds: r.holds,
		hinted,
		lineEvidence,
		decisions: r.decisions.map(d => d.code),
	})
	const out = process.env["MATRIX_OUT"]
	if (out !== undefined && out !== "")
		appendFileSync(
			out,
			`${JSON.stringify({ row: row.name, perId, whole, wallMs: Date.now() - started, files: r.wavFiles, holds: r.holds, hinted })}\n`,
		)
	expect(r.hops, report).toHaveLength(row.hops ?? 2)
	if (row.lineTrafficAtMs !== undefined)
		expect(lineEvidence, report).toBe("traffic")
	return { perId, whole, r, report }
}

/** One file of at least WHOLE_ID_S for every ID of the row. */
function expectEveryIdWhole(res: RowResult): void {
	for (const files of res.perId)
		expect(
			files.filter(s => s >= WHOLE_ID_S),
			res.report,
		).toHaveLength(1)
}

/** No fewer IDs whole than the base gave. */
function expectWholeAtLeast(res: RowResult, base: number): void {
	expect(res.whole.filter(Boolean).length, res.report).toBeGreaterThanOrEqual(
		base,
	)
}

const id = (fromMs: number, hz = ID_HZ): Span & { hz: number } => ({
	hz,
	fromMs,
	toMs: fromMs + ID_MS,
})
const voice = (s: Span & { hz: number }, amp = ID_AMP): Emitter => ({
	hz: s.hz,
	kind: "voice",
	fromMs: s.fromMs,
	toMs: s.toMs,
	amp,
})
/** A carrier with its 67 Hz sub-tone and no speech at all. */
const subTone = (hz: number, span: Span, amp = NEIGHBOUR_AMP): Emitter => ({
	hz,
	kind: "voice",
	...span,
	amp,
	pauses: [span],
})
const carrier = (hz: number, span: Span, amp = NEIGHBOUR_AMP): Emitter => ({
	hz,
	kind: "carrier",
	...span,
	amp,
})
const DECOY = { hz: DECOY_HZ, toMs: DECOY_TO_MS }

describe("lone-voice matrix row 1: a lone ID", () => {
	// Base: one file (whole).
	it("row 1: a lone 28 s ID, no neighbour, is one file", async () => {
		const s = id(30_000)
		const res = await runRow({
			name: "1",
			emitters: [voice(s)],
			ids: [s],
			durationMs: s.toMs + TAIL_MS,
		})
		expectEveryIdWhole(res)
	}, 600_000)
})

/**
 * Row 2: a line 25 kHz below keys 4 s before the ID and stays on past its end; the sweep lands on
 * it before the ID keys and watches it as a carrier (its 8 s watch caps under the ID).
 */
describe("lone-voice matrix row 2: a line keying before a lone ID", () => {
	const s = id(30_000)
	const line = { fromMs: s.fromMs - 4_000, toMs: s.toMs + 2_000 }
	it("row 2a: a plain carrier 25 kHz below, keyed 4 s before, leaves the ID one file", async () => {
		const res = await runRow({
			name: "2a",
			emitters: [voice(s), carrier(ID_HZ - 25_000, line)],
			ids: [s],
			durationMs: s.toMs + TAIL_MS,
		})
		expectEveryIdWhole(res)
	}, 600_000)

	it("row 2b: a sub-tone-only carrier 25 kHz below, keyed 4 s before, leaves the ID one file", async () => {
		const res = await runRow({
			name: "2b",
			emitters: [voice(s), subTone(ID_HZ - 25_000, line)],
			ids: [s],
			durationMs: s.toMs + TAIL_MS,
		})
		expectEveryIdWhole(res)
	}, 600_000)
})

/**
 * Row 3: a line 25 kHz below on air at the landing (keyed during the decoy's hold, so no earlier
 * visit of hop 1 saw it) is kept, and the ID keys 3, 6 or 9 s into the visit, its track then
 * followed. The line is a steady carrier; or the same with its track labelled analog voice
 * (followOnAir); or keyed 500 ms after the landing (its onset seen), labelled analog voice and
 * probed for a decoder's confirmation.
 */
const ROW3_DELAYS_MS = [3_000, 6_000, 9_000] as const
const LINE_HZ = ID_HZ - 25_000
function row3(
	name: string,
	lineFromMs: number,
	lineOf: Row["line"],
	delayMs: number,
): Row {
	const s = id(LANDING_MS + delayMs)
	return {
		name,
		emitters: [
			voice(s),
			carrier(LINE_HZ, { fromMs: lineFromMs, toMs: s.toMs + 2_000 }),
		],
		ids: [s],
		decoy: DECOY,
		...(lineOf === undefined ? {} : { line: lineOf }),
		durationMs: s.toMs + TAIL_MS,
	}
}
const LINE_BEFORE_LANDING_MS = DECOY_TO_MS - 2_000
const LINE_ONSET_SEEN_MS = LANDING_MS + 500

describe("lone-voice matrix row 3 steady: a steady line kept, then the ID followed", () => {
	for (const delayMs of ROW3_DELAYS_MS)
		it(`row 3 steady: the ID keyed ${delayMs / 1000} s in is one file`, async () => {
			const res = await runRow(
				row3(`3-steady-${delayMs}`, LINE_BEFORE_LANDING_MS, undefined, delayMs),
			)
			expectEveryIdWhole(res)
		}, 600_000)
})

describe("lone-voice matrix row 3 analog: an analog-labelled line kept, then the ID followed", () => {
	for (const delayMs of ROW3_DELAYS_MS)
		it(`row 3 analog: the ID keyed ${delayMs / 1000} s in is one file`, async () => {
			const res = await runRow(
				row3(
					`3-analog-${delayMs}`,
					LINE_BEFORE_LANDING_MS,
					{ hz: LINE_HZ, hints: { followOnAir: true } },
					delayMs,
				),
			)
			expectEveryIdWhole(res)
		}, 600_000)
})

describe("lone-voice matrix row 3 followed: a followed, probed-for-confirm line with its onset seen, then the ID", () => {
	for (const delayMs of ROW3_DELAYS_MS)
		it(`row 3 followed: the ID keyed ${delayMs / 1000} s in is one file`, async () => {
			const res = await runRow(
				row3(
					`3-followed-${delayMs}`,
					LINE_ONSET_SEEN_MS,
					{ hz: LINE_HZ, hints: { followOnAir: true }, confirm: true },
					delayMs,
				),
			)
			expectEveryIdWhole(res)
		}, 600_000)
})

/**
 * Row 4: a steady line beside a lone ID, its track hinted as voice to come (voiceLater: a spectrum
 * read as analog voice, not yet labelled) and never voicing, so the sweep holds it only as a
 * recording keep; the ID keys 3 s into the visit. Steady (on air at the landing, 25 kHz below);
 * probed for a decoder's confirmation; seen late (keyed 1.5 s into the visit); 12.5 kHz below.
 */
const ROW4_DELAY_MS = 3_000
function row4(
	name: string,
	lineHz: number,
	lineFromMs: number,
	confirm: boolean,
): Row {
	const s = id(LANDING_MS + ROW4_DELAY_MS)
	return {
		name,
		emitters: [
			voice(s),
			carrier(lineHz, { fromMs: lineFromMs, toMs: s.toMs + 2_000 }),
		],
		ids: [s],
		decoy: DECOY,
		line: {
			hz: lineHz,
			hints: { followOnAir: false, voiceLater: true },
			...(confirm ? { confirm: true } : {}),
		},
		durationMs: s.toMs + TAIL_MS,
	}
}

describe("lone-voice matrix row 4: a voiceLater-hinted, record-held line beside a lone ID", () => {
	it("row 4 steady: the ID is one file", async () => {
		const res = await runRow(
			row4("4-steady", LINE_HZ, LINE_BEFORE_LANDING_MS, false),
		)
		expectEveryIdWhole(res)
	}, 600_000)

	it("row 4 probed: the ID is one file", async () => {
		const res = await runRow(
			row4("4-probed", LINE_HZ, LINE_BEFORE_LANDING_MS, true),
		)
		expectEveryIdWhole(res)
	}, 600_000)

	it("row 4 seen late: the ID is one file", async () => {
		const res = await runRow(row4("4-late", LINE_HZ, LANDING_MS + 1_500, false))
		expectEveryIdWhole(res)
	}, 600_000)

	it("row 4 12.5 kHz below: the ID is one file", async () => {
		const res = await runRow(
			row4("4-12k5", ID_HZ - 12_500, LINE_BEFORE_LANDING_MS, false),
		)
		expectEveryIdWhole(res)
	}, 600_000)
})

/**
 * Row 5: a carrier 25 kHz below on air from the scene's start, so the first sweep's visit of hop 1
 * saw it before the decoy held hop 0; the ID keys at the landing or 3 s into the visit. A plain
 * carrier and a sub-tone-only one.
 */
describe("lone-voice matrix row 5: a carrier seen in an earlier sweep, then the ID", () => {
	const cases = [
		{ name: "5-carrier-0", subtone: false, delayMs: 50 },
		{ name: "5-carrier-3", subtone: false, delayMs: 3_000 },
		{ name: "5-subtone-0", subtone: true, delayMs: 50 },
		{ name: "5-subtone-3", subtone: true, delayMs: 3_000 },
	]
	for (const c of cases)
		it(`row ${c.name}: the ID is one file`, async () => {
			const s = id(LANDING_MS + c.delayMs)
			const span = { fromMs: 0, toMs: s.toMs + 2_000 }
			const res = await runRow({
				name: c.name,
				emitters: [
					voice(s),
					c.subtone ? subTone(LINE_HZ, span) : carrier(LINE_HZ, span),
				],
				ids: [s],
				decoy: DECOY,
				durationMs: s.toMs + TAIL_MS,
			})
			expectEveryIdWhole(res)
		}, 600_000)
})

/**
 * Row 6: two QSOs 12.5 kHz apart taking turns, simplex: 28 s overs, 3 s between one's end and the
 * other's start, A, B, A. Each over scored as an ID.
 */
describe("lone-voice matrix row 6: two adjacent QSOs 12.5 kHz apart, alternating", () => {
	it("row 6: every over is one file", async () => {
		const b = ID_HZ - 12_500
		const overs = [id(4_000), id(35_000, b), id(66_000)]
		const res = await runRow({
			name: "6",
			emitters: overs.map(o => voice(o)),
			ids: overs,
			durationMs: overs[2]!.toMs + TAIL_MS,
		})
		expectEveryIdWhole(res)
	}, 600_000)
})

/**
 * Row 7: the gate scene of a neighbour that keys before the ID and ends under it: three hops (a
 * 1.8 MHz range), a decoy voice on hop 0 to 28 150 ms (the landing on hop 1 at 29 950 ms), a
 * neighbour 25 kHz below and 6 dB under the ID on air 22 to 40 s, the ID 30 to 58 s.
 */
describe("lone-voice matrix row 7: the neighbour gate scene", () => {
	it("row 7: no fewer IDs whole than the base", async () => {
		const hop1 = CENTRE_HZ + 800_000
		const s = id(30_000, hop1 + 100_437)
		const res = await runRow({
			name: "7",
			emitters: [
				voice(s),
				{
					hz: s.hz - 25_000,
					kind: "voice",
					fromMs: 22_000,
					toMs: 40_000,
					amp: NEIGHBOUR_AMP,
				},
			],
			ids: [s],
			decoy: { hz: DECOY_HZ, fromMs: 2_000, toMs: 28_150 },
			range: { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 },
			hops: 3,
			durationMs: 64_000,
		})
		// Base splits it too, settled: 11.725 + 15.825 s, no ID whole.
		expectWholeAtLeast(res, 0)
	}, 600_000)
})

/**
 * Row 8: an analog-labelled line (a sub-tone carrier, never voiced) beside a lone ID on a frequency
 * already known as traffic, so the sweep follows it to what L has left (no carrier watch), no decoy.
 * The first visit of hop 1 lands at ROW8_VISIT_MS and follows the line, which closes 2 s in and
 * reopens 1.2 s later (a heard gap: traffic, asserted at ROW8_REKEY_MS), then closes again; quiet
 * sweeps follow; the line keys again at ROW8_REKEY_MS while the sweep is on hop 0, and stays on.
 * The ID keys at ROW8_LANDING_MS (hop 1's next visit lands within 1 s of it), 3 s and 6 s later,
 * 25 kHz and 12.5 kHz above the line. Settled numbers (s), base / head before the fix:
 * 25 kHz: 29.125 / 29.125, 29.875 / 18.825 + 9.925, 29.875 / 15.825 + 12.925;
 * 12.5 kHz: 29.775 / 20.975 + 8.1, 30.075 / 18.025 + 10.675, 30.075 / 15.025 + 13.675.
 */
/** The first visit of hop 1 (hop 0's dwell, the settle and the first block). */
const ROW8_VISIT_MS = 1_175
const ROW8_REKEY_MS = 13_000
const ROW8_LANDING_MS = 14_000
const ROW8_DELAYS_MS = [50, 3_000, 6_000] as const
function row8(offsetHz: number, delayMs: number): Row {
	const s = id(ROW8_LANDING_MS + delayMs)
	const hz = ID_HZ - offsetHz
	const close = ROW8_VISIT_MS + 2_000
	const reopen = close + 1_200
	return {
		name: `8-${offsetHz}-${delayMs}`,
		emitters: [
			voice(s),
			subTone(hz, { fromMs: 0, toMs: close }),
			subTone(hz, { fromMs: reopen, toMs: reopen + 800 }),
			subTone(hz, { fromMs: ROW8_REKEY_MS, toMs: s.toMs + 2_000 }),
		],
		ids: [s],
		line: { hz, hints: { followOnAir: true } },
		lineTrafficAtMs: ROW8_REKEY_MS,
		durationMs: s.toMs + TAIL_MS,
	}
}

describe("lone-voice matrix row 8 traffic 25: an analog line known as traffic, never voiced, 25 kHz from the ID", () => {
	for (const delayMs of ROW8_DELAYS_MS)
		it(`row 8 traffic 25: the ID keyed ${delayMs / 1000} s in is one file`, async () => {
			expectEveryIdWhole(await runRow(row8(25_000, delayMs)))
		}, 600_000)
})

describe("lone-voice matrix row 8 traffic 12.5: an analog line known as traffic, never voiced, 12.5 kHz from the ID", () => {
	for (const delayMs of ROW8_DELAYS_MS)
		it(`row 8 traffic 12.5: the ID keyed ${delayMs / 1000} s in is one file`, async () => {
			expectEveryIdWhole(await runRow(row8(12_500, delayMs)))
		}, 600_000)
})
