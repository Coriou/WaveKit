/**
 * Direct channel input with placements enabled, the production setup: a placement parent and its worker take their
 * channel sockets as stdin. A capture-centre move in both orders, a requested stop through the lifecycle actor, a
 * crash with a reconcile pass inside the fate window, and an in-place retune through the settlement adapter composed
 * as the core composes it (src/index.ts composeDecoderChannelizer) over a scripted wavekit-chan. Fake children, fake
 * clock; nothing connects anywhere.
 */
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChannelizerConfigSchema } from "../../../src/config.js"
import {
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import { SettlementRegistry } from "../../../src/core/channelizer/settlement-observer.js"
import type {
	ChannelInputMode,
	ChannelProvider,
} from "../../../src/core/channelizer/types.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { CHANNEL_FATE_MS } from "../../../src/decoders/direct-channel-input.js"
import type {
	PlacementPlanner,
	WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"
import { placementKey } from "../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../src/decoders/enablement/efficiency-gate.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FakeSources, deferred, iqCaps } from "../../mocks/rate-fakes.js"
import {
	CENTER,
	DirectDecoder,
	DirectProvider,
	type FakeSocket,
	fakeSocket,
} from "./direct-channel-fakes.js"

const DEBOUNCE = 350
const PARENT_HZ = CENTER
const WORKER_HZ = CENTER + 25_000
const CAPS = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
} as const
const ENDED = "Decoder input ended with its channel; restarting it"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	try {
		for (const dispose of cleanup.splice(0).reverse()) await dispose()
	} finally {
		vi.useRealTimers()
	}
})

/**
 * The core's composition: one ChannelizerManager over a scripted process, bound through the settlement observer,
 * with the in-place retune port copied onto the adapter (composeDecoderChannelizer).
 */
function composed(sources: FakeSources, fanout: FanoutManager) {
	const silent = pino({ level: "silent" })
	const dir = mkdtempSync("/tmp/wkdp-")
	const sent: ChannelizerRequest[] = []
	const sockets: FakeSocket[] = []
	const proc = Object.assign(new EventEmitter(), {
		generation: 1,
		input: new PassThrough(),
		start: () => {
			proc.emit("event", { v: 1, type: "ready", generation: 1, pid: 1 })
			return Promise.resolve()
		},
		stop: () => Promise.resolve(),
		send: (r: ChannelizerRequest) => {
			sent.push(r)
			if (r.type === "open")
				proc.emit("event", {
					v: 1,
					type: "opened",
					id: r.id,
					generation: 1,
					socket: "fake",
					outputRateHz: r.outputRateHz,
					format: r.format,
					filterTaps: 10,
					groupDelaySamples: 5,
				})
			if (r.type === "retune")
				proc.emit("event", {
					v: 1,
					type: "retuned",
					channelId: r.channelId,
					generation: 1,
					centerHz: r.centerHz,
				})
			if (r.type === "close")
				proc.emit("event", {
					v: 1,
					type: "closed",
					id: r.id,
					generation: 1,
					reason: "requested",
				})
		},
	})
	const connect: NonNullable<ChannelizerManagerDeps["connect"]> = (
		_path,
		_signal,
		input,
	) => {
		const socket = fakeSocket()
		if (input !== "direct") socket.resume()
		sockets.push(socket)
		return Promise.resolve(socket)
	}
	const registry = new SettlementRegistry()
	const lifetime = registry.registerProviderLifetime()!
	const observer = registry.createObserver(lifetime)
	const chan = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger: silent,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess: () => proc,
		connect,
		settlementObserver: observer,
	})
	const channels = observer.bindProvider(chan)
	Object.assign(channels, { retuneChannel: chan.retuneChannel.bind(chan) })
	cleanup.push(async () => {
		await chan.destroy()
		proc.input.destroy()
		rmSync(dir, { recursive: true, force: true })
	})
	const stats = (id: string, outputSamples: number) =>
		proc.emit("event", {
			v: 1,
			type: "stats",
			generation: 1,
			inputSamples: 1000,
			channels: [
				{
					id,
					outputSamples,
					queueHighWaterBytes: 0,
					droppedSamples: 0,
					saturatedSamples: 0,
				},
			],
		})
	return { chan, channels, sent, sockets, stats }
}

