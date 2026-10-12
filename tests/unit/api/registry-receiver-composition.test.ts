import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createRegionalRegistration } from "../../../src/core/regional/data.js"
import { createRegionalRegistry } from "../../../src/core/regional/registry.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"

const logger = pino({ level: "silent" })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(
	protectedMode: boolean,
	mount: "present" | "null" | "absent" = "present",
) {
	const root = await mkdtemp(join(tmpdir(), "wavekit-metadata-composition-"))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	let access: NamedAccessRuntimeContext | undefined
	let token = ""
	const origin = "http://receiver.lan:9000"
	if (protectedMode) {
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		token = storage.useMachineCredential(value => value)
		await storage.close()
		access = await openAccessRuntime({
			directory,
			ownership: "single-host-pid-namespace",
			bootstrap: {
				mode: "protected",
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9000"],
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
		})
		const context = access
		cleanups.push(() => context.close())
	}
	const sourceManager = new SourceManager(logger)
	cleanups.push(() => sourceManager.disconnectAll())
	const fanoutManager = new FanoutManager(logger)
	cleanups.push(async () => fanoutManager.destroy())
	const read = vi.spyOn(sourceManager, "getReceiverEvidence")
	const readPage = vi.spyOn(sourceManager, "getReceiverEvidencePage")
	const realRegistry = createRegionalRegistry(createRegionalRegistration())
	const families = vi.fn(
		(region: Parameters<typeof realRegistry.listFamilies>[0]) =>
			realRegistry.listFamilies(region),
	)
	const registry = {
		listFamilies: families,
		listChannels: vi.fn(
			(input: Parameters<typeof realRegistry.listChannels>[0]) =>
				realRegistry.listChannels(input),
		),
		resolveAlias: vi.fn(
			(input: Parameters<typeof realRegistry.resolveAlias>[0]) =>
				realRegistry.resolveAlias(input),
		),
	}
	const provider = createReceiverCapabilitiesProvider(
		{
			read: id => sourceManager.getReceiverEvidence(id),
			readPage: (after, limit) =>
				sourceManager.getReceiverEvidencePage(after, limit),
		},
		TUNER_REST_COMMAND_POLICY,
	)
	cleanups.push(async () => provider.dispose())
	const dispose = vi.spyOn(provider, "dispose")
	const decoderManager = Object.assign(new EventEmitter(), {
		getAllDecoders: () => [],
		getAllStatus: () => [],
		getAllHealth: () => new Map(),
		getStatus: () => undefined,
	}) as unknown as ApiServerDependencies["decoderManager"]
	const audioOutput = Object.assign(new EventEmitter(), {
		getConnectedClients: () => 0,
		getPort: () => 8080,
	}) as unknown as ApiServerDependencies["audioOutput"]
	const server = new ApiServer(
		{
			...(access ? { access } : {}),
			...(mount === "absent"
				? {}
				: {
						regionalRegistry: mount === "null" ? null : registry,
						receiverCapabilitiesProvider: mount === "null" ? null : provider,
					}),
			sourceManager,
			fanoutManager,
			decoderManager,
			audioOutput,
			logger,
		},
		{ host: "127.0.0.1", port: 0 },
	)
	cleanups.push(() => server.stop())
	await server.start()
	return {
		server,
		app: server.getApp(),
		provider,
		dispose,
		read,
		readPage,
		families,
		headers: { host: "receiver.lan:9000", authorization: `Bearer ${token}` },
	}
}

describe.each([false, true])(
	"combined metadata composition protected=%s",
	mode => {
		// Feature: regional-display-registry, Property 7: Admission ordering
		// Validates: Requirements 4.1, 4.2, 4.5
		// Feature: receiver-capabilities, Property 6: Admission/error precedence
		// Validates: Requirements 3.1, 3.3, 3.8
		it("mounts both real providers without claiming data or hardware readiness", async () => {
			const env = await setup(mode)
			for (const url of [
				"/api/regional/families?region=US",
				"/api/regional/channels?region=US&family=frs",
				"/api/receiver-capabilities",
			]) {
				const response = await env.app.inject({ url, headers: env.headers })
				expect(response.statusCode).toBe(200)
				expect(response.headers["cache-control"]).toBe("no-store")
				if (url.includes("families"))
					expect(response.json()).toMatchObject({
						state: "available",
						families: [{ state: "unavailable", datasetVersion: null }],
					})
				else if (url.includes("channels"))
					expect(response.json()).toMatchObject({
						state: "unavailable",
						reason: "evidence-pending",
					})
				else
					expect(response.json()).toEqual({
						schemaVersion: 1,
						items: [],
						nextAfter: null,
					})
			}
			expect(env.readPage).toHaveBeenCalledTimes(1)
			expect(env.read).not.toHaveBeenCalled()
			expect(env.families).toHaveBeenCalledTimes(1)
		expect(
			(
				await env.app.inject({
					url: "/health",
					headers: { host: env.headers.host },
				})
			).statusCode,
		).toBe(200)
			expect(env.server.getAccessBootstrap()).toBeNull()
			await Promise.all([env.server.stop(), env.server.stop()])
			expect(env.dispose).not.toHaveBeenCalled()
			expect(env.provider.list({ after: null, limit: 8 }).ok).toBe(true)
			env.provider.dispose()
			expect(env.provider.list({ after: null, limit: 8 })).toEqual({
				ok: false,
				code: "UNAVAILABLE",
			})
		})

		it.each(["absent", "null"] as const)(
			"keeps %s regional dependency distinct from always-mounted receiver absence",
			async mount => {
				const env = await setup(mode, mount)
				const regional = await env.app.inject({
					url: "/api/regional/families?region=US",
					headers: env.headers,
				})
				expect(regional.statusCode).toBe(mount === "absent" ? 404 : 503)
				const receiver = await env.app.inject({
					url: "/api/receiver-capabilities",
					headers: env.headers,
				})
				expect(receiver.statusCode).toBe(503)
				expect(receiver.json()).toMatchObject({
					code: "RECEIVER_CAPABILITIES_UNAVAILABLE",
				})
				expect(env.readPage).not.toHaveBeenCalled()
				expect(env.families).not.toHaveBeenCalled()
			},
		)
	},
)

it("preserves root denial serializer and never gives either feature public admission", async () => {
	const env = await setup(true)
	for (const url of [
		"/api/regional/families?region=US",
		"/api/receiver-capabilities",
	]) {
		const denied = await env.app.inject({
			url,
			headers: { host: env.headers.host },
		})
		expect(denied.statusCode).toBe(401)
		expect(denied.json()).toEqual({ code: "AUTH_REQUIRED" })
		expect(denied.headers["cache-control"]).toBe("no-store")
	}
	expect(env.readPage).not.toHaveBeenCalled()
	expect(env.families).not.toHaveBeenCalled()
	env.server.stopAdmission()
	const stopped = await env.app.inject({
		url: "/api/receiver-capabilities",
		headers: env.headers,
	})
	expect(stopped.statusCode).toBe(503)
	expect(stopped.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
	expect(env.readPage).not.toHaveBeenCalled()
})
