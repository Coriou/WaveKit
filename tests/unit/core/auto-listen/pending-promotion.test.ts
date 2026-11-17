/**
 * Pending voice under the dsd-fme adapter's real call timing, on the RECORDED dv-latency seeds.
 * The router learns of a call only from the adapter's `voice-call` snapshots and admits pending
 * voice at the first that is active, not encrypted and whose encryption is known. The adapter
 * announces a call on the first line after its 100 ms start delay (or its 500 ms timer), often
 * with its encryption not known yet, and resolves it when a link control decodes. This replays
 * every recorded DMR seed's lines through the production adapter on a fake clock at every timer
 * phase (20 ms steps), then drives the router per over with the over's own call snapshots and
 * its voice (three 20 ms frames every 60 ms burst, from one line clump before its first voice
 * sync line, as datagrams can precede their clumped line, to the over's end) through the
 * digital voice service's tap gate: before the first snapshot the voice reaches the router with
 * no call; while the call is announced but not known clear the tap gets nothing (unknown slot)
 * or zeros (known slot), so /auto never has that span (pending-service-path.test.ts drives the
 * real service). The over's own carrier is unchecked analog (Voice only off). It checks that
 * the voice the router got before the admission (the head) plays whole, what the listener
 * waits and hears raw, and that a call whose encryption never resolves is never heard.
 *
 * Revoked overs: one copy of another talker's IDs after a voice burst makes the adapter publish
 * the same callId not known clear again (clear -> unknown), and the router then drops the
 * voice it queued for it (fail closed). For an over whose snapshots hold such a revoke after its
 * admission, the run is capped just before the revoke (dropped 0 and the whole-head checks hold
 * up to there), and the uncapped run is checked to drop voice and play none of it after the
 * revoke. Revoked overs are counted like merged ones.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { describe, expect, it } from "vitest"
import {
	AUTO_ROUTE_PENDING_VOICE_MS,
	AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS,
	AUTO_ROUTE_STREAM,
	AUTO_ROUTE_TAKEOVER_MS,
	AUTO_ROUTE_VOICE_AHEAD_OF_LINE_MS,
} from "../../../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapSource,
} from "../../../../src/core/auto-listen/contract.js"
import { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	ADAPTER_TIMER_MS,
	DMR_SCENES,
	admits,
	loadSeed,
	overCall,
	replayCalls,
} from "./dv-seed-replay.js"
import type { CallEvent, Seed, SeedCall } from "./dv-seed-replay.js"
import { lcg } from "./helpers.js"

const logger = createLogger({ level: "fatal" })
/** Timer phases tried: 0 to 480 ms in 20 ms steps (25 phases of the 500 ms period). */
const PHASE_STEP_MS = 20
const PHASES = Array.from(
	{ length: ADAPTER_TIMER_MS / PHASE_STEP_MS },
	(_, k) => k * PHASE_STEP_MS,
)
/** One DMR burst (60 ms) carries three 20 ms vocoder frames of 160 samples at 8 kHz. */
const BURST_MS = 60
const FRAMES_PER_BURST = 3
/** 48 output samples per ms. */
const OUT_PER_MS = 48
/** Output samples a join of two inputs changes in the router's resampler (3 ms; measured 102). */
const RESAMPLER_EDGE = 144
/** A muted 20 ms frame as the service hands it to taps (160 zero samples). */
const ZERO_FRAME = Buffer.alloc(320)

interface OverRun {
	startMs: number
	endMs: number
	/** First decoded voice handed over: one clump before the first voice line, not before the over. */
	voiceMs: number
	/** The call snapshots the router hears, in order. */
	events: readonly CallEvent[]
	/** The snapshots the service gates the tap by (default `events`). */
	gateEvents?: readonly CallEvent[]
	/**
	 * The run stops here: past the admitting snapshot by the pending head's span plus one second
	 * (so the whole head and a second behind it are played), or one second past the over's end
	 * and its call's end for a call never known clear.
	 */
	stopMs: number
}

