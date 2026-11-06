// The real AutoListenRouter, client registry and web jitter ring through a core that stalls: what a
// listener gets at the old catch-up bound (5 blocks) and the current one (25). Fake clock, explicit
// order of ticks and audio, so every figure is exact for a given run.
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS,
} from "@wavekit/api-types"
import type * as ApiTypes from "@wavekit/api-types"
import { AUTO_ROUTE_STREAM } from "../../../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceTap,
	VoiceTapSource,
} from "../../../../src/core/auto-listen/contract.js"
import type { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	PcmDecoder,
	PcmRing,
	RING_MAX_MS,
} from "../../../../web/src/features/listen/pcm.js"

const logger = createLogger({ level: "fatal" })
const RATE = 48_000
const SAMPLES_PER_MS = RATE / 1000
const QUANTUM = 128
/** Chunk the fake source delivers each 20 ms: 960 samples of steady audio. */
const CHUNK_SAMPLES = 960
const SECONDS = 60

type Order = "pipe-first" | "tick-first" | "source-lost"

interface Scenario {
	/** Stalled milliseconds at the start of each period. */
	stallMs: number
	periodMs: number
	order: Order
}

class StepClock implements AutoRouteClock {
	t = 0
	fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
}

class RingResponse extends EventEmitter {
	writableEnded = false
	destroyed = false
	bytes = 0
	private readonly decoder = new PcmDecoder("s16le", 1)
	constructor(private readonly ring: PcmRing) {
		super()
	}
	write(chunk: Buffer): boolean {
		this.bytes += chunk.length
		this.ring.push(this.decoder.push(chunk))
		return true
	}
	end(): void {
		this.writableEnded = true
	}
	destroy(): void {
		this.destroyed = true
	}
}

/** The router module with its catch-up bound replaced; the bound is a module constant. */
async function routerAt(blocks: number): Promise<typeof AutoListenRouter> {
	vi.resetModules()
	vi.doMock("@wavekit/api-types", async importOriginal => ({
		...(await importOriginal<typeof ApiTypes>()),
		LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS: blocks,
	}))
	const mod = await import("../../../../src/core/auto-listen/router.js")
	return mod.AutoListenRouter
}

interface Result {
	/** Share of real time written to the client, percent. */
	delivered: number
	/** Share of real time the ring played non-zero audio, percent. */
	audible: number
	gaps: number
	rebases: number
	routeUnderruns: number
	fifoDroppedMs: number
	ringDroppedMs: number
	endLatencyMs: number
}

async function run(blocks: number, s: Scenario): Promise<Result> {
	const Router = await routerAt(blocks)
	const clock = new StepClock()
	const router = new Router(logger, { clock, wallClock: () => 0 })
	const ring = new PcmRing({ rate: RATE })
	const client = new RingResponse(ring)
	router.registry.register(
		client as unknown as http.ServerResponse,
		"127.0.0.1",
		AUTO_ROUTE_STREAM,
	)
	const chunk = Buffer.alloc(CHUNK_SAMPLES * 2)
	for (let i = 0; i < CHUNK_SAMPLES; i++) chunk.writeInt16LE(1_000, i * 2)
	const push = () =>
		router.pushAnalog(chunk, 0, chunk.length, true, {
			rate: RATE,
			format: "s16le",
		})
	const out = new Float32Array(QUANTUM)
	const total = SECONDS * 1000
	let owedChunks = 0
	let quantaDue = 0
	let audibleSamples = 0
	for (let t = 1; t <= total; t++) {
		clock.t = t
		const stalled = t % s.periodMs < s.stallMs
		const onBeat = t % LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS === 0
		if (onBeat) {
			if (stalled) {
				if (s.order !== "source-lost") owedChunks += 1
			} else {
				if (s.order === "tick-first") clock.fn?.()
				for (; owedChunks > 0; owedChunks--) push()
				push()
				if (s.order !== "tick-first") clock.fn?.()
			}
		}
		quantaDue += SAMPLES_PER_MS / QUANTUM
		while (quantaDue >= 1) {
			quantaDue -= 1
			ring.render(out)
			for (const v of out) if (v !== 0) audibleSamples += 1
		}
	}
	const status = router.status({ httpUrl: "h", wavUrl: "w" })
	const totalSamples = total * SAMPLES_PER_MS
	const result: Result = {
		delivered: (client.bytes / 2 / totalSamples) * 100,
		audible: (audibleSamples / totalSamples) * 100,
		gaps: ring.underruns,
		rebases: router.clockRebases,
		routeUnderruns: router.underruns,
		fifoDroppedMs: router.droppedSamples / SAMPLES_PER_MS,
		ringDroppedMs: ring.droppedSamples / SAMPLES_PER_MS,
		endLatencyMs: status.latencyMs + ring.bufferedMs,
	}
	router.destroy()
	return result
}

