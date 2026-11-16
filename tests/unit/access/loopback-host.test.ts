/**
 * A loopback Host from a loopback peer: one rule for the API (HTTP and /ws) and the audio
 * listeners, opt-in per runtime (local-http only), never widened for a remote peer.
 */
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { resolveAccessBootstrap } from "../../../src/access/bootstrap-policy.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const token = generateMachineToken(() => Buffer.alloc(32, 41))
const digest = digestMachineToken(token)
const bearer = ["Authorization", `Bearer ${token}`]
const LOOPBACK_HOSTS = [
	"127.0.0.1:5173",
	"127.0.0.1:9000",
	"localhost:8081",
	"LOCALHOST:1",
	"[::1]:9000",
	"[0:0:0:0:0:0:0:1]:65535",
	"127.0.0.1",
]
const FOREIGN_HOSTS = [
	"evil.example:9000",
	"evil.example",
	"localhost.evil.example:9000",
	"127.0.0.1.evil.example:9000",
	"127.0.0.2:9000",
	"0.0.0.0:9000",
	"[::]:9000",
]
const LOOPBACK_PEERS = ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]
const REMOTE_PEERS = [
	"10.0.0.8",
	"203.0.113.7",
	"::ffff:203.0.113.7",
	"2001:db8::1",
	"",
	"localhost",
]

async function policy(
	surface: "api" | "audio",
	loopbackHostFromLoopbackPeer: boolean | undefined,
) {
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	return new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [
			surface === "api" ? "receiver.test:9000" : "receiver.test:9001",
		],
		allowedOrigins: ["http://receiver.test:9000"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
		...(loopbackHostFromLoopbackPeer === undefined
			? {}
			: { loopbackHostFromLoopbackPeer }),
	})
}

function request(
	surface: "api" | "audio",
	transport: "http" | "websocket",
	host: string,
	remoteAddress: string,
): AccessRequest {
	return {
		method: "GET",
		rawTarget:
			surface === "api"
				? transport === "websocket"
					? "/ws"
					: "/api/status"
				: "/audio.wav",
		rawHeaders: [
			"Host",
			host,
			...(transport === "websocket"
				? ["Upgrade", "websocket", "Connection", "Upgrade"]
				: []),
			...bearer,
		],
		transport,
		surface,
		remoteAddress,
	}
}

const LISTENERS = [
	["api", "http"],
	["api", "websocket"],
	["audio", "http"],
] as const