/** Routed past the played head: one second. */
const PAST_ADMIT_MS = 1_000

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
	/** Output time of the last decoded sample (ms of seed time), null: none. */
	lastVoiceOutMs: number | null
	/** Loud analog (the over's carrier) played from the over start, ms. */
	buzzMs: number
	pendingOverwrittenMs: number
	droppedSamples: number
	/** Decoded voice samples (8 kHz, not the gate's zeros) handed to the tap, by burst time. */
	handed: Array<{ atMs: number; samples: number }>
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
 * from the over start to its end, the voice bursts from `voiceMs`, and the call snapshots. Each
 * frame carries the latest snapshot if it is active, none otherwise (as the digital voice service
 * hands them over).
 */
function routeOver(t: OverRun, seed = 7): Played {
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
		lastVoiceOutMs: null,
		buzzMs: 0,
		pendingOverwrittenMs: 0,
		droppedSamples: 0,
		handed: [],
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
					if (v !== 0) played.lastVoiceOutMs = clock.t
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
	let current: SeedCall | null = null
	let gate: SeedCall | null = null
	const rand = lcg(seed)
	const events: Array<{ at: number; order: number; run: () => void }> = []
	for (const e of t.gateEvents ?? t.events) {
		if (e.atMs > t.stopMs) break
		events.push({
			at: e.atMs,
			order: 0,
			run: () => {
				gate = e.call.active ? e.call : null
			},
		})
	}
	for (const e of t.events) {
		if (e.atMs > t.stopMs) break
		events.push({
			at: e.atMs,
			order: 0,
			run: () => {
				current = e.call.active ? e.call : null
				voice.tap?.call("dmr", e.call)
			},
		})
	}
	for (let b = t.voiceMs; b <= Math.min(t.endMs, t.stopMs); b += BURST_MS) {
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
			at: b,
			order: 1,
			run: () => {
				const call = current
				// The digital voice service's tap gate (src/core/digital-voice.ts ingest): a call
				// not known clear on an unknown slot drops the whole datagram; on a known slot
				// (stereo, dsd-fme copying the lone slot to both channels) it is zeroed.
				if (gate !== null && !admits(gate)) {
					if (gate.slot === null) return
					for (let k = 0; k < frames.length; k++)
						voice.tap?.frame("dmr", ZERO_FRAME, call)
					return
				}
				for (const f of frames) voice.tap?.frame("dmr", f, call)
				played.handed.push({ atMs: at, samples: 160 * frames.length })
			},
		})
	}
	// Same block: the call snapshot first (as the service hands it over).
	events.sort((a, b) => a.at - b.at || a.order - b.order)
	const loud = Buffer.alloc(960 * 2)
	for (let i = 0; i < 960; i++)
		loud.writeInt16LE(i % 2 === 0 ? 8_000 : -8_000, i * 2)
	const quiet = Buffer.alloc(960 * 2)
	const stream = { rate: 48_000, format: "s16le" as const }
	const stopAt = t.stopMs
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

/** Lets the worker answer its runner between runs (the replays are synchronous). */
const breathe = (): Promise<void> => new Promise(r => setImmediate(r))

interface Measured {
	scene: string
	phase: number
	over: number
	t: OverRun
	/** First voice sync line of the over. */
	voiceLineMs: number
	admitMs: number | null
	/**
	 * The over's call published not known clear again after its admission
	 * (one copy of another talker's IDs): the snapshot's time, and the
	 * uncapped run (t is capped just before it).
	 */
	revoked: { atMs: number; t: OverRun } | null
}

/** Every own-call over of every scene at every phase; merged overs are counted apart. */
async function measureAll(): Promise<{
	runs: Measured[]
	merged: number
	revoked: number
}> {
	const runs: Measured[] = []
	let merged = 0
	let revoked = 0
	for (const scene of DMR_SCENES) {
		const seed: Seed = loadSeed(scene)
		for (const phase of PHASES) {
			await breathe()
			const calls = replayCalls(seed, phase)
			for (const over of seed.overs) {
				const c = overCall(seed, over, calls)
				if (c.kind === "merged") {
					merged++
					continue
				}
				const voiceMs = Math.max(
					over.startMs,
					c.voiceLineMs - AUTO_ROUTE_VOICE_AHEAD_OF_LINE_MS,
				)
				const t: OverRun = {
					startMs: over.startMs,
					endMs: over.endMs,
					voiceMs,
					events: c.events,
					stopMs:
						c.admitMs !== null
							? 2 * c.admitMs - voiceMs + PAST_ADMIT_MS
							: Math.max(over.endMs, c.endMs ?? 0) + PAST_ADMIT_MS,
				}
				// A clear -> unknown snapshot of the same call after the admission.
				const admitted = c.admitMs
				const callId = c.events[0]?.call.callId
				const revoke =
					admitted === null
						? undefined
						: c.events.find(
								e =>
									e.atMs > admitted &&
									e.atMs <= t.stopMs &&
									e.call.callId === callId &&
									e.call.active &&
									!e.call.encrypted &&
									e.call.encryptionKnown === false,
							)
				if (revoke !== undefined) revoked++
				runs.push({
					scene,
					phase,
					over: over.index,
					t: revoke === undefined ? t : { ...t, stopMs: revoke.atMs - 1 },
					voiceLineMs: c.voiceLineMs,
					admitMs: c.admitMs,
					revoked: revoke === undefined ? null : { atMs: revoke.atMs, t },
				})
			}
		}
	}
	return { runs, merged, revoked }
}