function setup(
	opts: {
		composed?: boolean
		channelInput?: ChannelInputMode
		/** An efficiency gate with room for everything, so a start passes admission and displaceSecondaries. */
		gate?: boolean
	} = {},
) {
	vi.useFakeTimers()
	const lines: Array<Record<string, unknown>> = []
	const logger = pino(
		{ level: "info" },
		{ write: (line: string) => void lines.push(JSON.parse(line)) },
	)
	const order: string[] = []
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: CENTER })
	const instances: DirectDecoder[] = []
	const registry = new DecoderRegistry()
	registry.register(
		"direct-test",
		config => {
			const decoder = new DirectDecoder(config.id, order, config.options)
			instances.push(decoder)
			return decoder
		},
		CAPS,
	)
	let wanted: WantedPlacement[] = []
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted,
		unplaced: new Map(),
	}))
	const fanout = new FanoutManager(logger)
	const manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		channelInput: opts.channelInput ?? "direct",
		enablement: {
			planner,
			...(opts.gate
				? {
						gate: createEfficiencyGate(
							{ budgetCores: 64, cpuGuardPercent: 90 },
							{
								drops: {
									dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
									monoNow: () => performance.now(),
									sources: () => ["rtl"],
									droppedSinceMono: () => false,
									droppedWithinMs: () => false,
								},
							},
						),
					}
				: {}),
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => true,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	cleanup.push(() => fanout.destroy())
	cleanup.push(() => manager.destroy())
	manager.setSourceManager(sources as unknown as SourceManager)
	const fake = new DirectProvider(order)
	/** Every channel granted, in order: one id per grant, so a release is counted per channel. */
	const granted: Array<{ decoderId: string; channelId: string }> = []
	fake.channelIdFor = decoderId => {
		const channelId = `${decoderId}/${granted.length + 1}`
		granted.push({ decoderId, channelId })
		return channelId
	}
	const core = opts.composed ? composed(sources, fanout) : null
	const provider: ChannelProvider = core ? core.channels : fake
	manager.setChannelizer(provider)
	const restarting: string[] = []
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
	const place = (
		id: string,
		hz: number,
		primary = true,
		origin: WantedPlacement["origin"] = "configured",
	): WantedPlacement => ({
		key: placementKey(id, "rtl", "channel", hz),
		decoderId: id,
		sourceId: "rtl",
		channelHz: hz,
		reach: "channel",
		origin,
		primary,
		costCores: 0.14,
		sampleRateHz: 2_400_000,
	})
	const internal = manager as unknown as {
		decoders: Map<
			string,
			{
				consecutiveFailures: number
				currentDelay: number
				suspension: { reasonCode: string } | null
			}
		>
	}
	return {
		manager,
		sources,
		fake,
		core,
		order,
		restarting,
		place,
		create: (id: string) =>
			manager.createDecoder({
				id,
				type: "direct-test",
				enabled: true,
				options: {},
				useChannelizer: true,
			}),
		plan: (placements: WantedPlacement[]) => {
			wanted = placements
		},
		/** A reconcile pass (a bandplan or activity change), then the debounce. */
		settle: async () => {
			manager.notifyBandplansChanged()
			await vi.advanceTimersByTimeAsync(DEBOUNCE)
		},
		advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
		/** The newest instance created for `id`. */
		instance: (id: string) => instances.filter(item => item.id === id).at(-1)!,
		/** Spawns of every instance created for `id`. */
		spawns: (id: string) =>
			instances
				.filter(item => item.id === id)
				.reduce((sum, item) => sum + item.starts, 0),
		/** The newest channel the fake granted to `id`. */
		channelOf: (id: string) =>
			granted.filter(item => item.decoderId === id).at(-1)!.channelId,
		granted,
		releases: (channelId: string) =>
			fake.released.filter(id => id === channelId).length,
		logged: (msg: string) => lines.filter(line => line["msg"] === msg).length,
		failures: (id: string) => internal.decoders.get(id)!.consecutiveFailures,
		/** What a restart must leave as it found it: the error record, the failure count and the back-off. */
		record: (id: string) => {
			const state = internal.decoders.get(id)!
			const status = manager.getStatus(id)
			return {
				lastError: status?.lastError ?? null,
				failures: state.consecutiveFailures,
				delay: state.currentDelay,
				restartCount: status?.restartCount,
				nextRestartAt: status?.nextRestartAt ?? null,
			}
		},
		suspensionOf: (id: string) =>
			internal.decoders.get(id)?.suspension?.reasonCode ?? null,
		/** Destroys the manager, then checks D1 and D3 on every socket handed out. */
		closeAll: async () => {
			await manager.destroy()
			const sockets = core ? core.sockets : [...fake.sockets.values()]
			expect(sockets.length).toBeGreaterThan(0)
			for (const socket of sockets) {
				expect(socket.listenerCount("data")).toBe(0)
				expect(socket.destroyed).toBe(true)
			}
		},
	}
}

