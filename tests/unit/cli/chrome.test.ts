import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import type { KeyContext } from "../../../cli/source/ui/keymap.js"
import { stripLine } from "../../../cli/source/ui/strip.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import {
	bannerConditions,
	confirmLine,
	footerWithNotice,
	stripInput,
	switcherLine,
} from "../../../cli/source/view-models/chrome.js"
import { helpLines } from "../../../cli/source/view-models/help.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const ctx: KeyContext = {
	view: "decoders",
	confirm: null,
	help: true,
	input: false,
	edit: false,
	detail: false,
	heightClass: "roomy",
	rows: 9,
	v: {
		hasSelection: true,
		decoderRunning: true,
		control: null,
		audioRunning: null,
		paused: false,
	},
}

describe("strip input", () => {
	it("derives the audit strip from the live fixture", () => {
		const s = scenarioState("live")
		const input = stripInput(s)
		// R15/R31: acarsdec (running false, 13 restarts, not faulted) is "restarting",
		// attention rather than failing; it is still not up.
		expect(input.decoders).toEqual({
			up: 8,
			total: 9,
			failing: 0,
			restarting: 1,
			inWindow: 2,
		})
		// R46: the restarting decoder is visible in the strip.
		expect(lineText(stripLine(input, 199))).toContain("1 restarting")
		expect(input.drops.backpressure).toBe(true)
		expect(input.drops.ratio).toBeCloseTo(0.2125, 3)
		expect(lineText(stripLine(input, 119))).toMatch(
			/^api ● 2s {2}iq ● streaming · 4\.1 MB\/s {2}rx 445\.971 MHz/,
		)
	})
	it("reads crash-loop as failing and REST-down as a split api lane", () => {
		expect(stripInput(scenarioState("crash-loop")).decoders?.failing).toBe(1)
		// R15: the WS source:status frame keeps the IQ lane fresh while REST is down.
		// M2: at 80 the rx span outranks the iq word; the live glyph stays, the word returns at 120.
		expect(
			lineText(stripLine(stripInput(scenarioState("ws-only")), 79)),
		).toMatch(/^api ws ● rest × 45s {2}iq ● /)
		expect(
			lineText(stripLine(stripInput(scenarioState("ws-only")), 119)),
		).toMatch(/^api ws ● rest × 45s {2}iq ● streaming/)
		expect(
			lineText(stripLine(stripInput(scenarioState("api-down")), 79)),
		).toMatch(/^api × .*decoders \?.*drops \?/)
	})
	it("summarises two sources with the worst state (review focus 5)", () => {
		const s = scenarioState("live")
		const src = s.sources.value![0]!
		const stale: ExtendedSourceStatus = {
			...src,
			id: "pi-b",
			activity: {
				state: "stale",
				lastSampleAt: null,
				sampleAgeMs: 30000,
				timeoutMs: 10000,
			},
		}
		const two = { ...s, sources: laneOk([src, stale], s.now - 1000, "rest") }
		expect(lineText(stripLine(stripInput(two), 119))).toContain(
			"iq × 1/2 streaming",
		)
	})
})

describe("banner conditions", () => {
	it("maps connectivity states to one banner each", () => {
		expect(bannerConditions(scenarioState("live"))).toEqual([])
		expect(bannerConditions(scenarioState("api-down-cached"))[0]).toMatchObject(
			{ kind: "api-down", reason: "ECONNREFUSED" },
		)
		expect(bannerConditions(scenarioState("ws-only"))[0]).toMatchObject({
			kind: "rest-down",
			reason: "timeout 2s",
		})
		expect(bannerConditions(scenarioState("rest-only"))[0]).toMatchObject({
			kind: "ws-down",
			code: 1006,
		})
	})
})

