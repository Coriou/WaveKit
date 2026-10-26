import { expect, it } from "vitest"
import Fastify from "fastify"
import type { DecoderPlacementView } from "@wavekit/api-types"
import { decoderStatusExtensionProperties } from "../../../src/api/routes/decoder-status-schemas.js"

// Requirement 3.22: origin "activity" and the bounded activity entry survive
// response serialisation; the request schema rejects unknown values.
const placement: DecoderPlacementView = {
	sourceId: "rtl",
	channelHz: 466_225_000,
	reach: "channel",
	origin: "activity",
	primary: false,
	running: true,
	costCores: 0.14,
	activity: {
		ranking: "activity",
		state: "hot",
		score: 4.5,
		live: true,
		reasons: ["live-energy", "decoded"],
	},
}

it("serialises an activity placement with its activity entry", async () => {
	const app = Fastify()
	app.get(
		"/p",
		{
			schema: {
				response: {
					200: {
						type: "object",
						properties: {
							placements: decoderStatusExtensionProperties.placements,
						},
					},
				},
			},
		},
		async () => ({ placements: [placement] }),
	)
	try {
		const response = await app.inject("/p")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ placements: [placement] })
	} finally {
		await app.close()
	}
})

it("rejects an unknown origin, ranking, state or reason", async () => {
	const app = Fastify()
	app.post(
		"/v",
		{ schema: { body: decoderStatusExtensionProperties.placements } },
		async () => ({}),
	)
	try {
		for (const [body, expected] of [
			[[placement], 200],
			[[{ ...placement, origin: "guess" }], 400],
			[[{ ...placement, activity: { ranking: "magic" } }], 400],
			[[{ ...placement, activity: { ranking: "activity", state: "x" } }], 400],
			[
				[{ ...placement, activity: { ranking: "activity", reasons: ["x"] } }],
				400,
			],
			[[{ ...placement, activity: { ranking: "nearest" } }], 200],
		] as const) {
			const response = await app.inject({
				method: "POST",
				url: "/v",
				payload: body,
			})
			expect(response.statusCode).toBe(expected)
		}
	} finally {
		await app.close()
	}
})