type Rig = ReturnType<typeof setup>

async function parentAndWorker(r: Rig) {
	r.create("dec")
	r.plan([r.place("dec", PARENT_HZ), r.place("dec", WORKER_HZ, false)])
	await r.manager.startAll()
	const workerKey = placementKey("dec", "rtl", "channel", WORKER_HZ)
	expect(r.manager.getStatus("dec")).toMatchObject({ running: true })
	expect(r.manager.getStatus(workerKey)).toMatchObject({ running: true })
	for (const id of ["dec", workerKey]) {
		expect(r.instance(id).spawnedWith).toHaveLength(1)
		expect(r.instance(id).relayed).toEqual([])
	}
	return workerKey
}

function grantsTo(r: Rig, id: string) {
	return r.granted.filter(item => item.decoderId === id).length
}

/** Running, never restarted by the crash path, nothing counted; `lastError` too unless `stopError` (see below). */
function noCrash(r: Rig, ids: string[], stopError: string[] = []) {
	expect(r.restarting).toEqual([])
	for (const id of ids) {
		expect(r.manager.getStatus(id)).toMatchObject({
			running: true,
			restartCount: 0,
		})
		expect(r.failures(id)).toBe(0)
		if (!stopError.includes(id))
			expect(r.manager.getStatus(id)?.lastError ?? null).toBeNull()
	}
}

/** What a capture-centre move with the caps worker first leaves, in either mode (a parent and one worker). */
async function capsFirst(channelInput: ChannelInputMode) {
	const r = setup({ channelInput })
	r.create("dec")
	r.plan([r.place("dec", PARENT_HZ), r.place("dec", WORKER_HZ, false)])
	await r.manager.startAll()
	const workerKey = placementKey("dec", "rtl", "channel", WORKER_HZ)
	const old = [r.channelOf("dec"), r.channelOf(workerKey)]
	r.sources.setCenter("rtl", CENTER + 5_000)
	r.fake.endGeneration("rtl", old, "recentered")
	await r.advance(DEBOUNCE)
	await r.advance(5_000)
	const outcome = ["dec", workerKey].map(id => ({
		spawns: r.spawns(id),
		grants: grantsTo(r, id),
		running: r.manager.getStatus(id)?.running,
		restartCount: r.manager.getStatus(id)?.restartCount,
		lastError: r.manager.getStatus(id)?.lastError?.message ?? null,
		failures: r.failures(id),
	}))
	return { r, workerKey, old, outcome, restarting: [...r.restarting] }
}

