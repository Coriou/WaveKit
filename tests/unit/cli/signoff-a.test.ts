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
