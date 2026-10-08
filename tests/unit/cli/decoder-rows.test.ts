import { describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { pickVariant } from "../../../cli/source/ui/columns.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"
import {
	DECODERS_COLUMNS,
	OVERVIEW_COLUMNS,
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
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 119, 20, null, s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS          process             decodes           drop now  lifetime  nominal MHz      window",
		)
		const rows = t.rows.map(lineText)
		const acars = rows.find(r => r.includes("acarsdec")) ?? ""
		expect(acars).toMatch(
			/^! acarsdec +restarting ×13 +— +— +— +131\.550–131\.825 +out/,
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
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 79, 20, null, s.now)
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
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 59, 5, null, s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS         process     decodes       drop  window",
		)
		expect(t.rows).toHaveLength(5)
		expect(lineText(t.rows[4] ?? [])).toContain("+5 more")
		expect(t.shownIds).toHaveLength(4)
		const all = decoderTable(facts, OVERVIEW_COLUMNS, 59, 20, null, s.now)
		expect(all.rows.map(lineText).find(r => r.includes("lora"))).toMatch(
			/^● lora-meshtastic {2}up 50s {6}none for 50s {4}9% {2}out/,
		)
		for (const r of all.rows) expect(lineWidth(r)).toBeLessThanOrEqual(59)
	})

	it("hides nominal first in the Decoders view at 120 columns (§6.2)", () => {
		const t = decoderTable(facts, DECODERS_COLUMNS, 119, 20, "readsb", s.now)
		expect(lineText(t.header)).toBe(
			"  DECODERS          process     restarts  errors  decodes          events      IQ in  drop now  lifetime  window",
		)
		expect(lineText(t.header)).not.toContain("nominal")
		const readsb = t.rows.find(r => lineText(r).includes("readsb")) ?? []
		expect(readsb.slice(0, 3).every(sp => sp.role === "selected")).toBe(true)
	})

	it("keeps the selected row visible when rows are hidden", () => {
		const t = decoderTable(
			facts,
			OVERVIEW_COLUMNS,
			79,
			4,
			"lora-meshtastic",
			s.now,
		)
		expect(t.shownIds).toContain("lora-meshtastic")
	})

	it("never shows zero for unknown drops (legacy core)", () => {
		const legacy = scenarioState("legacy")
		const t = decoderTable(
			decoderFacts(legacy),
			OVERVIEW_COLUMNS,
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
		const rowAt = (cols: typeof OVERVIEW_COLUMNS, w: number): string =>
			lineText(
				decoderTable(facts, cols, w, 20, null, s.now).rows.find(r =>
					lineText(r).includes("acarsdec"),
				) ?? [],
			)
		// Overview standard (process 18): mid. Decoders view (process 10) and narrow: min.
		expect(rowAt(OVERVIEW_COLUMNS, 119)).toContain("restarting ×13 ")
		expect(rowAt(OVERVIEW_COLUMNS, 79)).toContain("restarting ×13 ")
		expect(rowAt(OVERVIEW_COLUMNS, 59)).toMatch(/restarting +—/)
		expect(rowAt(DECODERS_COLUMNS, 119)).toMatch(/restarting +13 /)
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

	it("R40/R15: tuned stays tuned with a note; a configured band says cfg", () => {
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
		expect(rtl && text(decoderCells(rtl, s.now)["nominal"])).toBe("433.920 cfg")
	})

	it("sanitises server-sent decoder ids (review focus 4)", () => {
		const evil = "x\x1b[2J\u202Ey"
		const f: DecoderFacts = {
			...by("readsb"),
			row: { ...by("readsb").row, id: evil },
		}
		const t = decoderTable([f], OVERVIEW_COLUMNS, 119, 5, evil, s.now)
		for (const line of [...t.rows, t.header])
			expect(/[\u0000-\u001f\u007f-\u009f\u202E]/.test(lineText(line))).toBe(
				false,
			)
	})
})
