import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { SCENARIO_NAMES } from "../test/scenario-types.js"
import { KEYS } from "../test/harness.js"
import { VIEW_ORDER } from "../ui/actions.js"
import { formatMessage } from "../ui/messages/index.js"
import { setGlyphMode } from "../ui/theme.js"
import { initialUi } from "../ui/ui-state.js"
import { VIEWS } from "./registry.js"

const deps = { summarize: formatMessage }

/** Each line with a byte outside 7-bit ASCII, with the offending characters. */
function nonAscii(frame: readonly string[], at: string): string[] {
	return frame.flatMap(line => {
		const bad = [...line].filter(ch => (ch.codePointAt(0) ?? 0) > 0x7f)
		return bad.length > 0 ? [`${at}: [${bad.join("")}] ${line}`] : []
	})
}

// Final review: WAVEKIT_ASCII / a non-UTF-8 locale must never receive a UTF-8 byte.
describe("ASCII glyph mode: every view at 120x40, every scenario, is 7-bit clean", () => {
	beforeAll(() => setGlyphMode("ascii"))
	afterAll(() => setGlyphMode("utf8"))
	for (const sc of SCENARIO_NAMES)
		it(`${sc}`, async () => {
			const problems: string[] = []
			for (const view of VIEW_ORDER) {
				const state = scenarioState(sc, deps)
				const rows = VIEWS[view].keyInfo(
					state,
					initialUi(view),
					119,
					36,
					"roomy",
				).rowIds.length
				const h = await renderApp({
					state,
					views: VIEWS,
					view,
					cols: 120,
					rows: 40,
				})
				try {
					problems.push(...nonAscii(h.frame(), `${sc} ${view}`))
					// The detail and the help overlay carry their own copy.
					if ((view === "decoders" || view === "messages") && rows > 0) {
						await h.press(KEYS.down)
						await h.press(KEYS.enter)
						problems.push(...nonAscii(h.frame(), `${sc} ${view} detail`))
						await h.press(KEYS.esc)
					}
					await h.press("?")
					problems.push(...nonAscii(h.frame(), `${sc} ${view} help`))
				} finally {
					h.unmount()
				}
			}
			expect(problems).toEqual([])
		})
	// A11 re-review: a waiting source's word ("connected · no samples") goes through
	// the glyph separator in the Receiver and the Overview too.
	it("live with a waiting source", async () => {
		const base = scenarioState("live", deps)
		const src = base.sources.value![0]!
		const state = {
			...base,
			sources: {
				...base.sources,
				value: [
					{
						...src,
						activity: {
							state: "waiting" as const,
							lastSampleAt: null,
							sampleAgeMs: null,
							timeoutMs: 10_000,
						},
					},
				],
			},
		}
		const problems: string[] = []
		for (const view of ["overview", "receiver"] as const) {
			const h = await renderApp({
				state,
				views: VIEWS,
				view,
				cols: 120,
				rows: 40,
			})
			try {
				problems.push(...nonAscii(h.frame(), `waiting ${view}`))
				expect(h.frame().join("\n")).toContain("connected | no samples")
			} finally {
				h.unmount()
			}
		}
		expect(problems).toEqual([])
	})
})
