/**
 * Pending voice under the dsd-fme adapter's real call timing. The
 * router learns of a call only from the adapter's `voice-call` event, which the adapter emits
 * when its call timer (every 500 ms, free phase) promotes the pending call created by the first
 * `SLOT` line, no earlier than 100 ms after it. So the first voice reaches the router up to
 * VC*→SLOT (600 ms in direct mode) + 600 ms before its call. This replays the PROVISIONAL
 * dv-latency seeds' lines through the production adapter on a fake clock at every timer phase
 * (20 ms steps) to get the call events, then drives the router with the seed's voice (three
 * 20 ms frames at the end of every 60 ms burst from the first `VC*` line to the over's end,
 * with no call before the event) and the over's own unchecked carrier (Voice only off), and
 * checks that the call head plays whole and what the listener waits and hears raw.
 */
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import type * as http from "node:http"
import { describe, expect, it } from "vitest"
import {
	AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS,
	AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS,
	AUTO_ROUTE_PENDING_VOICE_MS,
	AUTO_ROUTE_SEED_VOICE_TO_SLOT_MS,
	AUTO_ROUTE_STREAM,
	AUTO_ROUTE_TAKEOVER_MS,
} from "../../../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
	VoiceTapSource,
} from "../../../../src/core/auto-listen/contract.js"
import { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { lcg } from "./helpers.js"

const logger = createLogger({ level: "fatal" })
/** The fake clock's origin for the adapter (seed time 0). */
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
/** Timer phases tried: 0 to 480 ms in 20 ms steps (25 phases of the 500 ms period). */
const PHASE_STEP_MS = 20
/** One DMR burst (60 ms) carries three 20 ms vocoder frames of 160 samples at 8 kHz. */
const BURST_MS = 60
const FRAMES_PER_BURST = 3
/** Idle after the last line: the adapter's 4 s call timeout plus a timer period, and more. */
const IDLE_MS = 5_000

interface Seed {
	overs: Array<{ index: number; slot: number; startMs: number; endMs: number }>
	lines: Array<{ atMs: number; text: string }>
}

function loadSeed(scene: string): Seed {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../../mocks/fixtures/synthetic/dv-latency-${scene}.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as Seed
}

interface CallEvent {
	atMs: number
	call: VoiceTapCall
}

/** Runs `fn` with `Date.now()` and `new Date()` reading `clock.now`. */
function withFakeDate<T>(clock: { now: number }, fn: () => T): T {
	const RealDate = Date
	class FakeDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(clock.now)
			else super(...(args as [string | number | Date]))
		}
		static override now(): number {
			return clock.now
		}
	}
	globalThis.Date = FakeDate as DateConstructor
	try {
		return fn()
	} finally {
		globalThis.Date = RealDate
	}
}

/**
 * The seed's lines through the production adapter, its call timer firing at `phaseMs` + k × 500
 * (as its setInterval would); every `voice-call` event with its seed time.
 */
function replayCalls(seed: Seed, phaseMs: number): CallEvent[] {
	const decoder = new DsdFmeDecoder(
		{ id: "dmr", type: "dsd-fme", enabled: true, options: { mode: "auto" } },
		logger,
	)
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
	}
	const clock = { now: T0 }
	const events: CallEvent[] = []
	decoder.on("voice-call", (state: VoiceTapCall) => {
		events.push({
			atMs: clock.now - T0,
			call: {
				callId: state.callId,
				active: state.active,
				encrypted: state.encrypted,
				protocol: state.protocol,
				slot: state.slot,
			},
		})
	})
	withFakeDate(clock, () => {
		let tick = T0 + phaseMs
		const advance = (to: number): void => {
			for (; tick <= to; tick += AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS) {
				clock.now = tick
				internals.checkCallTimeoutAsync()
			}
			clock.now = Math.max(clock.now, to)
		}
		let last = 0
		for (const line of seed.lines) {
			last = Math.max(last, line.atMs)
			advance(T0 + last)
			internals.handleOutputLine(line.text)
		}
		advance(T0 + last + IDLE_MS)
	})
	return events
}