afterEach(() => {
	vi.doUnmock("@wavekit/api-types")
	vi.resetModules()
})

describe("the catch-up bound", () => {
	it("equals the web ring's maximum", () => {
		expect(
			LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS * LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
		).toBe(RING_MAX_MS)
	})
})

// Ticks and source chunks sit on a 20 ms grid, so a 290 ms stall is a 300 ms hole in ticks.
// `delivered` and `audible` are percent of 60 s, the milliseconds are exact to within 1 ms.
const BUSY: Scenario = { stallMs: 290, periodMs: 1000, order: "pipe-first" }
describe("60 s of steady audio through a stalling core, real router and ring", () => {
	it.each<[string, number, Scenario, Result]>([
		[
			"150 ms each second, audio first, old bound",
			5,
			{ stallMs: 150, periodMs: 1000, order: "pipe-first" },
			{
				delivered: 92,
				audible: 91.84,
				gaps: 29,
				rebases: 60,
				routeUnderruns: 0,
				fifoDroppedMs: 1880,
				ringDroppedMs: 0,
				endLatencyMs: 3019,
			},
		],
		[
			"150 ms each second, audio first",
			25,
			{ stallMs: 150, periodMs: 1000, order: "pipe-first" },
			{
				delivered: 99.97,
				audible: 99.67,
				gaps: 0,
				rebases: 0,
				routeUnderruns: 1,
				fifoDroppedMs: 0,
				ringDroppedMs: 0,
				endLatencyMs: 197,
			},
		],
		[
			"290 ms each second, audio first, old bound",
			5,
			BUSY,
			{
				delivered: 78,
				audible: 77.7,
				gaps: 59,
				rebases: 60,
				routeUnderruns: 0,
				fifoDroppedMs: 10_280,
				ringDroppedMs: 0,
				endLatencyMs: 3097,
			},
		],
		[
			"290 ms each second, audio first",
			25,
			BUSY,
			{
				delivered: 99.97,
				audible: 99.47,
				gaps: 1,
				rebases: 0,
				routeUnderruns: 1,
				fifoDroppedMs: 0,
				ringDroppedMs: 0,
				endLatencyMs: 319,
			},
		],
		[
			"290 ms each second, tick first, old bound",
			5,
			{ ...BUSY, order: "tick-first" },
			{
				delivered: 78,
				audible: 77.54,
				gaps: 59,
				rebases: 60,
				routeUnderruns: 0,
				fifoDroppedMs: 10_280,
				ringDroppedMs: 0,
				endLatencyMs: 3197,
			},
		],
		[
			"290 ms each second, tick first",
			25,
			{ ...BUSY, order: "tick-first" },
			{
				delivered: 99.97,
				audible: 98.93,
				gaps: 1,
				rebases: 0,
				routeUnderruns: 2,
				fifoDroppedMs: 0,
				ringDroppedMs: 0,
				endLatencyMs: 639,
			},
		],
		[
			"290 ms each second, source audio lost, old bound",
			5,
			{ ...BUSY, order: "source-lost" },
			{
				delivered: 78,
				audible: 69.7,
				gaps: 59,
				rebases: 60,
				routeUnderruns: 241,
				fifoDroppedMs: 0,
				ringDroppedMs: 0,
				endLatencyMs: 197,
			},
		],
		[
			"290 ms each second, source audio lost: full rate, still holes",
			25,
			{ ...BUSY, order: "source-lost" },
			{
				delivered: 99.97,
				audible: 69.5,
				gaps: 1,
				rebases: 0,
				routeUnderruns: 900,
				fifoDroppedMs: 0,
				ringDroppedMs: 0,
				endLatencyMs: 319,
			},
		],
		[
			"1.2 s each 10 s, audio first, old bound",
			5,
			{ stallMs: 1_200, periodMs: 10_000, order: "pipe-first" },
			{
				delivered: 88.8,
				audible: 88.5,
				gaps: 5,
				rebases: 6,
				routeUnderruns: 0,
				fifoDroppedMs: 3800,
				ringDroppedMs: 0,
				endLatencyMs: 3099,
			},
		],
		[
			"1.2 s each 10 s, audio first: past the bound, the loaded ring discards",
			25,
			{ stallMs: 1_200, periodMs: 10_000, order: "pipe-first" },
			{
				delivered: 92.8,
				audible: 90,
				gaps: 5,
				rebases: 6,
				routeUnderruns: 0,
				fifoDroppedMs: 1800,
				ringDroppedMs: 1500,
				endLatencyMs: 2697,
			},
		],
	])("%s (%i blocks)", async (_name, blocks, scenario, want) => {
		const got = await run(blocks, scenario)
		expect(got.delivered).toBeCloseTo(want.delivered, 1)
		expect(got.audible).toBeCloseTo(want.audible, 1)
		expect(got.gaps).toBe(want.gaps)
		expect(got.rebases).toBe(want.rebases)
		expect(got.routeUnderruns).toBe(want.routeUnderruns)
		expect(Math.abs(got.fifoDroppedMs - want.fifoDroppedMs)).toBeLessThan(1)
		expect(Math.abs(got.ringDroppedMs - want.ringDroppedMs)).toBeLessThan(1)
		expect(Math.abs(got.endLatencyMs - want.endLatencyMs)).toBeLessThan(1)
	})

	it("lost source audio is counted as underruns: 20 ms each comes to what the ear missed", async () => {
		const got = await run(LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS, {
			...BUSY,
			order: "source-lost",
		})
		const missing =
			(got.routeUnderruns * LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS) / (SECONDS * 1000)
		expect(missing * 100).toBe(30)
		expect(Math.abs(100 - got.audible - missing * 100)).toBeLessThan(1)
	})
})

