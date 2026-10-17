/**
 * Redacted config export through the real ApiServer (WG6 req 7, Main wiring): the route mounts
 * only with the access controller while CONFIG_EXPORT_REQUIRES_ACCESS (legacy → 404), denies a
 * request without a device credential, and redacts DO's `secret` option keys.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	CONFIG_EXPORT_CONTENT_TYPE,
	CONFIG_EXPORT_REQUIRES_ACCESS,
	CONFIG_EXPORT_ROUTE,
} from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { ConfigSchema } from "../../../src/config.js"
import type { Config } from "../../../src/config.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const KEY_SENTINEL = "-H 0123456789ABCDEF-sentinel"

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
		...extra,
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
	} as unknown as ApiServerDependencies
}

function config(): Config {
	return ConfigSchema.parse({
		decoders: [
			{
				id: "dmr",
				type: "dsd-fme",
				enabled: false,
				options: { extraArgs: [KEY_SENTINEL] },
			},
		],
	})
}

describe("config export through the API server (WG6 MA.1 CE)", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	it("is not mounted in legacy mode while the constant requires access", async () => {
		const server = new ApiServer(dependencies({ getConfig: config }), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		const res = await server
			.getApp()
			.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		if (CONFIG_EXPORT_REQUIRES_ACCESS) expect(res.statusCode).toBe(404)
		expect(res.body).not.toContain(KEY_SENTINEL)
	})

	it("in protected mode denies a request without a device and redacts secret options for an operator", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "config-export-wiring-"))
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

		const server = new ApiServer(dependencies({ access, getConfig: config }), {
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
			url: CONFIG_EXPORT_ROUTE,
			headers: { host },
		})
		expect(denied.statusCode).toBe(401)
		expect(denied.body).not.toContain(KEY_SENTINEL)

		const ok = await app.inject({
			method: "GET",
			url: CONFIG_EXPORT_ROUTE,
			headers: { host, authorization: `Bearer ${token}` },
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.headers["content-type"]).toBe(CONFIG_EXPORT_CONTENT_TYPE)
		expect(ok.headers["cache-control"]).toBe("no-store")
		expect(ok.body).toContain("dsd-fme")
		expect(ok.body).not.toContain(KEY_SENTINEL)
		expect(ok.body).not.toContain("0123456789ABCDEF")
	})

	it("in protected mode without a config provider answers 503", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "config-export-wiring-"))
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
		const server = new ApiServer(dependencies({ access }), {
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
		const res = await server.getApp().inject({
			method: "GET",
			url: CONFIG_EXPORT_ROUTE,
			headers: { host, authorization: `Bearer ${token}` },
		})
		expect(res.statusCode).toBe(503)
		expect(res.json<{ code: string }>().code).toBe("CONFIG_EXPORT_UNAVAILABLE")
	})
})
