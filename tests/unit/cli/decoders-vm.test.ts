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
			[
				{
					kind: "action:sent",
					at: t0,
					id: 1,
					key: "decoder:readsb",
					intent: RESTART,
				},
			],
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
					id: 1,
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
				{
					kind: "action:sent",
					at: t0,
					id: 1,
					key: "decoder:readsb",
					intent: RESTART,
				},
				{
					kind: "action:result",
					id: 1,
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
				{
					kind: "action:sent",
					at: t0,
					id: 1,
					key: "decoder:readsb",
					intent: RESTART,
				},
				{
					kind: "action:result",
					id: 1,
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
		// Nothing reconciled within 10 s more: the record ends as no-reply (R47 M5).
		const later = reduce(st, [], t0 + 21_000)
		expect(decoderActionText(later, "readsb", t0 + 21_000)).toBe(
			`restart sent ${clock(t0)} · no reply · not confirmed`,
		)
		expect(decoderActionText(later, "readsb", t0 + 32_000)).toBeNull()
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

	it("fits every detail row to the pane width (no reliance on Ink truncation)", () => {
		const f = fact(s, "readsb")
		for (const w of [86, 60, 40]) {
			const rows = decoderDetail(s, f, w, s.now)
			for (const r of rows)
				expect(cellWidth(lineText(r))).toBeLessThanOrEqual(w)
			const activity =
				rows.map(lineText).find(r => r.startsWith("activity")) ?? ""
			// The sparkline always stays; the caption shortens, then drops whole at 40.
			if (w >= 60) expect(activity).toContain("decodes/min")
			expect(activity.endsWith("…")).toBe(false)
		}
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

describe("R65 M2: server-chosen types are plain keys", () => {
	it("a decoder of type 'constructor' or '__proto__' renders with unknown band and raw type", () => {
		const s = scenarioState("live")
		for (const type of ["constructor", "__proto__", "toString"]) {
			const odd: DecoderRow = {
				id: `odd-${type}`,
				type,
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
			const f = decoderFacts(st).find(x => x.row.id === odd.id)
			expect(f?.nominal).toBe("?")
			const rows = f ? decoderDetail(st, f, 119, s.now).map(lineText) : []
			expect(rows[0]).toContain(`${type} · pid —`)
		}
	})
})

describe("B5 fix round 1", () => {
	const s = scenarioState("live")
	const fact = (st: AppState, id: string): DecoderFacts => {
		const f = decoderFacts(st).find(x => x.row.id === id)
		if (!f) throw new Error(`no ${id}`)
		return f
	}
	const sent = reduce(
		s,
		[
			{
				kind: "action:sent",
				at: s.now,
				id: 7,
				key: "decoder:readsb",
				intent: RESTART,
			},
		],
		s.now,
	)
	const open = (id: string) => {
		const b = initialUi("decoders")
		return {
			...b,
			selected: { ...b.selected, decoders: id },
			detail: { ...b.detail, decoders: { open: true, scroll: 0 } },
		}
	}

	it("I1/R75: the last decoder write is the footer notice while the detail is closed", () => {
		const m = decodersModel(sent, initialUi("decoders"), 119, 35, true)
		expect(m.notice).toBe(`readsb · restart sent ${clock(s.now)}`)
		expect(m.list.map(lineText).some(l => l.includes("restart sent"))).toBe(
			false,
		)
		const withDetail = decodersModel(sent, open("readsb"), 119, 35, true)
		expect(withDetail.notice).toBeNull()
		expect(
			withDetail.list.map(lineText).some(l => l.includes("restart sent")),
		).toBe(false)
		expect(
			withDetail.detail?.map(lineText).some(l => l.includes("restart sent")),
		).toBe(true)
	})

	it("I2: a stale detail is dim per lane and never claims no backpressure", () => {
		const stale = reduce(s, [], s.now + 20_000)
		const rows = decoderDetail(stale, fact(stale, "readsb"), 119, stale.now)
		const iq = rows.find(r => lineText(r).startsWith("IQ")) ?? []
		expect(lineText(iq)).toContain("backpressure ?")
		expect(lineText(iq)).not.toContain("no backpressure")
		for (const label of [
			"readsb",
			"process",
			"decodes",
			"IQ",
			"drops",
			"band",
		]) {
			const row = rows.find(r => lineText(r).startsWith(label)) ?? []
			expect(row.slice(1).every(x => x.role === "old")).toBe(true)
		}
	})

	it("I3: a stopped decoder with a branch reads drop now — (R8)", () => {
		const r = fact(s, "readsb")
		const stopped: DecoderFacts = {
			...r,
			row: { ...r.row, running: false },
			proc: "stopped",
			role: "neutral",
			dropNow: null,
		}
		const drops = decoderDetail(s, stopped, 119, s.now)
			.map(lineText)
			.find(l => l.startsWith("drops"))
		expect(drops).toMatch(/^drops {5}— now · 44% lifetime/)
	})

	it("I4: hidden detail rows are marked and reachable by scrolling (59x14, 80x30)", () => {
		const at = new Date(s.now - 5000).toISOString()
		const withErr = {
			...s,
			decoders: laneOk(
				(s.decoders.value ?? []).map(d =>
					d.id === "readsb"
						? {
								...d,
								lastError: {
									kind: "exit" as const,
									message: "exited code 1",
									at,
								},
							}
						: d,
				),
				s.now - 1000,
				"rest",
			),
		}
		for (const [w, h, roomy] of [
			[59, 14, false],
			[80, 30, true],
			[59, 10, false],
		] as const) {
			const first =
				decodersModel(withErr, open("readsb"), w, h, roomy).detail?.map(
					lineText,
				) ?? []
			const ui = {
				...open("readsb"),
				detail: {
					...open("readsb").detail,
					decoders: { open: true, scroll: 999 },
				},
			}
			const last =
				decodersModel(withErr, ui, w, h, roomy).detail?.map(lineText) ?? []
			expect(last.some(l => l.startsWith("activity"))).toBe(true)
			expect(last.some(l => l.startsWith("error"))).toBe(true)
			// A marker appears exactly when rows are hidden (at 59x10 they are).
			const hidden = !first.some(l => l.startsWith("error"))
			expect(/^\+\d+ rows · PgDn$/.test(first.at(-1) ?? "")).toBe(hidden)
			expect(/^\+\d+ rows · PgUp$/.test(last[0] ?? "")).toBe(hidden)
			if (h === 10) expect(hidden).toBe(true)
			for (const l of [...first, ...last])
				expect(cellWidth(l)).toBeLessThanOrEqual(w)
		}
	})

	it("I5: the detail header shows the full id, two spaces, then the identity", () => {
		for (const id of ["multimon-ng", "ais-catcher", "lora-meshtastic"]) {
			const head = lineText(decoderDetail(s, fact(s, id), 119, s.now)[0] ?? [])
			expect(head.startsWith(`${id}  `)).toBe(true)
			expect(head).not.toContain("…")
		}
	})

	it("M3: a last-decode-only fact does not repeat 'last … · last output …'", () => {
		const f = fact(s, "dsd-fme")
		const last: DecoderFacts = {
			...f,
			decodes: { kind: "last", lastAt: s.now - 5000 },
			lastAt: s.now - 5000,
		}
		const row =
			decoderDetail(s, last, 119, s.now)
				.map(lineText)
				.find(l => l.startsWith("decodes")) ?? ""
		expect(row).toBe("decodes   3 events · last output 5s ago")
	})

	it("M4/M6: no outcome text reads an unquoted ?; accepted without an event says so", () => {
		const failed = reduce(
			sent,
			[
				{
					kind: "action:result",
					id: 7,
					at: s.now + 10,
					key: "decoder:readsb",
					outcomes: [{ label: "restart", result: null, at: null }],
				},
			],
			s.now + 10,
		)
		expect(decoderActionText(failed, "readsb", s.now + 20)).toBe(
			"restart failed · network · ?",
		)
		const ok = reduce(
			sent,
			[
				{
					kind: "action:result",
					id: 7,
					at: s.now + 300,
					key: "decoder:readsb",
					outcomes: [
						{
							label: "restart",
							result: { ok: true, outcome: "ok", status: 200, message: "" },
							at: s.now + 300,
						},
					],
				},
			],
			s.now + 300,
		)
		expect(decoderActionText(ok, "readsb", s.now + 400)).toBe(
			`restart accepted ${clock(s.now + 300)} · 200`,
		)
	})

	it("M5: a long quoted server text is cut inside its quotes", () => {
		const rows = wrapKV(
			"error",
			`exit · "${"x".repeat(200)}" · 5s ago`,
			60,
		).map(lineText)
		const quotedRow = rows.find(r => r.includes('"')) ?? ""
		expect(quotedRow.trimEnd().endsWith('…"')).toBe(true)
		for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(60)
	})
})
