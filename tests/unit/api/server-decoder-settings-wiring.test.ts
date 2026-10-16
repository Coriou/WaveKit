/**
 * WG8 req 2 (Main wiring): the decoder settings routes through the real ApiServer. Protected
 * mode mounts GET settings and the working PATCH (both behind the access controller); legacy
 * mode serves the frozen decoder routes whether or not a settings service is passed.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { openDecoderSettingsService } from "../../../src/decoders/settings/service.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { decoderSettingsPort } from "../../../src/index.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const CAPS = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
} as const
const ISM: DecoderConfig = {
	id: "ism",
	type: "rtl433",
	enabled: true,
	options: { frequency: 433_920_000 },
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

describe("decoder settings through the API server", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), "decoder-settings-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const registry = new DecoderRegistry()
		registry.register(
			"rtl433",
			config => new RateDecoder(config.id, { ...CAPS }),
			{ ...CAPS },
		)
		const manager = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{ validateVersions: false },
		)
		cleanup.push(() => manager.destroy())
		const sources = new FakeSources()
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 433_920_000 })
		manager.setSourceManager(sources as unknown as SourceManager)
		manager.createDecoder(ISM)
		const stateDir = join(root, "state")
		await fs.mkdir(stateDir)
		const settings = await openDecoderSettingsService({
			configs: [ISM],
			stateDir,
			logger,
		})
		settings.setManager(decoderSettingsPort(manager))
		cleanup.push(() => settings.close())
		return { root, registry, manager, settings, stateDir }
	}

	function dependencies(
		extra: Partial<ApiServerDependencies>,
	): ApiServerDependencies {
		return {
			logger,
			sourceManager: Object.assign(new EventEmitter(), {
				getAllStatus: () => [],
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

	async function legacyResponses(withSettings: boolean) {
		const { registry, manager, settings } = await setup()
		const server = new ApiServer(
			dependencies({
				decoderManager: manager,
				decoderRegistry: registry,
				...(withSettings ? { decoderSettings: settings } : {}),
			}),
			{ host: "127.0.0.1", port: 0 },
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const out: Array<{ status: number; body: string }> = []
		for (const req of [
			{ method: "GET" as const, url: "/api/decoders/ism/settings" },
			{
				method: "PATCH" as const,
				url: "/api/decoders/ism",
				payload: { options: { frequency: 868_000_000 } },
			},
			{
				method: "PATCH" as const,
				url: "/api/decoders/nope",
				payload: { enabled: false },
			},
		]) {
			const res = await app.inject(req)
			// The correlation id is per request
			out.push({
				status: res.statusCode,
				body: res.body.replace(
					/"correlationId":"[^"]*"/,
					'"correlationId":"x"',
				),
			})
		}
		return out
	}

	it("legacy: no settings routes, PATCH answers exactly as without the service", async () => {
		const withService = await legacyResponses(true)
		const without = await legacyResponses(false)
		expect(withService).toEqual(without)
		expect(withService[0]).toEqual({
			status: 404,
			body: '{"error":"NotFound","code":"NOT_FOUND","message":"Route GET /api/decoders/ism/settings not found","correlationId":"x"}',
		})
		expect(withService[1]?.status).toBe(501)
	})

	it("protected: settings GET and PATCH need a credential, then write the store", async () => {
		const { root, registry, manager, settings, stateDir } = await setup()
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
			dependencies({
				decoderManager: manager,
				decoderRegistry: registry,
				decoderSettings: settings,
				access,
			}),
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
		const payload = { options: { frequency: 868_000_000 } }

		// No device credential: denied before any lookup or write
		const deniedGet = await app.inject({
			method: "GET",
			url: "/api/decoders/ism/settings",
			headers: { host },
		})
		expect(deniedGet.statusCode).toBe(401)
		const deniedPatch = await app.inject({
			method: "PATCH",
			url: "/api/decoders/ism",
			headers: { host },
			payload,
		})
		expect(deniedPatch.statusCode).toBe(401)
		await expect(
			fs.readdir(stateDir).then(names => names),
		).resolves.not.toContain(DECODER_SETTINGS_FILE_NAME)

		const get = await app.inject({
			method: "GET",
			url: "/api/decoders/ism/settings",
			headers: authorized,
		})
		expect(get.statusCode).toBe(200)

		const patch = await app.inject({
			method: "PATCH",
			url: "/api/decoders/ism",
			headers: authorized,
			payload,
		})
		expect(patch.statusCode).toBe(200)
		const result = patch.json<{
			revision: number
			changed: string[]
			pendingRestart: boolean
		}>()
		expect(result.revision).toBe(1)
		expect(result.changed).toEqual(["frequency"])
		expect(result.pendingRestart).toBe(true)
		expect(manager.isRestartPending("ism")).toBe(true)
		const file = JSON.parse(
			await fs.readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		) as { decoders: Record<string, { options: unknown }> }
		expect(file.decoders["ism"]?.options).toEqual({ frequency: 868_000_000 })
	})
})
