import { describe, expect, it } from "vitest"
import {
	aggregateDropNow,
	restartIncrements,
} from "../../../cli/source/data/rates.js"
import { apiView } from "../../../cli/source/data/freshness.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"

describe("scenario states", () => {
	it("builds every scenario", () => {
		for (const name of SCENARIO_NAMES)
			expect(() => scenarioState(name)).not.toThrow()
	})
	it("live: nine decoders, ws open, REST fresh, 21 % aggregate drop", () => {
		const s = scenarioState("live")
		expect(s.decoders.value).toHaveLength(9)
		expect(apiView(s.conn, s.now).kind).toBe("ok")
		expect(aggregateDropNow(s.fanoutHistory).ratio).toBeCloseTo(0.2125, 3)
		expect(s.messages.ring.entries).toHaveLength(7)
	})
	it("api-down has no cache; api-down-cached keeps values and is down", () => {
		const cold = scenarioState("api-down")
		expect(cold.decoders.value).toBeUndefined()
		expect(apiView(cold.conn, cold.now).kind).toBe("down")
		const cached = scenarioState("api-down-cached")
		expect(cached.decoders.value).toHaveLength(9)
		expect(apiView(cached.conn, cached.now)).toEqual({
			kind: "down",
			sinceMs: 151000,
		})
		expect(cached.messages.ring.gaps).toHaveLength(1)
	})
	it("ws-only and rest-only are split states", () => {
		const wsOnly = scenarioState("ws-only")
		expect(apiView(wsOnly.conn, wsOnly.now)).toMatchObject({
			kind: "split",
			ws: true,
			rest: false,
		})
		const restOnly = scenarioState("rest-only")
		expect(apiView(restOnly.conn, restOnly.now)).toMatchObject({
			kind: "split",
			ws: false,
			rest: true,
		})
	})
	it("crash-loop sees ≥ 2 restart increments for acarsdec; legacy has no activity or offered bytes", () => {
		const s = scenarioState("crash-loop")
		expect(
			restartIncrements(s.session["acarsdec"]?.restarts ?? [], s.now),
		).toBeGreaterThanOrEqual(2)
		const legacy = scenarioState("legacy")
		expect(legacy.sources.value?.[0]?.activity).toBeUndefined()
		expect(aggregateDropNow(legacy.fanoutHistory).ratio).toBeNull()
	})
})
