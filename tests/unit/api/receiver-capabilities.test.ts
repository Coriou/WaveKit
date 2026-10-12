import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { receiverCapabilitiesRoutes } from "../../../src/api/routes/receiver-capabilities.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"
import type {
	ReceiverCapabilitiesProvider,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"

const apps: FastifyInstance[] = []
afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
	vi.restoreAllMocks()
})
const path = "/api/receiver-capabilities"
function fixture(id = "test+source"): SourceReceiverEvidence {
	return {
		sourceId: id,
		sourceStateToken: {},
		sourceIncarnation: "1".padStart(32, "0"),
		sessionId: null,
		snapshotId: "2".padStart(32, "0"),
		capturedAt: Date.UTC(2026, 0, 1),
		source: { type: "rtl_tcp", kind: "iq", format: "U8_IQ" },
		caps: { sampleRate: 1000000, centerFreq: null },
		connection: "disconnected",
		delivery: {
			state: "disconnected",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10000,
		},
		header: { capture: "missing", bytes: null, capturedAt: null },
	}
}
function provider() {
	const value = fixture()
	const read = vi.fn((id: string) =>
		id === value.sourceId
			? { kind: "present" as const, evidence: value }
			: { kind: "missing" as const },
	)
	const readPage = vi.fn(() => ({
		kind: "candidates" as const,
		candidates: [value],
		capturedAt: value.capturedAt,
		snapshotId: value.snapshotId,
	}))
	return {
		value,
		read,
		readPage,
		instance: createReceiverCapabilitiesProvider(
			{ read, readPage },
			TUNER_REST_COMMAND_POLICY,
		),
	}
}
async function setup(
	instance: ReceiverCapabilitiesProvider | null | undefined,
	poison = false,
) {
	const app = Fastify()
	apps.push(app)
	if (poison) app.setSerializerCompiler(() => () => '{"private":"poison"}')
	await app.register(receiverCapabilitiesRoutes, { provider: instance })
	return app
}
function safeError(
	response: {
		statusCode: number
		body: string
		headers: Record<string, unknown>
	},
	suffix: string,
	status: number,
) {
	expect(response.statusCode).toBe(status)
	expect(response.headers["cache-control"]).toBe("no-store")
	expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(256)
	expect(JSON.parse(response.body)).toMatchObject({
		error: "ReceiverCapabilitiesError",
		code: `RECEIVER_CAPABILITIES_${suffix}`,
	})
	expect(Object.keys(JSON.parse(response.body) as object).sort()).toEqual([
		"code",
		"error",
		"message",
	])
}

