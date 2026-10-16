import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServerResponse } from "node:http"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecordingInventoryError } from "../../../src/core/recordings/inventory.js"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"

const DSD_ID = "dsd:0~20260101_120000_00001_call.wav"
const SCAN_ID = "scan:d_1~clip.wav"
const BYTES = Buffer.from("RIFF-fake-wav-bytes-0123456789")

type LeaseResult = ReturnType<RecordingRoutesOptions["access"]["leaseDownload"]>

describe("recordingRoutes", () => {
	let dir: string
	let app: FastifyInstance
	let list: ReturnType<typeof vi.fn>
	let resolve: ReturnType<typeof vi.fn>
	let authorize: ReturnType<typeof vi.fn>
	let release: ReturnType<typeof vi.fn>
	let lease: (response: ServerResponse) => LeaseResult
	let filePath: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "rec-routes-"))
		filePath = join(dir, "secret-clip.wav")
		await writeFile(filePath, BYTES)
		list = vi.fn(async () => ({
			items: [],
			nextCursor: null,
			scannedFiles: 0,
			truncated: false,
			scannedAt: "2026-01-01T00:00:00.000Z",
		}))
		resolve = vi.fn(async () => filePath)
		authorize = vi.fn(() => undefined)
		release = vi.fn()
		lease = () => ({ kind: "attached", active: () => true, release })
		app = Fastify({ logger: false })
		await app.register(recordingRoutes, {
			inventory: { list, resolve },
			authorize,
			access: { leaseDownload: (_request, response) => lease(response) },
		} as RecordingRoutesOptions)
		await app.ready()
	})
	afterEach(async () => {
		await app.close()
		await rm(dir, { recursive: true, force: true })
	})

	const get = (url: string, headers: Record<string, string> = {}) =>
		app.inject({ method: "GET", url, headers })

	it("returns the authorize denial and never calls list", async () => {
		authorize.mockReturnValue({
			kind: "deny",
			status: 401,
			code: "AUTH_REQUIRED",
			headers: { "x-test": "1" },
		})
		const res = await get("/api/recordings")
		expect(res.statusCode).toBe(401)
		expect(res.json()).toEqual({ code: "AUTH_REQUIRED" })
		expect(res.headers["x-test"]).toBe("1")
		expect(list).not.toHaveBeenCalled()
	})

	it("lists with no-store and passes the raw query (repeated keys as arrays)", async () => {
		const res = await get("/api/recordings?limit=5&kind=a&kind=b")
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(list).toHaveBeenCalledWith({ limit: "5", kind: ["a", "b"] })
	})

	it("maps RecordingInventoryError to 400 with fixed text", async () => {
		list.mockRejectedValue(
			new RecordingInventoryError("RECORDINGS_QUERY_INVALID"),
		)
		const res = await get("/api/recordings?limit=x")
		expect(res.statusCode).toBe(400)
		expect(res.json()).toEqual({
			error: "Bad Request",
			code: "RECORDINGS_QUERY_INVALID",
			message: "The recordings query is invalid",
		})
		expect(res.body).not.toContain("secret")
	})

	it("maps other list errors to 503", async () => {
		list.mockRejectedValue(new Error("EACCES /secret/dir"))
		const res = await get("/api/recordings")
		expect(res.statusCode).toBe(503)
		expect(res.json().code).toBe("RECORDINGS_UNAVAILABLE")
		expect(res.body).not.toContain("secret")
	})

	it.each([
		["capacity", 429, "ACCESS_CAPACITY"],
		["invalidated", 401, "AUTH_REQUIRED"],
		["unavailable", 503, "ACCESS_UNAVAILABLE"],
	])("lease rejected (%s) -> %i", async (reason, status, code) => {
		lease = () => ({ kind: "rejected", reason }) as LeaseResult
		const res = await get(`/api/recordings/${encodeURIComponent(DSD_ID)}/file`)
		expect(res.statusCode).toBe(status)
		expect(res.json()).toEqual({ code })
		expect(resolve).not.toHaveBeenCalled()
	})

	it("sends no body when the lease went inactive during resolve", async () => {
		lease = response => ({
			kind: "attached",
			active: () => {
				response.end()
				return false
			},
			release,
		})
		const res = await app.inject({
			method: "GET",
			url: `/api/recordings/${encodeURIComponent(DSD_ID)}/file`,
		})
		expect(res.body).toBe("")
		expect(res.body).not.toContain(BYTES.toString())
	})

	it.each([
		"dsd:0~..%2F..%2Fetc%2Fpasswd",
		"scan:d_1~..%2Fx.wav",
		"scan:d_1~../x.wav",
		"dsd%3A0%7E%2e%2e%2fx.wav",
		"%2Fetc%2Fpasswd",
		"scan:d_1~a%2Fb.wav",
		"scan:d_1~a%5Cb.wav",
		"nonsense",
	])("rejects invalid id %s with 404 and no resolve", async id => {
		const res = await get(`/api/recordings/${id}/file`)
		expect(res.statusCode).toBe(404)
		expect(resolve).not.toHaveBeenCalled()
		expect(res.body).not.toContain("passwd")
	})

	it("404s when resolve returns null", async () => {
		resolve.mockResolvedValue(null)
		const res = await get(`/api/recordings/${encodeURIComponent(SCAN_ID)}/file`)
		expect(res.statusCode).toBe(404)
		expect(res.json()).toEqual({
			error: "Not Found",
			code: "RECORDING_NOT_FOUND",
			message: "Recording not found",
		})
	})

	it("streams the exact bytes with download headers and ignores Range", async () => {
		for (const [id, name] of [
			[DSD_ID, "20260101_120000_00001_call.wav"],
			[SCAN_ID, "clip.wav"],
		] as const) {
			const res = await get(`/api/recordings/${encodeURIComponent(id)}/file`, {
				range: "bytes=2-5",
			})
			expect(res.statusCode).toBe(200)
			expect(res.rawPayload.equals(BYTES)).toBe(true)
			expect(res.headers["content-type"]).toBe("audio/wav")
			expect(res.headers["content-disposition"]).toBe(
				`attachment; filename="${name}"`,
			)
			expect(res.headers["accept-ranges"]).toBe("none")
			expect(res.headers["cache-control"]).toBe("no-store")
			expect(res.headers["content-range"]).toBeUndefined()
		}
		expect(resolve).toHaveBeenCalledWith(DSD_ID)
	})

	it("404s cleanly when the file vanished after resolve, without leaking paths", async () => {
		await unlink(filePath)
		const res = await get(`/api/recordings/${encodeURIComponent(DSD_ID)}/file`)
		expect(res.statusCode).toBe(404)
		expect(res.json().code).toBe("RECORDING_NOT_FOUND")
		expect(res.body).not.toContain(dir)
		expect(res.body).not.toContain("secret-clip")
	})

	it("refuses a directory resolved path", async () => {
		resolve.mockResolvedValue(dir)
		const res = await get(`/api/recordings/${encodeURIComponent(DSD_ID)}/file`)
		expect(res.statusCode).toBe(404)
		expect(res.body).not.toContain(dir)
	})

	it("refuses a symlink at the resolved path", async () => {
		const { symlink } = await import("node:fs/promises")
		const link = join(dir, "link.wav")
		await symlink(filePath, link)
		resolve.mockResolvedValue(link)
		const res = await get(`/api/recordings/${encodeURIComponent(DSD_ID)}/file`)
		expect(res.statusCode).toBe(404)
		expect(res.body).not.toContain("RIFF")
	})

	it("does not leak id or path on a resolve failure (503)", async () => {
		resolve.mockRejectedValue(new Error(`boom ${filePath}`))
		const res = await get(`/api/recordings/${encodeURIComponent(DSD_ID)}/file`)
		expect(res.statusCode).toBe(503)
		expect(res.json().code).toBe("RECORDINGS_UNAVAILABLE")
		expect(res.body).not.toContain(dir)
		expect(res.body).not.toContain("call.wav")
	})
})
