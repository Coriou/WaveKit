import { EventEmitter } from "node:events"
import type * as http from "node:http"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { LiveAudioAutoRouteLevel } from "@wavekit/api-types"
import { AUTO_ROUTE_STREAM } from "../../../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
	VoiceTapSource,
} from "../../../../src/core/auto-listen/contract.js"
import type { AutoRouteTrace } from "../../../../src/core/auto-listen/inputs.js"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import type { StreamFormat } from "../../../../src/core/audio-stream-server.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { feed, lcg } from "./helpers.js"

const logger = createLogger({ level: "fatal" })
const BLOCK = 960

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
	get running(): boolean {
		return this.fn !== null
	}
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

class FakeResponse extends EventEmitter {
	received: Buffer[] = []
	accept = true
	writableEnded = false
	destroyed = false
	write(chunk: Buffer): boolean {
		this.received.push(chunk)
		return this.accept
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

class FakeVoice implements VoiceTapSource {
	tap: VoiceTap | null = null
	readonly voiceSampleRate = 8_000
	addVoiceTap(tap: VoiceTap): () => void {
		this.tap = tap
		return () => {
			if (this.tap === tap) this.tap = null
		}
	}
}

class FakeCoverage implements VoiceCoveragePort {
	generation = 0
	readonly answer = new Map<string, VoiceCoverage>()
	readonly calls: { id: string; generation: number }[] = []
	throws = false
	covers(id: string): VoiceCoverage {
		this.calls.push({ id, generation: this.generation })
		if (this.throws) throw new Error("coverage failed")
		return this.answer.get(id) ?? "yes"
	}
}

interface Rec extends AutoRouteTrace {
	block: number
	at: number
	/** The fake coverage answer for the source when the event happened. */
	answer: VoiceCoverage
}

function call(
	over: Partial<VoiceTapCall> & { callId?: string } = {},
): VoiceTapCall {
	return {
		callId: "c1",
		active: true,
		encrypted: false,
		protocol: "DMR",
		slot: 1,
		...over,
	}
}

function noise(n: number, rand: () => number, amp = 20_000): Int16Array {
	return Int16Array.from({ length: n }, () => {
		const v = Math.round((rand() * 2 - 1) * amp)
		return v === 0 ? 1 : v
	})
}

function bytes(a: Int16Array | Float32Array): Buffer {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
}

/** Sorted half-open intervals with overlap count, `size` and `has`. */
class Intervals {
	readonly starts: number[] = []
	readonly ends: number[] = []
	overlaps = 0
	size = 0
	constructor(list: [number, number][]) {
		list.sort((x, y) => x[0] - y[0])
		let end = Number.NEGATIVE_INFINITY
		for (const [a, b] of list) {
			if (a < end) this.overlaps++
			this.size += b - a
			const last = this.starts.length - 1
			if (last >= 0 && a <= (this.ends[last] ?? 0))
				this.ends[last] = Math.max(this.ends[last] ?? 0, b)
			else {
				this.starts.push(a)
				this.ends.push(b)
			}
			end = Math.max(end, b)
		}
	}
	has(p: number): boolean {
		let lo = 0
		let hi = this.starts.length - 1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (p < (this.starts[mid] ?? 0)) hi = mid - 1
			else if (p >= (this.ends[mid] ?? 0)) lo = mid + 1
			else return true
		}
		return false
	}
}

/** Qualified reference positions (below `limit`) that were never read. */
function missing(
	ref: { flags: number[] },
	read: Intervals,
	limit = Number.POSITIVE_INFINITY,
): number {
	let n = 0
	ref.flags.forEach((f, p) => {
		if (f !== 0 && p < limit && !read.has(p)) n++
	})
	return n
}

/** Router, fake client, fake voice and coverage, a reference model of every input. */
class Sim {
	readonly clock = new FakeClock()
	readonly traces: Rec[] = []
	readonly produced: Buffer[] = []
	readonly snapshots: Buffer[] = []
	readonly events: LiveAudioAutoRouteLevel[] = []
	readonly eventTimes: number[] = []
	/** Decoder id (digital) and trace index at each event. */
	readonly eventDecoders: (string | undefined)[] = []
	readonly eventTraceIndex: number[] = []
	readonly voice = new FakeVoice()
	readonly coverage = new FakeCoverage()
	readonly router: AutoListenRouter
	client: FakeResponse | null = null
	readonly analogRate: number
	private readonly analogIn: number[] = []
	private readonly analogCuts: number[] = []
	private readonly analogFlags = new Map<number, number>()
	/** Per decoder: segments of real input samples, each closed by a flush. */
	private readonly voiceSegs = new Map<string, number[][]>()

