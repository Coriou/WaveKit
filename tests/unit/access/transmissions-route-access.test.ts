/**
 * GET /api/transmissions/:ref under protected access, through the real ApiServer composition (the
 * access runtime, the route's `authorize` wired by the server): without a credential the route
 * is denied before any lookup (no 400 or 404 oracle); with the machine credential it answers.
 * Synthetic ids only.
 */
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { TransmissionDto } from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { TransmissionRegistry } from "../../../src/core/transmissions/index.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const UNKNOWN = `tx_01JTESTACCESS${"0".repeat(13)}`

function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
}

function dependencies(
	extra: Partial<ApiServerDependencies>,
): ApiServerDependencies {
	return {
		logger,
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
		...extra,
	} as unknown as ApiServerDependencies
}

describe("GET /api/transmissions/:ref under protected access", () => {
	const cleanup: Array<() => Promise<void> | void> = []
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function protectedServer() {
		const root = await fs.mkdtemp(join(tmpdir(), "wk-tx-access-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			ownership: "single-host-pid-namespace",
			mode: "provision",
		})
		const token = storage.useMachineCredential(value => value)
		await storage.close()
		const access = await openAccessRuntime(runtimeOptions(directory))
		cleanup.push(() => access.close())
		const registry = new TransmissionRegistry()
		const claim = registry.claim({
			origin: "dv-call",
			kind: "voice-digital",
			sourceId: null,
			dvKey: "dv:dsd-a",
			lane: 0,
			run: "dsd-a#1",
			atMs: Date.now() - 1000,
			alias: "call:dsd-a:call-1",
		})
		if (claim === null) throw new TypeError("no claim")
		const server = new ApiServer(
			dependencies({ access, transmissions: registry }),
			{
				host: "127.0.0.1",
				port: 0,
				accessBootstrap: runtimeOptions(directory).bootstrap,
				publicOrigins: {
					api: origin,
					analogAudio: "http://receiver.lan:9001",
					digitalAudio: "http://receiver.lan:9002",
				},
			},
		)
		cleanup.push(() => server.stop())
		await server.start()
		return {
			app: server.getApp(),
			txId: claim.txId,
			authorized: { host, authorization: `Bearer ${token}` },
		}
	}

	it("denies a request without the credential before any lookup", async () => {
		const { app, txId } = await protectedServer()
		const answers = []
		for (const ref of [txId, UNKNOWN, "not a ref"]) {
			const res = await app.inject({
				method: "GET",
				url: `/api/transmissions/${encodeURIComponent(ref)}`,
				headers: { host },
			})
			expect(res.statusCode).toBe(401)
			expect(res.body).not.toContain(txId)
			answers.push(res.body)
		}
		// A held id, an unknown one and a malformed one answer alike: no oracle.
		expect(new Set(answers).size).toBe(1)
		// A wrong credential is denied too.
		const wrong = await app.inject({
			method: "GET",
			url: `/api/transmissions/${txId}`,
			headers: { host, authorization: "Bearer not-the-token" },
		})
		expect(wrong.statusCode).toBe(401)
	})

	it("answers with the credential: the transmission, an unknown id's 404, a malformed ref's 400", async () => {
		const { app, txId, authorized } = await protectedServer()
		const held = await app.inject({
			method: "GET",
			url: `/api/transmissions/${txId}`,
			headers: authorized,
		})
		expect(held.statusCode).toBe(200)
		expect(held.json<TransmissionDto>()).toMatchObject({
			id: txId,
			kind: "voice-digital",
		})
		const unknown = await app.inject({
			method: "GET",
			url: `/api/transmissions/${UNKNOWN}`,
			headers: authorized,
		})
		expect(unknown.statusCode).toBe(404)
		expect(unknown.json()).toMatchObject({ code: "TRANSMISSION_NOT_FOUND" })
		const malformed = await app.inject({
			method: "GET",
			url: `/api/transmissions/${encodeURIComponent("not a ref")}`,
			headers: authorized,
		})
		expect(malformed.statusCode).toBe(400)
	})
})
