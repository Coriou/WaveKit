// One long-lived /auto stream against the real store, controller and jitter ring: what the card says when
// the core is too busy to keep its 20 ms pacer on time. The connection never drops in these runs.
import {
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS,
} from "@wavekit/api-types"
import type { LiveAudioStatus } from "@wavekit/api-types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient, EventsClient } from "../../src/data/index.ts"
import { LiveAudioStore } from "../../src/data/index.ts"
import { AUTO_ROUTE_READ_TIMEOUT_MS } from "../../src/data/live-audio-store.ts"
import {
	audioAttachKey,
	autoRouteSource,
} from "../../src/features/listen/audio.ts"
import {
	NO_AUDIO_HEALTH,
	ROUTE_UNKNOWN_AFTER_MS,
} from "../../src/features/listen/audio-health.ts"
import {
	DEAD_STREAM_MS,
	ListenController,
	ROUTE_POLL_MS,
	STALL_GRACE_MS,
	STATS_GAP_MS,
	type ListenPhase,
	type ListenPlayer,
} from "../../src/features/listen/controller.ts"
import {
	PcmRing,
	RING_MAX_MS,
	STATS_EVERY_S,
} from "../../src/features/listen/pcm.ts"
import type { RingStats } from "../../src/features/listen/pcm.ts"
import type { PcmPlayerEvents } from "../../src/features/listen/pcm-player.ts"

const BASE = "http://localhost:5173/"
const RATE = 48_000
const BLOCK_MS = LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS
const BLOCK_SAMPLES = 960
const CATCHUP_MAX_BLOCKS = LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS
const QUANTUM = 128

function runningStatus(zeroFilledSamples = 0): LiveAudioStatus {
	return {
		running: true,
		sourceId: "rtl-0",
		effectiveSampleRate: 25_000,
		httpUrl: "http://localhost:3102/stream",
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		squelchOpen: true,
		config: {
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: 0,
			offsetHz: 0,
			audioFormat: "s16le",
		},
		autoRoute: {
			httpUrl: "http://localhost:3102/auto",
			wavUrl: "http://localhost:3102/auto.wav",
			clientCount: 1,
			digitalAvailable: false,
			active: "analog",
			since: "2026-01-01T00:00:00.000Z",
			underruns: 0,
			zeroFilledSamples,
			droppedMs: 0,
			clockRebases: 0,
			latencyMs: 60,
		},
	} as unknown as LiveAudioStatus
}

/** The core's `/auto` pacer (src/core/auto-listen/router.ts tick): CATCHUP blocks at most, the rest is never sent. */
class CorePacer {
	private startAt: number
	private emitted = 0
	private lastTick: number
	blocks = 0

	constructor(now: number) {
		this.startAt = now
		this.lastTick = now
	}

	/** One millisecond of core time; `stalled`: the event loop does not run timers. */
	step(now: number, stalled: boolean, write: () => void): void {
		if (stalled || now - this.lastTick < BLOCK_MS) return
		this.lastTick = now
		const due = Math.floor((now - this.startAt) * (RATE / 1000))
		let sent = 0
		while (due - this.emitted >= BLOCK_SAMPLES && sent < CATCHUP_MAX_BLOCKS) {
			write()
			this.emitted += BLOCK_SAMPLES
			this.blocks += 1
			sent += 1
		}
		if (due - this.emitted >= BLOCK_SAMPLES)
			this.startAt = now - this.emitted / (RATE / 1000)
	}
}