describe("footer, confirm, switcher, help", () => {
	it("prepends a recent notice", () => {
		const out = lineText(
			footerWithNotice(
				{
					...ctx,
					help: false,
					view: "receiver",
					v: { ...ctx.v, control: "external" },
				},
				{ text: "controlled externally · c to take control", at: 1000 },
				2000,
				119,
			),
		)
		expect(
			out.startsWith(
				"controlled externally · c to take control  c take control",
			),
		).toBe(true)
	})
	it("renders the confirm bar with the prompt cut before the hints", () => {
		const c = {
			kind: "decoder" as const,
			prompt: "restart readsb · up 51s · pid 1531",
			yes: "restart",
			no: "cancel",
			intent: {
				kind: "decoder" as const,
				op: "restart" as const,
				decoderId: "readsb",
			},
		}
		expect(lineText(confirmLine(c, 119))).toBe(
			"▶ restart readsb · up 51s · pid 1531   y restart  n cancel",
		)
		const narrow = lineText(confirmLine(c, 40))
		expect(narrow.endsWith("y restart  n cancel")).toBe(true)
		expect(cellWidth(narrow)).toBeLessThanOrEqual(40)
	})
	it("highlights the active view", () => {
		const l = switcherLine("decoders", 119)
		expect(lineText(l)).toBe(
			"1 Overview  2 Decoders  3 Messages  4 Receiver  5 System",
		)
		expect(l.find(s => s.text === "Decoders")?.role).toBe("selected")
	})
	it("draws a 60-column help box with the legend and diagnostics", () => {
		const lines = helpLines(ctx, 119, 35, {
			invalidFrames: 2,
			rejectedItems: 1,
		}).map(lineText)
		expect(lines[0]).toMatch(/┌─ keys · Decoders ─+┐/)
		const box = lines.filter(l => l.trim() !== "")
		for (const l of box) expect(cellWidth(l.trimStart())).toBe(60)
		expect(lines.join("\n")).toContain(
			"band  core's targets or WaveKit's table · * configured",
		)
		expect(lines.join("\n")).toContain("frames rejected 2 · items rejected 1")
		expect(findBanned(lines.join("\n"))).toEqual([])
	})
})

describe("M6: rx uses windowFor and the age of its actual source", () => {
	it("a tuner frequency of 0 falls back to the source centre, never 0.000 MHz", () => {
		const s = scenarioState("live")
		const tuner = s.tuner.value!.map(t => ({ ...t, frequency: 0 }))
		const src = s.sources.value!.map(x => ({
			...x,
			caps: { ...x.caps, centerFreq: 446_000_000 },
		}))
		const st = {
			...s,
			tuner: { ...s.tuner, value: tuner },
			sources: { ...s.sources, value: src },
		}
		const input = stripInput(st)
		expect(input.rx?.centreHz).toBe(446_000_000)
		expect(lineText(stripLine(input, 199))).not.toContain("0.000 MHz")
	})
	it("dims rx by the lane the centre came from", () => {
		const s = scenarioState("live")
		const oldAt = s.now - 60_000
		// Centre from the tuner; tuner lane old → dim, even though sources are fresh.
		const tunerOld = { ...s, tuner: { ...s.tuner, receivedAt: oldAt } }
		expect(stripInput(tunerOld).old.rx).toBe(true)
		// Centre and rate from the source caps (tuner reports 0 for both); the old
		// tuner lane does not dim them (item 8 dims by both centre and rate lanes).
		const fromSource = {
			...tunerOld,
			tuner: {
				...tunerOld.tuner,
				value: s.tuner.value!.map(t => ({ ...t, frequency: 0, sampleRate: 0 })),
			},
			sources: {
				...s.sources,
				value: s.sources.value!.map(x => ({
					...x,
					caps: { ...x.caps, centerFreq: 446_000_000 },
				})),
			},
		}
		expect(stripInput(fromSource).old.rx).toBe(false)
		expect(stripInput(s).old.rx).toBe(false)
	})
})

describe("M11: help lists every binding of the view, from the keymap", () => {
	afterEach(() => setGlyphMode("utf8"))
	const diag = { invalidFrames: 0, rejectedItems: 0 }
	const noSel: KeyContext = {
		...ctx,
		v: {
			hasSelection: false,
			decoderRunning: null,
			control: null,
			audioRunning: null,
			paused: false,
		},
		rows: 0,
	}
	const text = (c: KeyContext, height = 40) =>
		helpLines(c, 119, height, diag).map(lineText).join("\n")
	it("is not filtered by selection or running state", () => {
		const t = text(noSel)
		for (const s of [
			"start (asks to confirm)",
			"stop (asks to confirm)",
			"restart (asks to confirm)",
			"open detail",
			"close detail",
			"↑↓ j k",
			"PgUp PgDn",
			"top",
			"newest",
			"reconnect + refetch",
			"this help",
			"quit",
			"1-5",
			"next view",
		]) {
			expect(t).toContain(s)
		}
		expect(t).toMatch(/│ s +start \(asks to confirm\)/)
		expect(t).toMatch(/│ R +restart \(asks to confirm\)/)
		expect(t).toMatch(/ G +newest/)
		expect(t).toMatch(/ g +top/)
	})
	it("lists view-specific keys from the keymap", () => {
		const recv = text({ ...noSel, view: "receiver" })
		expect(recv).toContain("edit tuner")
		expect(recv).toContain("take / release control (asks to confirm)")
		expect(recv).toContain("review (asks to confirm)")
		expect(recv).not.toContain("restart (asks to confirm)")
		const msgs = text({ ...noSel, view: "messages" })
		for (const s of [
			"filter",
			"pause / resume",
			"copy JSON",
			"scroll detail",
			"apply filter",
		])
			expect(msgs).toContain(s)
		const sys = text({ ...noSel, view: "system" })
		expect(sys).toContain("start / stop audio")
		expect(sys).toContain("audio preset (asks to confirm)")
	})
	it("never cuts a label, and keeps the 60-column box in ASCII mode", () => {
		setGlyphMode("ascii")
		const lines = helpLines(noSel, 119, 40, diag).map(lineText)
		const t = lines.join("\n")
		expect(t).toContain("^v j k")
		expect(t).not.toContain("...)")
		for (const l of lines.filter(l => l.trim() !== ""))
			expect(cellWidth(l.trimStart())).toBe(60)
	})
})

