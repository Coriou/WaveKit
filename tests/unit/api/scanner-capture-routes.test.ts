import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"

describe("scanner capture routes", () => {
	let app: FastifyInstance
	const dir = mkdtempSync(join(tmpdir(), "wk-capr-"))
	const iq = join(dir, "cap_abc.cu8")
	writeFileSync(iq, Buffer.from([1, 2, 3, 4]))
	const json = join(dir, "cap_abc.json")
	writeFileSync(json, JSON.stringify({ id: "cap_abc" }))
	const deleteCapture = vi.fn((id: string) => Promise.resolve(id === "cap_abc"))

	beforeEach(async () => {
		app = Fastify({ logger: false })
		const service = {
			listCaptures: () => [{ id: "cap_abc" }],
			capturePath: (id: string, kind: "cu8" | "json") =>
				id === "cap_abc" ? (kind === "cu8" ? iq : json) : null,
			deleteCapture,
		} as unknown as ScannerRouteService
		await app.register(scannerRoutes, { scanner: service })
	})
	afterEach(async () => {
		await app.close()
	})

	it("lists, downloads by extension, and deletes captures", async () => {
		expect(
			(
				await app.inject({ method: "GET", url: "/api/scanner/captures" })
			).json(),
		).toEqual([{ id: "cap_abc" }])
		const bin = await app.inject({
			method: "GET",
			url: "/api/scanner/captures/cap_abc.cu8",
		})
		expect(bin.statusCode).toBe(200)
		expect(bin.headers["content-type"]).toBe("application/octet-stream")
		expect(bin.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]))
		const entry = await app.inject({
			method: "GET",
			url: "/api/scanner/captures/cap_abc.json",
		})
		expect(entry.json()).toEqual({ id: "cap_abc" })
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/captures/cap_abc.wav",
				})
			).statusCode,
		).toBe(404)
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/captures/..%2Fetc.json",
				})
			).statusCode,
		).toBe(404)
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/captures/cap_abc",
				})
			).statusCode,
		).toBe(204)
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/captures/cap_zzz",
				})
			).statusCode,
		).toBe(404)
	})
})