describe("a capture-centre move under placements (D2)", () => {
	it("children that exit on EOF before the caps worker: one restart of each placement, no crash", async () => {
		const r = setup()
		const workerKey = await parentAndWorker(r)
		const old = [r.channelOf("dec"), r.channelOf(workerKey)]
		r.sources.setCenter("rtl", CENTER + 5_000)
		r.fake.endGeneration("rtl", old, "recentered")
		r.instance("dec").exit(0)
		r.instance(workerKey).exit(0)
		expect(r.logged(ENDED)).toBe(2)
		await r.advance(DEBOUNCE)
		await r.advance(5_000)
		expect(r.spawns("dec")).toBe(2)
		expect(r.spawns(workerKey)).toBe(2)
		// Parent and worker re-placed once: one new grant each.
		expect(grantsTo(r, "dec")).toBe(2)
		expect(grantsTo(r, workerKey)).toBe(2)
		noCrash(r, ["dec", workerKey])
		// The channelizer ended the old channels itself: the manager releases neither.
		for (const id of old) expect(r.releases(id)).toBe(0)
		const fresh = [r.channelOf("dec"), r.channelOf(workerKey)]
		await r.closeAll()
		for (const id of fresh) expect(r.releases(id)).toBe(1)
	})

	it("the caps worker reaching them first (still running): one restart of each placement, no crash, the record of the EOF-first order", async () => {
		// Relay mode is unchanged: the parent's restart stop is a SIGTERM exit it records as its lastError (no count,
		// no restart). With direct input the channel had ended under that run, so its stop's exit records nothing,
		// exactly as when the child exits on EOF first; everything else is as relayed.
		const relay = await capsFirst("relay")
		await relay.r.manager.destroy()
		expect(relay.outcome[0]?.lastError).toContain("SIGTERM")
		const { r, workerKey, old, outcome, restarting } = await capsFirst("direct")
		expect(outcome).toEqual(
			relay.outcome.map(item => ({ ...item, lastError: null })),
		)
		expect(restarting).toEqual(relay.restarting)
		expect(r.spawns("dec")).toBe(2)
		expect(r.spawns(workerKey)).toBe(2)
		expect(r.granted).toHaveLength(4)
		expect(r.logged(ENDED)).toBe(0)
		noCrash(r, ["dec", workerKey])
		for (const id of old) expect(r.releases(id)).toBe(0)
		const fresh = [r.channelOf("dec"), r.channelOf(workerKey)]
		await r.closeAll()
		for (const id of fresh) expect(r.releases(id)).toBe(1)
	})

	it("a child that exits on EOF after the caps pass evaluated it running, before its restart turn: one restart", async () => {
		const r = setup()
		r.create("a")
		r.create("b")
		r.plan([r.place("a", PARENT_HZ), r.place("b", WORKER_HZ)])
		await r.manager.startAll()
		const old = [r.channelOf("a"), r.channelOf("b")]
		// a's restart comes first and waits in its stop; b exits meanwhile.
		const held = deferred()
		r.instance("a").stopGate = held
		r.fake.endGeneration("rtl", old, "recentered")
		await r.advance(DEBOUNCE)
		expect(r.instance("a").stops).toBe(1)
		expect(r.instance("b").stops).toBe(0)
		r.instance("b").exit(0)
		expect(r.logged(ENDED)).toBe(1)
		held.resolve()
		await r.advance(DEBOUNCE)
		await r.advance(5_000)
		expect(r.spawns("a")).toBe(2)
		expect(r.spawns("b")).toBe(2)
		expect(r.granted).toHaveLength(4)
		// a was restarted running, b had already ended on EOF: neither records anything.
		noCrash(r, ["a", "b"])
		await r.closeAll()
	})

	it.each(["exits on EOF first", "the caps worker first"] as const)(
		"a primary with an earlier crash on record, %s: lastError, failure count and back-off unchanged by the move",
		async order => {
			const r = setup()
			r.create("dec")
			r.plan([r.place("dec", PARENT_HZ)])
			await r.manager.startAll()
			// An earlier crash of its own: client-gone, then the crash path's restart.
			r.instance("dec").exit(1)
			r.fake.clientGone("rtl", r.channelOf("dec"))
			await r.advance(100)
			expect(r.spawns("dec")).toBe(2)
			const before = r.record("dec")
			expect(before.lastError).toMatchObject({ kind: "exit" })
			expect(before.failures).toBe(1)
			// The capture centre moves.
			r.sources.setCenter("rtl", CENTER + 5_000)
			r.fake.endGeneration("rtl", [r.channelOf("dec")], "recentered")
			if (order === "exits on EOF first") r.instance("dec").exit(0)
			await r.advance(DEBOUNCE)
			await r.advance(5_000)
			expect(r.spawns("dec")).toBe(3)
			expect(r.manager.getStatus("dec")).toMatchObject({ running: true })
			expect(r.restarting).toEqual(["dec"])
			expect(r.record("dec")).toEqual(before)
			await r.closeAll()
		},
	)
})

