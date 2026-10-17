import { createServer, request } from "node:http"
import type { IncomingMessage } from "node:http"
import fc from "fast-check"
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
import type { AudioRoute } from "../../../src/core/audio-stream-server.js"
import { createLogger } from "../../../src/utils/logger.js"

const authority = "receiver.local:8081"
const allowedOrigin = "http://receiver.local:8080"
const log = createLogger({ level: "fatal" })
const stream = { rate: 8000, format: "s16le" as const }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
	vi.restoreAllMocks()
})

type Resolver = (req: IncomingMessage) => AudioRoute | null

function registry(): AudioClientRegistry {
	return new AudioClientRegistry(log, {
		label: "Test audio",
		stream,
		stallTimeoutMs: 1000,
	})
}

/** Mimics LiveDemodulator.resolveRoute. */
function liveResolver(reg: AudioClientRegistry): Resolver {
	return req => {
		const { base, wav } = parseStreamPath(req.url)
		if (base !== "/stream") return null
		return { registry: reg, stream, wav }
	}
}

/** Mimics DigitalVoice.resolveRoute with one configured decoder "dmr1". */
function voiceResolver(reg: AudioClientRegistry): Resolver {
	const channels = new Map([["dmr1", reg]])
	return req => {
		const { base, wav } = parseStreamPath(req.url)
		let found: AudioClientRegistry | undefined
		if (base === "/stream") found = reg
		else {
			const match = /^\/decoders\/([^/]+)\/stream$/.exec(base)
			if (match?.[1]) {
				try {
					found = channels.get(decodeURIComponent(match[1]))
				} catch {
					found = undefined
				}
			}
		}
		return found ? { registry: found, stream, wav } : null
	}
}

async function freePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Missing address")
	await new Promise<void>(resolve => server.close(() => resolve()))
	return address.port
}

async function legacy(kind: "live" | "voice" = "live") {
	const reg = registry()
	const base = kind === "live" ? liveResolver(reg) : voiceResolver(reg)
	const resolve = vi.fn(base)
	const server = new AudioHttpServer(log, "Test audio", resolve, vi.fn())
	const port = await freePort()
	await server.start(port, "127.0.0.1")
	cleanups.push(async () => {
		reg.closeAll("test", true)
		await server.close()
	})
	return { server, port, registry: reg, resolve }
}

async function prot() {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("Missing session")
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [authority],
		allowedOrigins: [allowedOrigin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const leases = new ConnectionLeases(sessions)
	const reg = registry()
	const resolve = vi.fn(liveResolver(reg))
	const server = new AudioHttpServer(log, "Test audio", resolve, vi.fn(), {
		policy,
		sessions,
		leases,
	})
	const port = await freePort()
	await server.start(port, "127.0.0.1")
	cleanups.push(async () => {
		await server.close()
		leases.dispose()
	})
	return {
		server,
		port,
		registry: reg,
		resolve,
		bearer: { Authorization: `Bearer ${token}` },
		cookie: { Cookie: `wavekit_session=${session.cookieValue}` },
	}
}

interface Reply {
	status: number
	headers: IncomingMessage["headers"]
	body: Buffer
}

/** Sends a request; resolves once headers arrive (body collected briefly). */
async function send(
	port: number,
	path: string,
	method = "GET",
	headers: Record<string, string> = {},
): Promise<Reply> {
	return new Promise<Reply>((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: { Host: authority, Connection: "close", ...headers },
			},
			response => {
				const chunks: Buffer[] = []
				const status = response.statusCode ?? 0
				const done = () =>
					resolve({
						status,
						headers: response.headers,
						body: Buffer.concat(chunks),
					})
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				if (status === 200) {
					// Streaming: take headers (and WAV header if any) then hang up.
					setTimeout(() => {
						done()
						response.destroy()
					}, 30)
					return
				}
				response.once("end", done)
				response.on("error", done)
			},
		)
		req.on("error", reject)
		req.end()
	})
}

