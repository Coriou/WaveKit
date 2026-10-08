import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { formatMessage } from "../ui/messages/index.js"
import { overviewView } from "./overview.js"
import type { ViewModule } from "./types.js"

const deps = { summarize: formatMessage }
const decodersProbe: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: ({ ui }) => (
		<Text>{`decoders selected=${ui.selected.decoders ?? "none"} detail=${String(ui.detail.decoders.open)}`}</Text>
	),
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const views = { overview: overviewView, decoders: decodersProbe }

describe("Overview goldens (spec §6.1)", () => {
	const cases: Array<
		[string, Parameters<typeof scenarioState>[0], number, number]
	> = [
		["live 120x40", "live", 120, 40],
		["live 80x24", "live", 80, 24],
		["live 60x20", "live", 60, 20],
		["live 200x50", "live", 200, 50],
		["api-down-cached 80x24", "api-down-cached", 80, 24],
		["ws-only (REST down) 80x24", "ws-only", 80, 24],
	]
	for (const [name, scenario, cols, rows] of cases) {
		it(name, async () => {
			const h = await renderApp({
				state: scenarioState(scenario, deps),
				views,
				view: "overview",
				cols,
				rows,
			})
			const f = h.frame()
			expect(f.length).toBeLessThanOrEqual(rows - 1)
			expect(h.text()).toMatchSnapshot()
			h.unmount()
		})
	}
	it("selects a decoder and opens it in view 2", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		expect(h.text()).toContain("decoders selected=multimon-ng detail=true")
		h.unmount()
	})
})