	constructor(analogRate = 48_000, withVoice = true) {
		this.analogRate = analogRate
		this.router = new AutoListenRouter(logger, {
			clock: this.clock,
			wallClock: () => 1_700_000_000_000 + this.clock.t,
			trace: t => {
				this.traces.push({
					...t,
					block: this.produced.length,
					at: this.clock.t,
					answer: this.coverage.answer.get(t.source) ?? "yes",
				})
			},
		})
		const registry = this.router.registry
		const write = registry.write.bind(registry)
		registry.write = (chunk: Buffer) => {
			this.produced.push(chunk)
			this.snapshots.push(Buffer.from(chunk))
			write(chunk)
		}
		this.router.on("auto-route-changed", (level: LiveAudioAutoRouteLevel) => {
			this.events.push(level)
			this.eventTimes.push(this.clock.t)
			this.eventDecoders.push(
				this.router.status({ httpUrl: "", wavUrl: "" }).decoderId,
			)
			this.eventTraceIndex.push(this.traces.length)
		})
		if (withVoice) this.router.attachVoice(this.voice, this.coverage)
	}

	connect(): FakeResponse {
		const res = new FakeResponse()
		this.router.registry.register(
			res as unknown as http.ServerResponse,
			"127.0.0.1",
			AUTO_ROUTE_STREAM,
		)
		this.client = res
		return res
	}

	analog(samples: Int16Array, audible: boolean, stream?: StreamFormat): void {
		if (!this.router.wanted) return
		this.analogCuts.push(this.analogIn.length)
		this.analogFlags.set(this.analogIn.length, audible ? 1 : 0)
		for (const s of samples) this.analogIn.push(s)
		const buf = bytes(samples)
		this.router.pushAnalog(
			buf,
			0,
			buf.length,
			audible,
			stream ?? { rate: this.analogRate, format: "s16le" },
		)
	}

	/** One admitted frame (the model assumes coverage "yes" and a clear active call). */
	frame(
		id: string,
		samples: Int16Array,
		c: VoiceTapCall | null = call(),
	): void {
		const segs = this.voiceSegs.get(id) ?? [[]]
		this.voiceSegs.set(id, segs)
		const last = segs[segs.length - 1]
		if (last !== undefined) for (const s of samples) last.push(s)
		this.voice.tap?.frame(id, bytes(samples), c)
	}

	/** Model a flush (call end or hold expiry): the next frames start a new segment. */
	markFlush(id: string): void {
		const segs = this.voiceSegs.get(id)
		if (segs !== undefined && (segs[segs.length - 1]?.length ?? 0) > 0)
			segs.push([])
	}

	callEvent(id: string, c: VoiceTapCall): void {
		this.voice.tap?.call(id, c)
		if (!c.active) this.markFlush(id)
	}

	step(ms = 20): void {
		this.clock.tick(ms)
	}

	outputSamples(): number[] {
		const out: number[] = []
		for (const b of this.produced)
			for (let k = 0; k + 1 < b.length; k += 2) out.push(b.readInt16LE(k))
		return out
	}

	analogRef(): { samples: number[]; flags: number[] } {
		const res = new PolyphaseResampler(this.analogRate, 48_000)
		const cuts = this.analogCuts.filter(c => c > 0)
		return feed(res, Int16Array.from(this.analogIn), cuts, 4_096, at =>
			this.lastFlagAt(at),
		)
	}

	private lastFlagAt(at: number): number {
		// `feed` asks at span starts, which are the recorded cuts.
		return this.analogFlags.get(at) ?? 0
	}

