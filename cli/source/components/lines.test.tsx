import { describe, expect, it } from "vitest"
import { renderAt } from "../test/harness.js"
import { ColorContext, Lines } from "./lines.js"

describe("Lines", () => {
	it("renders one row per line with a 1-column gutter, keeping empty rows", async () => {
		const lines = [
			[
				{ text: "api ", role: "label" as const },
				{ text: "● 2s", role: "live" as const },
			],
			[],
			[{ text: "x", role: "value" as const }],
		]
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<Lines lines={lines} width={20} />
			</ColorContext.Provider>,
			{ cols: 20, rows: 10 },
		)
		expect(h.frame()).toEqual([" api ● 2s", "", " x"])
		h.unmount()
	})
})
