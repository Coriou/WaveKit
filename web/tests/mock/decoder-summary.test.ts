import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { DecoderSummary } from "@wavekit/api-types"
import { decoderVerdictSchema } from "@wavekit/api-types"

import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock GET /api/decoders/summary", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioOrigin: "http://localhost:3102",
		})
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const summary = async () =>
		(
			await server.app.inject({ method: "GET", url: "/api/decoders/summary" })
		).json<DecoderSummary[]>()
	const byId = async (id: string) => (await summary()).find(s => s.id === id)

	it("gives every decoder a valid verdict", async () => {
		const items = await summary()
		expect(items.length).toBeGreaterThan(0)
		for (const item of items)
			expect(decoderVerdictSchema.safeParse(item.verdict).success).toBe(true)
		expect((await byId("rtl433-433"))?.verdict).toMatchObject({
			code: "out-of-band",
			actions: ["tune-to-band"],
		})
	})

	it("pauses ADS-B for CPU budget near 1090 MHz until the budget is raised", async () => {
		const tuned = await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: 1_090_000_000 },
		})
		expect(tuned.statusCode).toBe(200)
		expect((await byId("readsb"))?.verdict).toEqual({
			code: "efficiency-budget",
			text: "ADS-B paused: CPU budget full",
			actions: ["raise-budget", "turn-off-others", "pause-scanner"],
		})
		const raised = await server.app.inject({
			method: "PUT",
			url: "/api/decoders/efficiency/budget",
			payload: { cpuBudgetCores: 5 },
		})
		expect(raised.statusCode).toBe(200)
		expect((await byId("readsb"))?.verdict.code).toMatch(/decoding|listening/)
	})
})
