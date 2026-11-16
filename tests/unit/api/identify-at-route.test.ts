/**
 * GET /api/identify?frequencyHz=F: one passive answer with a proof level (decoded, classified,
 * energy-only, nothing) composed from the discoveries near F. It reads the discovery list only.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	FREQUENCY_IDENTIFY_LIMITS,
	type Discovery,
	type FrequencyIdentifyResponse,
} from "@wavekit/api-types"
import {
	identifyAtRoutes,
	levelOf,
	type IdentifyAtSource,
} from "../../../src/api/routes/identify-at.js"
import type { DiscoveryFilter } from "../../../src/core/scanner/store/discovery-store.js"

const F = 100_000_000

function discovery(over: Partial<Discovery> & { id: string }): Discovery {
	return {
		frequencyHz: F,
		protocol: "unknown",
		class: "unknown",
		confidence: "activity",
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		...over,
	} as Discovery
}

let app: FastifyInstance | undefined

async function serve(
	listDiscoveries: IdentifyAtSource["listDiscoveries"],
): Promise<FastifyInstance> {
	app = Fastify({ logger: false })
	await app.register(identifyAtRoutes, {
		source: { listDiscoveries },
		now: () => Date.parse("2026-01-02T00:00:00.000Z"),
	})
	await app.ready()
	return app
}

afterEach(async () => {
	await app?.close()
	app = undefined
})

const page = (items: Discovery[], nextCursor: string | null = null) => ({
	items,
	nextCursor,
})

describe("levelOf", () => {
	it.each([
		[{ confidence: "decoded" }, "decoded"],
		[{ confidence: "candidate", proof: { kind: "decoded" } }, "decoded"],
		[{ confidence: "classified" }, "classified"],
		[
			{ confidence: "candidate", proof: { kind: "analog-voice" } },
			"classified",
		],
		[
			{ confidence: "candidate", proof: { kind: "carrier-only" } },
			"energy-only",
		],
		[{ confidence: "candidate" }, "energy-only"],
		[{ confidence: "activity" }, "energy-only"],
		[{ confidence: "classified", possibleSpur: {} }, "energy-only"],
	])("%j reads %s", (over, level) => {
		expect(
			levelOf(discovery({ id: "x", ...(over as Partial<Discovery>) })),
		).toBe(level)
	})
})

describe("GET /api/identify", () => {
	it("answers nothing without a discovery in the window, and names the live test", async () => {
		const list = vi.fn(() => page([]))
		const server = await serve(list)
		const res = await server.inject({ url: `/api/identify?frequencyHz=${F}` })
		expect(res.statusCode).toBe(200)
		const body = res.json<FrequencyIdentifyResponse>()
		expect(body).toMatchObject({
			frequencyHz: F,
			toleranceHz: 6_250,
			level: "nothing",
			best: null,
			others: [],
			truncated: false,
			confirm: { method: "POST", path: "/api/scanner/identify" },
		})
		expect(list).toHaveBeenCalledWith({
			nearHz: F,
			toleranceHz: 6_250,
			limit: FREQUENCY_IDENTIFY_LIMITS.scanMax,
		})
	})

	it("picks the best level, then the nearest", async () => {
		const server = await serve(() =>
			page([
				discovery({ id: "near-energy", frequencyHz: F + 100 }),
				discovery({
					id: "classified",
					frequencyHz: F - 2_000,
					confidence: "classified",
					class: "analog-fm",
				}),
				discovery({
					id: "decoded",
					frequencyHz: F + 3_000,
					confidence: "decoded",
					protocol: "pocsag",
					identity: { kind: "pocsag-capcode", value: "1234" },
				}),
			]),
		)
		const body = (
			await server.inject({ url: `/api/identify?frequencyHz=${F}` })
		).json<FrequencyIdentifyResponse>()
		expect(body.level).toBe("decoded")
		expect(body.best).toMatchObject({
			discoveryId: "decoded",
			offsetHz: 3_000,
			protocol: "pocsag",
			identity: { kind: "pocsag-capcode", value: "1234" },
			possibleSpur: false,
		})
		expect(body.others.map(o => [o.discoveryId, o.level])).toEqual([
			["classified", "classified"],
			["near-energy", "energy-only"],
		])
	})

	it.each([
		["classified", { confidence: "classified" }],
		["energy-only", { confidence: "candidate" }],
	] as const)("answers %s", async (level, over) => {
		const server = await serve(() => page([discovery({ id: "a", ...over })]))
		const body = (
			await server.inject({ url: `/api/identify?frequencyHz=${F}` })
		).json<FrequencyIdentifyResponse>()
		expect(body.level).toBe(level)
	})

	it("reads the decoded ones too when the window holds more than it reads", async () => {
		const many = Array.from(
			{ length: FREQUENCY_IDENTIFY_LIMITS.scanMax },
			(_, i) => discovery({ id: `e${i}`, frequencyHz: F + i }),
		)
		const list = vi.fn((filter: DiscoveryFilter) =>
			filter.minConfidence === "decoded"
				? page([
						discovery({
							id: "far-decoded",
							frequencyHz: F + 5_000,
							confidence: "decoded",
						}),
					])
				: page(many, "cursor"),
		)
		const server = await serve(list)
		const body = (
			await server.inject({
				url: `/api/identify?frequencyHz=${F}&toleranceHz=6000`,
			})
		).json<FrequencyIdentifyResponse>()
		expect(list).toHaveBeenCalledTimes(2)
		expect(body.level).toBe("decoded")
		expect(body.best?.discoveryId).toBe("far-decoded")
		expect(body.others).toHaveLength(FREQUENCY_IDENTIFY_LIMITS.othersMax)
		expect(body.truncated).toBe(true)
	})

	it.each([
		"",
		"?frequencyHz=0",
		"?frequencyHz=abc",
		"?frequencyHz=Infinity",
		`?frequencyHz=${F}&toleranceHz=1000001`,
		`?frequencyHz=${F}&toleranceHz=-1`,
		`?frequencyHz=${F}&freq=1`,
	])("refuses %s with a 400", async query => {
		const server = await serve(() => page([]))
		const res = await server.inject({ url: `/api/identify${query}` })
		expect(res.statusCode).toBe(400)
		expect(res.json<{ code: string }>().code).toBe("VALIDATION_ERROR")
		expect(res.body).not.toContain("abc")
	})

	it("accepts the tolerance at its 1 MHz bound", async () => {
		const server = await serve(() => page([]))
		const res = await server.inject({
			url: `/api/identify?frequencyHz=${F}&toleranceHz=1000000`,
		})
		expect(res.statusCode).toBe(200)
	})
})
