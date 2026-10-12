import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"
import type {
	ReceiverCapabilitiesProvider,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"
import type {
	ReceiverCapabilities,
	ReceiverCapabilitiesPage,
} from "@wavekit/api-types"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	isReceiverSourceId,
	receiverCapabilitiesSchema,
	receiverCapabilitiesPageSchema,
} from "../../../src/core/tuner-capabilities/types.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const path = "/api/receiver-capabilities"
const servers: ApiServer[] = []
const managers: SourceManager[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop()
	for (const manager of managers.splice(0)) await manager.disconnectAll()
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
	vi.restoreAllMocks()
})

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

async function setup(
	legacy: boolean,
	options: {
		provider?: ReceiverCapabilitiesProvider | null | undefined
		poison?: boolean
		parentFault?: boolean
	} = {},
) {
	const logger = pino({ level: "silent" })
	const sourceManager = new SourceManager(logger)
	managers.push(sourceManager)
	// Real public registration and real evidence accessor/provider; suppress ONLY
	// transport startup so fixtures never contact a configured or live receiver.
	const attempt = vi
		.spyOn(
			sourceManager as unknown as {
				attemptConnection(id: string): Promise<void>
			},
			"attemptConnection",
		)
		.mockResolvedValue()
	const read = vi.fn((id: string) => sourceManager.getReceiverEvidence(id))
	const readPage = vi.fn((after: string | null, limit: number) =>
		sourceManager.getReceiverEvidencePage(after, limit),
	)
	const pure = createReceiverCapabilitiesProvider(
		{ read, readPage },
		TUNER_REST_COMMAND_POLICY,
	)
	const injected = Object.hasOwn(options, "provider") ? options.provider : pure
	let context: NamedAccessRuntimeContext | undefined
	let token: string | undefined
	if (!legacy) {
		const root = await fs.mkdtemp(join(tmpdir(), "wavekit-receiver-routes-"))
		roots.push(root)
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			ownership: "single-host-pid-namespace",
			mode: "provision",
		})
		token = storage.useMachineCredential(value => value)
		await storage.close()
		context = await openAccessRuntime(runtimeOptions(directory))
		contexts.push(context)
	}
	const decoder = Object.assign(new EventEmitter(), {
		getAllDecoders: vi.fn(() => []),
		getAllStatus: vi.fn(() => []),
		getAllHealth: vi.fn(() => new Map()),
		getDecoder: vi.fn(),
		getStatus: vi.fn(),
	})
	const fanout = Object.assign(new EventEmitter(), {
		getTelemetrySnapshot: vi.fn(() => ({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		})),
		getBranchIds: vi.fn(() => []),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		destroy: vi.fn(),
	})
	const audio = Object.assign(new EventEmitter(), {
		getConnectedClients: vi.fn(() => 0),
		getPort: vi.fn(() => 0),
		stop: vi.fn(),
	})
	const deps: ApiServerDependencies = {
		logger,
		sourceManager,
		decoderManager:
			decoder as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager: fanout as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: audio as unknown as ApiServerDependencies["audioOutput"],
		...(context ? { access: context } : {}),
		// Announced Main dependency: no owner server edit or direct plugin mount.
		receiverCapabilitiesProvider: injected,
	}
	const server = new ApiServer(deps, {
		host: "127.0.0.1",
		port: 0,
		...(context
			? {
					accessBootstrap: runtimeOptions("unused").bootstrap,
					publicOrigins: {
						api: origin,
						analogAudio: "http://receiver.lan:9001",
						digitalAudio: "http://receiver.lan:9002",
					},
				}
			: {}),
	})
	servers.push(server)
	const app = server.getApp()
	const parser = vi.fn()
	app.addContentTypeParser(
		"application/receiver-test",
		{ parseAs: "string" },
		(_request, body, done) => {
			parser(body)
			done(null, {})
		},
	)
	if (options.poison)
		app.setSerializerCompiler(() => () => '{"private":"inherited poison"}')
	if (options.parentFault) {
		const inspected = server as unknown as { registerRoutes(): Promise<void> }
		const register = inspected.registerRoutes.bind(server)
		vi.spyOn(inspected, "registerRoutes").mockImplementation(async () => {
			// Actual startup has installed root correlation logging at this point;
			// insert the parent fault BEFORE delegating actual Main route mounting.
			app.addHook("onRequest", async request => {
				if (
					request.raw.url?.startsWith(path) ||
					request.raw.url === "/__receiver-parent-control"
				)
					throw new WaveKitError(
						"Parent fixture failure",
						"PARENT_FIXTURE_FAILURE",
					)
			})
			app.get("/__receiver-parent-control", async () => ({ unreachable: true }))
			await register()
		})
	}
	await server.start()
	const headers: Record<string, string> = legacy
		? { host }
		: { host, authorization: `Bearer ${token ?? ""}` }
	async function register(id: string) {
		await sourceManager.connect({
			id,
			type: "rtl_tcp",
			host: "test.invalid",
			port: 1234,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 1000000,
				exclusive: false,
			},
		})
	}
	async function pair() {
		const issued = await app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers,
		})
		expect(issued.statusCode).toBe(201)
		const paired = await app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: { host, origin },
			payload: { code: issued.json<{ code: string }>().code },
		})
		expect(paired.statusCode).toBe(201)
		const cookie = paired.headers["set-cookie"]
		if (typeof cookie !== "string") throw new TypeError("missing test session")
		return {
			host,
			origin,
			cookie: cookie.split(";")[0] ?? "",
			"x-wavekit-csrf": paired.json<{ csrfToken: string }>().csrfToken,
		}
	}
	return {
		app,
		server,
		context,
		sourceManager,
		read,
		readPage,
		pure,
		injected,
		attempt,
		headers,
		register,
		pair,
		parser,
	}
}
function clearReads(env: Awaited<ReturnType<typeof setup>>) {
	env.read.mockClear()
	env.readPage.mockClear()
}
function zeroReads(env: Awaited<ReturnType<typeof setup>>) {
	expect(env.read).not.toHaveBeenCalled()
	expect(env.readPage).not.toHaveBeenCalled()
}

