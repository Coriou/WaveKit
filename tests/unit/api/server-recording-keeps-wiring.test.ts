/**
 * WG9 req 2.1, 2.5, 2.7 (Main wiring): recording Keep, unkeep and delete through the real
 * ApiServer with the startup composition (inventory protection bound late to the keep service,
 * the dsd-fme pruner port). Protected: Keep, the pruner skips the kept call, unkeep, delete.
 * Legacy, or protected without a keep service: no Keep or delete routes (404).
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
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
import type {
	RecordingKeepKey,
	RecordingKeepService,
	RecordingProtection,
} from "../../../src/core/recordings/contract.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../src/core/recordings/keep-service.js"
import { lateBoundRecordingProtection } from "../../../src/core/recordings/late-bound-protection.js"
import {
	pruneCallRecordings,
	setCallRecordingProtection,
} from "../../../src/decoders/builtin/call-recordings.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const CALL = "20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"
const ID = `dsd:0~${CALL}`
const KEEP = `/api/recordings/${encodeURIComponent(ID)}/keep`
const DEL = `/api/recordings/${encodeURIComponent(ID)}`

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

describe("lateBoundRecordingProtection", () => {
	const keys = (p: RecordingProtection) => [
		p.isProtected("dsd~x.wav" as RecordingKeepKey),
		p.isDsdFmeFileProtected(CALL),
		p.isScannerFileProtected("d_A", "a.wav"),
		p.discoveryHoldsKept("d_A"),
	]

	it("answers protected until bound, and when the bound port throws", () => {
		let bound: RecordingProtection | undefined
		const port = lateBoundRecordingProtection(() => bound)
		expect(keys(port)).toEqual([true, true, true, true])
		bound = {
			isProtected: () => {
				throw new Error("boom")
			},
			isDsdFmeFileProtected: () => {
				throw new Error("boom")
			},
			isScannerFileProtected: () => {
				throw new Error("boom")
			},
			discoveryHoldsKept: () => {
				throw new Error("boom")
			},
		}
		expect(keys(port)).toEqual([true, true, true, true])
	})

	it("forwards every answer once bound", () => {
		const seen: unknown[][] = []
		const bound: RecordingProtection = {
			isProtected: k => (seen.push(["k", k]), false),
			isDsdFmeFileProtected: n => (seen.push(["d", n]), false),
			isScannerFileProtected: (d, n) => (seen.push(["s", d, n]), false),
			discoveryHoldsKept: d => (seen.push(["h", d]), false),
		}
		const port = lateBoundRecordingProtection(() => bound)
		expect(keys(port)).toEqual([false, false, false, false])
		expect(seen).toEqual([
			["k", "dsd~x.wav"],
			["d", CALL],
			["s", "d_A", "a.wav"],
			["h", "d_A"],
		])
	})
})

describe("recording Keep and delete through the API server", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		setCallRecordingProtection(null)
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	/** The startup composition from src/index.ts: inventory first, keep service bound late. */
	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), "recording-keeps-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const calls = join(root, "calls")
		const stateDir = join(root, "state")
		await fs.mkdir(calls)
		await fs.mkdir(stateDir)
		const file = join(calls, CALL)
		await fs.writeFile(file, wav(16_000))
		const old = (Date.now() - 60_000) / 1000
		await fs.utimes(file, old, old)
		let bound: RecordingKeepService | undefined
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "zeta", dir: calls }],
			scannerRecordingsDir: () => null,
			logger,
			protection: lateBoundRecordingProtection(() => bound),
		})
		// Before the keep service is bound, the inventory reports every item kept.
		const early = await inventory.list({})
		expect(early.items.map(i => i.kept)).toEqual([true])
		const keeps = await openRecordingKeepService({
			stateDir,
			inventory,
			logger,
		})
		bound = keeps
		cleanup.push(() => keeps.close())
		setCallRecordingProtection(keeps, logger)
		return { root, calls, file, inventory, keeps, stateDir }
	}

	async function protectedServer(
		root: string,
		extra: Partial<ApiServerDependencies>,
	) {
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
		const server = new ApiServer(dependencies({ ...extra, access }), {
			host: "127.0.0.1",
			port: 0,
			accessBootstrap: runtimeOptions(directory).bootstrap,
			publicOrigins: {
				api: origin,
				analogAudio: "http://receiver.lan:9001",
				digitalAudio: "http://receiver.lan:9002",
			},
		})
		cleanup.push(() => server.stop())
		await server.start()
		return {
			app: server.getApp(),
			authorized: { host, authorization: `Bearer ${token}` },
		}
	}

	it("protected: Keep, the pruner skips the kept call, unkeep, then delete", async () => {
		const { root, calls, file, inventory, keeps, stateDir } = await setup()
		const { app, authorized } = await protectedServer(root, {
			recordingInventory: inventory,
			recordingKeeps: keeps,
		})

		const denied = await app.inject({
			method: "PUT",
			url: KEEP,
			headers: { host },
		})
		expect(denied.statusCode).toBe(401)

		const kept = await app.inject({
			method: "PUT",
			url: KEEP,
			headers: authorized,
		})
		expect(kept.statusCode).toBe(200)
		expect(kept.json()).toEqual({ id: ID, kept: true, changed: true })
		expect(existsSync(join(stateDir, "recording-keeps.json"))).toBe(true)
		const list = await app.inject({
			method: "GET",
			url: "/api/recordings",
			headers: authorized,
		})
		expect(list.json<RecordingInventoryPage>().items.map(i => i.kept)).toEqual([
			true,
		])

		// The kept call survives an expired-age prune through the installed port.
		const pruned = await pruneCallRecordings([calls], {
			maxAgeHours: 0,
			maxTotalMb: 0,
		})
		expect(pruned.deleted).toEqual([])
		expect(pruned.protectedSkipped).toBe(1)
		expect(existsSync(file)).toBe(true)

		const refused = await app.inject({
			method: "DELETE",
			url: DEL,
			headers: authorized,
		})
		expect(refused.statusCode).toBe(409)
		expect(refused.json()).toMatchObject({ code: "RECORDING_KEPT" })
		expect(existsSync(file)).toBe(true)

		const unkept = await app.inject({
			method: "DELETE",
			url: KEEP,
			headers: authorized,
		})
		expect(unkept.statusCode).toBe(200)
		expect(unkept.json()).toEqual({ id: ID, kept: false, changed: true })

		const deleted = await app.inject({
			method: "DELETE",
			url: DEL,
			headers: authorized,
		})
		expect(deleted.statusCode).toBe(200)
		expect(deleted.json()).toEqual({ id: ID, deleted: true })
		expect(existsSync(file)).toBe(false)
	})

	it("protected without a keep service: inventory only, no Keep or delete routes", async () => {
		const { root, inventory, file } = await setup()
		const { app, authorized } = await protectedServer(root, {
			recordingInventory: inventory,
		})
		const list = await app.inject({
			method: "GET",
			url: "/api/recordings",
			headers: authorized,
		})
		expect(list.statusCode).toBe(200)
		for (const req of [
			{ method: "PUT" as const, url: KEEP },
			{ method: "DELETE" as const, url: KEEP },
			{ method: "DELETE" as const, url: DEL },
		]) {
			const res = await app.inject({ ...req, headers: authorized })
			expect(res.statusCode).toBe(404)
		}
		expect(existsSync(file)).toBe(true)
	})

	it("legacy: no Keep or delete routes even with a keep service (404)", async () => {
		const { inventory, keeps, file } = await setup()
		const server = new ApiServer(
			dependencies({ recordingInventory: inventory, recordingKeeps: keeps }),
			{ host: "127.0.0.1", port: 0 },
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		for (const req of [
			{ method: "PUT" as const, url: KEEP },
			{ method: "DELETE" as const, url: KEEP },
			{ method: "DELETE" as const, url: DEL },
		]) {
			const res = await app.inject(req)
			expect(res.statusCode).toBe(404)
		}
		expect(existsSync(file)).toBe(true)
	})
})
