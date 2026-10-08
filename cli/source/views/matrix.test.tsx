import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { SCENARIO_NAMES } from "../test/scenario-types.js"
import { VIEW_ORDER } from "../ui/actions.js"
import { findBanned } from "../ui/copy-rules.js"
import { formatMessage } from "../ui/messages/index.js"
import { cellWidth } from "../ui/text.js"
import { VIEWS } from "./registry.js"

const SIZES = [
	[60, 16],
	[60, 20],
	[80, 24],
	[120, 40],
	[200, 50],
] as const

// Feature: cli-dashboard-overhaul, Property 22: render bound
// Validates: spec §5.1, §9
describe("P22: every view × scenario × size fits rows−1 × cols with no banned copy", () => {
	for (const scenario of SCENARIO_NAMES) {
		for (const view of VIEW_ORDER) {
			it(`${scenario} · ${view}`, async () => {
				const state = scenarioState(scenario, { summarize: formatMessage })
				for (const [cols, rows] of SIZES) {
					const h = await renderApp({ state, views: VIEWS, view, cols, rows })
					try {
						const frame = h.frame()
						expect(frame.length, `${cols}x${rows} rows`).toBeLessThanOrEqual(
							rows - 1,
						)
						// A view that threw renders the boundary line instead of itself.
						expect(h.text(), `${cols}x${rows}`).not.toContain("render error")
						for (const line of frame) {
							expect(
								cellWidth(line),
								`${cols}x${rows}: ${line}`,
							).toBeLessThanOrEqual(cols)
							expect(findBanned(line), `${cols}x${rows}: ${line}`).toEqual([])
						}
					} finally {
						h.unmount()
					}
				}
			})
		}
	}
})