/** Raw bytes, not a HEAD-aware client or injector attempted-write collector. */
function wireHead(
	env: Awaited<ReturnType<typeof setup>>,
	target: string,
	headers: Record<string, string>,
	body = "",
) {
	const address = env.app.server.address()
	if (!address || typeof address === "string")
		throw new TypeError("missing test listener")
	return new Promise<{
		status: number
		headers: Record<string, string>
		body: Buffer
	}>((resolve, reject) => {
		const socket = new Socket()
		const chunks: Buffer[] = []
		let bytes = 0
		let settled = false
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			socket.destroy()
			reject(error)
		}
		socket.setTimeout(2000)
		socket.on("error", fail)
		socket.on("timeout", () => fail(new TypeError("test wire timeout")))
		socket.on("data", chunk => {
			bytes += chunk.length
			if (bytes > 512 * 1024) return fail(new TypeError("test wire bound"))
			chunks.push(Buffer.from(chunk))
		})
		socket.on("end", () => {
			if (settled) return
			const all = Buffer.concat(chunks)
			const split = all.indexOf("\r\n\r\n")
			if (split < 0) return fail(new TypeError("missing test response headers"))
			const lines = all.subarray(0, split).toString("latin1").split("\r\n")
			const status = Number(lines[0]?.split(" ")[1])
			if (!Number.isInteger(status))
				return fail(new TypeError("invalid test status"))
			const responseHeaders: Record<string, string> = {}
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(":")
				if (colon > 0)
					responseHeaders[line.slice(0, colon).toLowerCase()] = line
						.slice(colon + 1)
						.trim()
			}
			settled = true
			socket.destroy()
			resolve({
				status,
				headers: responseHeaders,
				body: all.subarray(split + 4),
			})
		})
		socket.on("close", () => {
			if (!settled)
				fail(new TypeError("test wire closed before complete response"))
		})
		socket.connect(address.port, "127.0.0.1", () => {
			const requestHeaders = { ...headers, connection: "close" }
			socket.write(
				`HEAD ${target} HTTP/1.1\r\n${Object.entries(requestHeaders)
					.map(([key, value]) => `${key}: ${value}\r\n`)
					.join("")}\r\n${body}`,
			)
		})
	})
}

const captureTime = Date.UTC(2026, 0, 1)
const token = (n: number) => n.toString(16).padStart(32, "0")
type EvidenceMode =
	| "disconnected"
	| "connecting"
	| "connected"
	| "aged-waiting"
	| "paused"
	| "stale"
	| "non-rtl"
	| "recording"
	| "recording-ended"
	| "non-u8"
	| "audio"