interface OverTiming {
	startMs: number
	endMs: number
	/** First `VC*` line of the over's slot: its first voice. */
	voiceMs: number
	/** First `SLOT` line of the over's slot. */
	slotMs: number
	/** The adapter's call start event for it (null: none in the over). */
	start: CallEvent | null
	end: CallEvent | null
}

function overTiming(
	seed: Seed,
	over: Seed["overs"][number],
	calls: readonly CallEvent[],
): OverTiming {
	const inOver = seed.lines.filter(
		l => l.atMs >= over.startMs && l.atMs <= over.endMs,
	)
	const tag = `[slot${over.slot}]`
	const vc = inOver.find(
		l =>
			l.text.includes("VC*") &&
			(!l.text.includes("[slot") || l.text.includes(tag)),
	)
	const slot = inOver.find(l => l.text.includes(`SLOT ${over.slot} `))
	if (vc === undefined || slot === undefined) throw new Error("seed lines")
	// The over's call: the first start at or after its SLOT line, on its slot.
	const start =
		calls.find(
			e => e.call.active && e.atMs >= slot.atMs && e.call.slot === over.slot,
		) ?? null
	const end =
		start === null
			? null
			: (calls.find(
					e => !e.call.active && e.call.callId === start.call.callId,
				) ?? null)
	return {
		startMs: over.startMs,
		endMs: over.endMs,
		voiceMs: vc.atMs,
		slotMs: slot.atMs,
		start,
		end,
	}
}