/** One steady DMR call from t=0 with a single stall at 5 s, its late frames after the late tick. */
async function runCall(blocks: number, stallMs: number) {
	const Router = await routerAt(blocks)
	const clock = new StepClock()
	const router = new Router(logger, { clock, wallClock: () => 0 })
	let tap: VoiceTap | null = null
	const voice: VoiceTapSource = {
		voiceSampleRate: 8_000,
		addVoiceTap: t => {
			tap = t
			return () => {
				tap = null
			}
		},
	}
	router.attachVoice(voice, { generation: 0, covers: () => "yes" })
	const ring = new PcmRing({ rate: RATE })
	const client = new RingResponse(ring)
	router.registry.register(
		client as unknown as http.ServerResponse,
		"127.0.0.1",
		AUTO_ROUTE_STREAM,
	)
	const route: string[] = []
	router.on("auto-route-changed", (l: { active: string }) =>
		route.push(l.active),
	)
	const frame = Buffer.alloc(320)
	for (let i = 0; i < 160; i++) frame.writeInt16LE(1_000, i * 2)
	const call = {
		callId: "c",
		active: true,
		encrypted: false,
		protocol: "DMR",
		slot: 1,
	}
	const push = () => (tap as VoiceTap | null)?.frame("d", frame, call)
	const out = new Float32Array(QUANTUM)
	let owed = 0
	let quantaDue = 0
	let audibleSamples = 0
	const total = 10_000
	for (let t = 1; t <= total; t++) {
		clock.t = t
		const stalled = t > 5_000 && t < 5_000 + stallMs
		if (t % LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS === 0) {
			if (stalled) owed += 1
			else {
				clock.fn?.()
				for (; owed > 0; owed--) push()
				push()
			}
		}
		quantaDue += SAMPLES_PER_MS / QUANTUM
		while (quantaDue >= 1) {
			quantaDue -= 1
			ring.render(out)
			for (const v of out) if (v !== 0) audibleSamples += 1
		}
	}
	const result = {
		route,
		audibleMs: audibleSamples / SAMPLES_PER_MS,
		droppedMs: router.droppedSamples / SAMPLES_PER_MS,
		underruns: router.underruns,
		rebases: router.clockRebases,
		gaps: ring.underruns,
		latencyMs: router.status({ httpUrl: "h", wavUrl: "w" }).latencyMs,
	}
	router.destroy()
	return result
}

describe("one catch-up across a digital call", () => {
	it("frames after the late tick, a stall under the 300 ms release: the route stays digital", async () => {
		const got = await runCall(25, 280)
		// "none" at the end is the router being destroyed
		expect(got.route).toEqual(["digital", "none"])
		expect(got.droppedMs).toBe(0)
		expect(got.rebases).toBe(0)
	})

	// One `now` serves the whole burst, and it is the true time: the burst can empty the queue 300 ms
	// after the last frame, so the source releases mid-burst and returns with the late frames.
	it("frames after the late tick, a stall at the release: one extra switch, no audio dropped", async () => {
		const got = await runCall(25, 400)
		expect(got.route).toEqual(["digital", "none", "digital", "none"])
		expect(got.droppedMs).toBe(0)
		expect(got.rebases).toBe(0)
		// the old bound's client went dry about as long: the ear loses no more than 100 ms over it
		const old = await runCall(5, 400)
		expect(old.route).toEqual(["digital", "none"])
		expect(old.audibleMs - got.audibleMs).toBeLessThanOrEqual(100)
	})
})