function legalEvidence(
	id: string,
	mode: EvidenceMode = "disconnected",
): SourceReceiverEvidence {
	const connected =
		mode !== "disconnected" &&
		mode !== "connecting" &&
		mode !== "recording-ended"
	const recording = mode === "recording" || mode === "recording-ended"
	const age = mode === "aged-waiting" ? 10000 : mode === "stale" ? 10001 : 1
	const bytes = Buffer.alloc(12)
	bytes.set([0x52, 0x54, 0x4c, 0x30])
	const type = recording
		? "recording"
		: mode === "non-rtl"
			? "sdrpp-network"
			: "rtl_tcp"
	const format =
		mode === "non-rtl" || mode === "non-u8"
			? "S16_IQ"
			: mode === "audio"
				? "S16LE"
				: "U8_IQ"
	return {
		sourceId: id,
		sourceStateToken: {},
		sourceIncarnation: token(id === "b" ? 4 : 1),
		sessionId:
			recording || mode === "disconnected" ? null : token(id === "b" ? 5 : 2),
		snapshotId: token(3),
		capturedAt: captureTime,
		source: { type, kind: mode === "audio" ? "audio_pcm" : "iq", format },
		caps: { sampleRate: 1000000, centerFreq: null },
		connection:
			mode === "recording-ended"
				? "ended"
				: mode === "connecting"
					? "connecting"
					: connected
						? "connected"
						: "disconnected",
		delivery: {
			state:
				mode === "recording-ended"
					? "ended"
					: mode === "disconnected"
						? "disconnected"
						: mode === "connecting" || mode === "aged-waiting"
							? "waiting"
							: mode === "paused"
								? "paused"
								: mode === "stale"
									? "stale"
									: "streaming",
			lastSampleAt: connected ? captureTime - age : null,
			sampleAgeMs: connected ? age : null,
			timeoutMs: 10000,
		},
		header:
			type !== "rtl_tcp" || format !== "U8_IQ"
				? { capture: "not-applicable", bytes: null, capturedAt: null }
				: connected
					? { capture: "complete", bytes, capturedAt: captureTime - age - 1 }
					: { capture: "missing", bytes: null, capturedAt: null },
	}
}
function legalDto(
	id = "a",
	mode: EvidenceMode = "disconnected",
): ReceiverCapabilities {
	const raw = legalEvidence(id, mode)
	const pure = createReceiverCapabilitiesProvider(
		{
			read: () => ({ kind: "present", evidence: raw }),
			readPage: () => ({ kind: "unavailable" }),
		},
		TUNER_REST_COMMAND_POLICY,
	)
	const result = pure.get(id)
	if (!result.ok) throw new TypeError("invalid legal DTO fixture")
	return result.value
}
const itemMutations: readonly {
	name: string
	mode: EvidenceMode
	change: (dto: ReceiverCapabilities) => ReceiverCapabilities
}[] = [
	{
		name: "colliding tokens",
		mode: "disconnected",
		change: d => ({ ...d, snapshotId: d.sourceIncarnation }),
	},
	{
		name: "network null session",
		mode: "connected",
		change: d => ({ ...d, sessionId: null }),
	},
	{
		name: "recording nonnull session",
		mode: "recording",
		change: d => ({ ...d, sessionId: token(9) }),
	},
	{
		name: "recording connecting",
		mode: "recording",
		change: d => ({ ...d, connection: "connecting" }),
	},
	{
		name: "network ended",
		mode: "disconnected",
		change: d => ({
			...d,
			connection: "ended",
			delivery: { ...d.delivery, state: "ended" },
		}),
	},
	{
		name: "network recording kind",
		mode: "disconnected",
		change: d => ({ ...d, source: { ...d.source, kind: "recording" } }),
	},
	{
		name: "IQ audio format",
		mode: "disconnected",
		change: d => ({ ...d, source: { ...d.source, format: "S16LE" } }),
	},
	{
		name: "sample age null pairing",
		mode: "connected",
		change: d => ({ ...d, delivery: { ...d.delivery, sampleAgeMs: null } }),
	},
	{
		name: "sample time null pairing",
		mode: "connected",
		change: d => ({ ...d, delivery: { ...d.delivery, lastSampleAt: null } }),
	},
	{
		name: "future sample",
		mode: "connected",
		change: d => ({
			...d,
			delivery: {
				...d.delivery,
				lastSampleAt: new Date(captureTime + 1).toISOString(),
				sampleAgeMs: 0,
			},
		}),
	},
	{
		name: "age arithmetic",
		mode: "connected",
		change: d => ({ ...d, delivery: { ...d.delivery, sampleAgeMs: 2 } }),
	},
	{
		name: "disconnected delivery",
		mode: "disconnected",
		change: d => ({ ...d, delivery: { ...d.delivery, state: "waiting" } }),
	},
	{
		name: "ended delivery",
		mode: "recording-ended",
		change: d => ({ ...d, delivery: { ...d.delivery, state: "waiting" } }),
	},
	{
		name: "connecting samples",
		mode: "connecting",
		change: d => ({
			...d,
			delivery: {
				...d.delivery,
				lastSampleAt: new Date(captureTime - 10000).toISOString(),
				sampleAgeMs: 10000,
			},
		}),
	},
	{
		name: "aged streaming",
		mode: "aged-waiting",
		change: d => ({ ...d, delivery: { ...d.delivery, state: "streaming" } }),
	},
	{
		name: "fresh waiting",
		mode: "connected",
		change: d => ({ ...d, delivery: { ...d.delivery, state: "waiting" } }),
	},
	{
		name: "fresh stale",
		mode: "connected",
		change: d => ({ ...d, delivery: { ...d.delivery, state: "stale" } }),
	},
	{
		name: "header wrong session",
		mode: "connected",
		change: d => ({
			...d,
			peerHeader: {
				state: "advertised",
				provenance: "rtl-peer-header",
				sessionId: token(9),
				observedAt: new Date(captureTime - 2).toISOString(),
				tunerType: 0,
				gainCount: 0,
			},
		}),
	},
	{
		name: "header future observation",
		mode: "connected",
		change: d => ({
			...d,
			peerHeader: {
				state: "advertised",
				provenance: "rtl-peer-header",
				sessionId: d.sessionId ?? token(2),
				observedAt: new Date(captureTime + 1).toISOString(),
				tunerType: 0,
				gainCount: 0,
			},
		}),
	},
	{
		name: "connected reason contradiction",
		mode: "connected",
		change: d => ({
			...d,
			peerHeader: { state: "unknown", reason: "not-connected" },
		}),
	},
	{
		name: "disconnected reason contradiction",
		mode: "disconnected",
		change: d => ({
			...d,
			peerHeader: { state: "unknown", reason: "format-not-captured" },
		}),
	},
	{
		name: "nonRTL header contradiction",
		mode: "non-rtl",
		change: d => ({
			...d,
			peerHeader: { state: "unknown", reason: "awaiting-header" },
		}),
	},
	{
		name: "duplicate controls",
		mode: "disconnected",
		change: d => {
			const first = d.controls[0]
			if (!first) throw new TypeError("missing legal fixture control")
			return {
				...d,
				controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
					() => first,
				),
			}
		},
	},
	{
		name: "reordered controls",
		mode: "disconnected",
		change: d => ({ ...d, controls: [...d.controls].reverse() }),
	},
	{
		name: "control ID",
		mode: "disconnected",
		change: d => ({
			...d,
			controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
				(r, i) => (i === 0 ? { ...r, id: "sampleRate" } : r),
			),
		}),
	},
	{
		name: "control unit",
		mode: "disconnected",
		change: d => ({
			...d,
			controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
				(r, i) => (i === 0 ? { ...r, unit: "index" } : r),
			),
		}),
	},
	{
		name: "control opcode",
		mode: "disconnected",
		change: d => ({
			...d,
			controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
				(r, i) =>
					i === 0 ? { ...r, command: { ...r.command, opcode: 2 } } : r,
			),
		}),
	},
	{
		name: "control rule",
		mode: "disconnected",
		change: d => ({
			...d,
			controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
				(r, i) =>
					i === 0 && r.command.validation.rule.kind === "integer-range"
						? {
								...r,
								command: {
									...r.command,
									validation: {
										...r.command.validation,
										rule: {
											...r.command.validation.rule,
											min: r.command.validation.rule.min + 1,
										},
									},
								},
							}
						: r,
			),
		}),
	},
	{
		name: "control transport",
		mode: "disconnected",
		change: d => ({
			...d,
			controls: d.controls.map<ReceiverCapabilities["controls"][number]>(
				(r, i) =>
					i === 0
						? {
								...r,
								transport: {
									state: "not-applicable",
									reason: "non-rtl-transport",
								},
							}
						: r,
			),
		}),
	},
]