	voiceRef(id: string): { samples: number[]; flags: number[] } {
		const samples: number[] = []
		const flags: number[] = []
		for (const seg of this.voiceSegs.get(id) ?? []) {
			if (seg.length === 0) continue
			const res = new PolyphaseResampler(8_000, 48_000)
			const input = Int16Array.from([
				...seg,
				...new Array<number>(res.taps - 1).fill(0),
			])
			const r = feed(res, input, [], 4_096, () => 2)
			for (const v of r.samples) samples.push(v)
			for (const v of r.flags) flags.push(v)
		}
		return { samples, flags }
	}

	of(source: string, kind?: AutoRouteTrace["kind"]): Rec[] {
		return this.traces.filter(
			t => t.source === source && (kind === undefined || t.kind === kind),
		)
	}

	/** Every read of `source` equals the reference at its positions. */
	expectReadsMatch(source: string, ref: { samples: number[] }): void {
		let bad = 0
		for (const r of this.of(source, "read")) {
			const block = this.produced[r.block]
			if (block === undefined) {
				bad++
				continue
			}
			for (let k = 0; k < r.count; k++)
				if (block.readInt16LE(2 * k) !== ref.samples[r.from + k]) bad++
		}
		expect(bad).toBe(0)
	}

	/** Positions of `source` touched by `kinds`; asserts each is touched at most once. */
	positions(source: string, kinds: AutoRouteTrace["kind"][]): Intervals {
		const list: [number, number][] = []
		for (const r of this.traces)
			if (r.source === source && kinds.includes(r.kind) && r.count > 0)
				list.push([r.from, r.from + r.count])
		const iv = new Intervals(list)
		expect(iv.overlaps).toBe(0)
		return iv
	}
}

const RUNS = 100

/** Removal end (head position) of `source` over traces before index `before`. */
function removedEnd(sim: Sim, source: string, before: number): number {
	let end = 0
	for (let i = 0; i < before; i++) {
		const t = sim.traces[i]
		if (t && t.source === source && t.kind !== "write")
			end = Math.max(end, t.from + t.count)
	}
	return end
}

/** Write end (tail position) of `source` over traces before index `before`. */
function writtenEnd(sim: Sim, source: string, before: number): number {
	let end = 0
	for (let i = 0; i < before; i++) {
		const t = sim.traces[i]
		if (t && t.source === source && t.kind === "write")
			end = Math.max(end, t.from + t.count)
	}
	return end
}

/** Write time of the oldest queued sample of `source` at trace index `before`, or null. */
function oldestAt(sim: Sim, source: string, before: number): number | null {
	const head = removedEnd(sim, source, before)
	for (let i = 0; i < before; i++) {
		const t = sim.traces[i]
		if (
			t &&
			t.source === source &&
			t.kind === "write" &&
			t.from <= head &&
			head < t.from + t.count
		)
			return t.at
	}
	return null
}

/** Every discard of `source` covers only silent reference positions. */
function discardsSilent(sim: Sim, source: string, flags: number[]): number {
	let bad = 0
	for (const d of sim.of(source, "discard"))
		for (let p = d.from; p < d.from + d.count; p++)
			if ((flags[p] ?? 0) !== 0) bad++
	return bad
}

function dropTotal(sim: Sim): number {
	return sim.traces
		.filter(t => t.kind === "drop")
		.reduce((n, t) => n + t.count, 0)
}

/** Reads of one source come in increasing, non-overlapping order (4.2). */
function readsIncreasing(sim: Sim, source: string): boolean {
	let end = 0
	for (const r of sim.of(source, "read")) {
		if (r.from < end) return false
		end = r.from + r.count
	}
	return true
}

interface Over {
	kind: "analog" | "digital"
	steps: number
	gap: number
}

/**
 * Sequential overs on air; analog reaches the router `delay` steps late (the pre-roll), so
 * digital overs can fall wholly inside the analog handover delay.
 */
function runOvers(
	overs: Over[],
	rate: number,
	delay: number,
	seed: number,
): Sim {
	const sim = new Sim(rate)
	const rand = lcg(seed)
	sim.connect()
	const analogAir: boolean[] = []
	const digital = new Map<number, string>()
	const ends = new Map<number, string>()
	let t = 0
	overs.forEach((o, k) => {
		for (let i = 0; i < o.steps; i++) {
			if (o.kind === "analog") analogAir[t + i] = true
			else digital.set(t + i, `call-${k}`)
		}
		if (o.kind === "digital") ends.set(t + o.steps, `call-${k}`)
		t += o.steps + o.gap
	})
	// 2.4 s of tail drains every queue (longest wait about 1.3 s).
	const total = t + delay + 120
	const chunk = rate / 50
	for (let i = 0; i < total; i++) {
		const end = ends.get(i)
		if (end !== undefined)
			sim.callEvent("dmr", call({ callId: end, active: false }))
		const callId = digital.get(i)
		if (callId !== undefined)
			sim.frame("dmr", noise(160, rand), call({ callId }))
		const audible = analogAir[i - delay] === true
		sim.analog(audible ? noise(chunk, rand) : new Int16Array(chunk), audible)
		sim.step()
	}
	return sim
}

const oversArb = fc.array(
	fc.record({
		kind: fc.constantFrom("analog" as const, "digital" as const),
		steps: fc.integer({ min: 5, max: 50 }),
		gap: fc.integer({ min: 0, max: 50 }),
	}),
	{ minLength: 1, maxLength: 4 },
)

describe("AutoListenRouter properties", { timeout: 120_000 }, () => {
	// Feature: auto-listen-route, Property 3: Bounded pacing
	// Validates: Requirements 2.6, 2.7
	it("paces at 48 kHz, at most 5 blocks per tick, rebasing only on stalls", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.integer({ min: 0, max: 100 }),
						fc.integer({ min: 0, max: 600 }),
					),
					{ minLength: 1, maxLength: 120 },
				),
				fc.integer(),
				(gaps, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					// Model of the design's pacer formula.
					let start = 0
					let emitted = 0
					let rebases = 0
					let late = false
					for (const g of gaps) {
						if (g > 0) sim.analog(noise(g * 48, rand), rand() < 0.7)
						const before = sim.produced.length
						sim.step(g)
						late = late || g > 100
						const t = sim.clock.t
						const due = Math.floor((t - start) * 48)
						const n = Math.min(Math.floor((due - emitted) / BLOCK), 5)
						if (n > 0) emitted += n * BLOCK
						if (due - emitted >= BLOCK) {
							start = t - emitted / 48
							rebases++
						}
						const blocks = sim.produced.length - before
						expect(blocks).toBeLessThanOrEqual(5)
						expect(sim.router.emittedSamples).toBe(emitted)
						expect(sim.router.clockRebases).toBe(rebases)
						expect(emitted).toBeLessThanOrEqual(Math.floor(t * 48))
						if (!late) {
							expect(rebases).toBe(0)
							expect(Math.floor(t * 48) - emitted).toBeLessThan(BLOCK)
						}
					}
					// Across rebases nothing is lost or repeated: removals tile the FIFO.
					const ref = sim.analogRef()
					const all = sim.positions("analog", ["read", "discard", "drop"])
					const end = removedEnd(sim, "analog", sim.traces.length)
					expect(all.size).toBe(end)
					expect(discardsSilent(sim, "analog", ref.flags)).toBe(0)
					expect(readsIncreasing(sim, "analog")).toBe(true)
					sim.expectReadsMatch("analog", ref)
					expect(dropTotal(sim)).toBe(sim.router.droppedSamples)
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 4: No doubled audio
	// Validates: Requirements 4.2
	// Feature: auto-listen-route, Property 5: No loss inside an over
	// Validates: Requirements 4.3, 4.4, 4.6, 4.10
	// Feature: auto-listen-route, Property 7: Catch-up only on silence
	// Validates: Requirements 4.3, 4.7
	it("emits every audible and admitted sample exactly once, in order, discarding only silence", () => {
		fc.assert(
			fc.property(
				oversArb,
				fc.constantFrom(25_000, 25_600, 48_000),
				fc.integer({ min: 0, max: 45 }),
				fc.integer(),
				(overs, rate, delay, seed) => {
					const sim = runOvers(overs, rate, delay, seed)
					expect(sim.router.droppedSamples).toBe(0)
					expect(dropTotal(sim)).toBe(0)
					const aref = sim.analogRef()
					const aread = sim.positions("analog", ["read"])
					expect(missing(aref, aread)).toBe(0)
					expect(discardsSilent(sim, "analog", aref.flags)).toBe(0)
					expect(readsIncreasing(sim, "analog")).toBe(true)
					sim.expectReadsMatch("analog", aref)
					const vref = sim.voiceRef("dmr")
					const vread = sim.positions("dmr", ["read"])
					expect(vread.size).toBe(vref.samples.length)
					expect(sim.of("dmr", "discard")).toHaveLength(0)
					expect(readsIncreasing(sim, "dmr")).toBe(true)
					sim.expectReadsMatch("dmr", vref)
					// One source per block: nothing is mixed.
					const perBlock = new Map<number, string>()
					for (const r of sim.traces.filter(x => x.kind === "read")) {
						const seen = perBlock.get(r.block)
						expect(seen === undefined || seen === r.source).toBe(true)
						perBlock.set(r.block, r.source)
					}
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 6: Priority and bound
	// Validates: Requirements 4.1, 4.5, 4.9
	// Feature: auto-listen-route, Property 7: Catch-up only on silence
	// Validates: Requirements 4.3, 4.7
	it("selects drain-eligible digital within PREEMPT_MAX_MS + one block; analog never preempts it", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.integer({ min: 0, max: 60 }),
				fc.integer({ min: 5, max: 90 }),
				fc.integer(),
				(stuck, s0, dur, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					let audible = true
					for (let i = 0; i < s0 + Math.max(dur, 80) + 30; i++) {
						if (!stuck && rand() < 0.1) audible = !audible
						if (i >= s0 && i < s0 + dur) sim.frame("dmr", noise(160, rand))
						sim.analog(
							audible ? noise(960, rand) : new Int16Array(960),
							audible,
						)
						sim.step()
					}
					const first = s0 * 20
					const last = (s0 + dur - 1) * 20
					const k = sim.events.findIndex(e => e.active === "digital")
					expect(k).toBeGreaterThanOrEqual(0)
					const at = sim.eventTimes[k] ?? Number.NaN
					expect(at - first).toBeLessThanOrEqual(1_500 + 20)
					const next = sim.eventTimes[k + 1]
					if (next !== undefined)
						expect(next).toBeGreaterThanOrEqual(last + 300)
					const from = sim.produced.length
					// The block produced at tick time t has index t / 20 − 1 (no rebases here).
					const startBlock = Math.round(at / 20) - 1
					const endBlock = next === undefined ? from : Math.round(next / 20) - 1
					for (const r of sim.of("analog", "read"))
						expect(r.block < startBlock || r.block >= endBlock).toBe(true)
					const aref = sim.analogRef()
					expect(discardsSilent(sim, "analog", aref.flags)).toBe(0)
					expect(dropTotal(sim)).toBe(sim.router.droppedSamples)
					expect(sim.router.status({ httpUrl: "", wavUrl: "" }).droppedMs).toBe(
						sim.router.droppedSamples / 48,
					)
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 10: Encryption
	// Validates: Requirements 3.2, 4.10
	it("routes nothing of an encrypted call after the encrypted event", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 30 }),
				fc.integer({ min: 1, max: 40 }),
				fc.constantFrom("silent", "muted", "frameOnly"),
				fc.integer({ min: 0, max: 30 }),
				fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
				fc.integer(),
				(a0, n1, mode, muted, laterGap, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					const e = a0 + n1
					const bStart = laterGap === null ? -1 : e + muted + laterGap
					let mark = -1
					let bMark = -1
					for (let i = 0; i < e + muted + 120; i++) {
						if (i >= a0 && i < e)
							sim.frame("d", noise(160, rand), call({ callId: "A" }))
						if (i === e) {
							mark = sim.traces.length
							if (mode !== "frameOnly")
								sim.callEvent("d", call({ callId: "A", encrypted: true }))
						}
						const enc = call({ callId: "A", encrypted: true })
						if (i >= e && i < e + muted && mode !== "silent")
							sim.voice.tap?.frame("d", Buffer.alloc(320), enc)
						if (mode === "frameOnly" && i === e && muted === 0)
							sim.voice.tap?.frame("d", Buffer.alloc(320), enc)
						if (bStart >= 0 && i === bStart) bMark = sim.traces.length
						if (bStart >= 0 && i >= bStart && i < bStart + 20)
							sim.frame("d", noise(160, rand), call({ callId: "B" }))
						sim.step()
					}
					const written = writtenEnd(sim, "d", mark)
					const after = sim.traces.slice(mark)
					for (const r of after.filter(
						t => t.source === "d" && t.kind === "read",
					))
						expect(r.from).toBeGreaterThanOrEqual(written)
					const stop = bMark < 0 ? sim.traces.length : bMark
					expect(
						sim.traces
							.slice(mark, stop)
							.filter(t => t.source === "d" && t.kind === "write"),
					).toHaveLength(0)
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 11: Several decoders
	// Validates: Requirements 3.5
	it("several decoders: one at a time, sticky until release, then oldest queued, ties by id", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.constantFrom("a", "b", "c", "d"),
						start: fc.integer({ min: 0, max: 150 }),
						len: fc.integer({ min: 5, max: 60 }),
					}),
					{ minLength: 1, maxLength: 6 },
				),
				fc.integer(),
				(calls, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					// Calls of one decoder run back to back as one stream of frames.
					const frames = new Map<string, Set<number>>()
					for (const c of calls) {
						const set = frames.get(c.id) ?? new Set<number>()
						for (let i = c.start; i < c.start + c.len; i++) set.add(i)
						frames.set(c.id, set)
					}
					const lastFrame = new Map<string, number>()
					const ids = [...frames.keys()].sort()
					const total = Math.max(...calls.map(c => c.start + c.len)) + 250
					for (let i = 0; i < total; i++) {
						for (const id of ids) {
							if (frames.get(id)?.has(i) === true) {
								sim.frame(id, noise(160, rand))
								lastFrame.set(id, sim.clock.t)
							}
						}
						sim.step()
					}
					// One source per block.
					const perBlock = new Map<number, string>()
					for (const r of sim.traces.filter(x => x.kind === "read")) {
						const seen = perBlock.get(r.block)
						expect(seen === undefined || seen === r.source).toBe(true)
						perBlock.set(r.block, r.source)
					}
					// Nothing silently lost or repeated: removals tile every written position.
					for (const id of ids) {
						const all = sim.positions(id, ["read", "drop", "discard"])
						expect(all.size).toBe(writtenEnd(sim, id, sim.traces.length))
						expect(sim.of(id, "discard")).toHaveLength(0)
					}
					for (let k = 0; k < sim.events.length; k++) {
						const t = sim.eventTimes[k] ?? 0
						const prev = k > 0 ? sim.eventDecoders[k - 1] : undefined
						const idx = sim.eventTraceIndex[k] ?? 0
						if (prev !== undefined) {
							const invalidated = sim.traces
								.slice(0, idx)
								.some(x => x.source === prev && x.kind === "drop" && x.at === t)
							if (!invalidated) {
								const lf = sim.eventTimes[k - 1] ?? 0
								expect(t - lf).toBeGreaterThanOrEqual(300)
								expect(oldestAt(sim, prev, idx)).toBeNull()
							}
						}
						const chosen = sim.eventDecoders[k]
						if (chosen === undefined) continue
						let best: string | null = null
						let bestAt = Number.POSITIVE_INFINITY
						for (const id of ids) {
							const at = oldestAt(sim, id, idx)
							if (at === null) continue
							if (
								best === null ||
								at < bestAt ||
								(at === bestAt && id < best)
							) {
								best = id
								bestAt = at
							}
						}
						expect(chosen).toBe(best)
					}
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 12: Coverage
	// Validates: Requirements 3.4, 4.10
	it("emits no voice queued before a generation change or under unknown / no; covers once per generation", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						frames: fc.subarray(["x", "y"]),
						bumps: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 3 })),
						answer: fc.constantFrom<VoiceCoverage>(
							"yes",
							"yes",
							"no",
							"unknown",
						),
						who: fc.constantFrom("x", "y"),
					}),
					{ minLength: 1, maxLength: 150 },
				),
				fc.integer(),
				(ops, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					const bumpMarks: number[] = []
					for (const op of ops) {
						for (const id of op.frames) sim.frame(id, noise(160, rand))
						if (op.bumps > 0) {
							// Several changes between two ticks, with no frames in between.
							for (let b = 0; b < op.bumps; b++) sim.coverage.generation++
							sim.coverage.answer.set(op.who, op.answer)
							bumpMarks.push(sim.traces.length)
						}
						sim.step()
					}
					for (let i = 0; i < 100; i++) sim.step()
					const per = new Map<string, number>()
					for (const c of sim.coverage.calls) {
						const key = `${c.id}@${c.generation}`
						per.set(key, (per.get(key) ?? 0) + 1)
					}
					for (const n of per.values()) expect(n).toBe(1)
					for (const t of sim.traces)
						if (t.kind === "write" && t.source !== "analog")
							expect(t.answer).toBe("yes")
					for (const mark of bumpMarks) {
						for (const id of ["x", "y"]) {
							const w = writtenEnd(sim, id, mark)
							for (const r of sim.traces.slice(mark))
								if (r.source === id && r.kind === "read")
									expect(r.from).toBeGreaterThanOrEqual(w)
						}
					}
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 14: Output blocks are immutable
	// Validates: Requirements 2.8
	it("every block a client finally receives equals the bytes produced for it", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom("accept", "withhold", "drain"), {
					minLength: 1,
					maxLength: 200,
				}),
				fc.integer(),
				(plan, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					const res = sim.connect()
					for (const p of plan) {
						if (p === "withhold") res.accept = false
						if (p === "accept") res.accept = true
						if (p === "drain") {
							res.accept = true
							res.emit("drain")
						}
						sim.analog(noise(960, rand), rand() < 0.8)
						sim.step()
					}
					res.accept = true
					res.emit("drain")
					sim.produced.forEach((b, i) => {
						expect(b.equals(sim.snapshots[i] ?? Buffer.alloc(0))).toBe(true)
					})
					for (const r of res.received) {
						const i = sim.produced.findIndex(
							p =>
								p.buffer === r.buffer &&
								r.byteOffset >= p.byteOffset &&
								r.byteOffset + r.length <= p.byteOffset + p.length,
						)
						expect(i).toBeGreaterThanOrEqual(0)
						const p = sim.produced[i]
						const snap = sim.snapshots[i]
						if (p && snap) {
							const off = r.byteOffset - p.byteOffset
							expect(r.equals(snap.subarray(off, off + r.length))).toBe(true)
						}
					}
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: auto-listen-route, Property 16: Digital tail
	// Validates: Requirements 4.11
	it("emits each call's full tail exactly once, including a mid-call hold-expiry flush", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						frames: fc.array(
							fc.record({
								samples: fc.integer({ min: 40, max: 160 }).map(n => n * 2),
								gap: fc.oneof(
									fc.integer({ min: 0, max: 13 }),
									fc.integer({ min: 17, max: 40 }),
								),
							}),
							{ minLength: 3, maxLength: 30 },
						),
						end: fc.boolean(),
						after: fc.integer({ min: 17, max: 40 }),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				fc.integer(),
				(calls, seed) => {
					const sim = new Sim()
					const rand = lcg(seed)
					sim.connect()
					calls.forEach((c, k) => {
						const callId = `call-${k}`
						c.frames.forEach((f, j) => {
							const last = j === c.frames.length - 1
							let pcm = noise(f.samples, rand)
							if (last) {
								// Ends in a non-zero impulse, no further datagram.
								pcm = new Int16Array(f.samples)
								pcm[f.samples - 1] = 25_000
							}
							sim.frame("dmr", pcm, call({ callId }))
							const gap = last ? 0 : f.gap
							sim.step()
							for (let g = 0; g < gap; g++) sim.step()
							// A gap of 17 or more steps (≥ 340 ms) expires the 300 ms hold.
							if (gap >= 17) sim.markFlush("dmr")
						})
						if (c.end) sim.callEvent("dmr", call({ callId, active: false }))
						for (let g = 0; g < c.after; g++) sim.step()
						sim.markFlush("dmr")
					})
					for (let g = 0; g < 200; g++) sim.step()
					const ref = sim.voiceRef("dmr")
					expect(writtenEnd(sim, "dmr", sim.traces.length)).toBe(
						ref.samples.length,
					)
					expect(sim.positions("dmr", ["read"]).size).toBe(ref.samples.length)
					expect(sim.router.droppedSamples).toBe(0)
					sim.expectReadsMatch("dmr", ref)
				},
			),
			{ numRuns: RUNS },
		)
	})
})