function harness(
	routeFilled: () => number = () => 0,
	get: (signal?: AbortSignal) => Promise<LiveAudioStatus> = () =>
		Promise.resolve(runningStatus(routeFilled())),
) {
	const handlers = new Map<string, (payload: unknown) => void>()
	const events = {
		subscribe: () => () => undefined,
		on: (type: string, handler: (payload: unknown) => void) => {
			handlers.set(type, handler)
			return () => handlers.delete(type)
		},
		onReconnected: () => () => undefined,
	} as unknown as EventsClient
	const api = {
		get: (_path: string, options?: { signal?: AbortSignal }) =>
			get(options?.signal),
		post: () => Promise.resolve({ success: true }),
	} as unknown as ApiClient
	const store = new LiveAudioStore(api, events)
	let playerEvents: PcmPlayerEvents | null = null
	const plays: string[] = []
	let stops = 0
	const player: ListenPlayer = {
		unlock: () => undefined,
		play: source => void plays.push(source.url),
		stop: () => {
			stops += 1
		},
		setVolume: () => undefined,
		dispose: () => undefined,
	}
	const listen = new ListenController(store, {
		createPlayer: e => {
			playerEvents = e
			return player
		},
	})
	// AudioOutput's wiring on a core that serves /auto
	const syncSource = () => {
		const source = autoRouteSource(store.get().status, BASE)
		listen.setSource(audioAttachKey(source), source)
	}
	store.subscribe(syncSource)
	const emit = (type: string, payload: unknown) => handlers.get(type)?.(payload)
	emit("live-audio:status", runningStatus())
	const started = Date.now()
	const timeline: { at: number; phase: ListenPhase }[] = []
	listen.subscribe((next, previous) => {
		if (next.phase !== previous.phase)
			timeline.push({ at: Date.now() - started, phase: next.phase })
	})
	return {
		store,
		listen,
		emit,
		plays,
		stops: () => stops,
		timeline,
		events: () => playerEvents as unknown as PcmPlayerEvents,
	}
}

/** One running stream: the core pacer feeds the ring, the render loop follows pcm-worklet.ts. */
function runStream(
	h: ReturnType<typeof harness>,
	ms: number,
	options: {
		stalled: (t: number) => boolean
		silent?: boolean
	},
) {
	const ring = new PcmRing({ rate: RATE })
	const start = Date.now()
	const pacer = new CorePacer(0)
	const block = new Float32Array(BLOCK_SAMPLES).fill(options.silent ? 0 : 0.1)
	const out = new Float32Array(QUANTUM)
	let quantaDue = 0
	let wasPlaying = false
	let lastStats = 0
	let audibleMs = 0
	for (let t = 1; t <= ms; t++) {
		pacer.step(t, options.stalled(t), () => {
			ring.push(block)
			h.events().onData()
		})
		quantaDue += RATE / 1000 / QUANTUM
		while (quantaDue >= 1) {
			quantaDue -= 1
			if (ring.render(out)) audibleMs += (QUANTUM / RATE) * 1000
			const playing = ring.playing
			if (playing !== wasPlaying || t / 1000 - lastStats >= STATS_EVERY_S) {
				wasPlaying = playing
				lastStats = t / 1000
				h.events().onStats(ring.stats())
			}
		}
		if (t % 1000 === 0)
			h.emit("live-audio:status", {
				...runningStatus(),
				bytesStreamed: pacer.blocks * 1920,
			})
		if (t % 100 === 0)
			h.emit("live-audio:level", {
				sourceId: "rtl-0",
				channelPowerDbfs: options.silent ? -100 : -60,
				noiseFloorDbfs: -100,
				squelchOpen: !options.silent,
				thresholdDbfs: -90,
				autoRoute: { active: options.silent ? "none" : "analog" },
			})
		vi.advanceTimersByTime(1)
	}
	expect(Date.now() - start).toBe(ms)
	return { ring, pacer, audibleMs }
}

/** 290 ms every second: under the bound, so all of it is caught up and only the first stall drains the ring. */
const busyCore = (t: number) => t % 1000 < 290
/** Past the bound: 1 900 ms with no byte, 500 ms catches up, 1 400 ms is never sent. */
const drowningCore = (t: number) => t % 2150 < 1900

