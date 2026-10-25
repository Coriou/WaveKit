/**
 * Container loopback exposure: both protected HTTP audio listeners bound on
 * 0.0.0.0 (ports this test reserves) still reject a forged Host and a missing
 * credential. The policy inputs mirror what validateProtectedRuntimeMapping
 * accepts for container-loopback: one 127.0.0.1 authority per listener.
 */
import { createServer, request } from "node:http"
import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
	parseStreamPath,
} from "../../../src/core/audio-stream-server.js"
import { createLogger } from "../../../src/utils/logger.js"

const log = createLogger({ level: "fatal" })
const stream = { rate: 8000, format: "s16le" as const }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function freeWildcardPort(): Promise<number> {
	const server = createServer()
	await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve))
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Missing address")
	await new Promise<void>(resolve => server.close(() => resolve()))
	return address.port
}

async function listener(label: string) {
	const port = await freeWildcardPort()
	const authority = `127.0.0.1:${port}`
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [authority],
		allowedOrigins: ["http://127.0.0.1:7100"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const leases = new ConnectionLeases(sessions)
	const registry = new AudioClientRegistry(log, {
		label,
		stream,
		stallTimeoutMs: 1000,
	})
	const resolve = vi.fn((req: IncomingMessage) => {
		const path = parseStreamPath(req.url)
		return path.base === "/stream" ? { registry, stream, wav: path.wav } : null
	})
	const server = new AudioHttpServer(log, label, resolve, vi.fn(), {
		policy,
		sessions,
		leases,
	})
	await server.start(port, "0.0.0.0")
	cleanups.push(async () => {
		await server.close()
		leases.dispose()
	})
	return { port, authority, token, resolve, registry }
}

async function get(port: number, headers: Record<string, string>) {
	return new Promise<{ status: number | undefined; body: string }>(
		(resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path: "/stream.wav",
					headers: { Connection: "close", ...headers },
				},
				response => {
					let body = ""
					response.on("data", (chunk: Buffer) => (body += chunk.toString()))
					response.on("end", () =>
						resolve({ status: response.statusCode, body }),
					)
					if (response.statusCode === 200) {
						resolve({ status: 200, body: "" })
						response.destroy()
					}
				},
			)
			req.on("error", reject)
			req.end()
		},
	)
}

describe.each(["Analog audio", "Digital audio"])(
	"%s on 0.0.0.0 under container-loopback",
	label => {
		it("rejects a forged Host even with a valid token", async () => {
			const env = await listener(label)
			for (const host of [
				`localhost:${env.port}`,
				`wavekit:${env.port}`,
				`172.17.0.2:${env.port}`,
			]) {
				const denied = await get(env.port, {
					Host: host,
					Authorization: `Bearer ${env.token}`,
				})
				expect(denied.status).toBe(403)
				expect(denied.body).toContain("HOST_FORBIDDEN")
			}
			expect(env.resolve).not.toHaveBeenCalled()
		})

		it("rejects a missing token with the genuine Host", async () => {
			const env = await listener(label)
			const denied = await get(env.port, { Host: env.authority })
			expect(denied.status).toBe(401)
			expect(denied.body).toContain("AUTH_REQUIRED")
			expect(env.resolve).not.toHaveBeenCalled()
			expect(env.registry.size).toBe(0)
		})

		it("admits the genuine Host with a machine credential", async () => {
			const env = await listener(label)
			const opened = await get(env.port, {
				Host: env.authority,
				Authorization: `Bearer ${env.token}`,
			})
			expect(opened.status).toBe(200)
		})
	},
)
