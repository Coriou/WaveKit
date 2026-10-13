import { EventEmitter, once } from "node:events"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import pino from "pino"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	BandPlanStackView,
	BandPlansChangedEventData,
} from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { createBandPlansCommitSink } from "../../../src/api/websocket/bandplans-broadcast-adapter.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { openBandPlanService } from "../../../src/core/bandplans/index.js"
import type {
	BandPlanService,
	BandPlansCommitSink,
} from "../../../src/core/bandplans/contract.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"
import { WaveKitError } from "../../../src/utils/errors.js"

// End-to-end change notices: real ApiServer, WebSocketEventBroadcaster and
// band-plan service over a mkdtemp stateDir, wired like src/index.ts.

const logger = pino({ level: "silent" })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const cleanup of cleanups.splice(0).reverse())
		await cleanup().catch(() => undefined)
})

const host = "receiver.lan:9000"
const origin = "http://receiver.lan:9000"

interface SetupOptions {
	readonly protectedMode: boolean
	/** Runs against stateDir before the server's service opens. */
	readonly prepare?: (stateDir: string) => Promise<void>
	/** Holds the store lock with a second service so the served store is unavailable. */
	readonly lockHeld?: boolean
}

async function openAccess(root: string) {
	const directory = join(root, "private")
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	const access: NamedAccessRuntimeContext = await openAccessRuntime({
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
	cleanups.push(() => access.close())
	return { access, token }
}

async function setup(options: SetupOptions) {
	const root = await mkdtemp(join(tmpdir(), "wavekit-bandplans-ws-"))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const opened = options.protectedMode ? await openAccess(root) : undefined
	const stateDir = join(root, "state")
	await mkdir(stateDir, { mode: 0o700 })
	await options.prepare?.(stateDir)
	if (options.lockHeld) {
		const holder = await openBandPlanService({
			stateDir,
			context: { region: "EU", effectiveCountry: null },
			writable: true,
		})
		cleanups.push(() => holder.close())
	}
	// Same late binding as src/index.ts: the sink is set once the server exists.
	let publishBandPlans: BandPlansCommitSink | undefined
	const service: BandPlanService = await openBandPlanService({
		stateDir,
		context: { region: "EU", effectiveCountry: null },
		writable: options.protectedMode,
		onCommit: event => publishBandPlans?.(event),
	})
	cleanups.push(() => service.close())
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
	const sourceManager = new SourceManager(logger)
	cleanups.push(() => sourceManager.disconnectAll())
	const fanoutManager = new FanoutManager(logger)
	cleanups.push(async () => fanoutManager.destroy())
	const server = new ApiServer(
		{
			...(opened ? { access: opened.access } : {}),
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
	publishBandPlans = createBandPlansCommitSink(
		server.getBandPlansBroadcastPort(),
	)
	await server.start()
	const headers: Record<string, string> = opened
		? { host, authorization: `Bearer ${opened.token}` }
		: { host }
	return { server, service, stateDir, headers }
}

type Env = Awaited<ReturnType<typeof setup>>
interface Frame {
	type: string
	channel?: string
	data: unknown
}

function wsUrl(server: ApiServer): string {
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing listener")
	return `ws://127.0.0.1:${bound.port}/ws`
}

async function connect(env: Env) {
	const socket = new WebSocket(wsUrl(env.server), { headers: env.headers })
	cleanups.push(async () => {
		socket.terminate()
	})
	const frames: Frame[] = []
	const listeners = new Set<() => void>()
	socket.on("message", raw => {
		frames.push(JSON.parse(raw.toString()) as Frame)
		for (const listener of listeners) listener()
	})
	await once(socket, "open")
	const waitFor = (predicate: (frame: Frame) => boolean, from: number) =>
		new Promise<Frame>(resolve => {
			const inspect = () => {
				const found = frames.slice(from).find(predicate)
				if (found) {
					listeners.delete(inspect)
					resolve(found)
				}
			}
			listeners.add(inspect)
			inspect()
		})
	const subscribe = async (channels: string[]) => {
		const from = frames.length
		const ack = waitFor(frame => frame.type === "subscribed", from)
		socket.send(JSON.stringify({ type: "subscribe", channels }))
		await ack
	}
	/**
	 * Application frames leave the broadcaster's per-client queue in order, so a
	 * later subscribe ack proves every earlier enqueued frame has arrived.
	 */
	const barrier = () => subscribe(["health"])
	const notices = (from = 0) =>
		frames
			.slice(from)
			.filter(frame => frame.type === "bandplans:changed")
			.map(frame => {
				expect(frame.channel).toBe("bandplans")
				return frame.data as BandPlansChangedEventData
			})
	return { socket, frames, subscribe, barrier, notices }
}

function tokenOf(view: BandPlanStackView): BandPlansChangedEventData {
	if (view.store.state !== "available") throw new Error("store unavailable")
	return { storeId: view.store.storeId, revision: view.store.revision }
}

function expectedOf(view: BandPlanStackView) {
	const token = tokenOf(view)
	if (token.storeId === null) throw new Error("never-persisted store")
	return { storeId: token.storeId, revision: token.revision }
}

function toggledStack(view: BandPlanStackView, index: number) {
	return view.stack.entries.map((entry, at) => ({
		packId: entry.packId,
		enabled:
			at === index % view.stack.entries.length ? !entry.enabled : entry.enabled,
	}))
}

/**
 * Durability is covered by the storage tests; here fsync would cost tens of ms on
 * macOS and push 100 runs past the test budget. Rename and write stay real.
 */
async function skipFsync(directory: string) {
	const handle = await open(directory, "r")
	const prototype = Object.getPrototypeOf(handle) as {
		sync: () => Promise<void>
	}
	await handle.close()
	vi.spyOn(prototype, "sync").mockResolvedValue(undefined)
}

describe("bandplans WebSocket channel end to end", () => {
	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 9.3, 11.9
	it("legacy never-persisted store snapshots storeId null and mounts no writes", async () => {
		const env = await setup({ protectedMode: false })
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		expect(client.notices()).toEqual([{ storeId: null, revision: 0 }])
		expect(tokenOf(env.service.view())).toEqual({ storeId: null, revision: 0 })
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 11.8, 11.9
	it("legacy read-only store over an existing file snapshots the persisted token", async () => {
		let persisted: BandPlansChangedEventData | undefined
		const env = await setup({
			protectedMode: false,
			prepare: async stateDir => {
				const writer = await openBandPlanService({
					stateDir,
					context: { region: "EU", effectiveCountry: null },
					writable: true,
				})
				try {
					const view = writer.view()
					const result = await writer.mutate({
						type: "set-stack",
						expected: expectedOf(view),
						entries: toggledStack(view, 0),
					})
					persisted = tokenOf(result.view)
				} finally {
					await writer.close()
				}
			},
		})
		expect(persisted?.storeId).toEqual(expect.any(String))
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		expect(client.notices()).toEqual([persisted])
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 11.9
	it("sends no snapshot for an unavailable store", async () => {
		const env = await setup({ protectedMode: true, lockHeld: true })
		expect(env.service.view().store).toEqual({ state: "unavailable" })
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		expect(client.notices()).toEqual([])
		expect(client.socket.readyState).toBe(WebSocket.OPEN)
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 9.3, 11.9
	it("protected subscribe snapshots the view; a changed write notifies, no-op and rejected writes do not", async () => {
		const env = await setup({ protectedMode: true })
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		const initial = env.service.view()
		expect(client.notices()).toEqual([tokenOf(initial)])
		expect(tokenOf(initial).storeId).toEqual(expect.any(String))

		// No-op: the stack is already the default.
		const noop = await env.server.getApp().inject({
			method: "DELETE",
			url: "/api/bandplans/stack",
			headers: { ...env.headers, origin },
			payload: { expected: expectedOf(initial) },
		})
		expect(noop.statusCode).toBe(200)
		// Rejected: stale revision.
		const stale = await env.server.getApp().inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { ...env.headers, origin },
			payload: {
				expected: { ...expectedOf(initial), revision: 99 },
				entries: toggledStack(initial, 0),
			},
		})
		expect(stale.statusCode).toBe(409)
		await client.barrier()
		expect(client.notices()).toHaveLength(1)

		const write = await env.server.getApp().inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { ...env.headers, origin },
			payload: {
				expected: expectedOf(initial),
				entries: toggledStack(initial, 0),
			},
		})
		expect(write.statusCode).toBe(200)
		const after = tokenOf(write.json<{ view: BandPlanStackView }>().view)
		expect(after).toEqual({
			storeId: tokenOf(initial).storeId,
			revision: tokenOf(initial).revision + 1,
		})
		await client.barrier()
		expect(client.notices()).toEqual([tokenOf(initial), after])
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 11.9
	it("notifies exactly once per changed commit with the new token over random mutation runs", async () => {
		const env = await setup({ protectedMode: true })
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		await skipFsync(env.stateDir)
		const op = fc.oneof(
			fc.record({ kind: fc.constant("toggle" as const), index: fc.nat(31) }),
			fc.constant({ kind: "same" as const }),
			fc.constant({ kind: "reset" as const }),
			fc.constant({ kind: "stale" as const }),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(op, { minLength: 1, maxLength: 3 }),
				async ops => {
					const from = client.frames.length
					const expected: BandPlansChangedEventData[] = []
					for (const step of ops) {
						const view = env.service.view()
						const token = expectedOf(view)
						const input =
							step.kind === "toggle"
								? {
										type: "set-stack",
										expected: token,
										entries: toggledStack(view, step.index),
									}
								: step.kind === "same"
									? {
											type: "set-stack",
											expected: token,
											entries: view.stack.entries.map(entry => ({
												packId: entry.packId,
												enabled: entry.enabled,
											})),
										}
									: step.kind === "reset"
										? { type: "reset-stack", expected: token }
										: {
												type: "reset-stack",
												expected: { ...token, revision: token.revision + 1 },
											}
						if (step.kind === "stale") {
							await expect(env.service.mutate(input)).rejects.toMatchObject({
								code: "BANDPLANS_CONFLICT",
							})
							expect(tokenOf(env.service.view())).toEqual(tokenOf(view))
							continue
						}
						const result = await env.service.mutate(input)
						if (result.changed) {
							expect(result.delivery).toBe("sent")
							expect(tokenOf(result.view)).toEqual({
								storeId: token.storeId,
								revision: token.revision + 1,
							})
							expected.push(tokenOf(result.view))
						} else {
							expect(result.delivery).toBe("not-needed")
							expect(tokenOf(result.view)).toEqual(tokenOf(view))
						}
					}
					await client.barrier()
					expect(client.notices(from)).toEqual(expected)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 11.9
	it("a throwing transport keeps the mutation durable and invalidates subscribers for refetch", async () => {
		const env = await setup({ protectedMode: true })
		const client = await connect(env)
		await client.subscribe(["bandplans"])
		await client.barrier()
		const initial = env.service.view()
		const closed = once(client.socket, "close")
		const broadcast = vi
			.spyOn(env.server.getWebSocketBroadcaster(), "broadcast")
			.mockImplementation(() => {
				throw new WaveKitError("transport detail", "FAILURE")
			})

		const write = await env.server.getApp().inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { ...env.headers, origin },
			payload: {
				expected: expectedOf(initial),
				entries: toggledStack(initial, 0),
			},
		})
		expect(write.statusCode).toBe(200)
		await closed
		const committed = env.service.view()
		expect(tokenOf(committed).revision).toBe(tokenOf(initial).revision + 1)

		// Delivery is recorded as sent: the port swallows the transport failure.
		const direct = await env.service.mutate({
			type: "set-stack",
			expected: expectedOf(committed),
			entries: toggledStack(committed, 0),
		})
		expect(direct).toMatchObject({ changed: true, delivery: "sent" })
		expect(broadcast).toHaveBeenCalledTimes(2)

		// A reconnecting client refetches the current token.
		broadcast.mockRestore()
		const again = await connect(env)
		await again.subscribe(["bandplans"])
		await again.barrier()
		expect(again.notices()).toEqual([tokenOf(env.service.view())])
	})
})
