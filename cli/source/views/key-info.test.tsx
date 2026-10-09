import { Lines } from "../components/lines.js"
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { HeightClass } from "../ui/line.js"
import type { ViewModule } from "./types.js"

describe("keyInfo gets the app's height class (R68)", () => {
	it("is compact at 29 rows and roomy at 30, whatever the content height", async () => {
		const seen: Array<HeightClass | undefined> = []
		const probe: ViewModule = {
			id: "overview",
			title: "Probe",
			Component: ({ width, height }) => (
				<Lines lines={[]} width={width + 1} height={height} />
			),
			keyInfo: (_s, _u, _w, _h, heightClass?: HeightClass) => {
				seen.push(heightClass)
				return { rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }
			},
		}
		for (const rows of [29, 30]) {
			const h = await renderApp({
				state: scenarioState("live"),
				views: { overview: probe },
				view: "overview",
				cols: 80,
				rows,
			})
			h.unmount()
		}
		expect(seen).toContain("compact")
		expect(seen).toContain("roomy")
		expect(seen).not.toContain(undefined)
	})
})