/** Lets the route reading's promise settle between fake-timer steps. */
async function settle(ms = 0) {
	vi.advanceTimersByTime(ms)
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("Listen on a stream the core paces late", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("the bound the pacer uses is one the ring can take", () => {
		expect(CATCHUP_MAX_BLOCKS * BLOCK_MS).toBe(RING_MAX_MS)
	})

	it.each([
		["with the squelch open", false],
		[
			"with the squelch closed (the core sends zeros at the same cadence)",
			true,
		],
	])(
		"keeps the one stream and never says Connecting %s",
		async (_name, silent) => {
			const h = harness()
			await h.listen.start()
			expect(h.plays).toEqual(["http://localhost:3102/auto"])
			const { ring, pacer } = runStream(h, 60_000, {
				stalled: busyCore,
				silent,
			})
			// a stall under the bound is caught up: all of real time was written, one connected client
			expect(pacer.blocks * BLOCK_MS).toBeGreaterThan(0.99 * 60_000)
			expect(ring.underruns).toBeLessThanOrEqual(1)
			expect(h.plays).toHaveLength(1)
			expect(h.stops()).toBe(0)
			expect(h.timeline.map(e => e.phase)).toEqual(["connecting", "playing"])
			expect(h.listen.get().phase).toBe("playing")
			expect(h.listen.get().audio.breaking).toBe(false)
		},
	)

	it("a stream mostly dry says breaking up, not a clean Listening, and stays connected", async () => {
		const h = harness()
		await h.listen.start()
		const { ring, audibleMs } = runStream(h, 60_000, { stalled: drowningCore })
		expect(ring.underruns).toBeGreaterThan(20)
		expect(audibleMs).toBeLessThan(0.5 * 60_000)
		expect(h.plays).toHaveLength(1)
		expect(h.listen.get().phase).toBe("playing")
		const { audio } = h.listen.get()
		expect(audio.breaking).toBe(true)
		expect(audio.heardPct).toBeLessThan(50)
		// what the readout says agrees with what the ring rendered, within one window's granularity
		expect(Math.abs(audio.missingMs - (60_000 - audibleMs))).toBeLessThan(2_000)
	})

	it("squelch silence never reads as breaking up, whatever the stream does", async () => {
		const h = harness()
		await h.listen.start()
		const { audibleMs } = runStream(h, 60_000, {
			stalled: drowningCore,
			silent: true,
		})
		expect(audibleMs).toBeLessThan(0.5 * 60_000)
		const { audio } = h.listen.get()
		expect(audio.breaking).toBe(false)
		expect(audio.heardPct).toBeNull()
		expect(audio.missingMs).toBe(0)
	})

	it("says Connecting within the grace when bytes stop, reattaches at the dead bound, and recovers", async () => {
		const h = harness()
		await h.listen.start()
		// 5 s of good audio, 10 s with no byte at all, then good audio again
		runStream(h, 25_000, { stalled: t => t > 5_000 && t <= 15_000 })
		const phases = h.timeline.map(e => e.phase)
		expect(phases).toEqual(["connecting", "playing", "connecting", "playing"])
		const flip = h.timeline[2]?.at ?? 0
		// the ring drains 200 ms after the last byte, then the grace runs
		expect(flip).toBeGreaterThan(5_000)
		expect(flip).toBeLessThanOrEqual(5_000 + 200 + STALL_GRACE_MS + 25)
		// the last byte, the 5 s bound, the first retry's 1 s, and the bytes return before the second bound
		expect(h.plays).toHaveLength(2)
	})
})

describe("Listen reads the core's zero-fill", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("zeros at full rate count as missing, on a stream the ring finds perfect", async () => {
		let filled = 48_000
		const h = harness(() => filled)
		await h.listen.start()
		const ring = {
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
			renderedMs: 0,
			dryMs: 0,
		}
		h.events().onStats(ring)
		await settle()
		for (let i = 1; i <= 80; i++) {
			// 290 ms of every second becomes zeros: 13 920 samples per second, 3 480 per 250 ms
			filled += 3_480
			ring.renderedMs += 250
			// bytes keep arriving: only the ring's view is perfect, nothing reattaches
			h.events().onData()
			h.events().onStats({ ...ring })
			await settle(250)
		}
		const { audio, latencyMs } = h.listen.get()
		expect(ring.dryMs).toBe(0)
		expect(audio.breaking).toBe(true)
		// once steady the 10 s window holds five 2 s readings of 580 ms: 29% missing
		expect(audio.heardPct).toBe(71)
		// 20 s less the last reading's 2 s, at 290 ms a second
		expect(audio.coreFilledMs).toBe(5_200)
		expect(audio.missingMs).toBe(audio.coreFilledMs)
		// ring 200 + core backlog 60
		expect(latencyMs).toBe(260)
	})

	it("reads at most once per bound, in ring time", async () => {
		const get = vi.fn(() => Promise.resolve(runningStatus()))
		const h = harness()
		h.store.readAutoRoute = () => get().then(status => status.autoRoute ?? null)
		await h.listen.start()
		const stats = {
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
			renderedMs: 0,
			dryMs: 0,
		}
		h.events().onStats(stats)
		await settle()
		expect(get).toHaveBeenCalledTimes(1)
		h.events().onStats({ ...stats, renderedMs: ROUTE_POLL_MS - 1 })
		await settle()
		expect(get).toHaveBeenCalledTimes(1)
		h.events().onStats({ ...stats, renderedMs: ROUTE_POLL_MS })
		await settle()
		expect(get).toHaveBeenCalledTimes(2)
	})

	it("a reading that returns after Stop and Listen again is ignored", async () => {
		let release: (route: null) => void = () => undefined
		const h = harness()
		const read = vi.fn(
			() =>
				new Promise<null>(resolve => {
					release = resolve
				}),
		)
		h.store.readAutoRoute = read
		await h.listen.start()
		const stats = {
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
			renderedMs: 0,
			dryMs: 0,
		}
		h.events().onStats(stats)
		expect(read).toHaveBeenCalledTimes(1)
		await h.listen.stop()
		await h.listen.start()
		h.events().onStats(stats)
		// not blocked by the old one still in flight
		expect(read).toHaveBeenCalledTimes(2)
		release(null)
		await settle()
		expect(read).toHaveBeenCalledTimes(2)
	})
})

