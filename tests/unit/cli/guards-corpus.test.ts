import { describe, expect, it } from "vitest"
import { REST_GUARDS } from "../../../cli/source/data/api-client.js"
import { parseServerMessage } from "../../../cli/source/data/guards.js"
import {
	ENDPOINT_PATHS,
	type Endpoint,
} from "../../../cli/source/data/types.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import { loadScenario } from "../../../cli/source/test/scenarios.js"

const BY_PATH = new Map(
	(Object.entries(ENDPOINT_PATHS) as Array<[Endpoint, string]>).map(
		([e, p]) => [p, e],
	),
)

describe("guards corpus (spec §13.1)", () => {
	for (const name of SCENARIO_NAMES) {
		it(`accepts every REST body and WS frame in ${name}`, () => {
			const sc = loadScenario(name)
			let checked = 0
			for (const [path, r] of Object.entries(sc.rest)) {
				const e = BY_PATH.get(path)
				// Error answers never reach a guard; only success bodies are wire shapes.
				if (!e || r.status < 200 || r.status >= 300) continue
				const g = REST_GUARDS[e](r.body)
				expect(g, `${name} ${path}`).toBeDefined()
				expect(g?.rejected, `${name} ${path} rejected items`).toBe(0)
				checked++
			}
			for (const f of [...sc.ws, ...(sc.wsAppend ?? [])]) {
				expect(
					parseServerMessage({
						type: f.type,
						channel: f.channel,
						data: f.data,
					}),
					`${name} ${f.type}`,
				).toBeDefined()
				checked++
			}
			expect(checked, `${name}: nothing checked`).toBeGreaterThan(0)
		})
	}
})
