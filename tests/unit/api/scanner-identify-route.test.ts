import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { ScannerApiError } from "../../../src/core/scanner/errors.js"

describe("POST /api/scanner/identify", () => {
	let app: FastifyInstance
	const identify = vi.fn()

	async function build(impl: () => Promise<unknown>) {
		identify.mockReset()
		identify.mockImplementation(impl)
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: { identify } as unknown as ScannerRouteService,
		})
	}

	afterEach(async () => {
		await app.close()
	})

	it("creates an identify job (201) from a frequency target or the whole window", async () => {
		await build(() => Promise.resolve({ id: "j_1", state: "starting" }))
		const one = await app.inject({
			method: "POST",
			url: "/api/scanner/identify",
			payload: {
				sourceId: "rtl",
				target: { frequencyHz: 446_193_750, bandwidthHz: 12_500 },
				protocols: ["dmr"],
				exhaustive: true,
			},
		})
		expect(one.statusCode).toBe(201)
		expect(one.json()).toMatchObject({ id: "j_1" })
		expect(identify).toHaveBeenLastCalledWith({
			sourceId: "rtl",
			target: { frequencyHz: 446_193_750, bandwidthHz: 12_500 },
			protocols: ["dmr"],
			exhaustive: true,
		})
		await app.inject({
			method: "POST",
			url: "/api/scanner/identify",
			payload: { target: { all: true, bandwidthHz: 12_500 }, timeoutMs: 5000 },
		})
		expect(identify).toHaveBeenLastCalledWith({
			target: { all: true },
			timeoutMs: 5000,
		})
	})

	it("rejects malformed targets before they reach the service", async () => {
		await build(() => Promise.resolve({}))
		for (const payload of [
			{},
			{ target: {} },
			{ target: { all: false } },
			{ target: { frequencyHz: 446e6, all: true } },
			{ target: { frequencyHz: -1 } },
			{ target: { frequencyHz: 446e6 }, protocols: ["morse"] },
			{ target: { frequencyHz: 446e6 }, timeoutMs: 999 },
		]) {
			const res = await app.inject({
				method: "POST",
				url: "/api/scanner/identify",
				payload,
			})
			expect(res.statusCode, JSON.stringify(payload)).toBe(400)
		}
		expect(identify).not.toHaveBeenCalled()
	})

	it("maps OUT_OF_WINDOW to 409 with the window", async () => {
		const window = { startHz: 445_690_400, endHz: 446_509_600 }
		await build(() =>
			Promise.reject(
				new ScannerApiError("tune first", "OUT_OF_WINDOW", 409, { window }),
			),
		)
		const res = await app.inject({
			method: "POST",
			url: "/api/scanner/identify",
			payload: { target: { frequencyHz: 447e6 } },
		})
		expect(res.statusCode).toBe(409)
		expect(res.json()).toEqual({
			error: "ScannerApiError",
			code: "OUT_OF_WINDOW",
			message: "tune first",
			details: { window },
		})
	})
})