describe("pending voice under the adapter's call timing (recorded dv-latency seeds)", () => {
	let measured: ReturnType<typeof measureAll> | null = null
	const all = (): ReturnType<typeof measureAll> => (measured ??= measureAll())

	it("first voice line to the admitting snapshot is at most AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS (1 694 ms, direct), and the first voice at most the bound before it", async () => {
		const { runs, merged, revoked } = await all()
		let worstDirect = 0
		let worstRepeater = 0
		let worstAge = 0
		let worstGated = 0
		let worstPreAnnounce = 0
		for (const m of runs) {
			if (m.admitMs === null) continue
			const lag = m.admitMs - m.voiceLineMs
			if (m.scene.includes("direct")) worstDirect = Math.max(worstDirect, lag)
			else worstRepeater = Math.max(worstRepeater, lag)
			worstAge = Math.max(worstAge, m.admitMs - m.t.voiceMs)
			// Announced before it is known clear: the tap gets none of its voice in between.
			const announced = m.t.events[0]?.atMs ?? m.admitMs
			worstGated = Math.max(worstGated, m.admitMs - announced)
			worstPreAnnounce = Math.max(worstPreAnnounce, announced - m.t.voiceMs)
		}
		// Measured: direct 1 693.5 ms, repeater 1 057.1 ms; the constant is the worst, rounded up.
		expect(worstDirect).toBeLessThanOrEqual(
			AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS,
		)
		expect(worstDirect).toBeGreaterThan(
			AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS - 1,
		)
		expect(worstRepeater).toBeGreaterThan(1_000)
		expect(worstRepeater).toBeLessThan(worstDirect)
		// What the router gets: voice before the first snapshot (call null) waits as pending voice
		// (measured up to 1 489.3 ms of it); none while the call is announced but not known clear
		// (the service's gate: measured up to 692.6 ms, lost to /auto). The oldest pending voice is
		// at most 1 885.1 ms old at its admission: inside the 2 100 ms bound.
		expect(worstPreAnnounce).toBeGreaterThan(1_400)
		expect(worstGated).toBeGreaterThan(600)
		expect(worstAge).toBeLessThan(AUTO_ROUTE_PENDING_VOICE_MS)
		// Every scene has an own-call over; merged overs (one call over two overs: no pending head)
		// and calls that never resolve are both present in the recordings.
		expect(new Set(runs.map(m => m.scene)).size).toBe(DMR_SCENES.length)
		expect(merged).toBeGreaterThan(0)
		// Overs revoked after their admission (another talker's single LC copy) are present too.
		expect(revoked).toBeGreaterThan(0)
		expect(runs.some(m => m.admitMs === null)).toBe(true)
	}, 120_000)

	for (const scene of DMR_SCENES) {
		it(`${scene}: at every timer phase the call head plays whole (pendingOverwrittenMs 0), decoded voice starts at the admitting snapshot, the carrier plays raw until then; a call never known clear is never heard`, async () => {
			const cache = new Map<string, Played>()
			const run = (t: OverRun, over: number): Played => {
				const key = JSON.stringify([
					over,
					t.voiceMs,
					t.stopMs,
					t.events.filter(e => e.atMs <= t.stopMs),
					t.gateEvents?.filter(e => e.atMs <= t.stopMs) ?? null,
				])
				let r = cache.get(key)
				if (r === undefined) {
					r = routeOver(t, over + 1)
					cache.set(key, r)
				}
				return r
			}
			for (const m of (await all()).runs.filter(r => r.scene === scene)) {
				await breathe()
				const label = { scene, phase: m.phase, over: m.over }
				const got = run(m.t, m.over)
				expect({ ...label, dropped: got.droppedSamples }).toEqual({
					...label,
					dropped: 0,
				})
				if (m.revoked !== null) {
					// Fail closed: past the revoke the router drops the queued voice, and none of
					// this over's voice plays after it.
					const uncapped = run(m.revoked.t, m.over)
					expect({ ...label, dropped: uncapped.droppedSamples > 0 }).toEqual({
						...label,
						dropped: true,
					})
					expect({
						...label,
						afterRevoke: (uncapped.lastVoiceOutMs ?? 0) > m.revoked.atMs + 20,
					}).toEqual({ ...label, afterRevoke: false })
				}
				if (m.admitMs === null) {
					// Encryption never known: nothing of it heard (fail closed).
					expect({ ...label, heard: got.voice.length }).toEqual({
						...label,
						heard: 0,
					})
					continue
				}
				expect({ ...label, overwritten: got.pendingOverwrittenMs }).toEqual({
					...label,
					overwritten: 0,
				})
				// The reference: the same voice with the call active and clear from its first frame.
				const end = m.t.events.find(e => !e.call.active)
				const first = m.t.events[0]
				if (first === undefined) throw new Error("no call snapshot")
				const clear = { ...first.call, active: true, encrypted: false }
				delete (clear as { encryptionKnown?: boolean }).encryptionKnown
				const ref = run(
					{
						...m.t,
						gateEvents: m.t.events,
						events: [
							{ atMs: m.t.voiceMs, call: clear },
							...(end === undefined ? [] : [end]),
						],
					},
					m.over,
				)
				// The call head plays whole: every sample the tap got before the admission (the
				// pending head) is played, in order, as the reference plays it (first mismatch over
				// the head's output: 48 per 8 kHz sample over 8, less the resampler's edge, where the
				// head joins later voice). Zeros are left out of both: the test's voice has none, so
				// they are the gate's muted frames or the reference's underrun where the tap got
				// nothing (from there on the call plays live in both).
				const head = got.handed
					.filter(h => h.atMs < (m.admitMs ?? 0))
					.reduce((n, h) => n + h.samples, 0)
				const gotVoice = got.voice.filter(v => v !== 0)
				const refVoice = ref.voice.filter(v => v !== 0)
				// A revoked over's run is capped before the revoke: the head plays whole up to the
				// cap (all the output time from its first sample to the cap, less one 40 ms block).
				const capOut =
					m.revoked === null || got.firstVoiceOutMs === null
						? Number.POSITIVE_INFINITY
						: (m.t.stopMs - got.firstVoiceOutMs - 40) * OUT_PER_MS
				const headOut = Math.min(
					head * (OUT_PER_MS / 8) - RESAMPLER_EDGE,
					Math.max(0, capOut),
				)
				expect({ ...label, played: gotVoice.length >= headOut }).toEqual({
					...label,
					played: true,
				})
				expect({
					...label,
					mismatch: firstMismatch(
						gotVoice.slice(0, headOut),
						refVoice.slice(0, headOut),
					),
				}).toEqual({ ...label, mismatch: -1 })
				// Time to audio: the admitting snapshot (its pending head passes the start buffer).
				const out = got.firstVoiceOutMs ?? Number.POSITIVE_INFINITY
				expect(out).toBeGreaterThanOrEqual(m.admitMs)
				expect(out).toBeLessThanOrEqual(m.admitMs + 40)
				// Buzz: the carrier from the over start until the call takes it over.
				expect(got.buzzMs).toBeLessThanOrEqual(m.admitMs - m.t.startMs + 40)
				// The reference takes over after its 200 ms start buffer (when the tap got voice all
				// along: announced known clear; otherwise the carrier fills the gate's gap).
				if (m.t.events[0]?.atMs === m.admitMs)
					expect(ref.buzzMs).toBeLessThanOrEqual(
						m.t.voiceMs - m.t.startMs + AUTO_ROUTE_TAKEOVER_MS + 40,
					)
			}
		}, 120_000)
	}
})