describe("R53: rx shows the centre alone when the rate is unknown", () => {
	it("keeps the centre with no span", () => {
		const s = scenarioState("live")
		const st = {
			...s,
			tuner: {
				...s.tuner,
				value: s.tuner.value!.map(t => ({ ...t, sampleRate: 0 })),
			},
			sources: {
				...s.sources,
				value: s.sources.value!.map(x => ({
					...x,
					caps: { ...x.caps, sampleRate: 0 },
				})),
			},
		}
		const input = stripInput(st)
		expect(input.rx).toMatchObject({ centreHz: 445_970_700, halfSpanHz: null })
		const text = lineText(stripLine(input, 199))
		expect(text).toContain("rx 445.971 MHz")
		expect(text).not.toContain("±")
	})
	it("item 8: dims rx when the lane its rate came from is old", () => {
		const s = scenarioState("live")
		const oldAt = s.now - 60_000
		// Centre from a fresh tuner; rate only from the (old) source caps.
		const st = {
			...s,
			tuner: {
				...s.tuner,
				value: s.tuner.value!.map(t => ({ ...t, sampleRate: 0 })),
			},
			sources: { ...s.sources, receivedAt: oldAt },
		}
		expect(stripInput(st).rx?.halfSpanHz).toBe(1_024_000)
		expect(stripInput(st).old.rx).toBe(true)
		expect(stripInput({ ...st, sources: s.sources }).old.rx).toBe(false)
	})
})

describe("A8 fix 1: strip counts (I-B, R77) and window count (I-C)", () => {
	const NOW = scenarioState("live").now
	const iso = (ms: number) => new Date(ms).toISOString()
	const withRows = (
		f: (
			d: NonNullable<
				ReturnType<typeof scenarioState>["decoders"]["value"]
			>[number],
		) => object,
	) => {
		const s = scenarioState("live")
		return {
			...s,
			decoders: {
				...s.decoders,
				value: s.decoders.value!.map(d => ({ ...d, ...f(d) })),
			},
		}
	}
	it("I-B: a running faulted decoder counts as failing; restarting stays apart", () => {
		const st = withRows(d =>
			d.id === "readsb"
				? { running: true, health: "faulted", restartCount: 7 }
				: {},
		)
		const dec = stripInput(st).decoders!
		expect(dec.failing).toBe(1)
		expect(dec.restarting).toBe(1)
		expect(lineText(stripLine(stripInput(st), 199))).toContain("1 failing")
	})
	it("I-B: a pending suspension counts as failing", () => {
		const st = withRows(d =>
			d.id === "readsb"
				? {
						running: true,
						suspended: true,
						transition: "suspending",
						suspension: { reasonCode: "x", since: iso(NOW) },
					}
				: {},
		)
		const pending = {
			...st,
			session: {
				...st.session,
				readsb: { ...st.session["readsb"]!, suspendingSince: NOW - 20_000 },
			},
		}
		expect(stripInput(pending).decoders?.failing).toBe(1)
	})
	it("I-C: no in-window count when the window is unknown, even with tuned decoders", () => {
		const s = scenarioState("live")
		const noWindow = {
			...s,
			tuner: {
				...s.tuner,
				value: s.tuner.value!.map(t => ({ ...t, frequency: 0 })),
			},
			sources: {
				...s.sources,
				value: s.sources.value!.map(x => ({
					...x,
					caps: { ...x.caps, centerFreq: 0 },
				})),
			},
			relay: { ...s.relay, value: { ...s.relay.value!, lastFrequency: 0 } },
		}
		expect(stripInput(noWindow).decoders?.inWindow).toBeNull()
		expect(lineText(stripLine(stripInput(noWindow), 199))).not.toContain(
			"in window",
		)
		expect(stripInput(s).decoders?.inWindow).toBe(2)
	})
})

describe("polish: help copy", () => {
	it("spells Shift-Tab out", () => {
		const t = helpLines({ ...ctx, help: true }, 119, 40, {
			invalidFrames: 0,
			rejectedItems: 0,
		})
			.map(lineText)
			.join("\n")
		expect(t).toContain("Shift-Tab")
		expect(t).not.toContain("S-Tab")
	})
})