describe("the core's counters only speak for time this Listen was hearing /auto", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const BLOCKS_60_S = 3_000 * BLOCK_SAMPLES

	/** Listen with a base reading taken, then `play(ms)` runs stats and readings every 250 ms. */
	async function listening() {
		const route = { filled: 0 }
		const h = harness(() => route.filled)
		await h.listen.start()
		let renderedMs = 0
		const tick = async () => {
			h.events().onData()
			h.events().onStats({
				playing: true,
				bufferedMs: 200,
				underruns: 0,
				droppedSamples: 0,
				renderedMs,
				dryMs: 0,
			})
			await settle()
		}
		await tick()
		const play = async (ms: number) => {
			for (let t = 0; t < ms; t += 250) {
				await settle(250)
				renderedMs += 250
				await tick()
			}
		}
		return { h, route, play, tick }
	}

	it("the bounds state their arithmetic", () => {
		expect(STATS_GAP_MS).toBe(4 * STATS_EVERY_S * 1000)
		expect(STATS_GAP_MS / 10_000).toBeLessThanOrEqual(0.1)
		expect(ROUTE_UNKNOWN_AFTER_MS).toBe(5 * ROUTE_POLL_MS)
	})

	it("a suspended ring: the counter rising meanwhile is not missing audio", async () => {
		const { h, route, play } = await listening()
		await play(10_000)
		await settle(30_000)
		route.filled += BLOCKS_60_S
		await play(12_000)
		expect(h.listen.get().audio).toMatchObject({
			heardPct: 100,
			missingMs: 0,
			coreFilledMs: 0,
			breaking: false,
		})
		// counted again after the new base
		route.filled += 50 * BLOCK_SAMPLES
		await play(4_000)
		expect(h.listen.get().audio.coreFilledMs).toBe(1_000)
	})

	it("a stats gap at the bound keeps the base, and one past it does not", async () => {
		const at = await listening()
		await at.play(2_000)
		await settle(STATS_GAP_MS - 250)
		at.route.filled += 25 * BLOCK_SAMPLES
		await at.play(4_000)
		expect(at.h.listen.get().audio.coreFilledMs).toBe(500)

		const past = await listening()
		await past.play(2_000)
		await settle(STATS_GAP_MS - 249)
		past.route.filled += 25 * BLOCK_SAMPLES
		await past.play(4_000)
		expect(past.h.listen.get().audio.coreFilledMs).toBe(0)
	})

	it("a switch of source: another source's count is not this one's", async () => {
		const { h, route, play } = await listening()
		await play(2_000)
		route.filled += 50 * BLOCK_SAMPLES
		h.emit("live-audio:status", {
			...runningStatus(route.filled),
			sourceId: "rtl-1",
		})
		await play(4_000)
		expect(h.listen.get().audio.coreFilledMs).toBe(0)
	})

	it("a reattach is a new stream", async () => {
		const { h, route, play } = await listening()
		await play(2_000)
		route.filled += 50 * BLOCK_SAMPLES
		h.events().onEnded("The audio stream ended")
		await settle(1_000)
		expect(h.plays).toHaveLength(2)
		await play(4_000)
		expect(h.listen.get().audio.coreFilledMs).toBe(0)
	})

	it("leaving /auto and coming back starts from a new base", async () => {
		const { h, route, play } = await listening()
		await play(2_000)
		const auto = autoRouteSource(h.store.get().status, BASE)
		const stream = {
			...auto!,
			route: "stream" as const,
			httpUrl: "http://localhost:3102/stream",
		}
		h.listen.setSource(audioAttachKey(stream), stream)
		await settle(250)
		expect(h.plays).toHaveLength(2)
		await play(2_000)
		route.filled += 200 * BLOCK_SAMPLES
		await play(2_000)
		h.listen.setSource(audioAttachKey(auto), auto)
		await settle(250)
		expect(h.plays).toHaveLength(3)
		await play(4_000)
		expect(h.listen.get().audio.coreFilledMs).toBe(0)
	})

	it("a reading in flight across a discontinuity is dropped", async () => {
		const route = { filled: 0 }
		const gets: ((status: LiveAudioStatus) => void)[] = []
		const h = harness(
			() => route.filled,
			() =>
				new Promise<LiveAudioStatus>(resolve => {
					gets.push(resolve)
				}),
		)
		await h.listen.start()
		const stats = {
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
			renderedMs: 0,
			dryMs: 0,
		}
		h.events().onStats(stats)
		expect(gets).toHaveLength(1)
		await settle(STATS_GAP_MS + 1)
		h.events().onStats(stats)
		// a new base is asked for at once; the old one coming back changes nothing
		expect(gets).toHaveLength(2)
		gets[0]?.(runningStatus(BLOCKS_60_S))
		await settle()
		gets[1]?.(runningStatus(0))
		await settle()
		expect(gets).toHaveLength(2)
	})

	/** Stats every 250 ms of ring time; `answers(renderedMs)` decides which readings succeed. */
	async function flaky(answers: (renderedMs: number) => boolean) {
		const route = { filled: 0 }
		let renderedMs = 0
		const h = harness(
			() => route.filled,
			() =>
				answers(renderedMs)
					? Promise.resolve(runningStatus(route.filled))
					: Promise.reject(new Error("no")),
		)
		await h.listen.start()
		const play = async (ms: number, each?: () => void) => {
			for (let t = 0; t < ms; t += 250) {
				h.events().onData()
				h.events().onStats({
					playing: true,
					bufferedMs: 200,
					underruns: 0,
					droppedSamples: 0,
					renderedMs,
					dryMs: 0,
				})
				await settle(250)
				renderedMs += 250
				each?.()
			}
		}
		return { h, route, play }
	}

	it("readings failing keep the base, however long: the next one counts what they missed", async () => {
		const run = async (lostMs: number) => {
			let down = false
			const { h, route, play } = await flaky(() => !down)
			await play(4_000)
			down = true
			route.filled += 25 * BLOCK_SAMPLES
			await play(lostMs)
			down = false
			await play(4_500)
			return h.listen.get().audio.coreFilledMs
		}
		expect(await run(3_500)).toBe(500)
		expect(await run(ROUTE_UNKNOWN_AFTER_MS + 8_000)).toBe(500)
	})

	it("sustained zero-fill read only every 8 s shows, about 70% heard", async () => {
		const { h, route, play } = await flaky(ms => ms % 8_000 === 0)
		// 30% of 250 ms of the route's samples at 48 kHz
		const fill = () => {
			route.filled += 3_600
		}
		await play(32_000, fill)
		const figures: (number | null)[] = []
		for (let i = 0; i < 32; i++) {
			await play(1_000, fill)
			figures.push(h.listen.get().audio.heardPct)
			expect(h.listen.get().audio.breaking).toBe(true)
		}
		// each reading credits 2 400 ms. The 10 s window holds one of them on 6 buckets of every 8, 24%
		// missing, and two on the other 2, 48%: (6 × 76 + 2 × 52) / 8 = 70
		const heard = figures.filter(f => f !== null)
		expect(heard).toHaveLength(figures.length)
		expect(Math.min(...heard)).toBeGreaterThanOrEqual(51)
		expect(Math.max(...heard)).toBeLessThanOrEqual(76)
		const mean = heard.reduce((a, b) => a + b, 0) / heard.length
		expect(Math.abs(mean - 70)).toBeLessThan(2)
	})

	it("a healthy stream read only every 8 s stays fully heard", async () => {
		const { h, play } = await flaky(ms => ms % 8_000 === 0)
		await play(32_000)
		for (let i = 0; i < 16; i++) {
			await play(1_000)
			expect(h.listen.get().audio).toMatchObject({
				heardPct: 100,
				breaking: false,
				missingMs: 0,
			})
		}
	})

	it("no reading at all has no figure, and no breaking up, past the bound", async () => {
		const { h, play } = await flaky(() => false)
		await play(ROUTE_UNKNOWN_AFTER_MS + 250)
		expect(h.listen.get().audio.heardPct).toBe(100)
		await play(1_000)
		expect(h.listen.get().audio).toMatchObject({
			heardPct: null,
			breaking: false,
		})
		await play(30_000)
		expect(h.listen.get().audio).toMatchObject({
			heardPct: null,
			breaking: false,
		})
	})

	it("a suspended ring still rebases, with the readings failing before it", async () => {
		let down = false
		const { h, route, play } = await flaky(() => !down)
		await play(4_000)
		down = true
		await play(2_000)
		await settle(30_000)
		route.filled += 3_000 * BLOCK_SAMPLES
		down = false
		await play(12_000)
		expect(h.listen.get().audio).toMatchObject({
			heardPct: 100,
			missingMs: 0,
			coreFilledMs: 0,
		})
	})
})

