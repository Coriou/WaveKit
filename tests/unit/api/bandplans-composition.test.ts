import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type {
	BandPlanStackView,
	BandPlanPackView,
	ImportPreview,
} from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { openBandPlanService } from "../../../src/core/bandplans/index.js"
import type { BandPlanService } from "../../../src/core/bandplans/index.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"

const logger = pino({ level: "silent" })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const host = "receiver.lan:9000"
const origin = "http://receiver.lan:9000"

async function setup(protectedMode: boolean) {
	const root = await mkdtemp(join(tmpdir(), "wavekit-bandplans-composition-"))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	let access: NamedAccessRuntimeContext | undefined
	let token = ""
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
		})
		const context = access
		cleanups.push(() => context.close())
	}
	const stateDir = join(root, "state")
	await mkdir(stateDir, { mode: 0o700 })
	const service: BandPlanService = await openBandPlanService({
		stateDir,
		context: { region: "EU", effectiveCountry: null },
		writable: protectedMode,
	})
	cleanups.push(() => service.close())
	const sourceManager = new SourceManager(logger)
	cleanups.push(() => sourceManager.disconnectAll())
	const fanoutManager = new FanoutManager(logger)
	cleanups.push(async () => fanoutManager.destroy())
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
			bandPlans: service,
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
	const storeFile = join(stateDir, "bandplans", "state.json")
	return {
		server,
		service,
		stateDir,
		storeFile,
		app: server.getApp(),
		authorized: { host, authorization: `Bearer ${token}` },
		anonymous: { host },
	}
}

type Env = Awaited<ReturnType<typeof setup>>

function setStackBody(view: BandPlanStackView) {
	if (view.store.state !== "available" || view.store.storeId === null)
		throw new Error("store unavailable")
	return {
		expected: { storeId: view.store.storeId, revision: view.store.revision },
		entries: view.stack.entries.map((entry, index) => ({
			packId: entry.packId,
			enabled: index === 0 ? !entry.enabled : entry.enabled,
		})),
	}
}

async function readView(env: Env, headers: Record<string, string>) {
	const response = await env.app.inject({ url: "/api/bandplans", headers })
	expect(response.statusCode).toBe(200)
	return response.json<BandPlanStackView>()
}

