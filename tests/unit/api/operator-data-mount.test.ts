import { EventEmitter, once } from "node:events"
import { request as httpRequest } from "node:http"
import * as operatorTransport from "../../../src/operator-data/transport.js"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	OPERATOR_DATA_LIMITS,
	operatorDataReadDtoSchema,
	operatorDataWriteDtoSchema,
} from "@wavekit/api-types"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { OperatorDataService } from "../../../src/operator-data/service.js"
import type { OperatorDataServiceOptions } from "../../../src/operator-data/service.js"
import { createOperatorDataCommitSink } from "../../../src/operator-data/broadcast-adapter.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const origin = "http://receiver.lan:9000"
const browser = { host: "receiver.lan:9000", origin }
const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
const services: OperatorDataService[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const socket of sockets.splice(0)) socket.terminate()
	for (const server of servers.splice(0))
		await server.stop().catch(() => undefined)
	for (const service of services.splice(0))
		await service.close().catch(() => undefined)
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})
function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
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
	}
}

async function setup(
	options: {
		storageStage?: OperatorDataServiceOptions["storageStage"]
		mount?: boolean
		legacy?: boolean
	} = {},
) {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-protected-server-"))
	roots.push(root)
	const directory = join(root, "private")
	const provisioned = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = provisioned.useMachineCredential(value => value)
	await provisioned.close()
	const context = await openAccessRuntime(runtimeOptions(directory))
	contexts.push(context)
	const logs: string[] = []
	const logger = pino(
		{ level: "trace" },
		{
			write: line => {
				logs.push(line)
			},
		},
	)
	const sourceManager = Object.assign(new EventEmitter(), {
		connect: vi.fn(),
		disconnect: vi.fn(),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getStream: vi.fn(),
		getSourceAssignments: vi.fn(() => []),
		isSourceAvailable: vi.fn(() => true),
		assignDecoder: vi.fn(),
		unassignDecoder: vi.fn(),
		getAssignedSource: vi.fn(),
		getCaps: vi.fn(),
		isCompatible: vi.fn(() => true),
	})
	const decoderManager = Object.assign(new EventEmitter(), {
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		restartDecoder: vi.fn(),
		getDecoder: vi.fn(),
		getAllDecoders: vi.fn(() => []),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getAllHealth: vi.fn(() => new Map()),
	})
	const fanoutManager = Object.assign(new EventEmitter(), {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn(() => []),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		getTelemetrySnapshot: vi.fn(() => ({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		})),
		destroy: vi.fn(),
	})
	const audioOutput = Object.assign(new EventEmitter(), {
		start: vi.fn(),
		stop: vi.fn(),
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		getConnectedClients: vi.fn(() => 0),
		getPort: vi.fn(() => 8080),
	})
	const dependencies: ApiServerDependencies = {
		...(options.legacy ? {} : { access: context }),
		logger,
		sourceManager:
			sourceManager as unknown as ApiServerDependencies["sourceManager"],
		decoderManager:
			decoderManager as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager:
			fanoutManager as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: audioOutput as unknown as ApiServerDependencies["audioOutput"],
	}
	const server = new ApiServer(dependencies, {
		host: "127.0.0.1",
		port: 0,
		accessBootstrap: runtimeOptions(directory).bootstrap,
		publicOrigins: {
			api: origin,
			analogAudio: "http://receiver.lan:9001",
			digitalAudio: "http://receiver.lan:9002",
		},
	})
	servers.push(server)
	const port = server.getOperatorDataBroadcastPort()
	const sink = createOperatorDataCommitSink(port)
	const operator = await OperatorDataService.open({
		stateDir: root,
		...(options.storageStage ? { storageStage: options.storageStage } : {}),
		onCommit: snapshot => {
			try {
				sink(snapshot)
			} catch {
				server.invalidateOperatorDataPublication()
			}
			return undefined
		},
	})
	services.push(operator)
	if (options.mount !== false && !options.legacy)
		server.mountOperatorData(operator)
	const app = server.getApp()
	const machine = { host: browser.host, authorization: `Bearer ${token}` }
	const pair = async () => {
		const issued = await app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: machine,
		})
		expect(issued.statusCode).toBe(201)
		const paired = await app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: browser,
			payload: { code: issued.json<{ code: string }>().code },
		})
		expect(paired.statusCode).toBe(201)
		const cookie = paired.headers["set-cookie"]
		if (typeof cookie !== "string") throw new Error("Missing cookie")
		const body = paired.json<{
			deviceId: string
			expiresAt: number
			csrfToken: string
		}>()
		return {
			body,
			cookie,
			headers: {
				...browser,
				cookie: cookie.split(";")[0] ?? "",
				"x-wavekit-csrf": body.csrfToken,
			},
		}
	}
	return {
		server,
		app,
		operator,
		port,
		root,
		context,
		directory,
		token,
		logs,
		sourceManager,
		decoderManager,
		machine,
		pair,
	}
}

