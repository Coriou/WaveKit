/**
 * WG8 req 4 (Main wiring): the recordings inventory through the real ApiServer. Protected mode
 * mounts the list and the download behind the access controller; legacy mode never mounts them.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { recordingDsdFmeDirs } from "../../../src/index.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const CALL = "20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"

function wav(dataBytes: number, rate = 8000): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVE", 8, "ascii")
	b.write("fmt ", 12, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(rate, 24)
	b.writeUInt32LE(rate * 2, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

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

describe("recordings inventory through the API server", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), "recordings-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const calls = join(root, "calls")
		await fs.mkdir(calls)
		const file = join(calls, CALL)
		const bytes = wav(16_000)
		await fs.writeFile(file, bytes)
		const old = (Date.now() - 60_000) / 1000
		await fs.utimes(file, old, old)
		const configs: DecoderConfig[] = [
			{
				id: "zeta",
				type: "dsd-fme",
				enabled: true,
				options: { output: "wav", wavDir: calls },
			},
			{ id: "ism", type: "rtl433", enabled: true, options: {} },
			{ id: "alpha", type: "dsd-fme", enabled: true, options: {} },
		]
		const dirs = recordingDsdFmeDirs({
			getConfiguredDecoderConfigs: () => configs,
		})
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => dirs,
			scannerRecordingsDir: () => null,
			logger,
		})
		return { root, inventory, bytes, dirs, calls }
	}

	it("lists only recording dsd-fme decoders, sorted by id", async () => {
		const { dirs, calls } = await setup()
		expect(dirs).toEqual([{ decoderId: "zeta", dir: calls }])
		expect(
			recordingDsdFmeDirs({
				getConfiguredDecoderConfigs: () => [
					{
						id: "b",
						type: "dsd-fme",
						enabled: true,
						options: { output: "wav", wavDir: "/b" },
					},
					{
						id: "a",
						type: "dsd-fme",
						enabled: true,
						options: {
							enablePerCallRecording: true,
							perCallRecordingDir: "/a",
						},
					},
				],
			}).map(d => d.decoderId),
		).toEqual(["a", "b"])
	})

	it("legacy: no recordings routes (404)", async () => {
		const { inventory } = await setup()
		const server = new ApiServer(
			dependencies({ recordingInventory: inventory }),
			{ host: "127.0.0.1", port: 0 },
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const list = await app.inject({ method: "GET", url: "/api/recordings" })
		expect(list.statusCode).toBe(404)
		const file = await app.inject({
			method: "GET",
			url: `/api/recordings/${encodeURIComponent(`dsd:0~${CALL}`)}/file`,
		})
		expect(file.statusCode).toBe(404)
	})

	it("protected: denied without a credential, then lists and downloads", async () => {
		const { root, inventory, bytes } = await setup()
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
		const server = new ApiServer(
			dependencies({ recordingInventory: inventory, access }),
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
		const app = server.getApp()
		const authorized = { host, authorization: `Bearer ${token}` }

		const denied = await app.inject({
			method: "GET",
			url: "/api/recordings",
			headers: { host },
		})
		expect(denied.statusCode).toBe(401)

		const list = await app.inject({
			method: "GET",
			url: "/api/recordings",
			headers: authorized,
		})
		expect(list.statusCode).toBe(200)
		const page = list.json<RecordingInventoryPage>()
		expect(page.items.map(i => i.id)).toEqual([`dsd:0~${CALL}`])

		const url = `/api/recordings/${encodeURIComponent(`dsd:0~${CALL}`)}/file`
		const deniedFile = await app.inject({
			method: "GET",
			url,
			headers: { host },
		})
		expect(deniedFile.statusCode).toBe(401)
		const file = await app.inject({ method: "GET", url, headers: authorized })
		expect(file.statusCode).toBe(200)
		expect(file.rawPayload.equals(bytes)).toBe(true)
	})
})