describe("a channel lost during startup", () => {
	it("invalidated while the start waits in displaceSecondaries: no spawn, the channel-loss hold, nothing counted", async () => {
		const r = setup({ gate: true })
		r.create("dec")
		r.plan([r.place("dec", PARENT_HZ)])
		const held = deferred()
		const displace = vi.spyOn(
			r.manager as unknown as {
				displaceSecondaries: () => Promise<{
					displaced: unknown[]
					released: boolean
				}>
			},
			"displaceSecondaries",
		)
		displace.mockImplementationOnce(async () => {
			await held.promise
			return { displaced: [], released: true }
		})
		const starting = r.manager.startAll()
		await vi.waitFor(() => expect(displace).toHaveBeenCalledTimes(1))
		const channel = r.channelOf("dec")
		r.fake.endGeneration("rtl", [channel], "recentered")
		held.resolve()
		await starting
		const decoder = r.instance("dec")
		expect(decoder.refused).toBe(1)
		expect(decoder.starts).toBe(0)
		expect(decoder.spawnedWith).toEqual([])
		expect(r.manager.getStatus("dec")).toMatchObject({
			running: false,
			suspended: true,
		})
		expect(r.suspensionOf("dec")).toBe("channelizer-unavailable")
		expect(r.manager.getStatus("dec")?.lastError ?? null).toBeNull()
		expect(r.failures("dec")).toBe(0)
		expect(r.restarting).toEqual([])
		expect(r.fake.sockets.get(channel)?.destroyed).toBe(true)
		// The channelizer ended that channel itself: the manager releases nothing.
		expect(r.releases(channel)).toBe(0)
		await r.closeAll()
	})

	it("closed while the adapter awaits before its spawn, under placements: no spawn, the hold, the channel released once", async () => {
		const r = setup()
		r.create("dec")
		const gate = deferred()
		r.instance("dec").beforeSpawn = gate
		r.plan([r.place("dec", PARENT_HZ)])
		const starting = r.manager.startAll()
		await vi.waitFor(() => expect(r.granted).toHaveLength(1))
		await r.advance(0)
		const channel = r.channelOf("dec")
		r.fake.sockets.get(channel)!.destroy()
		gate.resolve()
		await starting
		expect(r.instance("dec").refused).toBe(1)
		expect(r.spawns("dec")).toBe(0)
		expect(r.manager.getStatus("dec")).toMatchObject({
			running: false,
			suspended: true,
		})
		expect(r.suspensionOf("dec")).toBe("channelizer-unavailable")
		expect(r.manager.getStatus("dec")?.lastError ?? null).toBeNull()
		expect(r.failures("dec")).toBe(0)
		expect(r.restarting).toEqual([])
		expect(r.releases(channel)).toBe(1)
		await r.closeAll()
	})
})

