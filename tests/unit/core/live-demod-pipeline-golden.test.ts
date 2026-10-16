/**
 * Golden record of planLiveDemodPipeline over the 128-case grid.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	goldenCases,
	planGoldenCase,
} from "./live-demod-pipeline-golden-cases.js"

const golden = JSON.parse(
	readFileSync(
		new URL("./fixtures/live-demod-pipeline-golden.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>

describe("live demod pipeline golden", () => {
	const cases = goldenCases()

	it("covers 128 cases", () => {
		expect(cases).toHaveLength(128)
		expect(Object.keys(golden)).toHaveLength(128)
	})

	it.each(cases.map(c => [c.key, c] as const))("%s", (_key, c) => {
		expect(planGoldenCase(c.config)).toEqual(golden[c.key])
	})
})