describe("a status read that hangs", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	/** Answers nothing until aborted, as fetch does; `hang` decides per call. */
	function hanging(hang: () => boolean) {
		const signals: AbortSignal[] = []
		const get = (signal?: AbortSignal) => {
			if (signal) signals.push(signal)
			if (!hang()) return Promise.resolve(runningStatus())
			return new Promise<LiveAudioStatus>((_resolve, reject) => {
				const abort = () => reject(new DOMException("aborted", "AbortError"))
				if (signal?.aborted) abort()
				signal?.addEventListener("abort", abort)
			})
		}
		return { get, signals }
	}

	const stats = (renderedMs: number) => ({
		playing: true,
		bufferedMs: 200,
		underruns: 0,
		droppedSamples: 0,
		renderedMs,
		dryMs: 0,
	})

	it("its lifetime fits inside the reading cadence", () => {
		expect(AUTO_ROUTE_READ_TIMEOUT_MS).toBe(1_500)
		expect(AUTO_ROUTE_READ_TIMEOUT_MS).toBeLessThan(ROUTE_POLL_MS)
	})

	it("ends at the bound, not before, and answers null", async () => {
		const { get, signals } = hanging(() => true)
		const h = harness(undefined, get)
		let answer: unknown = "pending"
		void h.store.readAutoRoute().then(route => {
			answer = route
		})
		await settle(AUTO_ROUTE_READ_TIMEOUT_MS - 1)
		expect(signals[0]?.aborted).toBe(false)
		expect(answer).toBe("pending")
		await settle(1)
		expect(signals[0]?.aborted).toBe(true)
		await settle()
		expect(answer).toBeNull()
	})

	it("later readings still run, and on time", async () => {
		let hang = true
		const { get, signals } = hanging(() => hang)
		const h = harness(undefined, get)
		await h.listen.start()
		h.events().onStats(stats(0))
		expect(signals).toHaveLength(1)
		await settle(AUTO_ROUTE_READ_TIMEOUT_MS)
		expect(signals[0]?.aborted).toBe(true)
		hang = false
		await settle(ROUTE_POLL_MS - AUTO_ROUTE_READ_TIMEOUT_MS)
		h.events().onStats(stats(ROUTE_POLL_MS))
		expect(signals).toHaveLength(2)
	})

	it("Stop aborts it, and so does dispose", async () => {
		const { get, signals } = hanging(() => true)
		const h = harness(undefined, get)
		await h.listen.start()
		h.events().onStats(stats(0))
		expect(signals[0]?.aborted).toBe(false)
		// Stop's own status read answers through the same hanging get
		void h.listen.stop()
		expect(signals[0]?.aborted).toBe(true)

		const second = hanging(() => true)
		const d = harness(undefined, second.get)
		await d.listen.start()
		d.events().onStats(stats(0))
		d.listen.dispose()
		expect(second.signals[0]?.aborted).toBe(true)
	})

	it("an aborted caller signal ends a read before it starts", async () => {
		const { get, signals } = hanging(() => true)
		const h = harness(undefined, get)
		const abort = new AbortController()
		abort.abort()
		await expect(h.store.readAutoRoute(abort.signal)).resolves.toBeNull()
		expect(signals[0]?.aborted).toBe(true)
	})
})

