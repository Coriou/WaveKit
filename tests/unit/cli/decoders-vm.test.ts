import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type { AppState, DecoderRow } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	decoderFacts,
	type DecoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"
import {
	decoderActionText,
	decoderConfirm,
	decoderDetail,
	decodersModel,
} from "../../../cli/source/view-models/decoders.js"
import { sparkline, wrapKV } from "../../../cli/source/view-models/detail.js"

// Clock strings are local; build expectations from the same instants.
const pad2 = (n: number): string => String(n).padStart(2, "0")
const clock = (ms: number): string => {
	const d = new Date(ms)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const RESTART = {
	kind: "decoder",
	op: "restart",
	decoderId: "readsb",
} as const

describe("decoders view-model", () => {
	const s = scenarioState("live")
	const fact = (st: AppState, id: string): DecoderFacts => {
		const f = decoderFacts(st).find(x => x.row.id === id)
		if (!f) throw new Error(`no ${id}`)
		return f
	}

	it("builds the readsb detail rows (spec §6.2)", () => {
		const rows = decoderDetail(s, fact(s, "readsb"), 119, s.now).map(lineText)
		expect(rows[0]).toBe(
			"readsb    ADS-B · network producer · IQ in, JSON lines out · pid 1531 · version —",
		)
		expect(rows).toContain(
			"process   up 51s · 0 restarts · 6 errors · server health idle",
		)
		expect(rows).toContain(
			"decodes   none since start (51s) · 0 events · last output —",
		)
		expect(rows.find(r => r.startsWith("IQ"))).toBe(
			"IQ        570.6 MB in · branch decoder-readsb · buffer 389.1 KB, high-water 262.1 KB · in backpressure 0.2s, 121× total",
		)
		expect(rows.find(r => r.startsWith("drops"))).toBe(
			"drops     38% now · 44% lifetime · 836.0 MB in 3 357 chunks · last drain 0.3s ago",
		)
		expect(rows).toContain(
			"band      1090.000 MHz nominal · window 444.947–446.995 MHz · out of window",
		)
		expect(rows.find(r => r.startsWith("activity"))).toMatch(
			/decodes\/min since \d\d:\d\d \(\d+ of 30 min observed\)/,
		)
	})

	it("shows a restarting decoder with its evidence and the server's health verbatim", () => {
		const rows = decoderDetail(s, fact(s, "acarsdec"), 119, s.now).map(lineText)
		expect(rows).toContain(
			"process   restarting · 13 restarts · 0 errors · server health running",
		)
	})

	it("shows core's lastError quoted and sanitised (R15)", () => {
		const at = new Date(s.now - 5000).toISOString()
		const withErr = {
			...s,
			decoders: laneOk(
				(s.decoders.value ?? []).map(d =>
					d.id === "acarsdec"
						? {
								...d,
								lastError: {
									kind: "exit" as const,
									message: "exited code 1\x1b[2J",
									at,
								},
							}
						: d,
				),
				s.now - 1000,
				"rest",
			),
		}
		const rows = decoderDetail(
			withErr,
			fact(withErr, "acarsdec"),
			119,
			s.now,
		).map(lineText)
		expect(rows).toContain('error     exit · "exited code 1" · 5s ago')
	})

	it("states configured targets a tuned decoder does not apply (R40)", () => {
		const tuned = {
			...s,
			decoders: laneOk(
				(s.decoders.value ?? []).map(d =>
					d.id === "dsd-fme" ? { ...d, targetFrequenciesHz: [446_525_000] } : d,
				),
				s.now - 1000,
				"rest",
			),
		}
		const rows = decoderDetail(tuned, fact(tuned, "dsd-fme"), 119, s.now).map(
			lineText,
		)
		const i = rows.findIndex(r => r.startsWith("band"))
		// Wider than the pane: wrapKV continues under the value column.
		expect(rows.slice(i, i + 2)).toEqual([
			"band      tuned (follows the receiver) · configured 446.525 MHz (not applied by this decoder)",
			"          window 444.947–446.995 MHz · in window",
		])
	})

	it("builds confirm prompts that name the target", () => {
		expect(decoderConfirm(s, "readsb", "restart")).toMatchObject({
			kind: "decoder",
			prompt: "restart readsb · up 51s · pid 1531",
			yes: "restart",
			no: "cancel",
			intent: RESTART,
		})
	})

	it("reports sent → restarted → cleared, and failures with the status quoted", () => {
		const t0 = s.now
		let st = reduce(
			s,
			[{ kind: "action:sent", at: t0, key: "decoder:readsb", intent: RESTART }],
			t0,
		)
		expect(decoderActionText(st, "readsb", t0)).toBe(
			`restart sent ${clock(t0)}`,
		)
		st = reduce(
			st,
			[
				{
					kind: "action:result",
					at: t0 + 500,
					key: "decoder:readsb",
					outcomes: [
						{
							label: "restart",
							result: {
								ok: true,
								outcome: "ok",
								status: 200,
								message: "restarted successfully",
							},
							at: t0 + 500,
						},
					],
				},
				{
					kind: "ws",
					at: t0 + 1000,
					event: { type: "decoder:started", decoderId: "readsb" },
				},
			],
			t0 + 1000,
		)
		const done = decoderActionText(st, "readsb", t0 + 1000)
		expect(done).toBe(`restarted ${clock(t0 + 1000)}`)
		// R29: server success prose is never echoed.
		expect(done).not.toContain("successfully")
		expect(decoderActionText(st, "readsb", t0 + 12_000)).toBeNull()
		const failed = reduce(
			s,
			[
				{ kind: "action:sent", at: t0, key: "decoder:readsb", intent: RESTART },
				{
					kind: "action:result",
					at: t0 + 10,
					key: "decoder:readsb",
					outcomes: [
						{
							label: "restart",
							result: {
								ok: false,
								outcome: "failed",
								status: 502,
								message: "bad gateway",
							},
							at: t0 + 10,
						},
					],
				},
			],
			t0 + 10,
		)
		expect(decoderActionText(failed, "readsb", t0 + 20)).toBe(
			'restart failed · 502 · "bad gateway"',
		)
	})

	it("says no reply in 10s for an unknown outcome (R23)", () => {
		const t0 = s.now
		const st = reduce(
			s,
			[
				{ kind: "action:sent", at: t0, key: "decoder:readsb", intent: RESTART },
				{
					kind: "action:result",
					at: t0 + 10_000,
					key: "decoder:readsb",
					outcomes: [
						{
							label: "restart",
							result: {
								ok: false,
								outcome: "unknown",
								status: null,
								message: "timeout",
							},
							at: t0 + 10_000,
						},
					],
				},
			],
			t0 + 10_000,
		)
		expect(decoderActionText(st, "readsb", t0 + 10_000)).toBe(
			`restart sent ${clock(t0)} · no reply in 10s`,
		)
	})

	it("truncates unknown long decoder ids and shows ? for unknown nominal bands (review focus)", () => {
		const odd: DecoderRow = {
			id: "an-extremely-long-decoder-identifier-used-for-truncation-tests",
			type: "mystery",
			running: true,
			health: "running",
			uptime: 5,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
		const st = {
			...s,
			decoders: laneOk(
				[...(s.decoders.value ?? []), odd],
				s.now - 1000,
				"rest" as const,
			),
		}
		const m = decodersModel(st, initialUi("decoders"), 119, 35, true)
		const row = m.list.map(lineText).find(r => r.includes("an-extremely")) ?? ""
		expect(row).toContain("…")
		expect(cellWidth(row)).toBeLessThanOrEqual(119)
	})

	it("places the detail by size", () => {
		const base = initialUi("decoders")
		const ui = {
			...base,
			selected: { ...base.selected, decoders: "readsb" },
			detail: { ...base.detail, decoders: { open: true, scroll: 0 } },
		}
		expect(decodersModel(s, ui, 119, 35, true).placement.kind).toBe("bottom")
		expect(decodersModel(s, ui, 199, 45, true).placement.kind).toBe("right")
		const overlay = decodersModel(s, ui, 79, 21, false)
		expect(overlay.placement.kind).toBe("overlay")
		expect(overlay.list).toEqual([])
	})
})

describe("detail helpers", () => {
	it("wraps label/value rows on separators, indenting continuations", () => {
		const rows = wrapKV("IQ", "aaaa · bbbb · cccc", 22).map(lineText)
		expect(rows).toEqual(["IQ        aaaa · bbbb", "          cccc"])
	})
	it("leaves unobserved minutes blank in the sparkline", () => {
		expect(sparkline([undefined, 0, 4, 8])).toBe(" ▁▅█")
		expect(sparkline([undefined, 0, 0])).toBe(" ▁▁")
	})
})