describe.each([true, false])(
	"real ApiServer receiver mounting legacy=%s",
	legacy => {
		it.each(itemMutations)(
			"rejects one shape-valid item correlation: $name",
			async entry => {
				const original = legalDto("a", entry.mode)
				expect(receiverCapabilitiesSchema.safeParse(original).success).toBe(
					true,
				)
				const changed = entry.change(original)
				expect(receiverCapabilitiesSchema.safeParse(changed).success).toBe(true)
				const get = vi.fn(() => ({ ok: true as const, value: changed }))
				const list = vi.fn(() => ({
					ok: true as const,
					value: {
						schemaVersion: 1 as const,
						items: [changed],
						nextAfter: null,
					},
				}))
				const env = await setup(legacy, {
					provider: { get, list, dispose: () => {} },
				})
				const single = await env.app.inject({
					url: path + "/a",
					headers: env.headers,
				})
				expect(single.statusCode).toBe(503)
				expect(single.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_CONFLICT",
				)
				expect(get).toHaveBeenCalledTimes(1)
				expect(list).not.toHaveBeenCalled()
				const page = await env.app.inject({
					url: path + "?limit=1",
					headers: env.headers,
				})
				expect(page.statusCode).toBe(503)
				expect(page.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_CONFLICT",
				)
				expect(list).toHaveBeenCalledTimes(1)
				expect(get).toHaveBeenCalledTimes(1)
				zeroReads(env)
			},
		)

		it.each([
			"different snapshot",
			"different capture",
			"short continuing page",
		] as const)(
			"rejects one shape-valid page correlation: %s",
			async mutation => {
				const a = legalDto("a")
				const b = legalDto("b")
				const changed =
					mutation === "different snapshot"
						? { ...b, snapshotId: token(7) }
						: { ...b, capturedAt: new Date(captureTime + 1).toISOString() }
				const value: ReceiverCapabilitiesPage =
					mutation === "short continuing page"
						? { schemaVersion: 1, items: [a], nextAfter: "a" }
						: { schemaVersion: 1, items: [a, changed], nextAfter: null }
				expect(receiverCapabilitiesPageSchema.safeParse(value).success).toBe(
					true,
				)
				const get = vi.fn(() => ({
					ok: false as const,
					code: "NOT_FOUND" as const,
				}))
				const list = vi.fn(() => ({ ok: true as const, value }))
				const env = await setup(legacy, {
					provider: { get, list, dispose: () => {} },
				})
				const reply = await env.app.inject({
					url:
						path +
						(mutation === "short continuing page" ? "?limit=8" : "?limit=2"),
					headers: env.headers,
				})
				expect(reply.statusCode).toBe(503)
				expect(reply.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_CONFLICT",
				)
				expect(list).toHaveBeenCalledTimes(1)
				expect(get).not.toHaveBeenCalled()
				zeroReads(env)
			},
		)

		it("retains legal item states, aged waiting, page endings and full16 real-descriptor pages", async () => {
			let current = legalDto()
			const get = vi.fn(() => ({ ok: true as const, value: current }))
			const env = await setup(legacy, {
				provider: {
					get,
					list: () => ({ ok: false, code: "UNAVAILABLE" }),
					dispose: () => {},
				},
			})
			for (const mode of [
				"disconnected",
				"connecting",
				"connected",
				"aged-waiting",
				"paused",
				"stale",
				"non-rtl",
				"recording",
				"recording-ended",
				"non-u8",
				"audio",
			] as const) {
				current = legalDto("a", mode)
				get.mockClear()
				const reply = await env.app.inject({
					url: path + "/a",
					headers: env.headers,
				})
				expect(reply.statusCode).toBe(200)
				expect(reply.json()).toEqual(current)
				if (mode === "aged-waiting")
					expect(reply.json<ReceiverCapabilities>().delivery).toMatchObject({
						state: "waiting",
						sampleAgeMs: 10000,
						lastSampleAt: new Date(captureTime - 10000).toISOString(),
					})
				expect(get).toHaveBeenCalledTimes(1)
			}
			zeroReads(env)
			let sources: SourceReceiverEvidence[] = []
			const read = vi.fn(() => ({ kind: "missing" as const }))
			const readPage = vi.fn((_after: string | null, limit: number) => ({
				kind: "candidates" as const,
				candidates: sources.slice(0, limit + 1),
				capturedAt: captureTime,
				snapshotId: sources.length ? token(3) : null,
			}))
			const pure = createReceiverCapabilitiesProvider(
				{ read, readPage },
				TUNER_REST_COMMAND_POLICY,
			)
			const delegatedList = vi.fn(pure.list)
			const pages = await setup(legacy, {
				provider: { get: pure.get, list: delegatedList, dispose: pure.dispose },
			})
			for (const count of [0, 1, 2, 16]) {
				sources = Array.from({ length: count }, (_, i) =>
					legalEvidence(`a${String(i).padStart(2, "0")}`),
				)
				const limit = count === 2 ? 1 : count === 16 ? 16 : 1
				readPage.mockClear()
				delegatedList.mockClear()
				const reply = await pages.app.inject({
					url: `${path}?limit=${limit}`,
					headers: pages.headers,
				})
				expect(reply.statusCode).toBe(200)
				const dto = reply.json<ReceiverCapabilitiesPage>()
				expect(dto.items).toHaveLength(Math.min(count, limit))
				expect(dto.nextAfter).toBe(count > limit ? "a00" : null)
				for (const item of dto.items)
					expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(
						16 * 1024,
					)
				expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(256 * 1024)
				expect(delegatedList).toHaveBeenCalledTimes(1)
				expect(readPage).toHaveBeenCalledTimes(1)
				expect(read).not.toHaveBeenCalled()
			}
			zeroReads(pages)
		})

		it.each([false, true])(
			"preserves complete pre-feature parent envelopes with poison=%s",
			async poison => {
				const env = await setup(legacy, { poison, parentFault: true })
				const get = vi.spyOn(env.pure, "get")
				const list = vi.spyOn(env.pure, "list")
				const control = await env.app.inject({
					url: "/__receiver-parent-control",
					headers: env.headers,
				})
				const expected = control.json<Record<string, unknown>>()
				expect(typeof expected["correlationId"]).toBe("string")
				expect(control.headers["x-correlation-id"]).toBe(
					expected["correlationId"],
				)
				expect(Object.keys(expected).sort()).toEqual([
					"code",
					"correlationId",
					"error",
					"message",
				])
				for (const url of [path, path + "/id"]) {
					const reply = await env.app.inject({ url, headers: env.headers })
					const actual = reply.json<Record<string, unknown>>()
					expect(reply.statusCode).toBe(control.statusCode)
					expect(typeof actual["correlationId"]).toBe("string")
					expect(reply.headers["x-correlation-id"]).toBe(
						actual["correlationId"],
					)
					const { correlationId: _actualId, ...actualFields } = actual
					const { correlationId: _expectedId, ...expectedFields } = expected
					expect(actualFields).toEqual(expectedFields)
					expect(Object.keys(actual).sort()).toEqual(
						Object.keys(expected).sort(),
					)
					for (const key of [
						"cache-control",
						"vary",
						"access-control-allow-origin",
						"access-control-allow-credentials",
						"allow",
						"content-type",
					])
						expect(reply.headers[key]).toEqual(control.headers[key])
					const normalized = (headers: Record<string, unknown>) =>
						Object.fromEntries(
							Object.entries(headers).filter(
								([key]) =>
									!["date", "content-length", "x-correlation-id"].includes(key),
							),
						)
					expect(normalized(reply.headers)).toEqual(normalized(control.headers))
					if (reply.headers["content-length"] !== undefined)
						expect(Number(reply.headers["content-length"])).toBe(
							Buffer.byteLength(reply.body),
						)
					expect(reply.body).not.toContain("poison")
				}
				expect(get).not.toHaveBeenCalled()
				expect(list).not.toHaveBeenCalled()
				zeroReads(env)
			},
		)

		it("proves HEAD bodylessness using raw wire bytes, both patterns and root boundaries", async () => {
			const env = await setup(legacy)
			const overflow = encodeURIComponent("\u0800".repeat(84) + "abcde")
			const get = vi.spyOn(env.pure, "get")
			const list = vi.spyOn(env.pure, "list")
			const targets = [
				path + "?bad=invalid",
				path + "/id?bad=invalid",
				path + "/" + overflow + "?bad=invalid",
			]
			for (const target of targets) {
				for (const framing of [
					{ headers: env.headers, body: "" },
					{
						headers: {
							...env.headers,
							"content-length": "1",
							"content-type": "application/receiver-test",
						},
						body: "x",
					},
					{
						headers: {
							...env.headers,
							"transfer-encoding": "chunked",
							"content-type": "application/receiver-test",
						},
						body: "0\r\n\r\n",
					},
				]) {
					const reply = await wireHead(
						env,
						target,
						framing.headers,
						framing.body,
					)
					expect(reply.status).toBe(405)
					expect(reply.headers["allow"]).toBe("GET")
					expect(reply.headers["cache-control"]).toBe("no-store")
					expect(reply.body.length).toBe(0)
				}
			}
			for (const target of [path + "/" + "a".repeat(101), path + "/id/extra"]) {
				const reply = await wireHead(env, target, env.headers)
				expect(reply.status).toBe(404)
				expect(reply.headers["allow"]).toBeUndefined()
				expect(reply.body.length).toBe(0)
			}
			if (!legacy) {
				for (const target of [path, path + "/id"]) {
					const reply = await wireHead(env, target, { host })
					expect(reply.status).toBe(401)
					expect(reply.headers["cache-control"]).toBe("no-store")
					expect(reply.headers["allow"]).toBeUndefined()
					expect(reply.body.length).toBe(0)
				}
			}
			zeroReads(env)
			expect(get).not.toHaveBeenCalled()
			expect(list).not.toHaveBeenCalled()
			expect(env.parser).not.toHaveBeenCalled()
		})

		it("mounts normal get/list/empty/missing with real SourceManager and no control/acquisition calls", async () => {
			const env = await setup(legacy)
			const empty = await env.app.inject({ url: path, headers: env.headers })
			expect(empty.statusCode).toBe(200)
			expect(empty.json()).toEqual({
				schemaVersion: 1,
				items: [],
				nextAfter: null,
			})
			await env.register("source+one")
			clearReads(env)
			const reply = await env.app.inject({
				url: path + "/source%2Bone",
				headers: env.headers,
			})
			expect(reply.statusCode).toBe(200)
			const dto = reply.json<ReceiverCapabilities>()
			expect(dto.sourceId).toBe("source+one")
			expect(dto.connection).toBe("disconnected")
			expect(dto.peerHeader).toEqual({
				state: "unknown",
				reason: "not-connected",
			})
			expect(
				dto.controls.every(
					row =>
						row.physical.state === "unknown" &&
						row.currentValue.state === "unknown",
				),
			).toBe(true)
			expect(reply.headers["cache-control"]).toBe("no-store")
			expect(env.read).toHaveBeenCalledTimes(1)
			expect(env.readPage).not.toHaveBeenCalled()
			const missing = await env.app.inject({
				url: path + "/missing",
				headers: env.headers,
			})
			expect(missing.statusCode).toBe(404)
			expect(missing.json()).toEqual({
				error: "ReceiverCapabilitiesError",
				code: "RECEIVER_CAPABILITIES_NOT_FOUND",
				message: "Receiver source not found",
			})
			expect(env.attempt).toHaveBeenCalledTimes(1) // only explicit registration, never GET
		})

		it("preserves dependency absence/null/disposal and borrowed provider lifetime", async () => {
			for (const provider of [null, undefined]) {
				const env = await setup(legacy, { provider })
				const reply = await env.app.inject({ url: path, headers: env.headers })
				expect(reply.statusCode).toBe(503)
				expect(reply.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_UNAVAILABLE",
				)
				zeroReads(env)
			}
			const env = await setup(legacy)
			const dispose = vi.spyOn(env.pure, "dispose")
			await env.server.stop()
			expect(dispose).not.toHaveBeenCalled()
			const disposed = await setup(legacy)
			disposed.pure.dispose()
			clearReads(disposed)
			expect(
				(await disposed.app.inject({ url: path, headers: disposed.headers }))
					.statusCode,
			).toBe(503)
			zeroReads(disposed)
		})

		it.each([
			{ id: "a".repeat(100), valid: true, matches: true },
			{ id: "a".repeat(101), valid: false, matches: false },
			{ id: "é".repeat(100), valid: true, matches: true },
			{ id: "é".repeat(128), valid: false, matches: false },
			{ id: "\u0800".repeat(85), valid: true, matches: true },
			{ id: "\u0800".repeat(86), valid: false, matches: true },
			{ id: "😀".repeat(50), valid: true, matches: true },
			{ id: "😀".repeat(51), valid: false, matches: false },
			{ id: "\u0800".repeat(84) + "abcd", valid: true, matches: true },
			{ id: "\u0800".repeat(84) + "abcde", valid: false, matches: true },
			{ id: "\ufeffexact+id", valid: true, matches: true },
			{ id: "%2F", valid: true, matches: true },
		])("boundary ID valid=$valid matched=$matches $id", async entry => {
			const env = await setup(legacy)
			await env.register(entry.id)
			// Highest Unicode scalar is legal, distinct and UTF8-later than EVERY
			// enumerated first scalar, without appending to a max-sized ID.
			const later = "\u{10ffff}"
			if (entry.valid) {
				expect(isReceiverSourceId(later)).toBe(true)
				expect(
					Buffer.compare(
						Buffer.from(entry.id, "utf8"),
						Buffer.from(later, "utf8"),
					),
				).toBeLessThan(0)
				await env.register(later)
			}
			clearReads(env)
			const listed = await env.app.inject({
				url: path + "?limit=1",
				headers: env.headers,
			})
			expect(listed.statusCode).toBe(entry.valid ? 200 : 503)
			let returnedCursor: string | null = null
			if (entry.valid) {
				const page = listed.json<ReceiverCapabilitiesPage>()
				expect(page.items.map(item => item.sourceId)).toEqual([entry.id])
				expect(page.nextAfter).toBe(entry.id)
				returnedCursor = page.nextAfter
			} else
				expect(listed.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_LIMIT",
				)
			expect(env.readPage).toHaveBeenCalledTimes(1)
			expect(env.read).not.toHaveBeenCalled()
			const encoded = encodeURIComponent(entry.id)
			const targets = /^[a]+$/.test(entry.id)
				? [entry.id, entry.id.replace(/a/g, "%61")]
				: [encoded]
			for (const target of targets) {
				clearReads(env)
				const fetched = await env.app.inject({
					url: path + "/" + target,
					headers: env.headers,
				})
				expect(fetched.statusCode).toBe(
					entry.valid ? 200 : entry.matches ? 400 : 404,
				)
				if (entry.valid) {
					expect(fetched.json<ReceiverCapabilities>().sourceId).toBe(entry.id)
					expect(env.read).toHaveBeenCalledTimes(1)
					expect(env.readPage).not.toHaveBeenCalled()
				} else zeroReads(env)
				for (const method of [
					"HEAD",
					"POST",
					"PUT",
					"PATCH",
					"DELETE",
				] as const) {
					clearReads(env)
					const denied = await env.app.inject({
						method,
						url: path + "/" + target + "?limit=bad",
						headers: env.headers,
					})
					expect(denied.statusCode).toBe(entry.matches ? 405 : 404)
					// Attempted-write injection collector is not raw HEAD wire evidence.
					if (entry.matches) expect(denied.headers["allow"]).toBe("GET")
					else if (method !== "HEAD")
						expect(denied.body).not.toContain("RECEIVER_CAPABILITIES_")
					zeroReads(env)
				}
			}
			clearReads(env)
			if (entry.valid) {
				if (returnedCursor === null)
					throw new TypeError("missing returned boundary cursor")
				const cursor = await env.app.inject({
					url: path + "?limit=1&after=" + encodeURIComponent(returnedCursor),
					headers: env.headers,
				})
				expect(cursor.statusCode).toBe(200)
				expect(
					cursor
						.json<ReceiverCapabilitiesPage>()
						.items.map(item => item.sourceId),
				).toEqual([later])
				expect(cursor.json<ReceiverCapabilitiesPage>().nextAfter).toBeNull()
				expect(env.readPage).toHaveBeenCalledTimes(1)
				expect(env.read).not.toHaveBeenCalled()
				await env.sourceManager.disconnect(later)
			} else {
				const cursor = await env.app.inject({
					url: path + "?after=" + encoded,
					headers: env.headers,
				})
				expect(cursor.statusCode).toBe(400)
				zeroReads(env)
			}
			await env.sourceManager.disconnect(entry.id)
		})

		it("uses returned pagination cursors and refuses invalid existing sources before cursor/in lookahead", async () => {
			const env = await setup(legacy)
			await env.register("a")
			await env.register("b")
			const first = await env.app.inject({
				url: path + "?limit=1",
				headers: env.headers,
			})
			expect(first.json<ReceiverCapabilitiesPage>().nextAfter).toBe("a")
			const second = await env.app.inject({
				url:
					path +
					"?limit=1&after=" +
					encodeURIComponent(
						first.json<ReceiverCapabilitiesPage>().nextAfter ?? "",
					),
				headers: env.headers,
			})
			expect(
				second
					.json<ReceiverCapabilitiesPage>()
					.items.map(item => item.sourceId),
			).toEqual(["b"])
			expect(second.json<ReceiverCapabilitiesPage>().nextAfter).toBeNull()
			for (const invalid of ["0".repeat(101), "z".repeat(101)]) {
				await env.register(invalid)
				clearReads(env)
				const reply = await env.app.inject({
					url: path + "?limit=1&after=a",
					headers: env.headers,
				})
				expect(reply.statusCode).toBe(503)
				expect(reply.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_LIMIT",
				)
				expect(env.readPage).toHaveBeenCalledTimes(1)
				expect(env.read).not.toHaveBeenCalled()
				await env.sourceManager.disconnect(invalid)
			}
		})

		it("keeps matched method/framing/input precedence, OPTIONS and unknown paths", async () => {
			const env = await setup(legacy)
			for (const method of [
				"HEAD",
				"POST",
				"PUT",
				"PATCH",
				"DELETE",
			] as const) {
				for (const url of [path + "?after=%FF", path + "/bad%2Fid?bad=1"]) {
					const reply = await env.app.inject({
						method,
						url,
						headers: { ...env.headers, "content-type": "application/json" },
						payload: "not-json",
					})
					expect(reply.statusCode).toBe(405)
					expect(reply.headers["cache-control"]).toBe("no-store")
					// HEAD bytes are asserted by raw-wire cases, not injection collector.
				}
			}
			zeroReads(env)
			for (const request of [
				{ payload: "body" },
				{ headers: { ...env.headers, "transfer-encoding": "chunked" } },
			]) {
				const reply = await env.app.inject({
					method: "GET",
					url: path,
					headers: env.headers,
					...request,
				})
				expect(reply.statusCode).toBe(400)
			}
			zeroReads(env)
			expect(
				(
					await env.app.inject({
						url: path,
						headers: { ...env.headers, "content-length": "0" },
					})
				).statusCode,
			).toBe(200)
			clearReads(env)
			for (const method of ["GET", "HEAD", "POST"] as const)
				expect(
					(
						await env.app.inject({
							method,
							url: path + "/a/extra",
							headers: env.headers,
						})
					).statusCode,
				).toBe(404)
			const options = await env.app.inject({
				method: "OPTIONS",
				url: path,
				headers: { host, origin, "access-control-request-method": "GET" },
			})
			expect(options.statusCode).toBe(204)
			zeroReads(env)
		})

		it("preserves local exact bytes under poisoned parent serializer", async () => {
			const env = await setup(legacy, { poison: true })
			await env.register("id")
			const reply = await env.app.inject({
				url: path + "/id",
				headers: env.headers,
			})
			expect(reply.statusCode).toBe(200)
			expect(reply.json<ReceiverCapabilities>().sourceId).toBe("id")
			expect(reply.body).not.toContain("poison")
			const invalid = await env.app.inject({
				url: path + "?limit=0",
				headers: env.headers,
			})
			expect(invalid.statusCode).toBe(400)
			expect(invalid.json<{ code: string }>().code).toBe(
				"RECEIVER_CAPABILITIES_INVALID_REQUEST",
			)
			expect(Buffer.byteLength(invalid.body)).toBeLessThanOrEqual(256)
		})

		it("maps provider failures and faulty output through the actual server mount", async () => {
			for (const code of [
				"UNAVAILABLE",
				"FAILED",
				"CONFLICT",
				"LIMIT",
			] as const) {
				const get = vi.fn(() => ({ ok: false as const, code }))
				const list = vi.fn(() => ({ ok: false as const, code }))
				const env = await setup(legacy, {
					provider: { get, list, dispose: () => {} },
				})
				for (const url of [path, path + "/source"]) {
					const reply = await env.app.inject({ url, headers: env.headers })
					expect(reply.statusCode).toBe(503)
					expect(reply.json<{ code: string }>().code).toBe(
						`RECEIVER_CAPABILITIES_${code}`,
					)
					expect(reply.headers["cache-control"]).toBe("no-store")
					expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(256)
				}
				expect(get).toHaveBeenCalledTimes(1)
				expect(list).toHaveBeenCalledTimes(1)
				zeroReads(env)
			}
			const throwProvider: ReceiverCapabilitiesProvider = {
				get: () => {
					throw new TypeError("private provider detail")
				},
				list: () => {
					throw new TypeError("private provider detail")
				},
				dispose: () => {},
			}
			const throwing = await setup(legacy, { provider: throwProvider })
			const failure = await throwing.app.inject({
				url: path,
				headers: throwing.headers,
			})
			expect(failure.statusCode).toBe(503)
			expect(failure.json<{ code: string }>().code).toBe(
				"RECEIVER_CAPABILITIES_FAILED",
			)
			expect(failure.body).not.toContain("private provider detail")
			const faulty = {
				get: () => ({ ok: true, value: { physical: "supported" } }),
				list: () => ({
					ok: true,
					value: {
						schemaVersion: 1,
						items: [],
						nextAfter: null,
						extra: "private",
					},
				}),
				dispose: () => {},
			} as unknown as ReceiverCapabilitiesProvider
			const invalid = await setup(legacy, { provider: faulty })
			for (const url of [path, path + "/source"]) {
				const reply = await invalid.app.inject({
					url,
					headers: invalid.headers,
				})
				expect(reply.statusCode).toBe(503)
				expect(reply.json<{ code: string }>().code).toBe(
					"RECEIVER_CAPABILITIES_CONFLICT",
				)
			}
		})

		it("separates pre-routing decode failures from feature query errors with zero reads", async () => {
			const env = await setup(legacy)
			for (const raw of ["%ZZ", "%ED%A0%80", "%C0%AF", "%F4%90%80%80"]) {
				const reply = await env.app.inject({
					url: path + "/" + raw,
					headers: env.headers,
				})
				expect(reply.statusCode).toBe(400)
				expect(reply.body).not.toContain("RECEIVER_CAPABILITIES_")
			}
			const matched = await env.app.inject({
				url: path + "?after=%FF",
				headers: env.headers,
			})
			expect(matched.statusCode).toBe(400)
			expect(matched.json<{ code: string }>().code).toBe(
				"RECEIVER_CAPABILITIES_INVALID_REQUEST",
			)
			zeroReads(env)
			// Node malformed framing, artificial unframed streams and late aborts are
			// excluded transport cases, not feature JSON/header/read-rollback promises.
		})
	},
)

