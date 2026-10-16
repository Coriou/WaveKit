/** WG6 req 3.4: GET /api/decoders/types adds option descriptors; status carries optionIssues. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import { toApiDecoderStatus } from "../../../src/api/serializers/decoder-status.js"
import type { DecoderCaps, DecoderStatus } from "../../../src/decoders/types.js"

const descriptors = vi.hoisted(() => ({
	known: [
		{
			key: "gain",
			type: "number",
			min: 0,
			max: 50,
			unit: "dB",
			default: null,
			secret: false,
			effect: "restart",
			description: "Tuner gain",
		},
		{
			key: "mode",
			type: "enum",
			enumValues: ["a", "b"],
			default: "a",
			secret: false,
			effect: "restart",
			description: "Mode",
		},
	],
}))
vi.mock("../../../src/decoders/options/index.js", () => ({
	validateDecoderOptions: () => undefined,
	decoderOptionDescriptors: (type: string) =>
		type === "known" ? descriptors.known : undefined,
}))

const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const status: DecoderStatus = {
	id: "d",
	type: "known",
	running: false,
	health: "running",
	uptime: 0,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	optionIssues: [{ path: "zap", code: "unknown-key", message: "unknown" }],
}

describe("decoder types options and status optionIssues", () => {
	let app: FastifyInstance
	beforeEach(async () => {
		app = Fastify()
		await app.register(decoderRoutes, {
			decoderManager: {
				getAllStatus: () => [status],
				getStatus: () => status,
			} as unknown as DecoderRoutesOptions["decoderManager"],
			decoderRegistry: {
				getCaps: () => caps,
				getRegisteredTypes: () => ["known", "plain"],
			} as unknown as DecoderRoutesOptions["decoderRegistry"],
		})
	})
	afterEach(async () => {
		await app.close()
	})

	it("keeps caps and adds options only where descriptors exist", async () => {
		const body = (await app.inject("/api/decoders/types")).json() as Array<
			Record<string, unknown>
		>
		expect(body[0]).toMatchObject({
			type: "known",
			caps: { input: "iq" },
			options: descriptors.known,
		})
		expect(body[1]).toMatchObject({ type: "plain", caps: { input: "iq" } })
		expect(body[1]).not.toHaveProperty("options")
	})

	it("status routes carry optionIssues", async () => {
		for (const url of ["/api/decoders", "/api/decoders/d"]) {
			const json = (await app.inject(url)).json() as unknown
			const item = Array.isArray(json) ? json[0] : json
			expect(item.optionIssues).toEqual(status.optionIssues)
		}
	})

	it("the WS serializer carries optionIssues and omits it when absent", () => {
		expect(toApiDecoderStatus(status).optionIssues).toEqual(status.optionIssues)
		const { optionIssues: _omit, ...rest } = status
		expect(toApiDecoderStatus(rest)).not.toHaveProperty("optionIssues")
	})
})