describe("a requested stop under placements (D5)", () => {
	function spyEvaluations(r: Rig) {
		return vi.spyOn(
			r.manager as unknown as { enqueueSourceEvaluation: () => void },
			"enqueueSourceEvaluation",
		)
	}

	it("releases each placement's channel before its child is signalled; no invalidation, no evaluation", async () => {
		const r = setup()
		const workerKey = await parentAndWorker(r)
		const channels = { dec: r.channelOf("dec"), worker: r.channelOf(workerKey) }
		const evaluations = spyEvaluations(r)
		const invalidations = vi.fn()
		r.fake.on("channel-invalidated", invalidations)
		r.order.length = 0
		await r.manager.stopDecoder("dec")
		expect([...r.order].sort()).toEqual(
			[
				`release:${channels.dec}`,
				`release:${channels.worker}`,
				"signal:dec",
				`signal:${workerKey}`,
			].sort(),
		)
		expect(r.order.indexOf(`release:${channels.dec}`)).toBeLessThan(
			r.order.indexOf("signal:dec"),
		)
		expect(r.order.indexOf(`release:${channels.worker}`)).toBeLessThan(
			r.order.indexOf(`signal:${workerKey}`),
		)
		await r.advance(CHANNEL_FATE_MS + DEBOUNCE)
		expect(evaluations).not.toHaveBeenCalled()
		expect(invalidations).not.toHaveBeenCalled()
		expect(r.restarting).toEqual([])
		expect(r.manager.getStatus("dec")).toMatchObject({ running: false })
		await r.closeAll()
		for (const id of Object.values(channels)) expect(r.releases(id)).toBe(1)
	})

	it("the actor's own stop of a start that finished after the stop was recorded releases first too", async () => {
		const r = setup()
		r.create("dec")
		r.plan([r.place("dec", PARENT_HZ)])
		const gate = deferred()
		r.instance("dec").startGate = gate
		const starting = r.manager.startAll()
		await vi.waitFor(() => expect(r.instance("dec").starts).toBe(1))
		const channel = r.channelOf("dec")
		r.order.length = 0
		const stopping = r.manager.stopDecoder("dec")
		await r.advance(0)
		gate.resolve()
		await r.advance(0)
		await Promise.allSettled([starting, stopping])
		await r.advance(CHANNEL_FATE_MS)
		expect(r.order).toEqual([`release:${channel}`, "signal:dec"])
		expect(r.manager.getStatus("dec")).toMatchObject({ running: false })
		expect(r.restarting).toEqual([])
		await r.closeAll()
		expect(r.releases(channel)).toBe(1)
	})
})

describe("a crash with a reconcile pass inside the fate window", () => {
	it("a worker crash: the pass leaves it waiting, client-gone gives one crash-path restart, its channel released once", async () => {
		const r = setup()
		const workerKey = await parentAndWorker(r)
		const channel = r.channelOf(workerKey)
		r.instance(workerKey).exit(1)
		await r.settle()
		expect(r.restarting).toEqual([])
		expect(r.spawns(workerKey)).toBe(1)
		r.fake.clientGone("rtl", channel)
		expect(r.restarting).toEqual([workerKey])
		await r.advance(100)
		expect(r.spawns(workerKey)).toBe(2)
		expect(r.manager.getStatus(workerKey)).toMatchObject({
			running: true,
			restartCount: 1,
			lastError: { kind: "exit" },
		})
		expect(r.releases(channel)).toBe(1)
		// The fate timer went with the classification.
		await r.advance(CHANNEL_FATE_MS * 2)
		expect(r.restarting).toEqual([workerKey])
		expect(r.spawns(workerKey)).toBe(2)
		expect(r.spawns("dec")).toBe(1)
		await r.closeAll()
		expect(r.releases(channel)).toBe(1)
	})

	it("a primary moved by the pass while its crash waits keeps the crash: one crash-path restart, at the new channel", async () => {
		const r = setup()
		r.create("dec")
		r.plan([r.place("dec", PARENT_HZ)])
		await r.manager.startAll()
		const channel = r.channelOf("dec")
		r.instance("dec").exit(1)
		r.plan([r.place("dec", PARENT_HZ + 50_000)])
		await r.settle()
		// The move waits for the crash's own restart, as it waits for a scheduled crash retry.
		expect(r.restarting).toEqual([])
		expect(r.spawns("dec")).toBe(1)
		expect(r.granted).toHaveLength(1)
		await r.advance(CHANNEL_FATE_MS)
		expect(r.restarting).toEqual(["dec"])
		await r.advance(100)
		expect(r.spawns("dec")).toBe(2)
		expect(r.manager.getStatus("dec")).toMatchObject({
			running: true,
			restartCount: 1,
			lastError: { kind: "exit" },
		})
		expect(r.failures("dec")).toBe(1)
		expect(r.instance("dec").options["channelHz"]).toBe(PARENT_HZ + 50_000)
		expect(r.granted).toHaveLength(2)
		expect(r.releases(channel)).toBe(1)
		await r.advance(CHANNEL_FATE_MS * 2)
		expect(r.restarting).toEqual(["dec"])
		expect(r.spawns("dec")).toBe(2)
		await r.closeAll()
		expect(r.releases(channel)).toBe(1)
	})

	it("an operator start while the crash waits: no crash-path restart, its channel released once, one start", async () => {
		const r = setup()
		r.create("dec")
		r.plan([r.place("dec", PARENT_HZ)])
		await r.manager.startAll()
		const channel = r.channelOf("dec")
		r.instance("dec").exit(1)
		await r.manager.startDecoder("dec")
		await r.advance(CHANNEL_FATE_MS * 2)
		expect(r.restarting).toEqual([])
		expect(r.spawns("dec")).toBe(2)
		expect(r.releases(channel)).toBe(1)
		expect(r.manager.getStatus("dec")).toMatchObject({ running: true })
		await r.closeAll()
		expect(r.releases(channel)).toBe(1)
	})
})

