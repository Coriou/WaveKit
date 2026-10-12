import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { once } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	requestMachineDevices,
	revokeAllMachineDevices,
	revokeMachineDevice,
} from "../../../src/access/machine-client.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

let root: string
let directory: string
let owner: PrivateAccessStorage
let token: string
const servers: Server[] = []
const deviceId = `device_${"A".repeat(43)}`
const inventory = {
	devices: [
		{
			deviceId,
			createdAt: 10,
			renewedAt: 10,
			expiresAt: 20,
			current: false,
		},
	],
}
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "wavekit-machine-client-"))
	directory = join(root, "private")
	owner = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	token = owner.useMachineCredential(value => value)
})
afterEach(async () => {
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

describe("machine device client", () => {
	it("sends one exact bearer request and no cookie", async () => {
		const seen: IncomingMessage[] = []
		const origin = await listen((req, res) => {
			seen.push(req)
			expect(req.headers.authorization).toBe(`Bearer ${token}`)
			expect(req.headers.cookie).toBeUndefined()
			expect(req.headers.host).toBe(new URL(origin).host)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(inventory))
		})
		expect(
			await requestMachineDevices({ apiOrigin: origin, directory }),
		).toEqual({ kind: "ok", body: inventory })
		expect(seen).toHaveLength(1)
		expect(seen[0]?.method).toBe("GET")
		expect(seen[0]?.url).toBe("/api/access/machine/devices")
	})

	it("posts the original device id and revoke-all target once", async () => {
		const calls: Array<{ method: string | undefined; url: string | undefined; body: string }> =
			[]
		const origin = await listen((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				calls.push({
					method: req.method,
					url: req.url,
					body: Buffer.concat(chunks).toString("utf8"),
				})
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(
					req.url?.endsWith("/revoke-all")
						? JSON.stringify({ revoked: true })
						: JSON.stringify({ revoked: true }),
				)
			})
		})
		expect(
			await revokeMachineDevice({
				apiOrigin: origin,
				directory,
				deviceId,
			}),
		).toEqual({ kind: "ok", body: { revoked: true } })
		expect(
			await revokeAllMachineDevices({ apiOrigin: origin, directory }),
		).toEqual({ kind: "ok", body: { revoked: true } })
		expect(calls).toEqual([
			{
				method: "POST",
				url: "/api/access/machine/devices/revoke",
				body: JSON.stringify({ deviceId }),
			},
			{
				method: "POST",
				url: "/api/access/machine/devices/revoke-all",
				body: "",
			},
		])
	})

	it("does not read the credential for an invalid device id or origin", async () => {
		const read = vi.spyOn(PrivateAccessStorage, "readMachineCredential")
		expect(
			await revokeMachineDevice({
				apiOrigin: "http://127.0.0.1:9",
				directory,
				deviceId: "device_nope",
			}),
		).toEqual({ kind: "unavailable", code: "ACCESS_COMMAND_INVALID" })
		expect(
			await requestMachineDevices({
				apiOrigin: "http://127.0.0.1:9/secret",
				directory,
			}),
		).toEqual({ kind: "unavailable", code: "ACCESS_COMMAND_INVALID" })
		expect(read).not.toHaveBeenCalled()
	})

	it("hides response bodies and does not retry after a timeout", async () => {
		let calls = 0
		const origin = await listen((_req, res) => {
			calls++
			res.writeHead(500, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ token, path: directory }))
		})
		const failed = await requestMachineDevices({ apiOrigin: origin, directory })
		expect(failed).toEqual({
			kind: "unavailable",
			code: "MACHINE_SERVICE_UNAVAILABLE",
		})
		expect(JSON.stringify(failed)).not.toContain(token)
		expect(JSON.stringify(failed)).not.toContain(directory)
		const hanging = await listen(() => {})
		const timed = await requestMachineDevices({
			apiOrigin: hanging,
			directory,
			timeoutMs: 30,
		})
		expect(timed).toEqual({
			kind: "unavailable",
			code: "MACHINE_REQUEST_TIMED_OUT",
		})
		expect(calls).toBe(1)
	})

	it.each([
		[401, "AUTH_REQUIRED"],
		[429, "MACHINE_RATE_LIMITED"],
		[503, "ACCESS_UNAVAILABLE"],
		[403, "MACHINE_SERVICE_UNAVAILABLE"],
	] as const)("maps HTTP %i to %s", async (status, code) => {
		const origin = await listen((_req, res) => {
			res.writeHead(status)
			res.end("secret-body")
		})
		const result = await requestMachineDevices({ apiOrigin: origin, directory })
		expect(result).toEqual({ kind: "unavailable", code })
		expect(JSON.stringify(result)).not.toContain("secret-body")
	})
})