class FakeClock implements AutoRouteClock {
	t = 0
	private fn: (() => void) | null = null
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
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

class FakeResponse extends EventEmitter {
	writableEnded = false
	destroyed = false
	write(): boolean {
		return true
	}
	end(): void {
		this.writableEnded = true
		this.emit("close")
	}
	destroy(): void {
		this.destroyed = true
		this.emit("close")
	}
}

class FakeVoice implements VoiceTapSource, VoiceCoveragePort {
	tap: VoiceTap | null = null
	readonly voiceSampleRate = 8_000
	readonly generation = 0
	addVoiceTap(tap: VoiceTap): () => void {
		this.tap = tap
		return () => {
			if (this.tap === tap) this.tap = null
		}
	}
	covers(): VoiceCoverage {
		return "yes"
	}
}

interface Played {
	/** Decoded voice samples played, in order. */
	voice: number[]
	/** Output time of the first decoded sample (ms of seed time), null: none. */
	firstVoiceOutMs: number | null
	/** Loud analog (the over's carrier) played from the over start, ms. */
	buzzMs: number
	pendingOverwrittenMs: number
	droppedSamples: number
}

/**
 * The router over one over, 20 ms blocks on the seed's time: the carrier (unchecked analog, loud)
 * from the over start to its end, the voice bursts, and the call events at `callAtMs` (start) and
 * `endAtMs` (end). Frames before the start event carry no call.
 */
function routeOver(
	t: OverTiming,
	callAtMs: number,
	endAtMs: number,
	seed = 7,
): Played {
	const clock = new FakeClock()
	// From 200 ms before the over (ten silent blocks), on the 20 ms block grid.
	const begin = Math.max(0, Math.floor((t.startMs - 200) / 20) * 20)
	clock.t = begin
	const voice = new FakeVoice()
	const pendingReads: Array<{ source: string; count: number }> = []
	const router = new AutoListenRouter(logger, {
		clock,
		wallClock: () => 1_700_000_000_000 + clock.t,
		trace: tr => {
			if (tr.kind === "read")
				pendingReads.push({ source: tr.source, count: tr.count })
		},
	})
	router.attachVoice(voice, voice)
	router.setAnalogVoiceChecked(false)
	const played: Played = {
		voice: [],
		firstVoiceOutMs: null,
		buzzMs: 0,
		pendingOverwrittenMs: 0,
		droppedSamples: 0,
	}
	const write = router.registry.write.bind(router.registry)
	router.registry.write = (chunk: Buffer) => {
		let at = 0
		for (const r of pendingReads) {
			for (let k = 0; k < r.count; k++) {
				const v = chunk.readInt16LE(2 * (at + k))
				if (r.source === "analog") {
					if (v !== 0) played.buzzMs += 1 / 48
				} else {
					played.firstVoiceOutMs ??= clock.t
					played.voice.push(v)
				}
			}
			at += r.count
		}
		pendingReads.length = 0
		write(chunk)
	}
	router.registry.register(
		new FakeResponse() as unknown as http.ServerResponse,
		"127.0.0.1",
		AUTO_ROUTE_STREAM,
	)
	const start: VoiceTapCall = {
		callId: "c1",
		active: true,
		encrypted: false,
		protocol: "DMR",
		slot: 1,
	}
	const end: VoiceTapCall = { ...start, active: false }
	// Schedule: bursts from the first voice line to the over's end, the call events.
	const rand = lcg(seed)
	const events: Array<{ at: number; order: number; run: () => void }> = []
	events.push({
		at: callAtMs,
		order: 0,
		run: () => voice.tap?.call("dmr", start),
	})
	for (let b = t.voiceMs; b <= t.endMs; b += BURST_MS) {
		const frames: Buffer[] = []
		for (let f = 0; f < FRAMES_PER_BURST; f++) {
			const pcm = Buffer.alloc(320)
			for (let i = 0; i < 160; i++) {
				const v = Math.round((rand() * 2 - 1) * 20_000)
				pcm.writeInt16LE(v === 0 ? 1 : v, i * 2)
			}
			frames.push(pcm)
		}
		const at = b
		events.push({
			at,
			order: 1,
			run: () => {
				for (const f of frames)
					voice.tap?.frame("dmr", f, at >= callAtMs ? start : null)
			},
		})
	}
	events.push({ at: endAtMs, order: 2, run: () => voice.tap?.call("dmr", end) })
	// Same block: the call event first (as the service hands it over).
	events.sort((a, b) => a.at - b.at || a.order - b.order)
	const loud = Buffer.alloc(960 * 2)
	for (let i = 0; i < 960; i++)
		loud.writeInt16LE(i % 2 === 0 ? 8_000 : -8_000, i * 2)
	const quiet = Buffer.alloc(960 * 2)
	const stream = { rate: 48_000, format: "s16le" as const }
	const stopAt = Math.max(endAtMs, t.endMs) + 3_000
	let next = 0
	for (let ms = begin; ms < stopAt; ms += 20) {
		const on = ms >= t.startMs && ms < t.endMs
		router.pushAnalog(on ? loud : quiet, 0, 1_920, on, stream)
		while (next < events.length && (events[next]?.at ?? 0) < ms + 20) {
			events[next]?.run()
			next++
		}
		clock.tick(20)
	}
	played.pendingOverwrittenMs = router.pendingOverwrittenMs
	played.droppedSamples = router.droppedSamples
	router.destroy()
	return played
}

/** Index of the first differing sample, -1 when equal (a loop: no deep-equal of long arrays). */
function firstMismatch(a: readonly number[], b: readonly number[]): number {
	const n = Math.max(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
	return -1
}

const SCENES = ["dmr-direct-no-terminator", "dmr-repeater-gaps-same"] as const

describe("pending voice under the adapter's call promotion (dv-latency seeds)", () => {
	const phases = Array.from(
		{ length: AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS / PHASE_STEP_MS },
		(_, k) => k * PHASE_STEP_MS,
	)

	it("the adapter announces a call 100 to 600 ms after its SLOT line, so the first voice is at most 1 200 ms ahead of it: inside the 1 360 ms bound", () => {
		let maxLag = Number.NEGATIVE_INFINITY
		let minLag = Number.POSITIVE_INFINITY
		let maxAhead = Number.NEGATIVE_INFINITY
		for (const scene of SCENES) {
			const seed = loadSeed(scene)
			for (const phase of phases) {
				const calls = replayCalls(seed, phase)
				for (const over of seed.overs) {
					const t = overTiming(seed, over, calls)
					expect(t.start).not.toBeNull()
					const at = t.start?.atMs ?? 0
					maxLag = Math.max(maxLag, at - t.slotMs)
					minLag = Math.min(minLag, at - t.slotMs)
					maxAhead = Math.max(maxAhead, at - t.voiceMs)
				}
			}
		}
		// The announce hold and the promotion period, as the constants say (dsd-fme.ts:575, 578).
		expect(minLag).toBeGreaterThanOrEqual(AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS)
		expect(maxLag).toBeLessThanOrEqual(
			AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS +
				AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS,
		)
		// The worst phase is seen (within one 20 ms phase step).
		expect(maxLag).toBeGreaterThan(
			AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS +
				AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS -
				PHASE_STEP_MS,
		)
		// 600 + 600 = 1 200 ms at most from the first voice; the bound adds burst and margin.
		expect(maxAhead).toBeLessThanOrEqual(
			AUTO_ROUTE_SEED_VOICE_TO_SLOT_MS +
				AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS +
				AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS,
		)
		expect(maxAhead).toBeLessThan(AUTO_ROUTE_PENDING_VOICE_MS)
	})

	for (const scene of SCENES) {
		it(`${scene}: at every timer phase the call head plays whole (pendingOverwrittenMs 0), decoded voice starts at the call event, the carrier plays raw until then`, () => {
			const seed = loadSeed(scene)
			let worstTtv = 0
			let worstBuzz = 0
			for (const phase of phases) {
				const calls = replayCalls(seed, phase)
				for (const over of seed.overs) {
					const t = overTiming(seed, over, calls)
					const callAt = t.start?.atMs ?? 0
					const endAt = t.end?.atMs ?? t.endMs
					const got = routeOver(t, callAt, endAt, over.index + 1)
					// The reference: the same voice with the call active from its first frame.
					const ref = routeOver(t, t.voiceMs, endAt, over.index + 1)
					const label = { scene, phase, over: over.index }
					expect({ ...label, overwritten: got.pendingOverwrittenMs }).toEqual({
						...label,
						overwritten: 0,
					})
					expect({ ...label, dropped: got.droppedSamples }).toEqual({
						...label,
						dropped: 0,
					})
					// The call head plays whole: exactly the reference's decoded voice (first mismatch).
					expect(got.voice.length).toBe(ref.voice.length)
					expect({
						...label,
						mismatch: firstMismatch(got.voice, ref.voice),
					}).toEqual({
						...label,
						mismatch: -1,
					})
					// Time to audio: the call event (its age passes the start buffer), within a block.
					const ttv =
						(got.firstVoiceOutMs ?? Number.POSITIVE_INFINITY) - t.voiceMs
					expect(ttv).toBeGreaterThanOrEqual(callAt - t.voiceMs)
					expect(ttv).toBeLessThanOrEqual(callAt - t.voiceMs + 40)
					// Buzz: the carrier from the over start until the call takes it over.
					expect(got.buzzMs).toBeLessThanOrEqual(callAt - t.startMs + 40)
					// The reference takes over after its 200 ms start buffer.
					expect(ref.buzzMs).toBeLessThanOrEqual(
						t.voiceMs - t.startMs + AUTO_ROUTE_TAKEOVER_MS + 40,
					)
					worstTtv = Math.max(worstTtv, ttv)
					worstBuzz = Math.max(worstBuzz, got.buzzMs)
				}
			}
			// Measured worst over the phases (seed time, block rounding included): direct mode
			// 1 209.6 ms to audio and 1 299.6 ms of buzz (first voice 127.5 ms into the over, SLOT
			// 600 ms later, the call event up to 600 ms after that); behind a repeater (SLOT 240 ms
			// after the first voice) 850.8 ms and 939.6 ms. Far past the 300 ms time-to-audio and
			// 400 ms buzz targets: see tests/integration/listen-scenes.test.ts.
			if (scene === "dmr-direct-no-terminator") {
				expect(worstTtv).toBeLessThanOrEqual(1_210)
				expect(worstTtv).toBeGreaterThan(1_180)
				expect(worstBuzz).toBeLessThanOrEqual(1_300)
			} else {
				expect(worstTtv).toBeLessThanOrEqual(851)
				expect(worstTtv).toBeGreaterThan(820)
				expect(worstBuzz).toBeLessThanOrEqual(940)
			}
		}, 120_000)
	}
})