describe("band-plan routes mounted by ApiServer", () => {
	it("legacy mode serves reads with writable false and registers no writes", async () => {
		const env = await setup(false)
		const view = await readView(env, env.anonymous)
		expect(view.capabilities.writable).toBe(false)
		expect(view.context).toEqual({ region: "EU", effectiveCountry: null })
		expect(view.store).toEqual({
			state: "available",
			storeId: null,
			revision: 0,
		})
		for (const url of ["/api/bandplans/resolved", "/api/bandplans/presets"]) {
			const response = await env.app.inject({ url, headers: env.anonymous })
			expect(response.statusCode).toBe(200)
		}
		// Legacy opens read-only: nothing under stateDir/bandplans is created.
		await expect(stat(join(env.stateDir, "bandplans"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		const inertExpected = {
			storeId: "00000000-0000-4000-8000-000000000001",
			revision: 0,
		}
		const writes = [
			{
				method: "PUT",
				url: "/api/bandplans/stack",
				body: { expected: inertExpected, entries: [] },
			},
			{
				method: "DELETE",
				url: "/api/bandplans/stack",
				body: { expected: inertExpected },
			},
			{
				method: "POST",
				url: "/api/bandplans/presets",
				body: { expected: inertExpected, preset: {} },
			},
		] as const
		for (const write of writes) {
			const response = await env.app.inject({
				method: write.method,
				url: write.url,
				headers: { ...env.anonymous, origin },
				payload: write.body,
			})
			expect(response.statusCode).toBe(404)
		}
		await expect(stat(join(env.stateDir, "bandplans"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		expect((await readView(env, env.anonymous)).store).toEqual(view.store)
	})

	it("protected mode admits reads like regional, denies anonymous writes and accepts authorised writes", async () => {
		const env = await setup(true)
		for (const url of [
			"/api/bandplans",
			"/api/bandplans/resolved",
			"/api/bandplans/presets",
		]) {
			const denied = await env.app.inject({ url, headers: env.anonymous })
			expect(denied.statusCode).toBe(401)
			expect(denied.json()).toEqual({ code: "AUTH_REQUIRED" })
			const admitted = await env.app.inject({ url, headers: env.authorized })
			expect(admitted.statusCode).toBe(200)
		}
		const regional = await env.app.inject({
			url: "/api/regional/families?region=US",
			headers: env.anonymous,
		})
		// Regional is not mounted here; root admission still denies before routing.
		expect(regional.statusCode).toBe(401)

		const view = await readView(env, env.authorized)
		expect(view.capabilities.writable).toBe(true)
		expect(view.store.state).toBe("available")
		if (view.store.state === "available")
			expect(view.store.storeId).toEqual(expect.any(String))
		const before = await readFile(env.storeFile, "utf8")
		const anonymousWrite = await env.app.inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { ...env.anonymous, origin },
			payload: setStackBody(view),
		})
		expect(anonymousWrite.statusCode).toBe(401)
		expect(anonymousWrite.json()).toEqual({ code: "AUTH_REQUIRED" })
		expect(await readFile(env.storeFile, "utf8")).toBe(before)
		expect((await readView(env, env.authorized)).store).toEqual(view.store)

		const write = await env.app.inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { ...env.authorized, origin },
			payload: setStackBody(view),
		})
		expect(write.statusCode).toBe(200)
		const after = write.json<{ view: BandPlanStackView }>().view
		expect(after.store).toMatchObject({
			state: "available",
			revision: view.store.state === "available" ? view.store.revision + 1 : -1,
		})
		expect(await readFile(env.storeFile, "utf8")).not.toBe(before)
	})

	it.each([false, true])(
		"stop() closes the service and releases the store lock (protected=%s)",
		async protectedMode => {
			const env = await setup(protectedMode)
			const view = env.service.view()
			await env.server.stop()
			const expected =
				view.store.state === "available" && view.store.storeId !== null
					? { storeId: view.store.storeId, revision: view.store.revision }
					: {
							storeId: "00000000-0000-4000-8000-000000000001",
							revision:
								view.store.state === "available" ? view.store.revision : 0,
						}
			await expect(
				env.service.mutate({
					type: "reset-stack",
					expected,
				}),
			).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
			expect(env.service.view().store).toEqual({ state: "unavailable" })
			const reopened = await openBandPlanService({
				stateDir: env.stateDir,
				context: { region: "EU", effectiveCountry: null },
				writable: true,
			})
			try {
				expect(reopened.view().store.state).toBe("available")
			} finally {
				await reopened.close()
			}
		},
	)

	it("advertises all three import formats and imports each end to end in protected mode (WG5)", async () => {
		const env = await setup(true)
		const view = await readView(env, env.authorized)
		expect(view.capabilities.importFormats).toEqual([
			"sdrpp-json",
			"sdrsharp-xml",
			"gqrx-csv",
		])
		const fixtures = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../mocks/fixtures/bandplans",
		)
		const files = [
			["sdrpp-json", "synthetic-sdrpp.json"],
			["sdrsharp-xml", "sdrsharp/BandPlan.xml"],
			["gqrx-csv", "synthetic-gqrx.csv"],
		] as const
		for (const [format, file] of files) {
			const fileBody = {
				format,
				fileName: basename(file),
				contentBase64: (await readFile(join(fixtures, file))).toString(
					"base64",
				),
				groupOverrides: [],
			}
			const anonymous = await env.app.inject({
				method: "POST",
				url: "/api/bandplans/imports/preview",
				headers: { ...env.anonymous, origin },
				payload: fileBody,
			})
			expect(anonymous.statusCode).toBe(401)
			const previewResponse = await env.app.inject({
				method: "POST",
				url: "/api/bandplans/imports/preview",
				headers: { ...env.authorized, origin },
				payload: fileBody,
			})
			expect(previewResponse.statusCode, format).toBe(200)
			const preview = previewResponse.json<ImportPreview>()
			expect(preview.format).toBe(format)
			expect(preview.bands.length).toBeGreaterThan(0)
			const current = await readView(env, env.authorized)
			if (current.store.state !== "available" || current.store.storeId === null)
				throw new Error("store unavailable")
			const commit = await env.app.inject({
				method: "POST",
				url: "/api/bandplans/imports",
				headers: { ...env.authorized, origin },
				payload: {
					...fileBody,
					expected: {
						storeId: current.store.storeId,
						revision: current.store.revision,
					},
					previewDigest: preview.previewDigest,
					name: `WG5 ${format}`,
					author: null,
					licence: null,
					keepColourHints: true,
					replacesPackId: null,
					addToStack: true,
				},
			})
			expect(commit.statusCode, format).toBe(201)
			const { createdId } = commit.json<{ createdId: string | null }>()
			expect(createdId).toMatch(/^imported-[0-9a-f]{12}$/)
			const pack = await env.app.inject({
				url: `/api/bandplans/packs/${String(createdId)}`,
				headers: env.authorized,
			})
			expect(pack.statusCode).toBe(200)
			expect(pack.json<BandPlanPackView>().pack).toMatchObject({
				kind: "imported",
				provenance: { kind: "imported", format },
			})
		}
	})
})
