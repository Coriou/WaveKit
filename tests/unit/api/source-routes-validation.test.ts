/**
 * POST /api/sources validates the body with SourceConfigSchema (Zod at the
 * boundary), including the stall watchdog bounds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type {
	SourceConfig,
	SourceManager,
	SourceStatus,
} from "../../../src/core/source-manager.js"

function createMockSourceManager() {
	let created: SourceConfig | undefined
	const status = (config: SourceConfig): SourceStatus => ({
		id: config.id,
		type: config.type,
		url: `${config.host}:${config.port}`,
		connected: true,
		activity: {
			state: "waiting",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10_000,
		},
		bytesReceived: 0,
		dataRate: 0,
		reconnectAttempts: 0,
		caps: config.caps,
	})
	return {
		connect: vi.fn(async (config: SourceConfig) => {
			created = config
		}),
		getStatus: vi.fn((id: string) =>
			created && created.id === id ? status(created) : undefined,
		),
	}
}

const body = (extra: Record<string, unknown>) => ({
	id: "rtl-2",
	type: "rtl_tcp",
	host: "127.0.0.1",
	port: 1234,
	caps: {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
	},
	...extra,
})

describe("POST /api/sources validation", () => {
	let app: FastifyInstance
	let sourceManager: ReturnType<typeof createMockSourceManager>

	beforeEach(async () => {
		sourceManager = createMockSourceManager()
		app = Fastify({ logger: false })
		await app.register(sourceRoutes, {
			sourceManager: sourceManager as unknown as SourceManager,
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it.each([
		["a non-numeric string", "abc"],
		["below the 1 s floor", 500],
		["above the maximum", 700_000],
		["negative", -1],
		["fractional", 1500.5],
	])("rejects stallTimeoutMs %s without connecting", async (_label, value) => {
		const response = await app.inject({
			method: "POST",
			url: "/api/sources",
			payload: body({ stallTimeoutMs: value }),
		})
		expect(response.statusCode).toBe(400)
		expect(sourceManager.connect).not.toHaveBeenCalled()
	})

	it.each([0, 1000, 15_000, 600_000])(
		"accepts stallTimeoutMs %s and passes a number to the source manager",
		async value => {
			const response = await app.inject({
				method: "POST",
				url: "/api/sources",
				payload: body({ stallTimeoutMs: value }),
			})
			expect(response.statusCode).toBe(201)
			expect(sourceManager.connect).toHaveBeenCalledTimes(1)
			expect(sourceManager.connect.mock.calls[0]?.[0].stallTimeoutMs).toBe(
				value,
			)
		},
	)

	it("parses the body with SourceConfigSchema (Zod defaults applied)", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/sources",
			payload: body({}),
		})
		expect(response.statusCode).toBe(201)
		const config = sourceManager.connect.mock.calls[0]?.[0]
		expect(config?.loop).toBe(false)
		expect(config?.playbackSpeed).toBe(1)
		expect(config?.stallTimeoutMs).toBeUndefined()
	})

	it("rejects a body Zod refuses even when the JSON schema allows it", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/sources",
			payload: body({ playbackSpeed: 0 }), // JSON schema min 0, Zod positive
		})
		expect(response.statusCode).toBe(400)
		expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" })
		expect(sourceManager.connect).not.toHaveBeenCalled()
	})
})
