import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { once } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	canonicalPairingOrigin,
	requestPairingCode,
} from "../../../src/access/pairing-client.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

let root: string
let directory: string
let owner: PrivateAccessStorage
let token: string
const servers: Server[] = []
const issuance = { code: "ABCDE-FGHJK", expiresInSeconds: 600 }
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "wavekit-pairing-client-"))
	directory = join(root, "private")
	owner = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	token = owner.useMachineCredential(value => value)
})
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
	await owner.close()
	await fs.rm(root, { recursive: true, force: true })
})
async function listen(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
	const server = createServer(handler)
	servers.push(server)
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("live-core pairing client", () => {
	it("makes exactly the original POST with bearer credentials while the writer remains live", async () => {
		const entries = await fs.readdir(directory)
		const handler = vi.fn((req: IncomingMessage, res: ServerResponse) => {
			expect(req.method).toBe("POST")
			expect(req.url).toBe("/api/access/pairing-codes")
			expect(req.headers.authorization).toBe(`Bearer ${token}`)
			expect(req.headers.cookie).toBeUndefined()
			res.writeHead(201, { "Content-Type": "application/json" })
			res.end(JSON.stringify(issuance))
		})
		const origin = await listen(handler)
		expect(await requestPairingCode({ apiOrigin: origin, directory })).toEqual({
			kind: "issued",
			...issuance,
		})
		expect(handler).toHaveBeenCalledOnce()
		expect(await fs.readdir(directory)).toEqual(entries)
	})
	it.each([
		"http://user:secret@localhost",
		"http://localhost/path",
		"http://localhost?secret",
		"http://localhost#secret",
		"http://127.1",
		"http://0x7f000001",
		"http://0.0.0.0",
		"http://[::]",
		"ws://localhost",
		"http://*",
		"http://localhost:0",
	])(
		"rejects invalid target %s before private credential lookup",
		async apiOrigin => {
			const read = vi.spyOn(PrivateAccessStorage, "readMachineCredential")
			const request = vi.fn<typeof fetch>()
			expect(
				await requestPairingCode({ apiOrigin, directory }, { fetch: request }),
			).toEqual({ kind: "unavailable", code: "ACCESS_COMMAND_INVALID" })
			expect(read).not.toHaveBeenCalled()
			expect(request).not.toHaveBeenCalled()
		},
	)
	it("canonicalizes explicit DNS/default-port/IPv6 origins without host aliases", () => {
		expect(canonicalPairingOrigin("https://EXAMPLE.test:443")).toBe(
			"https://example.test",
		)
		expect(canonicalPairingOrigin("http://[0:0:0:0:0:0:0:1]:80")).toBe(
			"http://[::1]",
		)
	})
	it("refuses redirects without sending a credential to the redirected authority", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end(token),
		)
		const other = await listen(reached)
		const origin = await listen((_req, res) => {
			res.writeHead(307, { Location: `${other}/secret` })
			res.end(token)
		})
		expect(await requestPairingCode({ apiOrigin: origin, directory })).toEqual({
			kind: "unavailable",
			code: "PAIRING_SERVICE_UNAVAILABLE",
		})
		expect(reached).not.toHaveBeenCalled()
	})
	it("forces no redirect following and omits cookies in request options", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify(issuance), { status: 201 }),
			)
		await requestPairingCode(
			{ apiOrigin: "http://localhost", directory },
			{ fetch: request },
		)
		expect(request).toHaveBeenCalledWith(
			"http://localhost/api/access/pairing-codes",
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				credentials: "omit",
			}),
		)
	})
	it.each([401, 404, 429, 503])(
		"emits fixed generic status for HTTP %i without response diagnostics",
		async status => {
			const origin = await listen((_req, res) => {
				res.writeHead(status)
				res.end(JSON.stringify({ code: token, message: directory }))
			})
			const result = await requestPairingCode({ apiOrigin: origin, directory })
			expect(result).toEqual({
				kind: "unavailable",
				code:
					status === 401
						? "AUTH_REQUIRED"
						: status === 429
							? "PAIRING_CAPACITY"
							: "PAIRING_SERVICE_UNAVAILABLE",
			})
			expect(JSON.stringify(result)).not.toContain(token)
			expect(JSON.stringify(result)).not.toContain(directory)
		},
	)
	it.each([
		{ code: token, expiresInSeconds: 600 },
		{ code: "ABCDE-FGHIL", expiresInSeconds: 600 },
		{ code: "abcde-fghjk", expiresInSeconds: 600 },
		{ ...issuance, expiresInSeconds: 601 },
		{ ...issuance, expiresInSeconds: 0 },
		{ ...issuance, machineToken: "secret" },
	])(
		"rejects malformed/noncanonical/extra-field pairing responses",
		async body => {
			const origin = await listen((_req, res) => {
				res.writeHead(201)
				res.end(JSON.stringify(body))
			})
			expect(
				await requestPairingCode({ apiOrigin: origin, directory }),
			).toEqual({ kind: "unavailable", code: "PAIRING_INVALID_RESPONSE" })
		},
	)
	it("bounds response bytes and never returns a prefix from oversized or broken JSON", async () => {
		for (const body of [
			JSON.stringify({ ...issuance, padding: "x".repeat(1024) }),
			`{\"code\":\"${token}\"`,
		]) {
			const origin = await listen((_req, res) => {
				res.writeHead(201)
				res.end(body)
			})
			expect(
				await requestPairingCode({ apiOrigin: origin, directory }),
			).toEqual({ kind: "unavailable", code: "PAIRING_INVALID_RESPONSE" })
		}
	})
	it("sanitizes storage and network errors without returning token/path/cause", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error(`${token} ${directory}`))
		expect(
			await requestPairingCode(
				{ apiOrigin: "http://localhost", directory },
				{ fetch: request },
			),
		).toEqual({ kind: "unavailable", code: "PAIRING_SERVICE_UNAVAILABLE" })
		expect(
			await requestPairingCode({
				apiOrigin: "http://localhost",
				directory: join(root, "missing"),
			}),
		).toEqual({ kind: "unavailable", code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
		expect(await fs.readdir(root)).toEqual(["private"])
	})
	it("times out pending credential I/O and never sends after late completion", async () => {
		const read = PrivateAccessStorage.readMachineCredential
		let release!: () => void
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		vi.spyOn(PrivateAccessStorage, "readMachineCredential").mockImplementation(
			async (options, consumer) => {
				await pending
				return read(options, consumer)
			},
		)
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const origin = await listen(reached)
		const result = await requestPairingCode({
			apiOrigin: origin,
			directory,
			timeoutMs: 10,
		})
		expect(result).toEqual({
			kind: "unavailable",
			code: "PAIRING_REQUEST_TIMED_OUT",
		})
		release()
		await new Promise<void>(resolve => setTimeout(resolve, 20))
		expect(reached).not.toHaveBeenCalled()
	})
	it("bounds network/body waiting with the same original deadline", async () => {
		const origin = await listen((_req, res) => {
			res.writeHead(201)
			res.write('{"code":"')
		})
		expect(
			await requestPairingCode({ apiOrigin: origin, directory, timeoutMs: 30 }),
		).toEqual({ kind: "unavailable", code: "PAIRING_REQUEST_TIMED_OUT" })
	})
	it("honors pre-abort before reading private credentials", async () => {
		const read = vi.spyOn(PrivateAccessStorage, "readMachineCredential")
		const controller = new AbortController()
		controller.abort(token)
		expect(
			await requestPairingCode({
				apiOrigin: "http://localhost",
				directory,
				signal: controller.signal,
			}),
		).toEqual({ kind: "unavailable", code: "PAIRING_REQUEST_TIMED_OUT" })
		expect(read).not.toHaveBeenCalled()
	})
})
