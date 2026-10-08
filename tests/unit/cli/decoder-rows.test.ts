import { describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import {
	POLL_ENDPOINTS,
	type AppState,
} from "../../../cli/source/data/types.js"
import { pickVariant } from "../../../cli/source/ui/columns.js"
import { bannerConditions } from "../../../cli/source/view-models/chrome.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"
import {
	decoderCells,
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
	type DecoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"

const text = (c: ReturnType<typeof decoderCells>[string] | undefined): string =>
	lineText(c?.variants[c.variants.length - 1] ?? [])

describe("decoder rows (live fixture)", () => {
	const s = scenarioState("live", { summarize: formatMessage })
	const facts = decoderFacts(s)
	const by = (id: string): DecoderFacts => {
		const f = facts.find(x => x.row.id === id)
		if (!f) throw new Error(`no ${id}`)
		return f
	}

	it("derives process, decodes, drops and window per decoder", () => {
		// R15/R31: !running with restarts on record and not faulted is core's
		// restart backoff: "restarting", attention, not failing.
		expect(by("acarsdec")).toMatchObject({
			proc: "restarting",
			role: "attention",
			failing: false,
			dropNow: null,
			membership: "out",
		})
		expect(by("readsb")).toMatchObject({
			proc: "up",
			backpressure: true,
			membership: "out",
		})
		expect(by("readsb").dropNow).toBeCloseTo(0.38, 3)
		expect(by("dsd-fme")).toMatchObject({ membership: "in", nominal: "tuned" })
		expect(by("dsd-fme").ratePerSec).toBeGreaterThan(0)
	})

	it("renders the 120-column overview table like spec §6.1", () => {
		const t = decoderTable(facts, "overview", 119, 20, null, s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS          process             decodes           drop now  lifetime  nominal MHz *cfg  window",
		)
		const rows = t.rows.map(lineText)
		const acars = rows.find(r => r.includes("acarsdec")) ?? ""
		expect(acars).toMatch(
			/^! acarsdec +restarting ×13 +— +— +— +131\.550–131\.825\* +out/,
		)
		const readsb = rows.find(r => r.includes("readsb")) ?? ""
		expect(readsb).toMatch(
			/^● readsb +up 51s +none for 51s +!38% +44% +1090\.000 +out/,
		)
		expect(rows[0]).toMatch(
			/^● dsd-fme {11}up 52s {14}2\/min · \d+s ago +12% +36% {2}tuned/,
		)
		for (const r of t.rows) expect(lineWidth(r)).toBeLessThanOrEqual(119)
	})

	it("drops lifetime and nominal whole at 80 columns, keeping core cells rich (§6.1 80×24)", () => {
		const t = decoderTable(facts, "overview", 79, 20, null, s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS          process             decodes           drop now  window",
		)
		const rows = t.rows.map(lineText)
		expect(rows.find(r => r.includes("acarsdec"))).toMatch(
			/restarting ×13 +— +— +out/,
		)
		expect(rows.find(r => r.includes("rtl433"))).toMatch(
			/^● rtl433 {12}up 51s {14}none for 51s {10}!15% {2}out/,
		)
	})

	it("drops lifetime and nominal at 60 columns and marks hidden rows (§6.1 60×20)", () => {
		const t = decoderTable(facts, "overview", 59, 5, null, s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS         process     decodes       drop  window",
		)
		expect(t.rows).toHaveLength(5)
		expect(lineText(t.rows[4] ?? [])).toContain("+5 more")
		expect(t.shownIds).toHaveLength(4)
		const all = decoderTable(facts, "overview", 59, 20, null, s.now)
		expect(all.rows.map(lineText).find(r => r.includes("lora"))).toMatch(
			/^● lora-meshtastic {2}up 50s {6}none for 50s {4}9% {2}out/,
		)
		for (const r of all.rows) expect(lineWidth(r)).toBeLessThanOrEqual(59)
	})

	it("hides nominal first in the Decoders view at 120 columns (§6.2)", () => {
		const t = decoderTable(facts, "decoders", 119, 20, "readsb", s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS          process     restarts  errors  decodes          events      IQ in  drop now  lifetime  window",
		)
		expect(lineText(t.header)).not.toContain("nominal")
		const readsb = t.rows.find(r => lineText(r).includes("readsb")) ?? []
		expect(readsb.slice(0, 3).every(sp => sp.role === "selected")).toBe(true)
	})

	it("keeps the selected row visible when rows are hidden", () => {
		const t = decoderTable(facts, "overview", 79, 4, "lora-meshtastic", s.now)
		expect(t.shownIds).toContain("lora-meshtastic")
	})

	it("never shows zero for unknown drops (legacy core)", () => {
		const legacy = scenarioState("legacy")
		const t = decoderTable(
			decoderFacts(legacy),
			"overview",
			119,
			20,
			null,
			legacy.now,
		)
		const dsd = t.rows.map(lineText).find(r => r.includes("dsd-fme")) ?? ""
		expect(dsd).toMatch(/\?/)
		expect(dsd).not.toMatch(/ 0% /)
	})

	it("explains missing decoder data", () => {
		expect(lineText(decodersPlaceholder(scenarioState("api-down")) ?? [])).toBe(
			"no data · API unreachable",
		)
		expect(decodersPlaceholder(scenarioState("live"))).toBeNull()
	})

	it("R8: a stopped decoder with a branch keeps its lifetime %, drop now is —", () => {
		const r = by("readsb")
		const stopped: DecoderFacts = {
			...r,
			row: { ...r.row, running: false },
			proc: "stopped",
			role: "neutral",
			dropNow: null,
		}
		const cells = decoderCells(stopped, s.now)
		expect(text(cells["drop"])).toBe("—")
		expect(text(cells["lifetime"])).toBe("44%")
		expect(text(cells["process"])).toBe("stopped")
	})

	it("R31: restarting renders with the attention role and glyph", () => {
		const cells = decoderCells(by("acarsdec"), s.now)
		const proc = cells["process"]?.variants[0] ?? []
		expect(proc[0]?.role).toBe("attention")
		const name = cells["decoder"]?.variants[0] ?? []
		expect(name[0]).toMatchObject({ text: "!", role: "attention" })
	})

	it("R50: restarting keeps its evidence as width allows (rich, mid, min)", () => {
		const proc = decoderCells(by("acarsdec"), s.now)["process"]
		expect(proc?.variants.map(lineText)).toEqual([
			"restarting",
			"restarting ×13",
			"restarting · 13 restarts",
		])
		for (const v of proc?.variants ?? [])
			for (const span of v) expect(span.role).toBe("attention")
		expect(lineText(pickVariant(proc ?? { variants: [[]] }, 24))).toBe(
			"restarting · 13 restarts",
		)
		const rowAt = (cols: "overview" | "decoders", w: number): string =>
			lineText(
				decoderTable(facts, cols, w, 20, null, s.now).rows.find(r =>
					lineText(r).includes("acarsdec"),
				) ?? [],
			)
		// Overview standard (process 18): mid. Decoders view (process 10) and narrow: min.
		expect(rowAt("overview", 119)).toContain("restarting ×13 ")
		expect(rowAt("overview", 79)).toContain("restarting ×13 ")
		expect(rowAt("overview", 59)).toMatch(/restarting +—/)
		expect(rowAt("decoders", 119)).toMatch(/restarting +13 /)
	})

	it("R50: down with restarts reads down · N restarts; no restarts, just down", () => {
		const a = by("acarsdec")
		const down: DecoderFacts = { ...a, proc: "down", role: "fault" }
		const v = decoderCells(down, s.now)["process"]?.variants ?? []
		expect(v.map(lineText)).toEqual(["down", "down ×13", "down · 13 restarts"])
		for (const line of v)
			for (const span of line) expect(span.role).toBe("fault")
		const fresh: DecoderFacts = { ...down, row: { ...a.row, restartCount: 0 } }
		expect(
			decoderCells(fresh, s.now)["process"]?.variants.map(lineText),
		).toEqual(["down"])
	})

	it("R21: a nonzero drop never reads 0%", () => {
		const cells = decoderCells({ ...by("direwolf"), dropNow: 0.004 }, s.now)
		expect(text(cells["drop"])).toBe("<1%")
	})

	it("R40/R15: tuned stays tuned with a note; a configured band carries its mark", () => {
		const withTargets = {
			...s,
			decoders: {
				...s.decoders,
				value: (s.decoders.value ?? []).map(d =>
					d.id === "dsd-fme"
						? { ...d, targetFrequenciesHz: [446_525_000] }
						: d.id === "rtl433"
							? { ...d, targetFrequenciesHz: [433_920_000] }
							: d,
				),
			},
		}
		const f = decoderFacts(withTargets)
		const dsd = f.find(x => x.row.id === "dsd-fme")
		expect(dsd).toMatchObject({
			nominal: "tuned",
			membership: "in",
			bandOrigin: "nominal",
			bandNote: "configured 446.525 MHz (not applied by this decoder)",
		})
		const rtl = f.find(x => x.row.id === "rtl433")
		expect(rtl?.bandOrigin).toBe("configured")
		expect(rtl && text(decoderCells(rtl, s.now)["nominal"])).toBe("433.920*")
	})

	it("sanitises server-sent decoder ids (review focus 4)", () => {
		const evil = "x\x1b[2J\u202Ey"
		const f: DecoderFacts = {
			...by("readsb"),
			row: { ...by("readsb").row, id: evil },
		}
		const t = decoderTable([f], "overview", 119, 5, evil, s.now)
		for (const line of [...t.rows, t.header])
			expect(/[\u0000-\u001f\u007f-\u009f\u202E]/.test(lineText(line))).toBe(
				false,
			)
	})

	describe("fix round 1", () => {
		const configured = facts.filter(f => f.bandOrigin === "configured")
		it("I1: a configured band is marked at every width the column shows", () => {
			expect(configured.map(f => f.row.id).sort()).toEqual([
				"acarsdec",
				"dumpvdl2",
			])
			for (const [kind, w] of [
				["overview", 199],
				["overview", 119],
				["decoders", 199],
			] as const) {
				const t = decoderTable(facts, kind, w, 20, null, s.now)
				expect(lineText(t.header)).toContain("nominal MHz *cfg")
				const acars = lineText(
					t.rows.find(r => lineText(r).includes("acarsdec")) ?? [],
				)
				expect(acars).toContain("131.550–131.825*")
			}
			// At 80 the band column is gone, so no bare configured band appears.
			const at80 = decoderTable(facts, "overview", 79, 20, null, s.now)
			expect(lineText(at80.header)).not.toContain("nominal")
			// Without configured rows the mockup header is unchanged.
			const plain = facts.filter(f => f.bandOrigin !== "configured")
			expect(
				lineText(decoderTable(plain, "overview", 119, 20, null, s.now).header),
			).toBe(
				"  DECODERS          process             decodes           drop now  lifetime  nominal MHz      window",
			)
		})
		it("I2: every cell of a stale lane is dim, and dim covers whole rows (api-down-cached)", () => {
			const cached = scenarioState("api-down-cached")
			const f = decoderFacts(cached)
			expect(f.length).toBeGreaterThan(0)
			// The cached lanes are past the TTL on their own: no option needed to dim them.
			expect(f.every(x => x.oldRest && x.oldFanout)).toBe(true)
			const own = decoderTable(f, "overview", 119, 20, null, cached.now)
			for (const row of own.rows)
				for (const span of row)
					if (span.text.trim() !== "" && span.role !== "old")
						throw new Error(`not dim: ${JSON.stringify(span)}`)
			const t = decoderTable(f, "overview", 119, 20, null, cached.now, {
				dim: true,
			})
			for (const row of t.rows)
				for (const span of row)
					if (span.text.trim() !== "") expect(span.role).toBe("old")
			// Lane-driven: an old decoders lane dims every REST cell without the option.
			const oldRest = { ...by("readsb"), oldRest: true }
			const cells = decoderCells(oldRest, s.now)
			for (const id of [
				"decoder",
				"process",
				"decodes",
				"restarts",
				"errors",
				"events",
				"iq",
			])
				for (const span of cells[id]?.variants[0] ?? [])
					expect(span.role).toBe("old")
			expect(cells["drop"]?.variants[0]?.[0]?.role).not.toBe("old")
			const oldFanout = decoderCells(
				{ ...by("readsb"), oldFanout: true },
				s.now,
			)
			for (const id of ["drop", "lifetime"])
				for (const span of oldFanout[id]?.variants[0] ?? [])
					expect(span.role).toBe("old")
			const oldWindow = decoderCells(
				{ ...by("readsb"), oldWindow: true },
				s.now,
			)
			for (const id of ["window", "nominal"])
				for (const span of oldWindow[id]?.variants[0] ?? [])
					expect(span.role).toBe("old")
		})
		it("m2: starting has a minimal variant that fits 10 columns", () => {
			const st: DecoderFacts = {
				...by("readsb"),
				proc: "starting",
				role: "neutral",
				row: { ...by("readsb").row, uptime: 4 },
			}
			const v = decoderCells(st, s.now)["process"]?.variants.map(lineText)
			expect(v).toEqual(["starting", "starting 4s"])
		})
		it("m3: the window — follows the glyph mode", () => {
			setGlyphMode("ascii")
			try {
				const ext = decoderCells({ ...by("readsb"), membership: "—" }, s.now)
				expect(text(ext["window"])).toBe("-")
			} finally {
				setGlyphMode("utf8")
			}
		})
		it("m5: unknown drop under backpressure is '? !'; no branch on a fresh fanout is —", () => {
			const r = by("readsb")
			expect(
				text(
					decoderCells({ ...r, dropNow: null, backpressure: true }, s.now)[
						"drop"
					],
				),
			).toBe("? !")
			const nob = decoderCells(
				{
					...r,
					branch: null,
					dropNow: null,
					lifetime: null,
					backpressure: false,
					fanoutFresh: true,
				},
				s.now,
			)
			expect(text(nob["drop"])).toBe("—")
			expect(text(nob["lifetime"])).toBe("—")
		})
		it("m7: one failing endpoint is not 'API unreachable' (§9)", () => {
			const st = {
				...s,
				conn: {
					...s.conn,
					rest: { ...s.conn.rest, failing: ["decoders" as const] },
				},
				decoders: {
					value: undefined,
					receivedAt: null,
					origin: "rest" as const,
					error: {
						kind: "http" as const,
						status: 500,
						message: "boom",
						at: s.now,
					},
				},
			}
			expect(lineText(decodersPlaceholder(st) ?? [])).toBe(
				"no data · GET /api/decoders failing · 500",
			)
		})
	})
	describe("R57 follow-ups", () => {
		const err = (status: number) => ({
			kind: "http" as const,
			status,
			message: "boom",
			at: s.now,
		})
		const noDecoders = {
			value: undefined,
			receivedAt: null,
			origin: "rest" as const,
			error: err(500),
		}
		it("placeholder agrees with the banner: endpoint failing, then whole API down", () => {
			const one: AppState = {
				...s,
				decoders: noDecoders,
				conn: { ...s.conn, rest: { ...s.conn.rest, failing: ["decoders"] } },
			}
			expect(lineText(decodersPlaceholder(one) ?? [])).toBe(
				"no data · GET /api/decoders failing · 500",
			)
			const ep = bannerConditions(one).find(c => c.kind === "endpoint")
			expect(ep).toMatchObject({ path: "/api/decoders", reason: "500" })
			const all: AppState = {
				...one,
				conn: {
					...one.conn,
					ws: { ...one.conn.ws, state: "closed" },
					rest: {
						...one.conn.rest,
						failing: [...POLL_ENDPOINTS],
						lastError: { kind: "network", message: "ECONNREFUSED", at: s.now },
					},
				},
			}
			expect(bannerConditions(all)[0]?.kind).toBe("api-down")
			expect(lineText(decodersPlaceholder(all) ?? [])).toBe(
				"no data · API unreachable",
			)
		})
		it("never truncates a configured band's mark: the column fits the widest label", () => {
			const wide = {
				...s,
				decoders: {
					...s.decoders,
					value: (s.decoders.value ?? []).map(d =>
						d.id === "readsb"
							? { ...d, targetFrequenciesHz: [978_000_000, 1_090_000_000] }
							: d,
					),
				},
			}
			const t = decoderTable(
				decoderFacts(wide),
				"overview",
				119,
				20,
				null,
				s.now,
			)
			const row = lineText(
				t.rows.find(r => lineText(r).includes("readsb")) ?? [],
			)
			expect(row).toContain("978.000–1090.000*")
		})
		it("a selected row keeps the selected role under dim", () => {
			const t = decoderTable(facts, "overview", 119, 20, "readsb", s.now, {
				dim: true,
			})
			const row = t.rows.find(r => lineText(r).includes("readsb")) ?? []
			expect(row.slice(0, 3).map(x => x.role)).toEqual([
				"selected",
				"selected",
				"selected",
			])
			expect(
				row
					.slice(4)
					.filter(x => x.text.trim() !== "")
					.every(x => x.role === "old"),
			).toBe(true)
		})
	})
})
