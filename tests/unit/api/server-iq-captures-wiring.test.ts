/**
 * Named IQ captures through the real ApiServer: protected mode with source fanout and the
 * config mounts them under `<stateDir>/iq-captures`; legacy mode never mounts them.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { IqCaptureList } from "@wavekit/api-types"
import type { Config } from "../../../src/config.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })

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

describe("IQ captures through the API server", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), "iq-captures-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		return {
			root,
			extra: {
				getConfig: () => ({ stateDir: join(root, "state") }) as Config,
				iqSnapshotFanoutFor: () => {
					throw new Error("no capture in this test")
				},
			} satisfies Partial<ApiServerDependencies>,
		}
	}

	it("legacy: no capture routes (404)", async () => {
		const { extra } = await setup()
		const server = new ApiServer(dependencies(extra), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		const list = await server
			.getApp()
			.inject({ method: "GET", url: "/api/iq/captures" })
		expect(list.statusCode).toBe(404)
	})

	it("protected: denied without a credential, then lists from the state directory", async () => {
		const { root, extra } = await setup()
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
		const app = server.getApp()
		const denied = await app.inject({
			method: "GET",
			url: "/api/iq/captures",
			headers: { host },
		})
		expect(denied.statusCode).toBe(401)
		const list = await app.inject({
			method: "GET",
			url: "/api/iq/captures",
			headers: { host, authorization: `Bearer ${token}` },
		})
		expect(list.statusCode).toBe(200)
		expect(list.json<IqCaptureList>().captures).toEqual([])
		const stat = await fs.stat(join(root, "state", "iq-captures"))
		expect(stat.isDirectory()).toBe(true)
		expect(stat.mode & 0o777).toBe(0o700)
	})
})