function expectLegacyCors(reply: Reply): void {
	expect(reply.headers["access-control-allow-origin"]).toBe("*")
	expect(reply.headers["access-control-allow-credentials"]).toBeUndefined()
	expect(reply.headers["access-control-allow-private-network"]).toBeUndefined()
}

describe("legacy audio CORS (no access adapter)", () => {
	it.each([
		["live", "/stream"],
		["live", "/stream.wav"],
		["voice", "/stream"],
		["voice", "/stream.wav"],
		["voice", "/decoders/dmr1/stream"],
		["voice", "/decoders/dmr1/stream.wav"],
	] as const)(
		"%s %s 200 stream carries * and unchanged expose list",
		async (kind, path) => {
			const env = await legacy(kind)
			const reply = await send(env.port, path, "GET", {
				Origin: "http://anything.example",
			})
			expect(reply.status).toBe(200)
			expectLegacyCors(reply)
			expect(reply.headers["access-control-expose-headers"]).toBe(
				"X-Audio-Format, X-Sample-Rate, X-Channels, Retry-After",
			)
			expect(reply.headers["x-audio-format"]).toBe("s16le")
			if (path.endsWith(".wav"))
				expect(reply.body.subarray(0, 4).toString()).toBe("RIFF")
		},
	)

	it.each(["live", "voice"] as const)(
		"%s 404 on unknown path and non-GET methods",
		async kind => {
			const env = await legacy(kind)
			for (const [path, method] of [
				["/nope", "GET"],
				["/decoders/other/stream", "GET"],
				["/stream", "POST"],
				["/stream", "DELETE"],
				["/stream.wav", "PUT"],
			] as const) {
				const reply = await send(env.port, path, method)
				expect(reply.status).toBe(404)
				expectLegacyCors(reply)
			}
			expect(env.registry.size).toBe(0)
		},
	)

	it("503 after admission stop carries *", async () => {
		const env = await legacy()
		env.server.stopAdmission()
		const reply = await send(env.port, "/stream")
		expect(reply.status).toBe(503)
		expectLegacyCors(reply)
		expect(env.registry.size).toBe(0)
	})

	it.each([
		["live", "/stream"],
		["live", "/stream.wav"],
		["voice", "/decoders/dmr1/stream"],
		["voice", "/decoders/dmr1/stream.wav"],
	] as const)(
		"%s OPTIONS %s answers 204 preflight without registering",
		async (kind, path) => {
			const env = await legacy(kind)
			const reply = await send(env.port, path, "OPTIONS", {
				Origin: "http://anything.example",
				"Access-Control-Request-Method": "GET",
			})
			expect(reply.status).toBe(204)
			expectLegacyCors(reply)
			expect(reply.headers["access-control-allow-methods"]).toBe("GET, OPTIONS")
			expect(reply.headers["access-control-allow-headers"]).toBe("Range")
			expect(reply.headers["access-control-max-age"]).toBe("600")
			expect(reply.headers["x-audio-format"]).toBeUndefined()
			expect(reply.body.length).toBe(0)
			expect(env.registry.size).toBe(0)
		},
	)

	it.each(["live", "voice"] as const)(
		"%s OPTIONS on unknown path is 404 with *",
		async kind => {
			const env = await legacy(kind)
			const reply = await send(env.port, "/decoders/zzz/stream", "OPTIONS")
			expect(reply.status).toBe(404)
			expectLegacyCors(reply)
			expect(reply.headers["access-control-allow-methods"]).toBeUndefined()
		},
	)
})

