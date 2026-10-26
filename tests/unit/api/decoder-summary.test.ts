import Fastify from "fastify"
import { expect, it } from "vitest"
import {
	decoderSummary,
	decoderSummaryRoutes,
	DECODING_WINDOW_MS,
} from "../../../src/api/routes/decoder-summary.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"

const now = Date.parse("2026-10-01T12:00:00Z")
const status = (patch: Partial<DecoderStatus> = {}): DecoderStatus => ({
	id: "synthetic",
	type: "multimon-ng",
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	lastOutputAt: new Date(now),
	...patch,
})
it.each([
	[{}, "decoding"],
	[{ lastOutputAt: new Date(now - DECODING_WINDOW_MS) }, "decoding"],
	[{ lastOutputAt: new Date(now - DECODING_WINDOW_MS - 1) }, "idle"],
	[{ lastOutputAt: undefined }, "idle"],
	[{ lastOutputAt: new Date(now + 1) }, "idle"],
	[{ running: false }, "idle"],
	[{ suspended: true }, "suspended"],
	[
		{ suspension: { reasonCode: "no-channel-selected", since: new Date(now) } },
		"suspended",
	],
	[{ health: "faulted", suspended: true }, "failed"],
	[{ health: "restarting" }, "failed"],
] as const)("computes the health verdict for %j", (patch, health) => {
	expect(decoderSummary(status(patch), now).health).toBe(health)
})
it("serves a compact summary and takes static precedence over decoder ids", async () => {
	const app = Fastify()
	await app.register(decoderSummaryRoutes, {
		decoderManager: {
			getAllStatus: () => [
				status({
					placements: [
						{
							sourceId: "synthetic",
							channelHz: 123,
							running: true,
							reach: "channel",
							origin: "configured",
							primary: true,
							costCores: 0,
						},
						{
							sourceId: "synthetic",
							channelHz: 456,
							running: false,
							reach: "channel",
							origin: "configured",
							primary: false,
							costCores: 0,
						},
					],
				}),
			],
		},
	})
	app.get("/api/decoders/:id", async () => ({ wrong: true }))
	try {
		const response = await app.inject("/api/decoders/summary")
		expect(response.statusCode).toBe(200)
		const [entry] = response.json()
		expect(entry).toMatchObject({
			id: "synthetic",
			protocol: "multimon-ng",
			state: "running",
			eventsOut: 3,
			placements: [{ sourceId: "synthetic", frequencyHz: 123 }],
			suspensionReason: null,
		})
		expect(Object.keys(entry).sort()).toEqual(
			[
				"id",
				"protocol",
				"state",
				"eventsOut",
				"placements",
				"lastOutputAt",
				"suspensionReason",
				"health",
			].sort(),
		)
	} finally {
		await app.close()
	}
})

it("represents a running decoder without placement metadata conservatively", () => {
	expect(
		decoderSummary(
			status({ sourceId: "synthetic", targetFrequenciesHz: [123] }),
			now,
		).placements,
	).toEqual([{ sourceId: "synthetic", frequencyHz: 123 }])
	expect(
		decoderSummary(status({ targetFrequenciesHz: [123, 456] }), now).placements,
	).toEqual([{ sourceId: null, frequencyHz: null }])
	expect(decoderSummary(status({ running: false }), now).placements).toEqual([])
})