describe("a loopback Host from a loopback peer", () => {
	it.each(LISTENERS)(
		"%s over %s admits it with the rule on",
		async (surface, transport) => {
			const p = await policy(surface, true)
			for (const host of LOOPBACK_HOSTS)
				for (const peer of LOOPBACK_PEERS)
					expect(p.evaluate(request(surface, transport, host, peer)).kind).toBe(
						"authenticated",
					)
		},
	)

	it.each(LISTENERS)(
		"%s over %s refuses a foreign Host from a loopback peer",
		async (surface, transport) => {
			const p = await policy(surface, true)
			for (const host of FOREIGN_HOSTS)
				for (const peer of LOOPBACK_PEERS)
					expect(
						p.evaluate(request(surface, transport, host, peer)),
					).toMatchObject({ kind: "deny", status: 403, code: "HOST_FORBIDDEN" })
		},
	)

	it.each(LISTENERS)(
		"%s over %s keeps the exact allowlist for a remote peer with a loopback Host",
		async (surface, transport) => {
			const p = await policy(surface, true)
			for (const host of LOOPBACK_HOSTS)
				for (const peer of REMOTE_PEERS)
					expect(
						p.evaluate(request(surface, transport, host, peer)),
					).toMatchObject({ kind: "deny", status: 403, code: "HOST_FORBIDDEN" })
			const own =
				surface === "api" ? "receiver.test:9000" : "receiver.test:9001"
			expect(
				p.evaluate(request(surface, transport, own, "203.0.113.7")).kind,
			).toBe("authenticated")
		},
	)

	it("never admits a Host the allowlist lacks unless both Host and peer are loopback", async () => {
		// Feature: loopback-host, Property 1: no admission beyond allowlist or loopback pair
		const p = await policy("api", true)
		fc.assert(
			fc.property(
				fc.constantFrom(...LOOPBACK_HOSTS, ...FOREIGN_HOSTS),
				fc.constantFrom(...LOOPBACK_PEERS, ...REMOTE_PEERS),
				fc.constantFrom("http" as const, "websocket" as const),
				(host, peer, transport) => {
					const admitted =
						p.evaluate(request("api", transport, host, peer)).kind ===
						"authenticated"
					expect(admitted).toBe(
						LOOPBACK_HOSTS.includes(host) && LOOPBACK_PEERS.includes(peer),
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	it.each([undefined, false])(
		"with the rule %s the exact allowlist stands, loopback or not",
		async flag => {
			for (const [surface, transport] of LISTENERS) {
				const p = await policy(surface, flag)
				for (const host of LOOPBACK_HOSTS)
					expect(
						p.evaluate(request(surface, transport, host, "127.0.0.1")),
					).toMatchObject({ code: "HOST_FORBIDDEN" })
			}
		},
	)

	it("keeps Origin checks: a loopback Host does not admit a foreign Origin", async () => {
		const p = await policy("api", true)
		const req = request("api", "websocket", "127.0.0.1:9000", "127.0.0.1")
		expect(
			p.evaluate({
				...req,
				rawHeaders: [...req.rawHeaders, "Origin", "http://evil.example"],
			}),
		).toMatchObject({ code: "ORIGIN_FORBIDDEN" })
	})
})

describe("the runtime passes the rule to every listener", () => {
	const roots: string[] = []
	const contexts: NamedAccessRuntimeContext[] = []
	afterEach(async () => {
		for (const context of contexts.splice(0))
			await context.close().catch(() => undefined)
		for (const root of roots.splice(0))
			await fs.rm(root, { recursive: true, force: true })
	})

	async function open(loopbackHostFromLoopbackPeer?: boolean) {
		const root = await fs.mkdtemp(join(tmpdir(), "wavekit-loopback-host-"))
		roots.push(root)
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		const machine = storage.useMachineCredential(value => value)
		await storage.close()
		const bootstrap = resolveAccessBootstrap({
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: ["127.0.0.1:9000"],
			allowedOrigins: ["http://127.0.0.1:9000"],
			externalAudioOrigins: ["http://127.0.0.1:9001", "http://127.0.0.1:9002"],
		})
		if (bootstrap.mode !== "protected") throw new Error("Invalid bootstrap")
		const context = await openAccessRuntime({
			bootstrap,
			audio: {
				analog: {
					listenerScheme: "http",
					allowedAuthorities: ["127.0.0.1:9001"],
				},
				digital: {
					listenerScheme: "http",
					allowedAuthorities: ["127.0.0.1:9002"],
				},
			},
			directory,
			ownership: "single-host-pid-namespace",
			...(loopbackHostFromLoopbackPeer === undefined
				? {}
				: { loopbackHostFromLoopbackPeer }),
		})
		contexts.push(context)
		return { context, machine }
	}

	const ask = (
		listener: { policy: AccessPolicy },
		surface: "api" | "audio",
		host: string,
		peer: string,
		machine: string,
	) =>
		listener.policy.evaluate({
			method: "GET",
			rawTarget: surface === "api" ? "/api/status" : "/audio.wav",
			rawHeaders: ["Host", host, "Authorization", `Bearer ${machine}`],
			transport: "http",
			surface,
			remoteAddress: peer,
		})

	it("on: the API's Host reaches the audio listeners from loopback, and the reverse", async () => {
		const { context, machine } = await open(true)
		const listeners = [
			[context.api, "api"],
			[context.analogAudio, "audio"],
			[context.digitalAudio, "audio"],
		] as const
		for (const [listener, surface] of listeners) {
			for (const host of ["127.0.0.1:9000", "localhost:9001", "[::1]:9002"]) {
				expect(ask(listener, surface, host, "127.0.0.1", machine).kind).toBe(
					"authenticated",
				)
				expect(
					ask(listener, surface, host, "198.51.100.4", machine),
				).toMatchObject(
					// Each listener's own authority stays admitted from anywhere.
					surface === "api" && host === "127.0.0.1:9000"
						? { kind: "authenticated" }
						: { code: "HOST_FORBIDDEN" },
				)
			}
			expect(
				ask(listener, surface, "evil.example:9000", "127.0.0.1", machine),
			).toMatchObject({ code: "HOST_FORBIDDEN" })
		}
	})

	it("off by default: each listener keeps its own exact Host", async () => {
		const { context, machine } = await open()
		expect(
			ask(context.analogAudio, "audio", "127.0.0.1:9000", "127.0.0.1", machine),
		).toMatchObject({ code: "HOST_FORBIDDEN" })
		expect(
			ask(context.api, "api", "localhost:9000", "127.0.0.1", machine),
		).toMatchObject({ code: "HOST_FORBIDDEN" })
	})
})
