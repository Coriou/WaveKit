import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import { apiView, iqView } from "../../../cli/source/data/freshness.js"
import type { ConnState } from "../../../cli/source/data/types.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { stripLine, type StripInput } from "../../../cli/source/ui/strip.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { stripInput } from "../../../cli/source/view-models/chrome.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const NOW = Date.parse("2026-10-08T18:07:52Z")
const live: StripInput = {
	api: { kind: "ok", restAgeMs: 2000 },
	iq: {
		glyph: "live",
		word: "streaming",
		ageMs: null,
		rateBytesPerSec: 3994 * 1024,
	},
	decoders: { up: 8, total: 9, failing: 1, inWindow: 2 },
	drops: { ratio: 0.34, backpressure: true },
	rx: { centreHz: 445_970_700, halfSpanHz: 1_024_000, control: "external" },
	clockMs: NOW,
	old: { iq: false, decoders: false, rx: false },
}

describe("strip (spec §4.2 widths)", () => {
	it("M2: renders the 200/120/80/60 column variants, keeping rx and drops", () => {
		expect(lineText(stripLine(live, 199))).toMatch(
			/^api ● 2s {2}iq ● streaming · 4\.1 MB\/s {2}rx 445\.971 MHz ±1\.024 · external control {2}decoders 8\/9 up · 1 failing · 2 in window {2}drops !34% +18:07$/,
		)
		expect(lineText(stripLine(live, 119))).toBe(
			"api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz ±1.024  decoders 8/9 up · 1 failing · 2 in window  drops !34%",
		)
		expect(lineText(stripLine(live, 79))).toBe(
			"api ● 2s  iq ● streaming  rx 445.971 MHz ±1.024  dec 8/9 ×1  drops !34%   18:07",
		)
		expect(lineText(stripLine(live, 59))).toBe(
			"api ● 2s  iq ●  rx 445.971 MHz  dec 8/9 ×1  drops !34%",
		)
	})
	it("renders the connectivity variants", () => {
		const t = (api: StripInput["api"]) =>
			lineText(stripLine({ ...live, api }, 119))
		expect(
			t({ kind: "split", ws: true, rest: false, restAgeMs: 45000 }),
		).toMatch(/^api ws ● rest × 45s/)
		expect(
			t({ kind: "split", ws: false, rest: true, restAgeMs: 2000 }),
		).toMatch(/^api ws × rest ● 2s/)
		expect(t({ kind: "down", sinceMs: 151000 })).toMatch(/^api × 2m {2}/)
		expect(t({ kind: "connecting" })).toMatch(/^api ○ connecting/)
	})
	it("never shows 0 for unknowns", () => {
		const out = lineText(
			stripLine(
				{
					...live,
					iq: {
						glyph: "unknown",
						word: "unknown",
						ageMs: null,
						rateBytesPerSec: null,
					},
					decoders: null,
					drops: { ratio: null, backpressure: false },
				},
				119,
			),
		)
		expect(out).toContain("iq ? unknown")
		expect(out).toContain("decoders ?")
		expect(out).toContain("drops ?")
	})
	it("says backpressure in words when the drop ratio is unknown (R32)", () => {
		const out = stripLine(
			{ ...live, drops: { ratio: null, backpressure: true } },
			119,
		)
		expect(lineText(out)).toContain("drops ? · backpressure")
		expect(out.find(s => s.text === "backpressure")?.role).toBe("attention")
		expect(out.find(s => s.text === "?")?.role).toBe("unknown")
	})
	it("M15: the drops lane reads `drops !N%` at every width", () => {
		for (let w = 40; w <= 220; w++) {
			const text = lineText(stripLine(live, w))
			expect(text).not.toMatch(/\bdrop !|% now/)
			if (text.includes("drops")) expect(text).toContain("drops !34%")
		}
	})
	it("M2: rx and drops stay at 60 columns in every scenario that has them", () => {
		for (const sc of [
			"live",
			"ws-only",
			"rest-only",
			"iq-stale",
			"iq-disconnected",
			"crash-loop",
			"dropping",
		] as const) {
			const input = stripInput(scenarioState(sc))
			for (const w of [59, 79, 119]) {
				const text = lineText(stripLine(input, w))
				expect(text, `${sc} ${w}`).toContain("rx 445.971")
				expect(text, `${sc} ${w}`).toContain("drops ")
				expect(lineWidth(stripLine(input, w))).toBeLessThanOrEqual(w)
			}
		}
		expect(lineText(stripLine(stripInput(scenarioState("live")), 59))).toBe(
			"api ● 2s  iq ●  rx 445.971 MHz  dec 8/9 !1  drops !21%",
		)
	})
	it("final fix: non-live iq states have short words, so rx survives at 59", () => {
		const states: Array<[StripInput["iq"]["glyph"], string, string]> = [
			["fault", "disconnected", "iq × down"],
			["neutral", "connected · no samples", "iq ○ no samples"],
			["unknown", "unknown", "iq ?"],
			["neutral", "paused", "iq ○ paused"],
			["neutral", "ended", "iq ○ ended"],
		]
		for (const [glyph, word, short] of states) {
			const input: StripInput = {
				...live,
				api: { kind: "split", ws: true, rest: false, restAgeMs: 45_000 },
				iq: { glyph, word, ageMs: null, rateBytesPerSec: null },
				decoders: { up: 7, total: 9, failing: 1, restarting: 1, inWindow: 2 },
			}
			for (let w = 59; w <= 70; w++) {
				const text = lineText(stripLine(input, w))
				expect(text, `${word} ${w}`).toContain("rx 445.971")
				expect(text, `${word} ${w}`).toContain("drops ")
				expect(lineWidth(stripLine(input, w))).toBeLessThanOrEqual(w)
			}
			expect(lineText(stripLine(input, 59))).toContain(short)
			// With room the full word comes back.
			expect(lineText(stripLine(input, 119))).toContain(
				`iq ${glyph === "fault" ? "×" : glyph === "unknown" ? "?" : "○"} ${word}`,
			)
		}
	})
	it("copy sweep: a REST lane with no age says `rest ×`, not `rest × ?`", () => {
		const t = lineText(
			stripLine(
				{
					...live,
					api: { kind: "split", ws: true, rest: false, restAgeMs: null },
				},
				119,
			),
		)
		expect(t).toMatch(/^api ws ● rest × {2}iq/)
	})
	it("shows the IQ rate only while the lane is live (B3 fix 1)", () => {
		const stale = stripLine(
			{
				...live,
				iq: {
					glyph: "fault",
					word: "no samples",
					ageMs: 12_000,
					rateBytesPerSec: 3_900_000,
				},
			},
			199,
		)
		expect(lineText(stale)).toContain("iq × no samples 12s  ")
		expect(lineText(stale)).not.toContain("MB/s")
		const down = stripLine(
			{
				...live,
				iq: {
					glyph: "fault",
					word: "disconnected",
					ageMs: null,
					rateBytesPerSec: 0,
				},
			},
			199,
		)
		expect(lineText(down)).not.toContain("B/s")
	})

	function conn(
		ws: ConnState["ws"]["state"],
		lastOkAt: number | null,
	): ConnState {
		return {
			target: { base: null, ws: null },
			discovery: { mode: "explicit", tried: [] },
			ws: {
				state: ws,
				since: 0,
				code: null,
				reason: null,
				nextRetryAt: null,
				attempt: 0,
			},
			rest: {
				lastOkAt,
				lastCycleAt: null,
				nextAt: null,
				failing: [],
				firstFailAt: null,
				lastError: null,
			},
			invalidFrames: 0,
			rejectedItems: 0,
			lastEventAt: null,
		}
	}
	const states = [
		"disconnected",
		"waiting",
		"streaming",
		"stale",
		"paused",
		"ended",
	] as const

	// Feature: cli-dashboard-overhaul, Property 21: strip honesty
	// Validates: spec T1, T2, §9
	it("P21: streaming only when activity is streaming and fresh; api ● only when WS open and REST fresh; no banned words", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...states),
				fc.boolean(),
				fc.option(fc.integer({ min: 0, max: 30000 }), { nil: null }),
				fc.constantFrom("idle", "connecting", "open", "closed") as fc.Arbitrary<
					ConnState["ws"]["state"]
				>,
				fc.option(fc.integer({ min: 0, max: 60000 }), { nil: null }),
				fc.integer({ min: 60, max: 220 }),
				(state, fresh, beatAge, ws, okAgo, width) => {
					const now = 100_000
					const source = {
						id: "s",
						connected: true,
						dataRate: 10,
						activity: {
							state,
							lastSampleAt: null,
							sampleAgeMs: 5,
							timeoutMs: 1,
						},
					} as ExtendedSourceStatus
					const beat =
						beatAge === null
							? undefined
							: { bytesReceived: 1, dataRateKiB: 10, at: now - beatAge }
					const c = conn(ws, okAgo === null ? null : now - okAgo)
					const input: StripInput = {
						...live,
						iq: iqView(source, fresh, beat, now),
						api: apiView(c, now),
					}
					const text = lineText(stripLine(input, width - 1))
					expect(lineWidth(stripLine(input, width - 1))).toBeLessThanOrEqual(
						width - 1,
					)
					if (text.includes("streaming"))
						expect(fresh && state === "streaming").toBe(true)
					expect(text.startsWith("api ●")).toBe(
						ws === "open" && okAgo !== null && okAgo <= 15000,
					)
					expect(findBanned(text)).toEqual([])
				},
			),
			{ numRuns: 100 },
		)
	})
})