describe("Listen on a stream that went quiet", () => {
	const playing: RingStats = {
		playing: true,
		bufferedMs: 200,
		underruns: 0,
		droppedSamples: 0,
		renderedMs: 0,
		dryMs: 0,
	}

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function live() {
		const h = harness()
		await h.listen.start()
		h.events().onData()
		h.events().onStats(playing)
		return h
	}

	it("the bound is past the grace and the longest live gap", () => {
		expect(DEAD_STREAM_MS).toBe(5_000)
		expect(DEAD_STREAM_MS).toBeGreaterThan(STALL_GRACE_MS + 200)
	})

	it("does not reattach just under the bound, and does at it", async () => {
		const h = await live()
		vi.advanceTimersByTime(DEAD_STREAM_MS - 1)
		expect(h.listen.get().phase).toBe("playing")
		expect(h.plays).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(h.listen.get().phase).toBe("connecting")
		vi.advanceTimersByTime(999)
		expect(h.plays).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(h.plays).toHaveLength(2)
	})

	it("a slow stream with a byte inside each bound is alive, however dry the ring", async () => {
		const h = await live()
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(DEAD_STREAM_MS - 1)
			h.events().onData()
		}
		expect(h.plays).toHaveLength(1)
		expect(h.stops()).toBe(0)
	})

	it("a connection that never sends its first byte has the same bound", async () => {
		const h = harness()
		await h.listen.start()
		vi.advanceTimersByTime(DEAD_STREAM_MS)
		expect(h.listen.get().phase).toBe("connecting")
		vi.advanceTimersByTime(1_000)
		expect(h.plays).toHaveLength(2)
	})

	it("repeated silence ends in the error state, keeps trying, and audio clears it", async () => {
		const h = await live()
		// 5 + 1 + 5 + 2 + 5 + 5 + 5 = 28 s from the last byte
		vi.advanceTimersByTime(28_000 - 1)
		expect(h.listen.get().phase).toBe("connecting")
		vi.advanceTimersByTime(1)
		expect(h.listen.get().phase).toBe("error")
		expect(h.listen.get().error).toBe("No audio arrived for 5 s")
		const plays = h.plays.length
		vi.advanceTimersByTime(5_000)
		expect(h.plays.length).toBe(plays + 1)
		h.events().onData()
		h.events().onStats(playing)
		expect(h.listen.get().phase).toBe("playing")
		expect(h.listen.get().error).toBeNull()
	})

	it("stopping clears it: no timer is left and nothing reattaches", async () => {
		const h = await live()
		await h.listen.stop()
		expect(vi.getTimerCount()).toBe(0)
		vi.advanceTimersByTime(60_000)
		expect(h.plays).toHaveLength(1)
		expect(h.listen.get().phase).toBe("off")
	})

	it("a blocked context keeps saying Tap to play", async () => {
		const h = await live()
		h.events().onBlocked()
		vi.advanceTimersByTime(3 * DEAD_STREAM_MS)
		expect(h.listen.get().phase).toBe("blocked")
		expect(h.plays).toHaveLength(1)
	})
})

