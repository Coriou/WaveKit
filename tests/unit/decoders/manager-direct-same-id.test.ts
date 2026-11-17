/**
 * The same channel id in the same generation. A capture-centre move that keeps the wavekit-chan process closes the
 * decoder's channel and grants it again under the old id (`<decoderId>-g<generation>`), and the decoder manager matches
 * stats and terminal events by (generation, id) only. What keeps the old channel's events off the new grant is the
 * producer's order: an entry is forwarded only for an id in the open table, the id is granted again only after the old
 * `closed` lifts the close fence, and both travel on one FIFO event stream. These tests compose the real
 * ChannelizerManager (through the settlement adapter, as the core does) with a scripted process and fake children,
 * and check that order end to end. Fake clock; nothing connects anywhere.
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
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FakeSources, iqCaps } from "../../mocks/rate-fakes.js"
import {
	CENTER,
	DirectDecoder,
	type FakeSocket,
	fakeSocket,
} from "./direct-channel-fakes.js"

const DEBOUNCE = 350
const ID = "dec-g1"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	try {
		for (const dispose of cleanup.splice(0).reverse()) await dispose()
	} finally {
		vi.useRealTimers()
	}
})

function setup() {
	vi.useFakeTimers()
	const silent = pino({ level: "silent" })
	const lines: Array<Record<string, unknown>> = []
	const logger = pino(
		{ level: "info" },
		{ write: (line: string) => void lines.push(JSON.parse(line)) },
	)
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	const fanout = new FanoutManager(silent)
	const dir = mkdtempSync("/tmp/wkds-")
	const sent: ChannelizerRequest[] = []
	/** Close requests the process has not answered yet: the test answers them, as late as it likes. */
	const unansweredCloses: string[] = []
	const sockets: FakeSocket[] = []
	const event = (body: Record<string, unknown>) =>
		proc.emit("event", { v: 1, generation: 1, ...body })
	const proc = Object.assign(new EventEmitter(), {
		generation: 1,
		input: new PassThrough(),
		start: () => {
			// This binary takes `recenter`: a centre move keeps the process and its generation.
			event({ type: "ready", pid: 1, recenter: true })
			return Promise.resolve()
		},
		stop: () => Promise.resolve(),
		send: (r: ChannelizerRequest) => {
			sent.push(r)
			if (r.type === "open")
				event({
					type: "opened",
					id: r.id,
					socket: "fake",
					outputRateHz: r.outputRateHz,
					format: r.format,
					filterTaps: 10,
					groupDelaySamples: 5,
				})
			// Answered on a later turn, as a process reading the line would: after the manager queued the move.
			if (r.type === "recenter")
				queueMicrotask(() =>
					event({
						type: "recentered",
						centerHz: r.centerHz,
						atInputBytes: r.atInputBytes,
					}),
				)
			if (r.type === "close") unansweredCloses.push(r.id)
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
	const settlement = new SettlementRegistry()
	const observer = settlement.createObserver(
		settlement.registerProviderLifetime()!,
	)
	const chan = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger: silent,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess: () => proc,
		connect,
		settlementObserver: observer,
		// The channelizer's own clock (watchdog, linger) follows the fake timers, never the host's load.
		openNow: () => Date.now(),
	})
	const channels = observer.bindProvider(chan)
	Object.assign(channels, { retuneChannel: chan.retuneChannel.bind(chan) })
	const invalidations: unknown[][] = []
	chan.on("channel-invalidated", (...args: unknown[]) =>
		invalidations.push(args),
	)

	const order: string[] = []
	const instances: DirectDecoder[] = []
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	registry.register(
		"direct-test",
		config => {
			const decoder = new DirectDecoder(config.id, order, config.options)
			instances.push(decoder)
			return decoder
		},
		caps,
	)
	const manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		channelInput: "direct",
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.setChannelizer(channels)
	const restarting: string[] = []
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
	manager.createDecoder({
		id: "dec",
		type: "direct-test",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	cleanup.push(async () => {
		await manager.destroy()
		await chan.destroy()
		fanout.destroy()
		proc.input.destroy()
		rmSync(dir, { recursive: true, force: true })
	})
	return {
		manager,
		chan,
		sources,
		sent,
		sockets,
		invalidations,
		restarting,
		lines,
		decoder: () => instances.at(-1)!,
		/** A `stats` line listing `id` with the process's own cumulative counters for it. */
		stats: (id: string, outputSamples: number, droppedSamples = 0) =>
			event({
				type: "stats",
				inputSamples: 1000,
				channels: [
					{
						id,
						outputSamples,
						queueHighWaterBytes: 0,
						droppedSamples,
						saturatedSamples: 0,
					},
				],
			}),
		/** The process answers the oldest close; `client-gone` when its writer had already failed. */
		answerClose: (reason: "requested" | "client-gone" = "requested") => {
			const id = unansweredCloses.shift()
			if (id === undefined) throw new Error("no close to answer")
			event({ type: "closed", id, reason })
		},
		unansweredCloses,
		opens: () => sent.filter(item => item.type === "open").length,
		bytesIn: () => manager.getStatus("dec")?.stats.bytesIn,
	}
}

/** The capture centre moves; the process stays, and the channel is closed and invalidated (not yet `closed`). */
async function moveCentre(r: ReturnType<typeof setup>) {
	r.sources.setCenter("rtl", CENTER + 5_000)
	await vi.advanceTimersByTimeAsync(0)
}

describe("a centre move that keeps the process: the same id in the same generation", () => {
	it("the old stats and the old closed are consumed before the id is granted again; the new grant counts from zero", async () => {
		const r = setup()
		await r.manager.startDecoder("dec")
		const first = r.decoder()
		expect(first.spawnedWith).toHaveLength(1)
		r.stats(ID, 1000)
		expect(r.bytesIn()).toBe(8000)

		await moveCentre(r)
		expect(r.chan.currentGeneration("rtl")).toBe(1)
		expect(r.invalidations).toEqual([["rtl", 1, [ID], "caps-changed"]])
		expect(r.unansweredCloses).toEqual([ID])
		// A stats line the process wrote before it took the close: the id is no longer open, nothing is credited.
		r.stats(ID, 1500)
		expect(r.bytesIn()).toBe(8000)

		// The child sees EOF and exits; the caps worker's restart asks for the same id, which waits for the fence.
		first.exit(0)
		await vi.advanceTimersByTimeAsync(DEBOUNCE)
		expect(r.opens()).toBe(1)
		expect(first.spawnedWith).toHaveLength(1)

		r.answerClose()
		await vi.advanceTimersByTimeAsync(0)
		expect(r.opens()).toBe(2)
		expect(r.sent.filter(item => item.type === "open").at(-1)).toMatchObject({
			id: ID,
		})
		expect(r.chan.currentGeneration("rtl")).toBe(1)
		expect(first.spawnedWith).toHaveLength(2)
		expect(r.manager.getStatus("dec")).toMatchObject({
			running: true,
			restartCount: 0,
		})
		expect(r.restarting).toEqual([])

		// The new channel's counter starts at zero in the process: 10 samples are 10 new samples.
		r.stats(ID, 10)
		expect(r.bytesIn()).toBe(8000 + 80)
		r.stats(ID, 30, 5)
		expect(r.bytesIn()).toBe(8000 + 200)
	})

	it("a late writer failure of the old channel (its close answered client-gone) is dropped: the new grant is untouched", async () => {
		const r = setup()
		await r.manager.startDecoder("dec")
		const first = r.decoder()
		await moveCentre(r)
		first.exit(0)
		await vi.advanceTimersByTimeAsync(DEBOUNCE)
		// The old channel's writer had failed before the process took the close: `closed {client-gone}` for the id.
		r.answerClose("client-gone")
		await vi.advanceTimersByTimeAsync(0)
		expect(first.spawnedWith).toHaveLength(2)
		const fresh = r.sockets.at(-1)!
		expect(fresh).toBe(first.spawnedWith[1])
		// Only the move's invalidation: the late client-gone found no open channel of that id.
		expect(r.invalidations).toEqual([["rtl", 1, [ID], "caps-changed"]])
		expect(
			r.lines.filter(line => line["msg"] === "Channel died; invalidating it"),
		).toEqual([])
		await vi.advanceTimersByTimeAsync(5_000)
		expect(r.manager.getStatus("dec")).toMatchObject({
			running: true,
			restartCount: 0,
		})
		expect(r.manager.getStatus("dec")?.lastError ?? null).toBeNull()
		expect(r.restarting).toEqual([])
		expect(first.spawnedWith).toHaveLength(2)
		// The new grant still counts: its own stats are credited from zero.
		r.stats(ID, 4)
		expect(r.bytesIn()).toBe(32)
	})
})
