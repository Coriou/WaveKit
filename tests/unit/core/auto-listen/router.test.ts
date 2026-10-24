import { EventEmitter } from "node:events"
import type * as http from "node:http"
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

/** Qualified reference positions (below `limit`) that were never read. */
function missing(
	ref: { flags: number[] },
	read: Set<number>,
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
		let flag = 0
		for (const c of this.analogCuts)
			if (c <= at) flag = this.analogFlags.get(c) ?? 0
		return flag
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

	/** Positions of `source` touched by `kinds`, each at most once. */
	positions(source: string, kinds: AutoRouteTrace["kind"][]): Set<number> {
		const seen = new Set<number>()
		let twice = 0
		for (const r of this.traces) {
			if (r.source !== source || !kinds.includes(r.kind)) continue
			for (let p = r.from; p < r.from + r.count; p++) {
				if (seen.has(p)) twice++
				seen.add(p)
			}
		}
		expect(twice).toBe(0)
		return seen
	}
}

describe("AutoListenRouter", () => {
	it("idles without a client: no pacer, no tap, analog ignored (7.1)", () => {
		const sim = new Sim()
		expect(sim.router.wanted).toBe(false)
		expect(sim.clock.running).toBe(false)
		expect(sim.voice.tap).toBeNull()
		sim.router.pushAnalog(Buffer.alloc(1_920, 1), 0, 1_920, true, {
			rate: 48_000,
			format: "s16le",
		})
		expect(sim.traces).toHaveLength(0)
		const res = sim.connect()
		expect(sim.router.wanted).toBe(true)
		expect(sim.clock.running).toBe(true)
		expect(sim.voice.tap).not.toBeNull()
		res.end()
		expect(sim.router.wanted).toBe(false)
		expect(sim.clock.running).toBe(false)
		expect(sim.voice.tap).toBeNull()
	})

	it("emits fresh 1 920-byte zero blocks paced at 48 kHz while nothing plays (2.6, 2.8)", () => {
		const sim = new Sim()
		sim.connect()
		for (let i = 0; i < 50; i++) sim.step(20)
		expect(sim.produced).toHaveLength(50)
		expect(new Set(sim.produced).size).toBe(50)
		for (const b of sim.produced) {
			expect(b.length).toBe(1_920)
			expect(b.every(x => x === 0)).toBe(true)
		}
		expect(sim.router.emittedSamples).toBe(50 * BLOCK)
		expect(sim.router.underruns).toBe(0)
		expect(sim.router.status({ httpUrl: "h", wavUrl: "w" }).active).toBe("none")
		expect(sim.client?.received).toHaveLength(50)
	})

	it("plays an analog over sample-exact, then releases to none, one event per switch (4.4, 6.4)", () => {
		const sim = new Sim()
		const rand = lcg(1)
		sim.connect()
		for (let i = 0; i < 25; i++) {
			sim.analog(noise(960, rand), true)
			sim.step()
		}
		for (let i = 0; i < 40; i++) {
			sim.analog(new Int16Array(960), false)
			sim.step()
		}
		const ref = sim.analogRef()
		sim.expectReadsMatch("analog", ref)
		const read = sim.positions("analog", ["read"])
		const written = sim.positions("analog", ["write"]).size
		expect(missing(ref, read, written)).toBe(0)
		expect(sim.events.map(e => e.active)).toEqual(["analog", "none"])
		// Release: 300 ms after the last audible span and no audible sample queued.
		const releasedAt = sim.eventTimes[1] ?? 0
		expect(releasedAt).toBeGreaterThanOrEqual(480 + 300)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("catches up only on silence, down to the 60 ms target (4.7)", () => {
		const sim = new Sim()
		const rand = lcg(2)
		sim.connect()
		// A burst: 100 ms audible then 400 ms silence, then 100 ms audible, all at once.
		sim.analog(noise(4_800, rand), true)
		sim.analog(new Int16Array(19_200), false)
		sim.analog(noise(4_800, rand), true)
		for (let i = 0; i < 40; i++) sim.step()
		const ref = sim.analogRef()
		sim.expectReadsMatch("analog", ref)
		for (const d of sim.of("analog", "discard"))
			for (let p = d.from; p < d.from + d.count; p++)
				expect(ref.flags[p]).toBe(0)
		expect(sim.of("analog", "discard").length).toBeGreaterThan(0)
		const read = sim.positions("analog", ["read"])
		expect(missing(ref, read)).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("counts an underrun when the selected FIFO runs short (4.8)", () => {
		const sim = new Sim()
		sim.connect()
		sim.analog(noise(1_920, lcg(3)), true)
		for (let i = 0; i < 5; i++) sim.step()
		expect(sim.router.underruns).toBeGreaterThan(0)
		const s = sim.router.status({ httpUrl: "h", wavUrl: "w" })
		expect(s.underruns).toBe(sim.router.underruns)
	})

	it("rebases once on an event-loop stall without losing or repeating a sample (2.7)", () => {
		const sim = new Sim()
		const rand = lcg(4)
		sim.connect()
		for (let i = 0; i < 10; i++) {
			sim.analog(noise(960, rand), true)
			sim.step()
		}
		// A 500 ms stall: the input arrives in one burst, then one late tick.
		for (let i = 0; i < 25; i++) sim.analog(noise(960, rand), true)
		const before = sim.produced.length
		sim.step(500)
		expect(sim.produced.length - before).toBe(5)
		expect(sim.router.clockRebases).toBe(1)
		for (let i = 0; i < 100; i++) {
			sim.analog(noise(960, rand), true)
			sim.step()
		}
		expect(sim.router.clockRebases).toBe(1)
		const reads = sim.of("analog", "read")
		for (let i = 1; i < reads.length; i++) {
			const a = reads[i - 1]
			const b = reads[i]
			if (a && b) expect(b.from).toBe(a.from + a.count)
		}
		sim.expectReadsMatch("analog", sim.analogRef())
		expect(sim.of("analog", "drop")).toHaveLength(0)
	})

	it("emits nothing after a backward clock step until due passes emitted (design, pacing)", () => {
		const sim = new Sim()
		sim.connect()
		for (let i = 0; i < 5; i++) sim.step()
		sim.step(-100)
		expect(sim.produced).toHaveLength(5)
		for (let i = 0; i < 5; i++) sim.step()
		expect(sim.produced).toHaveLength(5)
		sim.step(20)
		expect(sim.produced).toHaveLength(6)
		expect(sim.router.clockRebases).toBe(0)
	})

	it("digital preempts a stuck-open analog at 1.5 s and counts the drop (4.5, 9.2)", () => {
		const sim = new Sim()
		const rand = lcg(5)
		sim.connect()
		let firstVoiceAt = -1
		for (let i = 0; i < 300; i++) {
			sim.analog(noise(960, rand), true)
			if (i >= 50 && i < 250) {
				if (firstVoiceAt < 0) firstVoiceAt = sim.clock.t
				sim.frame("dmr", noise(160, rand))
			}
			sim.step()
		}
		const idx = sim.events.findIndex(e => e.active === "digital")
		expect(idx).toBeGreaterThan(0)
		const at = sim.eventTimes[idx] ?? 0
		expect(at - firstVoiceAt).toBeLessThanOrEqual(1_500 + 20)
		expect(at - firstVoiceAt).toBeGreaterThanOrEqual(1_500)
		expect(sim.router.droppedSamples).toBeGreaterThan(0)
		const s = sim.router.status({ httpUrl: "h", wavUrl: "w" })
		expect(s.droppedMs).toBe(sim.router.droppedSamples / 48)
		// Analog never preempts digital: the next switch comes after digital's last frame + 300 ms.
		const next = sim.eventTimes[idx + 1]
		if (next !== undefined) expect(next).toBeGreaterThanOrEqual(250 * 20 + 300)
		sim.expectReadsMatch("dmr", sim.voiceRef("dmr"))
	})

	it("plays a short digital over wholly inside the analog handover delay in full afterwards (4.10, 9.2)", () => {
		const sim = new Sim()
		const rand = lcg(6)
		sim.connect()
		// 1 s of delayed analog audio (as a pre-roll catch-up delivers it), then silence.
		sim.analog(noise(48_000, rand), true)
		for (let i = 0; i < 150; i++) {
			if (i >= 5 && i < 30) sim.frame("dmr", noise(160, rand))
			if (i === 30) sim.callEvent("dmr", call({ active: false }))
			sim.analog(new Int16Array(960), false)
			sim.step()
		}
		expect(sim.events.map(e => e.active)).toEqual(["analog", "digital", "none"])
		const ref = sim.voiceRef("dmr")
		sim.expectReadsMatch("dmr", ref)
		expect(sim.positions("dmr", ["read"]).size).toBe(ref.samples.length)
		const aref = sim.analogRef()
		const aread = sim.positions("analog", ["read"])
		expect(missing(aref, aread)).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("starts digital after 200 ms queued or waited (4.6)", () => {
		const sim = new Sim()
		const rand = lcg(7)
		sim.connect()
		for (let i = 0; i < 30; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		expect(sim.events[0]?.active).toBe("digital")
		const at = sim.eventTimes[0] ?? 0
		expect(at).toBeGreaterThanOrEqual(200)
		expect(at).toBeLessThanOrEqual(240)
	})

	it("never routes an encrypted call; clear then encrypted with audio queued drops it (3.2, 4.10)", () => {
		const sim = new Sim()
		const rand = lcg(8)
		sim.connect()
		for (let i = 0; i < 20; i++) {
			sim.frame("enc", noise(160, rand), call({ encrypted: true }))
			sim.step()
		}
		expect(sim.of("enc", "write")).toHaveLength(0)
		// Clear audio queued (start buffer not met), then an encrypted update, no datagram.
		for (let i = 0; i < 3; i++) sim.frame("dmr", noise(160, rand))
		sim.callEvent("dmr", call({ encrypted: true }))
		for (let i = 0; i < 50; i++) sim.step()
		expect(sim.of("dmr", "read")).toHaveLength(0)
		expect(sim.of("dmr", "drop").length).toBeGreaterThan(0)
		expect(sim.events).toHaveLength(0)
	})

	it("stops reading at once when a playing call turns encrypted (4.10)", () => {
		const sim = new Sim()
		const rand = lcg(9)
		sim.connect()
		for (let i = 0; i < 30; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		expect(sim.of("dmr", "read").length).toBeGreaterThan(0)
		const t = sim.clock.t
		sim.callEvent("dmr", call({ encrypted: true }))
		for (let i = 0; i < 20; i++) {
			sim.frame("dmr", new Int16Array(160), call({ encrypted: true }))
			sim.step()
		}
		expect(sim.of("dmr", "read").filter(r => r.at > t)).toHaveLength(0)
		expect(sim.events.at(-1)?.active).toBe("none")
	})

	it("detach clears a selected decoder and goes to none (5.1)", () => {
		const sim = new Sim()
		const rand = lcg(10)
		sim.connect()
		for (let i = 0; i < 15; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		expect(sim.events.at(-1)?.active).toBe("digital")
		sim.voice.tap?.detach("dmr")
		expect(sim.events.at(-1)?.active).toBe("none")
		expect(sim.of("dmr", "drop").length).toBeGreaterThan(0)
	})

	it("invalidates on coverage generation changes between ticks and calls covers once per generation (3.4)", () => {
		const sim = new Sim()
		const rand = lcg(11)
		sim.connect()
		for (let i = 0; i < 3; i++) sim.frame("dmr", noise(160, rand))
		// A → B → A between two ticks, with no frames.
		sim.coverage.generation++
		sim.coverage.generation++
		sim.coverage.generation++
		for (let i = 0; i < 30; i++) sim.step()
		expect(sim.of("dmr", "read")).toHaveLength(0)
		expect(sim.of("dmr", "drop").length).toBe(1)
		const perGen = new Map<number, number>()
		for (const c of sim.coverage.calls)
			perGen.set(c.generation, (perGen.get(c.generation) ?? 0) + 1)
		for (const n of perGen.values()) expect(n).toBe(1)
		expect([...perGen.keys()]).toEqual([0, 3])
	})

	it("admits nothing under unknown or no coverage, or when covers throws (3.4)", () => {
		const sim = new Sim()
		const rand = lcg(12)
		sim.connect()
		sim.coverage.answer.set("a", "unknown")
		sim.coverage.answer.set("b", "no")
		for (let i = 0; i < 20; i++) {
			sim.frame("a", noise(160, rand))
			sim.frame("b", noise(160, rand))
			sim.step()
		}
		sim.coverage.throws = true
		sim.coverage.generation++
		for (let i = 0; i < 20; i++) {
			sim.frame("c", noise(160, rand))
			sim.step()
		}
		expect(sim.traces.filter(t => t.source !== "analog")).toHaveLength(0)
		expect(sim.events).toHaveLength(0)
	})

	it("drops a retuned decoder's queued voice (generation bump) before it plays (9.2)", () => {
		const sim = new Sim()
		const rand = lcg(13)
		sim.connect()
		sim.analog(noise(48_000, rand), true)
		for (let i = 0; i < 10; i++) sim.frame("dmr", noise(160, rand))
		sim.router.resetAnalog()
		sim.coverage.generation++
		sim.coverage.answer.set("dmr", "no")
		for (let i = 0; i < 50; i++) sim.step()
		expect(sim.of("dmr", "read")).toHaveLength(0)
		expect(sim.of("dmr", "drop").length).toBeGreaterThan(0)
		expect(sim.of("analog", "drop").length).toBeGreaterThan(0)
	})

	it("drops queued voice older than 3 s (4.10)", () => {
		const sim = new Sim()
		const rand = lcg(14)
		sim.connect()
		// "a" plays a 4 s call; "b" queues 0.4 s behind it and expires.
		for (let i = 0; i < 230; i++) {
			if (i < 200) sim.frame("a", noise(160, rand))
			if (i >= 2 && i < 22) sim.frame("b", noise(160, rand))
			sim.step()
		}
		expect(sim.of("b", "read")).toHaveLength(0)
		expect(sim.of("b", "drop").length).toBeGreaterThan(0)
		const s = sim.router.status({ httpUrl: "h", wavUrl: "w" })
		expect(s.droppedMs).toBeGreaterThan(300)
	})

	it("flushes the tail of a call ending in an impulse with no further datagram (4.11)", () => {
		const sim = new Sim()
		const rand = lcg(15)
		sim.connect()
		for (let i = 0; i < 20; i++) {
			const f = i === 19 ? new Int16Array(160) : noise(160, rand)
			if (i === 19) f[159] = 30_000
			sim.frame("dmr", f)
			sim.step()
		}
		sim.callEvent("dmr", call({ active: false }))
		for (let i = 0; i < 40; i++) sim.step()
		const ref = sim.voiceRef("dmr")
		expect(sim.positions("dmr", ["write"]).size).toBe(ref.samples.length)
		expect(sim.positions("dmr", ["read"]).size).toBe(ref.samples.length)
		sim.expectReadsMatch("dmr", ref)
		// The impulse's response reaches the end of the stream.
		expect(ref.samples.slice(-120).some(v => v !== 0)).toBe(true)
	})

	it("flushes on hold expiry mid-call, then again at the call end (4.11)", () => {
		const sim = new Sim()
		const rand = lcg(16)
		sim.connect()
		for (let i = 0; i < 10; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		for (let i = 0; i < 20; i++) sim.step()
		sim.markFlush("dmr")
		for (let i = 0; i < 10; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		sim.callEvent("dmr", call({ active: false }))
		// A duplicate end does not flush again.
		sim.callEvent("dmr", call({ active: false }))
		for (let i = 0; i < 40; i++) sim.step()
		const ref = sim.voiceRef("dmr")
		expect(sim.positions("dmr", ["write"]).size).toBe(ref.samples.length)
		expect(sim.positions("dmr", ["read"]).size).toBe(ref.samples.length)
		sim.expectReadsMatch("dmr", ref)
	})

	it("keeps the first decoder until it releases; ties go to the lower id (3.5)", () => {
		const sim = new Sim()
		const rand = lcg(17)
		sim.connect()
		for (let i = 0; i < 60; i++) {
			if (i < 30) sim.frame("b", noise(160, rand))
			if (i < 30) sim.frame("a", noise(160, rand))
			sim.step()
		}
		for (let i = 0; i < 100; i++) sim.step()
		const order = sim.events.map(e => e.active)
		expect(order[0]).toBe("digital")
		const statuses = sim.events.filter(e => e.active === "digital")
		expect(statuses).toHaveLength(2)
		const reads = sim.traces.filter(
			t => t.kind === "read" && t.source !== "analog",
		)
		expect(reads[0]?.source).toBe("a")
		// "b" plays only after "a" has no admitted audio left.
		const lastA = Math.max(...sim.of("a", "read").map(r => r.block))
		const firstB = Math.min(...sim.of("b", "read").map(r => r.block))
		expect(firstB).toBeGreaterThan(lastA)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("reports status and level, digital fields only while digital (6.1, 6.2)", () => {
		const bare = new Sim(48_000, false)
		const s0 = bare.router.status({
			httpUrl: "http://x/auto",
			wavUrl: "http://x/auto.wav",
		})
		expect(s0).toEqual({
			active: "none",
			since: new Date(1_700_000_000_000).toISOString(),
			httpUrl: "http://x/auto",
			wavUrl: "http://x/auto.wav",
			clientCount: 0,
			digitalAvailable: false,
			underruns: 0,
			droppedMs: 0,
			clockRebases: 0,
			latencyMs: 20,
		})
		const sim = new Sim()
		const rand = lcg(18)
		sim.connect()
		for (let i = 0; i < 15; i++) {
			sim.frame("dmr", noise(160, rand))
			sim.step()
		}
		const s = sim.router.status({ httpUrl: "h", wavUrl: "w" })
		expect(s.active).toBe("digital")
		expect(s.protocol).toBe("DMR")
		expect(s.decoderId).toBe("dmr")
		expect(s.slot).toBe(1)
		expect(s.digitalAvailable).toBe(true)
		expect(s.clientCount).toBe(1)
		expect(s.latencyMs).toBeGreaterThanOrEqual(20)
		const l1 = sim.router.level()
		const l2 = sim.router.level()
		expect(l1).toEqual({ active: "digital", protocol: "DMR" })
		expect(l1).not.toBe(l2)
		sim.frame("p25", noise(160, rand), call({ protocol: null }))
		sim.voice.tap?.detach("dmr")
		for (let i = 0; i < 15; i++) {
			sim.frame("p25", noise(160, rand), call({ protocol: null, slot: null }))
			sim.step()
		}
		const p = sim.router.status({ httpUrl: "h", wavUrl: "w" })
		expect(p.active).toBe("digital")
		expect("protocol" in p).toBe(false)
		expect(p.slot).toBeNull()
		expect(sim.router.level()).toEqual({ active: "digital" })
	})

	it("rebuilds the analog resampler on a rate or format change and ignores invalid formats (5.2)", () => {
		const sim = new Sim(25_000)
		const rand = lcg(19)
		sim.connect()
		for (let i = 0; i < 5; i++) {
			sim.analog(noise(500, rand), true)
			sim.step()
		}
		const writesBefore = sim.of("analog", "write").length
		const f = new Float32Array(960).map(() => rand() * 0.5 - 0.25)
		sim.router.pushAnalog(bytes(f), 0, f.byteLength, true, {
			rate: 48_000,
			format: "f32le",
		})
		expect(sim.of("analog", "write").length).toBe(writesBefore + 1)
		sim.router.pushAnalog(Buffer.alloc(100), 0, 100, true, {
			rate: 1_000,
			format: "s16le",
		})
		sim.router.pushAnalog(Buffer.alloc(100), 0, 100, true, {
			rate: 48_000,
			format: "u8" as "s16le",
		})
		expect(sim.of("analog", "write").length).toBe(writesBefore + 1)
		for (let i = 0; i < 10; i++) sim.step()
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("split-sample spans: lead bytes take the previous span's flag (3.6)", () => {
		const rand = lcg(20)
		const f = new Float32Array(2_000).map(() => rand() * 1.6 - 0.8)
		const buf = bytes(f)
		const stream: StreamFormat = { rate: 32_000, format: "f32le" }
		const runA = new Sim(32_000)
		runA.connect()
		// Spans cut inside samples: [0, 1 001) audible, [1 001, 5 003) silent, rest audible.
		runA.router.pushAnalog(buf, 0, 1_001, true, stream)
		runA.router.pushAnalog(buf, 1_001, 5_003, false, stream)
		runA.router.pushAnalog(buf, 5_003, buf.length, true, stream)
		const runB = new Sim(32_000)
		runB.connect()
		// Same decisions on whole samples: sample 250 started audible, 1 250 started silent.
		runB.router.pushAnalog(buf, 0, 1_004, true, stream)
		runB.router.pushAnalog(buf, 1_004, 5_004, false, stream)
		runB.router.pushAnalog(buf, 5_004, buf.length, true, stream)
		const writes = (s: Sim) =>
			s.of("analog", "write").reduce((n, w) => n + w.count, 0)
		expect(writes(runA)).toBe(writes(runB))
		for (let i = 0; i < 20; i++) {
			runA.step()
			runB.step()
		}
		expect(runA.outputSamples()).toEqual(runB.outputSamples())
		const removals = (sim: Sim) =>
			sim.traces
				.filter(t => t.kind !== "write")
				.map(t => [t.kind, t.from, t.count, t.block])
		expect(removals(runA)).toEqual(removals(runB))
	})

	it("resetAnalog clears a selected analog source and counts its audio (5.1)", () => {
		const sim = new Sim()
		sim.connect()
		sim.analog(noise(9_600, lcg(21)), true)
		sim.step()
		expect(sim.events.at(-1)?.active).toBe("analog")
		sim.router.resetAnalog()
		expect(sim.events.at(-1)?.active).toBe("none")
		expect(sim.router.droppedSamples).toBe(9_600 - 960 - 17)
	})

	it("stops and clears on the last disconnect; a reconnect restarts from zero (7.1)", () => {
		const sim = new Sim()
		const res = sim.connect()
		sim.analog(noise(9_600, lcg(22)), true)
		sim.frame("dmr", noise(160, lcg(23)))
		sim.step()
		res.end()
		expect(sim.router.level().active).toBe("none")
		expect(sim.of("analog", "discard").at(-1)?.count).toBe(9_600 - 17)
		expect(sim.router.droppedSamples).toBe(0)
		const n = sim.produced.length
		sim.step()
		expect(sim.produced.length).toBe(n)
		sim.connect()
		expect(sim.router.emittedSamples).toBe(0)
		sim.step()
		expect(sim.produced.length).toBe(n + 1)
		expect(sim.produced.at(-1)?.every(b => b === 0)).toBe(true)
		sim.router.destroy()
		expect(sim.router.wanted).toBe(false)
	})

	// Feature: auto-listen-route, Property 14: Output blocks are immutable
	// Validates: Requirements 2.8
	it("keeps every block intact while a socket withholds drain for seconds (delayed-drain regression)", () => {
		const sim = new Sim()
		const res = sim.connect()
		res.accept = false
		// Distinct ramps: block b holds b × 7 + k (mod 2^15) after resampling of a slow ramp.
		let v = 0
		for (let i = 0; i < 250; i++) {
			const ramp = Int16Array.from({ length: 960 }, () => {
				v = (v + 13) % 20_000
				return v + 1
			})
			sim.analog(ramp, true)
			sim.step()
		}
		// 5 s withheld: the socket took one block and holds it; the registry queued the rest.
		expect(res.received).toHaveLength(1)
		res.accept = true
		res.emit("drain")
		expect(res.received.length).toBeGreaterThan(1)
		// Nothing the router produced was written again after it was handed over.
		sim.produced.forEach((b, i) => {
			expect(b.equals(sim.snapshots[i] ?? Buffer.alloc(0))).toBe(true)
		})
		// Every buffer the client received is a slice of one produced block, unchanged.
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
		expect(new Set(sim.produced).size).toBe(sim.produced.length)
	})
})