describe("Listen's stall grace", () => {
	const playing: RingStats = {
		playing: true,
		bufferedMs: 200,
		underruns: 0,
		droppedSamples: 0,
		renderedMs: 0,
		dryMs: 0,
	}
	const dry: RingStats = { ...playing, playing: false, bufferedMs: 0 }

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function listening() {
		const h = harness()
		await h.listen.start()
		h.events().onStats(playing)
		expect(h.listen.get().phase).toBe("playing")
		return h
	}

	it("holds Listening just short of the bound and says Connecting at it", async () => {
		const h = await listening()
		h.events().onStats(dry)
		vi.advanceTimersByTime(1_999)
		expect(h.listen.get().phase).toBe("playing")
		vi.advanceTimersByTime(1)
		expect(h.listen.get().phase).toBe("connecting")
	})

	it("a dry report while already waiting does not restart the bound", async () => {
		const h = await listening()
		h.events().onStats(dry)
		vi.advanceTimersByTime(1_500)
		h.events().onStats(dry)
		vi.advanceTimersByTime(500)
		expect(h.listen.get().phase).toBe("connecting")
	})

	it("audio back inside the bound cancels it", async () => {
		const h = await listening()
		h.events().onStats(dry)
		vi.advanceTimersByTime(1_999)
		h.events().onStats(playing)
		h.events().onData()
		vi.advanceTimersByTime(DEAD_STREAM_MS - 1)
		expect(h.timeline.map(e => e.phase)).toEqual(["connecting", "playing"])
	})

	it("a stream that ended says Connecting at once and reattaches", async () => {
		const h = await listening()
		h.events().onStats(dry)
		h.events().onEnded("The audio stream ended")
		expect(h.listen.get().phase).toBe("connecting")
		vi.advanceTimersByTime(1_000)
		expect(h.plays).toHaveLength(2)
	})

	it("stopping inside the bound leaves Listen off", async () => {
		const h = await listening()
		h.events().onStats(dry)
		await h.listen.stop()
		vi.advanceTimersByTime(DEAD_STREAM_MS + 10_000)
		expect(h.listen.get().phase).toBe("off")
	})

	it("a blocked context inside the bound stays blocked", async () => {
		const h = await listening()
		h.events().onStats(dry)
		h.events().onBlocked()
		vi.advanceTimersByTime(10_000)
		expect(h.listen.get().phase).toBe("blocked")
	})

	it("the <audio> fallback holds its waiting event to the same bound", async () => {
		const handlers = new Map<string, () => void>()
		const play = vi.fn(() => Promise.resolve())
		const el = {
			addEventListener: (type: string, fn: () => void) =>
				void handlers.set(type, fn),
			removeEventListener: () => undefined,
			removeAttribute: () => undefined,
			pause: () => undefined,
			load: () => undefined,
			play,
			volume: 1,
		} as unknown as HTMLAudioElement
		const store = new LiveAudioStore(
			{ get: () => Promise.resolve(runningStatus()) } as unknown as ApiClient,
			{
				subscribe: () => () => undefined,
				on: () => () => undefined,
				onReconnected: () => () => undefined,
			} as unknown as EventsClient,
		)
		const listen = new ListenController(store, { createPlayer: null })
		listen.bind(el)
		const source = autoRouteSource(runningStatus(), BASE)
		listen.setSource(audioAttachKey(source), source)
		await listen.start()
		handlers.get("playing")?.()
		handlers.get("waiting")?.()
		vi.advanceTimersByTime(1_999)
		expect(listen.get().phase).toBe("playing")
		handlers.get("playing")?.()
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(2_000)
			handlers.get("progress")?.()
		}
		expect(listen.get().phase).toBe("playing")
		handlers.get("waiting")?.()
		vi.advanceTimersByTime(2_000)
		expect(listen.get().phase).toBe("connecting")
		// and it reattaches at the dead bound, its last sign of bytes being the progress before the wait
		vi.advanceTimersByTime(DEAD_STREAM_MS - 2_000)
		vi.advanceTimersByTime(1_000)
		expect(play).toHaveBeenCalledTimes(2)
		listen.dispose()
	})

	it("the readout starts clean on each Listen, whatever the ring counted before", async () => {
		const h = harness()
		await h.listen.start()
		h.events().onStats({ ...playing, renderedMs: 60_000, dryMs: 9_000 })
		for (let i = 1; i <= 8; i++)
			h.events().onStats({
				...playing,
				renderedMs: 60_000 + i * 1_000,
				dryMs: 9_000 + i * 500,
			})
		expect(h.listen.get().audio.missingMs).toBe(4_000)
		await h.listen.stop()
		await h.listen.start()
		expect(h.listen.get().audio).toEqual(NO_AUDIO_HEALTH)
		h.events().onStats({ ...playing, renderedMs: 70_000, dryMs: 13_000 })
		expect(h.listen.get().audio).toEqual(NO_AUDIO_HEALTH)
	})
})