function address(server: ApiServer): string {
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing listener")
	return `http://127.0.0.1:${bound.port}`
}

function token(service: OperatorDataService) {
	const { storeId, revision } = service.snapshot()
	return { storeId, revision }
}
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}
async function subscriber(
	env: Awaited<ReturnType<typeof setup>>,
	headers: Record<string, string> = env.machine,
) {
	const socket = new WebSocket(
		address(env.server).replace("http:", "ws:") + "/ws",
		{ headers },
	)
	sockets.push(socket)
	const frames: { type: string; channel?: string; data: unknown }[] = []
	const listeners = new Set<() => void>()
	socket.on("message", raw => {
		frames.push(
			JSON.parse(raw.toString()) as {
				type: string
				channel?: string
				data: unknown
			},
		)
		for (const listener of listeners) listener()
	})
	await once(socket, "open")
	const next = (type: string, from = frames.length) => {
		const known = frames.slice(from).find(frame => frame.type === type)
		if (known) return Promise.resolve(known)
		return new Promise<(typeof frames)[number]>(resolve => {
			const inspect = () => {
				const found = frames.slice(from).find(frame => frame.type === type)
				if (found) {
					listeners.delete(inspect)
					resolve(found)
				}
			}
			listeners.add(inspect)
			inspect()
		})
	}
	const initial = next("operator-data:snapshot")
	socket.send(
		JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
	)
	await initial
	return { socket, frames, next }
}
const base = "/api/operator-data"