describe("real protected ApiServer root admission before receiver feature", () => {
	// Feature: receiver-capabilities, Property 6: Admission/error precedence
	// Validates: Requirements 3.1, 3.3, 3.8
	it("denies malformed queries before reads and preserves root code-only serializers", async () => {
		const env = await setup(false, { poison: true })
		for (const headers of [
			{ host },
			{ host, authorization: "Bearer invalid" },
			{ ...env.headers, host: "foreign.invalid" },
			{ ...env.headers, origin: "http://evil.invalid" },
		]) {
			const reply = await env.app.inject({ url: path + "?limit=bad", headers })
			expect([400, 401, 403]).toContain(reply.statusCode)
			expect(Object.keys(reply.json<object>())).toEqual(["code"])
			expect(reply.body).not.toContain("poison")
		}
		zeroReads(env)
		const session = await env.pair()
		expect(
			(await env.app.inject({ url: path, headers: session })).statusCode,
		).toBe(200)
		clearReads(env)
		const { "x-wavekit-csrf": _csrf, ...withoutCsrf } = session
		const denied = await env.app.inject({
			method: "POST",
			url: path + "?limit=bad",
			headers: withoutCsrf,
		})
		expect(denied.statusCode).toBe(403)
		expect(Object.keys(denied.json<object>())).toEqual(["code"])
		zeroReads(env)
		const admitted = await env.app.inject({
			method: "POST",
			url: path + "?limit=bad",
			headers: session,
		})
		expect(admitted.statusCode).toBe(405)
		zeroReads(env)
	})

	it("does not make absent providers public and preserves shutdown unavailable precedence", async () => {
		const env = await setup(false, { provider: null })
		const unauthenticated = await env.app.inject({
			url: path,
			headers: { host },
		})
		expect(unauthenticated.statusCode).toBe(401)
		expect(unauthenticated.json()).toEqual({ code: "AUTH_REQUIRED" })
		const admitted = await env.app.inject({ url: path, headers: env.headers })
		expect(admitted.statusCode).toBe(503)
		expect(admitted.json<{ code: string }>().code).toBe(
			"RECEIVER_CAPABILITIES_UNAVAILABLE",
		)
		env.server.stopAdmission()
		const shutdown = await env.app.inject({
			url: path + "?limit=bad",
			headers: env.headers,
		})
		expect(shutdown.statusCode).toBe(503)
		expect(shutdown.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
		zeroReads(env)
	})

	it("uses the real SessionStore persistence failure latch before receiver input/provider work", async () => {
		const env = await setup(false)
		const session = await env.pair()
		if (!env.context) throw new TypeError("missing protected test context")
		const rename = vi
			.spyOn(fs, "rename")
			.mockRejectedValueOnce(new TypeError("test-owned persistence fault"))
		await expect(env.context.api.sessions.create()).rejects.toThrow()
		rename.mockRestore()
		expect(env.context.api.sessions.unavailable).toBe(true)
		clearReads(env)
		const denied = await env.app.inject({
			url: path + "?limit=bad",
			headers: session,
		})
		expect(denied.statusCode).toBe(503)
		expect(denied.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
		expect(denied.headers["cache-control"]).toBe("no-store")
		zeroReads(env)
	})
})
