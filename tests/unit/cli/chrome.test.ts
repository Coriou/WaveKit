import { beforeAll, describe, expect, it } from "vitest"
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
		expect(
			lineText(stripLine(stripInput(scenarioState("ws-only")), 79)),
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
			"nominal  band from WaveKit's built-in table, not the API",
		)
		expect(lines.join("\n")).toContain("frames rejected 2 · items rejected 1")
		expect(findBanned(lines.join("\n"))).toEqual([])
	})
})