describe("the core's composition (settlement adapter over wavekit-chan)", () => {
	it("retunes a handed-off worker channel in place: retuned, no restart, bytesIn counted under its new id", async () => {
		const r = setup({ composed: true })
		const core = r.core!
		r.create("dec")
		const vfo = r.place("dec", CENTER + 10_000, false, "vfo")
		r.plan([r.place("dec", PARENT_HZ), vfo])
		await r.manager.startAll()
		const worker = r.instance(vfo.key)
		expect(worker.spawnedWith).toHaveLength(1)
		expect(worker.relayed).toEqual([])
		const row = core.chan
			.openChannelRows()
			.find(item => item.decoderId === vfo.key)!
		core.stats(row.id, 100)
		expect(r.manager.getStatus(vfo.key)?.stats.bytesIn).toBe(800)
		const moved = r.place("dec", WORKER_HZ, false, "vfo")
		r.plan([r.place("dec", PARENT_HZ), moved])
		await r.settle()
		expect(core.sent.filter(item => item.type === "retune")).toEqual([
			expect.objectContaining({ channelId: row.id, centerHz: WORKER_HZ }),
		])
		expect(r.manager.getStatus(vfo.key)).toBeUndefined()
		expect(r.manager.getStatus(moved.key)).toMatchObject({
			running: true,
			restartCount: 0,
		})
		expect(worker.starts).toBe(1)
		expect(worker.stops).toBe(0)
		expect(r.restarting).toEqual([])
		core.stats(row.id, 580)
		expect(r.manager.getStatus(moved.key)?.stats.bytesIn).toBe(580 * 8)
		await r.closeAll()
	})

	it("relay mode: no channel-stats listener below the adapter and a stats line emits nothing", async () => {
		const r = setup({ composed: true, channelInput: "relay" })
		const core = r.core!
		r.create("dec")
		r.plan([r.place("dec", PARENT_HZ)])
		await r.manager.startAll()
		expect(r.instance("dec").relayed).toHaveLength(1)
		expect(r.instance("dec").spawnedWith).toEqual([])
		expect(core.chan.listenerCount("channel-stats")).toBe(0)
		const emit = vi.spyOn(core.chan, "emit")
		core.stats(core.chan.openChannelRows()[0]!.id, 100)
		expect(emit.mock.calls.some(call => call[0] === "channel-stats")).toBe(
			false,
		)
		await r.manager.destroy()
	})
})