describe("receiver capabilities route protocol (unmounted plugin fixtures)", () => {
	it("uses the existing descriptor and closed unknown evidence, sends exact bytes despite inherited serializer", async () => {
		const p = provider()
		const app = await setup(p.instance, true)
		const list = await app.inject({ url: path })
		expect(list.statusCode).toBe(200)
		expect(list.headers["cache-control"]).toBe("no-store")
		expect(list.body).not.toContain("poison")
		const get = await app.inject({ url: path + "/test%2Bsource" })
		expect(get.statusCode).toBe(200)
		expect(get.json<{ sourceId: string }>().sourceId).toBe("test+source")
		expect(p.readPage).toHaveBeenCalledTimes(1)
		expect(p.read).toHaveBeenCalledTimes(1)
		const dto = get.json<{
			controls: {
				physical: { state: string }
				currentValue: { state: string }
			}[]
		}>()
		expect(dto.controls).toHaveLength(15)
		expect(
			dto.controls.every(
				row =>
					row.physical.state === "unknown" &&
					row.currentValue.state === "unknown",
			),
		).toBe(true)
	})

	it.each([undefined, null])(
		"absence %s is UNAVAILABLE only after GET input validation",
		async missing => {
			const app = await setup(missing)
			safeError(await app.inject({ url: path }), "UNAVAILABLE", 503)
			safeError(
				await app.inject({ url: path + "?limit=0" }),
				"INVALID_REQUEST",
				400,
			)
		},
	)

	it("maps disposed, missing and all provider failures without raw details", async () => {
		const p = provider()
		const app = await setup(p.instance)
		safeError(await app.inject({ url: path + "/missing" }), "NOT_FOUND", 404)
		p.instance.dispose()
		safeError(await app.inject({ url: path }), "UNAVAILABLE", 503)
		for (const code of [
			"UNAVAILABLE",
			"FAILED",
			"CONFLICT",
			"LIMIT",
		] as const) {
			const faulty: ReceiverCapabilitiesProvider = {
				get: () => ({ ok: false, code }),
				list: () => ({ ok: false, code }),
				dispose: () => {},
			}
			const target = await setup(faulty)
			safeError(await target.inject({ url: path }), code, 503)
			safeError(await target.inject({ url: path + "/id" }), code, 503)
		}
		const throws: ReceiverCapabilitiesProvider = {
			get: () => {
				throw new TypeError("secret")
			},
			list: () => {
				throw new TypeError("secret")
			},
			dispose: () => {},
		}
		safeError(await (await setup(throws)).inject({ url: path }), "FAILED", 503)
	})

	it("rejects faulty closed output, sparse pages and physical claims", async () => {
		const p = provider()
		const result = p.instance.get(p.value.sourceId)
		if (!result.ok) throw new TypeError("fixture invalid")
		const sparse: unknown[] = []
		sparse.length = 4096
		const outputs: unknown[] = [
			null,
			{ ok: true, value: { ...result.value, extra: "private" } },
			{
				ok: true,
				value: {
					...result.value,
					controls: result.value.controls.map(row => ({
						...row,
						physical: { state: "supported" },
					})),
				},
			},
			{ ok: true, value: { schemaVersion: 1, items: sparse, nextAfter: null } },
			{ ok: false, code: "NOT_FOUND" },
			{ ok: false, code: "FAILED", cause: "secret" },
		]
		for (const output of outputs) {
			const bad = {
				get: () => output,
				list: () => output,
				dispose: () => {},
			} as unknown as ReceiverCapabilitiesProvider
			safeError(await (await setup(bad)).inject({ url: path }), "CONFLICT", 503)
		}
		const getter = vi.fn(() => result.value)
		const output = { ok: true }
		Object.defineProperty(output, "value", { get: getter, enumerable: true })
		const bad = {
			get: () => output,
			list: () => output,
			dispose: () => {},
		} as unknown as ReceiverCapabilitiesProvider
		safeError(await (await setup(bad)).inject({ url: path }), "CONFLICT", 503)
		expect(getter).not.toHaveBeenCalled()
		const physical = {
			...result.value,
			controls: result.value.controls.map(row => ({
				...row,
				physical: { state: "supported" },
			})),
		}
		const physicalProvider = {
			get: () => ({ ok: true, value: physical }),
			list: () => ({
				ok: true,
				value: { schemaVersion: 1, items: [physical], nextAfter: null },
			}),
			dispose: () => {},
		} as unknown as ReceiverCapabilitiesProvider
		const physicalApp = await setup(physicalProvider)
		safeError(
			await physicalApp.inject({ url: path + "/test%2Bsource" }),
			"CONFLICT",
			503,
		)
		safeError(await physicalApp.inject({ url: path }), "CONFLICT", 503)
		const trapped = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new TypeError("private output fault")
				},
			},
		)
		const trapProvider = {
			get: () => trapped,
			list: () => trapped,
			dispose: () => {},
		} as unknown as ReceiverCapabilitiesProvider
		const outputFailure = await (
			await setup(trapProvider)
		).inject({ url: path })
		safeError(outputFailure, "FAILED", 500)
		expect(outputFailure.body).not.toContain("private output fault")
	})

	it("accepts a full sixteen-item public page with all240 controls", async () => {
		const values = Array.from({ length: 16 }, (_, i) =>
			fixture(`source-${String(i).padStart(2, "0")}`),
		)
		const pure = createReceiverCapabilitiesProvider(
			{
				read: () => ({ kind: "missing" }),
				readPage: () => ({
					kind: "candidates",
					candidates: values,
					capturedAt: values[0]!.capturedAt,
					snapshotId: values[0]!.snapshotId,
				}),
			},
			TUNER_REST_COMMAND_POLICY,
		)
		const reply = await (await setup(pure)).inject({ url: path + "?limit=16" })
		expect(reply.statusCode).toBe(200)
		expect(reply.json<{ items: unknown[] }>().items).toHaveLength(16)
		expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(256 * 1024)
	})

	it("denies exact matched HEAD/writes before malformed query, ID or framed body", async () => {
		const p = provider()
		const app = await setup(p.instance)
		for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
			for (const url of [path + "?limit=bad", path + "/bad%2Fid?unknown=1"]) {
				const response = await app.inject({
					method,
					url,
					payload: "not-json",
					headers: { "content-type": "application/json" },
				})
				expect(response.statusCode).toBe(405)
				expect(response.headers["allow"]).toBe("GET")
				expect(response.headers["cache-control"]).toBe("no-store")
				// Injector body collector is not HEAD wire evidence; actual wire is
				// covered through both real ApiServer patterns in the admission suite.
				if (method !== "HEAD") safeError(response, "METHOD_NOT_ALLOWED", 405)
			}
		}
		expect(p.read).not.toHaveBeenCalled()
		expect(p.readPage).not.toHaveBeenCalled()
	})

	it("refuses Node-accepted framed GETs before parsers/reads, allows CL0", async () => {
		const p = provider()
		const app = Fastify()
		apps.push(app)
		const parser = vi.fn(
			(
				_request: FastifyRequest,
				_payload: unknown,
				done: (error: null, value: object) => void,
			) => done(null, {}),
		)
		app.addContentTypeParser("application/test", parser)
		await app.register(receiverCapabilitiesRoutes, { provider: p.instance })
		for (const request of [
			{ payload: "x", headers: { "content-type": "application/test" } },
			{ headers: { "transfer-encoding": "chunked" } },
		])
			safeError(
				await app.inject({ method: "GET", url: path, ...request }),
				"INVALID_REQUEST",
				400,
			)
		expect(parser).not.toHaveBeenCalled()
		expect(p.readPage).not.toHaveBeenCalled()
		expect(
			(await app.inject({ url: path, headers: { "content-length": "0" } }))
				.statusCode,
		).toBe(200)
		// Artificial unframed/erroring streams and late aborts are excluded; no wrapper.
	})

	it("rejects raw query/encoding/cursor negatives without provider calls", async () => {
		const p = provider()
		const app = await setup(p.instance)
		for (const query of [
			"limit=0",
			"limit=17",
			"limit=01",
			"limit=+1",
			"limit=1.0",
			"limit=1e1",
			"limit=1&%6cimit=2",
			"unknown=1",
			"after=",
			"limit=",
			"after=a&",
			"&limit=1",
			"limit=1&&after=a",
			"after=a=b",
			"after=%FF",
			"after=%C0%AF",
			"after=%ED%A0%80",
			"after=%",
			"after=a%2Fb",
			"after=a%5Cb",
			"after=a%00b",
			"after=" + "a".repeat(101),
		])
			safeError(
				await app.inject({ url: path + "?" + query }),
				"INVALID_REQUEST",
				400,
			)
		safeError(
			await app.inject({ url: path + "/test%2Bsource?limit=1" }),
			"INVALID_REQUEST",
			400,
		)
		expect(p.read).not.toHaveBeenCalled()
		expect(p.readPage).not.toHaveBeenCalled()
		expect(
			(await app.inject({ url: path + "?after=a+b&limit=%31%36" })).statusCode,
		).toBe(200)
		expect(p.readPage).toHaveBeenCalledWith("a+b", 16)
	})

	it("preserves exact once-decoded IDs, encoded slash refusal and unrelated root routes", async () => {
		const p = provider()
		const get = vi.spyOn(p.instance, "get")
		const app = await setup(p.instance)
		await app.inject({ url: path + "/%252F" })
		expect(get).toHaveBeenCalledWith("%2F")
		get.mockClear()
		for (const id of ["a%2Fb", "a%5Cb", "%ED%A0%80", "%F4%90%80%80"]) {
			const reply = await app.inject({ url: path + "/" + id })
			expect(reply.statusCode).toBe(400)
		}
		expect(get).not.toHaveBeenCalled()
		for (const method of ["GET", "HEAD", "POST"] as const)
			expect(
				(await app.inject({ method, url: path + "/a/extra" })).statusCode,
			).toBe(404)
		expect(
			(await app.inject({ method: "OPTIONS", url: path })).statusCode,
		).toBe(404)
	})

	// Feature: receiver-capabilities, Property 6: Admission/error precedence
	// Validates: Requirements 3.2, 3.3, 3.8
	it("generated invalid limit queries never read evidence", async () => {
		const p = provider()
		const app = await setup(p.instance)
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 17, max: 1000000 }), async limit => {
				safeError(
					await app.inject({ url: `${path}?limit=${limit}` }),
					"INVALID_REQUEST",
					400,
				)
			}),
			{ numRuns: 100 },
		)
		expect(p.readPage).not.toHaveBeenCalled()
	})
})
