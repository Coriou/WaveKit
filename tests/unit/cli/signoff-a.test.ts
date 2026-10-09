import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import type { AppState } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { stripLine } from "../../../cli/source/ui/strip.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { stripInput } from "../../../cli/source/view-models/chrome.js"
import { decoderFacts } from "../../../cli/source/view-models/decoder-rows.js"
import { receiverSummary } from "../../../cli/source/view-models/overview.js"
import { receiverLines } from "../../../cli/source/view-models/receiver.js"

const deps = { summarize: formatMessage }

describe("sign-off item 2 (R96): N failing equals the × rows", () => {
	const s = scenarioState("contracts", deps)
	for (const dt of [0, 5_000, 11_000, 30_000, 120_000])
		it(`contracts at +${dt / 1000}s`, () => {
			const st: AppState = { ...s, now: s.now + dt }
			const facts = decoderFacts(st)
			const strip = stripInput(st).decoders
			expect(strip?.failing).toBe(facts.filter(f => f.role === "fault").length)
			expect(strip?.restarting ?? 0).toBe(
				facts.filter(
					f => f.proc === "restarting" || f.proc === "faulted-retrying",
				).length,
			)
		})
	it("a stop pending for more than 10 s is a fault (×)", () => {
		const facts = decoderFacts({ ...s, now: s.now + 60_000 })
		const pending = facts.filter(f => f.proc === "suspend-pending")
		for (const f of pending) expect(f.role).toBe("fault")
	})
})

describe("sign-off item 4: unknown tuner fields read ?", () => {
	it("frequency ? and gain ?", () => {
		const text = receiverLines(
			scenarioState("tuner-unknown", deps),
			initialUi("receiver"),
			199,
			40,
			true,
		).map(lineText)
		expect(text.find(l => l.startsWith("frequency"))).toMatch(
			/^frequency \? {2,}window/,
		)
		expect(text.find(l => l.startsWith("gain"))).toMatch(
			/^gain +\? {2,}rtl agc/,
		)
	})
})

describe("sign-off item 5: rate and drops only while IQ flows", () => {
	const live = scenarioState("live", deps)
	const down: AppState = {
		...live,
		sources: laneOk(
			live.sources.value!.map(x => ({
				...x,
				connected: false,
				activity: {
					state: "disconnected" as const,
					lastSampleAt: null,
					sampleAgeMs: null,
					timeoutMs: 10_000,
				},
			})),
			live.now - 500,
			"rest",
		),
	}
	it("the Overview shows no byte rate beside a disconnected source", () => {
		const text = receiverSummary(down, 199).map(lineText).join("\n")
		expect(text).toContain("disconnected")
		expect(text).not.toMatch(/[KM]B\/s/)
		expect(receiverSummary(live, 199).map(lineText).join("\n")).toMatch(/MB\/s/)
	})
	it("the strip's drops read — while no source streams, not the last window's %", () => {
		const line = lineText(stripLine(stripInput(down), 200))
		expect(line).toContain("drops —")
		expect(line).not.toMatch(/drops !?\d/)
	})
})