describe("actual protected operator runtime mounting", () => {
	it("keeps registration intent unavailable before listen and computes current snapshot health after listen", async () => {
		const env = await setup()
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		await env.server.start()
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(true)
		const read = await env.app.inject({ url: base, headers: env.machine })
		expect(read.statusCode).toBe(200)
		operatorDataReadDtoSchema.parse(read.json())
		const broken = vi.spyOn(env.operator, "snapshot").mockImplementation(() => {
			throw new WaveKitError("private detail", "FAILURE")
		})
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		expect(
			(await env.app.inject({ url: base, headers: env.machine })).statusCode,
		).toBe(503)
		broken.mockRestore()
		env.server.stopAdmission()
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
	})

	it("never mounts operator routes or active operator subscriptions on legacy servers", async () => {
		const env = await setup({ legacy: true })
		expect(() => env.server.mountOperatorData(env.operator)).toThrow()
		await env.server.start()
		expect((await env.app.inject({ url: base })).statusCode).toBe(404)
		expect(env.server.getAccessBootstrap()).toBeNull()
	})

	it("preserves actual root Origin/CSRF admission and mounted 428/409/parser errors across all seven routes", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const expected = token(env.operator)
		for (const headers of [
			browser,
			{ ...paired.headers, origin: "http://evil.invalid" },
			{ ...paired.headers, "x-wavekit-csrf": "wrong" },
		]) {
			const denied = await env.app.inject({
				method: "PATCH",
				url: base + "/preferences",
				headers,
				payload: { expected, set: { units: "metric" } },
			})
			expect([401, 403]).toContain(denied.statusCode)
		}
		expect(env.operator.snapshot().revision).toBe(expected.revision)
		expect(
			(
				await env.app.inject({
					method: "PATCH",
					url: base + "/preferences",
					headers: paired.headers,
					payload: { set: { units: "metric" } },
				})
			).statusCode,
		).toBe(428)
		const frequency = {
			name: "Repeater",
			frequencyHz: 145500000,
			mode: "nfm",
			bandwidthHz: 12500,
			tone: { kind: "dcs", code: "023", polarity: "inverted" },
		}
		const created = await env.app.inject({
			method: "POST",
			url: base + "/saved-frequencies",
			headers: paired.headers,
			payload: { expected, frequency },
		})
		expect(created.statusCode).toBe(201)
		const creation = operatorDataWriteDtoSchema.parse(created.json())
		const id = creation.savedFrequencyId!
		expect(creation.snapshot.savedFrequencies[0]?.tone).toEqual(frequency.tone)
		const replaced = await env.app.inject({
			method: "PUT",
			url: base + "/saved-frequencies/" + id,
			headers: env.machine,
			payload: {
				expected: token(env.operator),
				frequency: { ...frequency, name: "Renamed" },
			},
		})
		expect(replaced.statusCode).toBe(200)
		const patch = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		expect(patch.statusCode).toBe(200)
		const report = await env.app.inject({
			method: "POST",
			url: base + "/command-usage",
			headers: env.machine,
			payload: {
				expected: token(env.operator),
				command: "open-saved-frequency",
				savedFrequencyId: id,
			},
		})
		expect(report.statusCode).toBe(200)
		expect(
			(
				await env.app.inject({
					method: "DELETE",
					url: base + "/command-usage",
					headers: env.machine,
					payload: { expected: token(env.operator) },
				})
			).statusCode,
		).toBe(200)
		expect(
			(
				await env.app.inject({
					method: "DELETE",
					url: base + "/saved-frequencies/" + id,
					headers: env.machine,
					payload: { expected: token(env.operator) },
				})
			).statusCode,
		).toBe(200)
		const conflict = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected, set: { units: "imperial" } },
		})
		expect(conflict.statusCode).toBe(409)
		expect(conflict.json().details).toEqual({ current: token(env.operator) })
		const quota = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: { ...env.machine, "content-type": "application/json" },
			payload: JSON.stringify({
				expected: token(env.operator),
				junk: "x".repeat(16385),
			}),
		})
		expect(quota.statusCode).toBe(409)
	})

	it("rechecks actual current session immediately before queue admission even after a successful root hook", async () => {
		const env = await setup()
		let revoke = false
		let id = ""
		env.app.addHook("onRoute", route => {
			if (route.url === base + "/preferences")
				route.schema = {
					...route.schema,
					response: {
						401: {
							type: "object",
							properties: { unrelated: { type: "string" } },
							required: ["unrelated"],
						},
					},
				}
		})
		env.app.addHook("preHandler", async request => {
			if (revoke && request.url === base + "/preferences")
				await env.context.api.sessions.revoke(id)
		})
		await env.server.start()
		const paired = await env.pair()
		id = paired.body.deviceId
		revoke = true
		const mutate = vi.spyOn(env.operator, "mutate")
		const denied = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: paired.headers,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		expect(denied.statusCode).toBe(401)
		expect(denied.json()).toEqual({ code: "AUTH_REQUIRED" })
		expect(mutate).not.toHaveBeenCalled()
	})

	it("serializes one CAS winner and one409, with one synchronous publication and repeated ordered snapshots", async () => {
		const env = await setup()
		await env.server.start()
		const client = await subscriber(env)
		const initial = client.frames.find(
			frame => frame.type === "operator-data:snapshot",
		)!
		expect(Object.keys(initial).sort()).toEqual(["channel", "data", "type"])
		const expected = token(env.operator)
		const update = client.next("operator-data:updated")
		const results = await Promise.all(
			["metric", "imperial"].map(units =>
				env.app.inject({
					method: "PATCH",
					url: base + "/preferences",
					headers: env.machine,
					payload: { expected, set: { units } },
				}),
			),
		)
		expect(results.map(result => result.statusCode).sort()).toEqual([200, 409])
		const frame = await update
		const dto = operatorDataReadDtoSchema.parse(frame.data)
		expect(dto.snapshot.revision).toBe(expected.revision + 1)
		const count = client.frames.filter(
			value => value.type === "operator-data:updated",
		).length
		const noop = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: {
				expected: token(env.operator),
				set: { units: dto.preferences.values.units },
			},
		})
		expect(noop.statusCode).toBe(200)
		const repeated = client.next("operator-data:snapshot")
		client.socket.send(
			JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
		)
		const again = await repeated
		expect(
			client.frames.filter(value => value.type === "operator-data:updated"),
		).toHaveLength(count)
		expect(operatorDataReadDtoSchema.parse(again.data).snapshot).toEqual(
			env.operator.snapshot(),
		)
	})

	it("commits admitted real persistence after caller revocation while sending only to the current subscriber", async () => {
		const entered = gate(),
			blocked = gate()
		let armed = false
		const env = await setup({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await blocked.promise
				}
			},
		})
		await env.server.start()
		const paired = await env.pair()
		const revoked = await subscriber(env, paired.headers)
		const current = await subscriber(env)
		const updated = current.next("operator-data:updated")
		armed = true
		const write = env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: paired.headers,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		await entered.promise
		const closed = once(revoked.socket, "close")
		await env.context.api.sessions.revoke(paired.body.deviceId)
		await closed
		blocked.release()
		expect((await write).statusCode).toBe(200)
		const frame = await updated
		expect(operatorDataReadDtoSchema.parse(frame.data).snapshot).toEqual(
			env.operator.snapshot(),
		)
		expect(
			revoked.frames.some(value => value.type === "operator-data:updated"),
		).toBe(false)
	})

	it("real post-rename directory-sync uncertainty returns503, publishes nothing and makes on-demand healthfalse", async () => {
		let armed = false
		const env = await setup({
			storageStage: (stage, phase) => {
				if (armed && stage === "directory-sync" && phase === "before") {
					armed = false
					throw new WaveKitError("private fsync detail", "FAILURE")
				}
			},
		})
		await env.server.start()
		const client = await subscriber(env)
		armed = true
		const result = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		expect(result.statusCode).toBe(503)
		expect(result.body).not.toContain("private")
		expect(
			(await env.app.inject({ url: base, headers: env.machine })).statusCode,
		).toBe(503)
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		expect(
			client.frames.some(value => value.type === "operator-data:updated"),
		).toBe(false)
		await env.server.stop()
		const recovered = await OperatorDataService.open({ stateDir: env.root })
		services.push(recovered)
		expect(recovered.snapshot().preferenceOverrides.units).toBe("metric")
	})

	it.each(["mapping", "port"] as const)(
		"preserves durable success when %s fails and invalidates subscribers for refetch",
		async failure => {
			const env = await setup()
			await env.server.start()
			const client = await subscriber(env)
			const closed = once(client.socket, "close")
			if (failure === "mapping")
				vi.spyOn(
					operatorTransport,
					"toOperatorDataReadDto",
				).mockImplementationOnce(() => {
					throw new WaveKitError("private transport detail", "FAILURE")
				})
			else
				vi.spyOn(
					env.server.getWebSocketBroadcaster(),
					"broadcast",
				).mockImplementation(() => {
					throw new WaveKitError("private transport detail", "FAILURE")
				})

			const write = await env.app.inject({
				method: "PATCH",
				url: base + "/preferences",
				headers: env.machine,
				payload: { expected: token(env.operator), set: { units: "metric" } },
			})
			expect(write.statusCode).toBe(200)
			await closed
			expect(env.operator.snapshot().preferenceOverrides.units).toBe("metric")
			expect(env.logs.join("")).not.toContain("private transport detail")
		},
	)

	it("maps an actually full service queue to safe BUSY503 without admitting the mounted write", async () => {
		const entered = gate(),
			blocked = gate()
		let armed = false
		const env = await setup({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await blocked.promise
				}
			},
		})
		await env.server.start()
		const expected = token(env.operator)
		armed = true
		const accepted = Array.from(
			{ length: OPERATOR_DATA_LIMITS.waitingTransactions + 1 },
			() =>
				env.operator
					.mutate({
						type: "patch-preferences",
						expected,
						set: { units: "metric" },
					})
					.then(
						() => "committed",
						() => "conflict",
					),
		)
		await entered.promise
		const denied = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected, set: { units: "imperial" } },
		})
		blocked.release()
		const outcomes = await Promise.all(accepted)
		expect(denied.statusCode).toBe(503)
		expect(denied.json().code).toBe("OPERATOR_DATA_BUSY")
		expect(outcomes.filter(outcome => outcome === "committed")).toHaveLength(1)
		expect(env.operator.snapshot().preferenceOverrides.units).toBe("metric")
		expect(env.operator.snapshot().revision).toBe(expected.revision + 1)
	})

	it("seals new work immediately but keeps the sink and current WS alive until actual close drain finishes", async () => {
		const entered = gate(),
			blocked = gate()
		let armed = false
		const env = await setup({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await blocked.promise
				}
			},
		})
		await env.server.start()
		const client = await subscriber(env)
		const updated = client.next("operator-data:updated")
		armed = true
		const write = env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		await entered.promise
		let finished = false
		const stopping = env.server.stop().then(() => {
			finished = true
		})
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		expect(
			(await env.app.inject({ url: base, headers: env.machine })).statusCode,
		).toBe(503)
		expect(finished).toBe(false)
		expect(client.socket.readyState).toBe(WebSocket.OPEN)
		blocked.release()
		expect((await write).statusCode).toBe(200)
		await updated
		await stopping
		expect(finished).toBe(true)
		expect(
			client.frames.some(frame => frame.type === "operator-data:updated"),
		).toBe(true)
	})

	it("retains the first failed stop outcome while still closing transports", async () => {
		const env = await setup()
		await env.server.start()
		const close = vi
			.spyOn(env.operator, "close")
			.mockRejectedValue(new WaveKitError("private cleanup detail", "FAILURE"))
		const stopping = env.server.stop()
		expect(env.server.stop()).toBe(stopping)
		await expect(stopping).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		expect(env.server.stop()).toBe(stopping)
		expect(close).toHaveBeenCalledTimes(1)
		expect(env.app.server.listening).toBe(false)
		close.mockRestore()
	})
	it("keeps readiness false on failed listen and after stop racing an incomplete startup", async () => {
		const env = await setup()
		vi.spyOn(env.app, "listen").mockRejectedValueOnce(
			new WaveKitError("private bind failure", "FAILURE"),
		)
		await expect(env.server.start()).rejects.toMatchObject({ code: "FAILURE" })
		expect(
			env.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		const next = await setup()
		const started = next.server.start()
		const stopped = next.server.stop()
		await expect(started).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		await stopped
		expect(
			next.server.getAccessBootstrap()?.capabilities.operatorDataAvailable,
		).toBe(false)
		expect(next.app.server.listening).toBe(false)
	})

	it("discards an actual adopted client's queued operator update on revocation before flush", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const revoked = await subscriber(env, paired.headers)
		const current = await subscriber(env)
		const broadcaster = env.server.getWebSocketBroadcaster()
		const clients = (
			broadcaster as unknown as { clients: Map<string, { socket: WebSocket }> }
		).clients
		const serverSocket = [...clients.values()][0]!.socket
		let blocked = true
		Object.defineProperty(serverSocket, "bufferedAmount", {
			configurable: true,
			get: () => (blocked ? 1 : 0),
		})
		const updated = current.next("operator-data:updated")
		const result = await env.app.inject({
			method: "PATCH",
			url: base + "/preferences",
			headers: env.machine,
			payload: { expected: token(env.operator), set: { units: "metric" } },
		})
		expect(result.statusCode).toBe(200)
		await updated
		expect(
			revoked.frames.some(frame => frame.type === "operator-data:updated"),
		).toBe(false)
		const closed = once(revoked.socket, "close")
		await env.context.api.sessions.revoke(paired.body.deviceId)
		blocked = false
		// Exercise actual enqueue/flush checks before relying on the close handshake.
		broadcaster.broadcast("operator-data", {
			type: "operator-data:updated",
			channel: "operator-data",
			data: operatorTransport.toOperatorDataReadDto(env.operator.snapshot()),
		})
		await closed
		expect(
			revoked.frames.some(frame => frame.type === "operator-data:updated"),
		).toBe(false)
		expect(clients.size).toBe(1)
	})

	it("invalidates only the client whose snapshot capture fails and lets another client continue", async () => {
		const env = await setup()
		await env.server.start()
		const current = await subscriber(env)
		const socket = new WebSocket(
			address(env.server).replace("http:", "ws:") + "/ws",
			{ headers: env.machine },
		)
		sockets.push(socket)
		await once(socket, "open")
		const frames: string[] = []
		socket.on("message", value => frames.push(value.toString()))
		const closed = once(socket, "close")
		vi.spyOn(env.operator, "snapshot").mockImplementationOnce(() => {
			throw new WaveKitError("private capture detail", "FAILURE")
		})
		socket.send(
			JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
		)
		await closed
		expect(frames.join("")).not.toContain("operator-data:snapshot")
		const updated = current.next("operator-data:updated")
		expect(
			(
				await env.app.inject({
					method: "PATCH",
					url: base + "/preferences",
					headers: env.machine,
					payload: { expected: token(env.operator), set: { units: "metric" } },
				})
			).statusCode,
		).toBe(200)
		await updated
		expect(current.socket.readyState).toBe(WebSocket.OPEN)
	})

	it("recovers a disconnected create outcome by refetch without replaying the admitted mutation", async () => {
		const entered = gate(),
			blocked = gate()
		let armed = false
		const env = await setup({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await blocked.promise
				}
			},
		})
		await env.server.start()
		const current = await subscriber(env)
		const updated = current.next("operator-data:updated")
		const expected = token(env.operator)
		const payload = JSON.stringify({
			expected,
			frequency: {
				name: "Lost response",
				frequencyHz: 145500000,
				mode: "nfm",
				bandwidthHz: 12500,
				tone: { kind: "none" },
			},
		})
		armed = true
		const request = httpRequest(
			address(env.server) + base + "/saved-frequencies",
			{
				method: "POST",
				headers: {
					...env.machine,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
				},
			},
		)
		request.on("error", () => {})
		request.end(payload)
		await entered.promise
		request.destroy()
		blocked.release()
		await updated
		const read = await env.app.inject({ url: base, headers: env.machine })
		const dto = operatorDataReadDtoSchema.parse(read.json())
		expect(dto.snapshot.savedFrequencies).toHaveLength(1)
		expect(dto.snapshot.revision).toBe(expected.revision + 1)
		const changed = operatorTransport.toOperatorDataReadDto(
			env.operator.snapshot(),
		)
		expect(dto).toEqual(changed)
	})
})