describe("protected audio CORS (access adapter)", () => {
	it("echoes the allowed origin with credentials on 200, never *", async () => {
		const env = await prot()
		const reply = await send(env.port, "/stream", "GET", {
			...env.bearer,
			Origin: allowedOrigin,
		})
		expect(reply.status).toBe(200)
		expect(reply.headers["access-control-allow-origin"]).toBe(allowedOrigin)
		expect(reply.headers["access-control-allow-credentials"]).toBe("true")
	})

	it("refuses a disallowed origin without ACAO", async () => {
		const env = await prot()
		const reply = await send(env.port, "/stream", "GET", {
			...env.bearer,
			Origin: "http://evil.example",
		})
		expect(reply.status).toBe(403)
		expect(reply.headers["access-control-allow-origin"]).toBeUndefined()
		expect(env.resolve).not.toHaveBeenCalled()
	})

	it("never emits * on 401, 404, non-GET, 503 or OPTIONS", async () => {
		const env = await prot()
		const replies = [
			await send(env.port, "/stream"),
			await send(env.port, "/nope", "GET", env.bearer),
			await send(env.port, "/stream", "POST", env.bearer),
			await send(env.port, "/stream", "OPTIONS", {
				Origin: allowedOrigin,
				"Access-Control-Request-Method": "GET",
			}),
			await send(env.port, "/nope", "OPTIONS", env.bearer),
		]
		expect(replies.map(r => r.status)).toEqual([401, 404, 404, 204, 404])
		env.server.stopAdmission()
		replies.push(await send(env.port, "/stream", "GET", env.bearer))
		expect(replies.at(-1)?.status).toBe(503)
		for (const reply of replies)
			expect(reply.headers["access-control-allow-origin"]).not.toBe("*")
		// WG9 req 1.2: an allowed protected preflight is cacheable for 600 s (origin-specific,
		// never `*`); every other reply, including the shutdown 503, carries no Max-Age.
		expect(replies[3]?.headers["access-control-max-age"]).toBe("600")
		for (const [i, reply] of replies.entries())
			if (i !== 3)
				expect(reply.headers["access-control-max-age"]).toBeUndefined()
	})
})

describe("Property 13", () => {
	// Feature: web-gaps-7, Property 13: Audio CORS
	// Validates: Requirements 8.1, 8.2, 8.3
	const pathArb = fc.oneof(
		fc.constantFrom(
			"/stream",
			"/stream.wav",
			"/decoders/dmr1/stream",
			"/decoders/dmr1/stream.wav",
			"/decoders/x/stream",
			"/",
		),
		fc.stringMatching(/^[a-z0-9/._-]{0,24}$/).map(s => `/${s}`),
	)
	const methodArb = fc.constantFrom(
		"GET",
		"OPTIONS",
		"POST",
		"PUT",
		"DELETE",
		"PATCH",
	)
	const originArb = fc.option(
		fc.constantFrom(
			allowedOrigin,
			"http://evil.example",
			"null",
			"https://receiver.local:8080",
		),
		{ nil: undefined },
	)
	const authArb = fc.constantFrom("none", "bearer", "cookie")

	it("legacy responses carry * and never credentials", async () => {
		const env = await legacy("voice")
		await fc.assert(
			fc.asyncProperty(
				pathArb,
				methodArb,
				originArb,
				async (path, method, origin) => {
					const reply = await send(
						env.port,
						path,
						method,
						origin ? { Origin: origin } : {},
					)
					expectLegacyCors(reply)
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000)

	it("protected responses never carry *", async () => {
		const env = await prot()
		await fc.assert(
			fc.asyncProperty(
				pathArb,
				methodArb,
				originArb,
				authArb,
				async (path, method, origin, auth) => {
					const headers: Record<string, string> = {
						...(auth === "bearer" ? env.bearer : {}),
						...(auth === "cookie" ? env.cookie : {}),
						...(origin ? { Origin: origin } : {}),
						...(method === "OPTIONS"
							? { "Access-Control-Request-Method": "GET" }
							: {}),
					}
					const reply = await send(env.port, path, method, headers)
					expect(reply.headers["access-control-allow-origin"]).not.toBe("*")
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000)
})
