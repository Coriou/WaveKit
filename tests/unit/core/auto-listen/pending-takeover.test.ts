/**
 * Listen (2026-11-15): pending voice and takeover. Decoded voice handed over before its call is
 * active and explicitly clear waits (AUTO_ROUTE_PENDING_VOICE_MS) and is admitted in order when
 * the call turns active and clear, or let go uncounted (encrypted, unresolved, not covering, past
 * the bound). Analog that no content check governs yields to an admitted clear call after its
 * 200 ms start buffer (AUTO_ROUTE_TAKEOVER_MS) instead of the 1.5 s preemption bound.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	AUTO_ROUTE_PENDING_END_GUARD_MS,
	AUTO_ROUTE_PENDING_VOICE_MS,
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
import {
	AnalogInput,
	PendingVoice,
} from "../../../../src/core/auto-listen/inputs.js"
import type { AutoRouteTrace } from "../../../../src/core/auto-listen/inputs.js"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import {
	AutoListenRouter,
	encryptionUnresolved,
} from "../../../../src/core/auto-listen/router.js"
import {
	FLAG_AUDIBLE,
	FLAG_SILENT,
} from "../../../../src/core/auto-listen/source-fifo.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { lcg } from "./helpers.js"

const logger = createLogger({ level: "fatal" })
/** 8 000 × 720 / 1 000 = 5 760 samples: 36 frames of 160 (20 ms at 8 kHz). */
const PENDING_FRAMES = (8_000 * AUTO_ROUTE_PENDING_VOICE_MS) / 1000 / 160

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
	answer: VoiceCoverage = "yes"
	covers(): VoiceCoverage {
		return this.answer
	}
}

function call(over: Partial<VoiceTapCall> = {}): VoiceTapCall {
	return {
		callId: "c1",
		active: true,
		encrypted: false,
		protocol: "DMR",
		slot: 1,
		...over,
	}
}

/** A call event carrying the later `encryptionKnown` field (not in VoiceTapCall yet). */
function callWithKnown(
	known: boolean,
	over: Partial<VoiceTapCall> = {},
): VoiceTapCall & { encryptionKnown: boolean } {
	return { ...call(over), encryptionKnown: known }
}

function noise(n: number, rand: () => number, amp = 20_000): Int16Array {
	return Int16Array.from({ length: n }, () => {
		const v = Math.round((rand() * 2 - 1) * amp)
		return v === 0 ? 1 : v
	})
}

function bytes(a: Int16Array): Buffer {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
}

/** `count` distinct deterministic 20 ms frames. */
function frames(count: number, seed = 5): Buffer[] {
	const rand = lcg(seed)
	return Array.from({ length: count }, () => bytes(noise(160, rand)))
}

/** Router, one client, fake voice and coverage; 20 ms per step; the played samples per source. */
class Sim {
	readonly clock = new FakeClock()
	readonly traces: AutoRouteTrace[] = []
	readonly voice = new FakeVoice()
	readonly coverage = new FakeCoverage()
	readonly router: AutoListenRouter
	readonly actives: string[] = []
	/** Played samples of each source, in output order. */
	readonly played = new Map<string, number[]>()
	private readonly loud = noise(960, lcg(11))
	private pendingReads: Array<{ source: string; count: number }> = []

	constructor() {
		this.router = new AutoListenRouter(logger, {
			clock: this.clock,
			wallClock: () => 1_700_000_000_000 + this.clock.t,
			trace: t => {
				this.traces.push({ ...t })
				if (t.kind === "read")
					this.pendingReads.push({ source: t.source, count: t.count })
			},
		})
		this.router.attachVoice(this.voice, this.coverage)
		const write = this.router.registry.write.bind(this.router.registry)
		this.router.registry.write = (chunk: Buffer) => {
			let at = 0
			for (const r of this.pendingReads) {
				let list = this.played.get(r.source)
				if (list === undefined) {
					list = []
					this.played.set(r.source, list)
				}
				for (let k = 0; k < r.count; k++)
					list.push(chunk.readInt16LE(2 * (at + k)))
				at += r.count
			}
			this.pendingReads = []
			write(chunk)
		}
		this.router.registry.register(
			new FakeResponse() as unknown as http.ServerResponse,
			"127.0.0.1",
			AUTO_ROUTE_STREAM,
		)
	}

	/** One 20 ms step: optional analog span and voice frames (call null: before a call), one block. */
	step(
		opts: {
			analog?: boolean
			frames?: Buffer[]
			call?: VoiceTapCall | null
		} = {},
	): void {
		if (opts.analog !== undefined) {
			const buf = bytes(opts.analog ? this.loud : new Int16Array(960))
			this.router.pushAnalog(buf, 0, buf.length, opts.analog, {
				rate: 48_000,
				format: "s16le",
			})
		}
		for (const f of opts.frames ?? [])
			this.voice.tap?.frame("dmr", f, opts.call ?? null)
		this.clock.tick(20)
		this.actives.push(this.router.status({ httpUrl: "h", wavUrl: "w" }).active)
	}

	written(source: string): number {
		let n = 0
		for (const t of this.traces)
			if (t.source === source && t.kind === "write") n += t.count
		return n
	}

	read(source: string): number {
		return this.played.get(source)?.length ?? 0
	}
}

/** Plays `list` as one call: frames [0, pre) before the call event, the rest during it. */
function playCall(
	list: Buffer[],
	pre: number,
	start: VoiceTapCall = call(),
): Sim {
	const sim = new Sim()
	for (let i = 0; i < list.length; i++) {
		if (i === pre) sim.voice.tap?.call("dmr", start)
		const f = list[i] as Buffer
		sim.step({ frames: [f], call: i < pre ? null : start })
	}
	// Every frame came before the call event: it comes after the last one.
	if (pre >= list.length) sim.voice.tap?.call("dmr", start)
	sim.voice.tap?.call("dmr", call({ active: false }))
	for (let i = 0; i < 40; i++) sim.step()
	return sim
}

describe("pending voice (AUTO_ROUTE_PENDING_VOICE_MS)", () => {
	it("the bound is 720 ms: 36 frames of 20 ms at 8 kHz", () => {
		expect(AUTO_ROUTE_PENDING_VOICE_MS).toBe(720)
		expect(PENDING_FRAMES).toBe(36)
		expect(new PendingVoice(8_000).capacity).toBe(5_760)
	})

	it("voice before the call turns active and clear is admitted in order: the same audio as a call active from its first frame", () => {
		const list = frames(60)
		const reference = playCall(list, 0)
		// The first 400 ms (20 frames) arrive before the call event.
		const pending = playCall(list, 20)
		expect(pending.read("dmr")).toBe(reference.read("dmr"))
		expect(pending.played.get("dmr")).toEqual(reference.played.get("dmr"))
		expect(pending.router.droppedSamples).toBe(0)
		// One source, one switch to digital.
		expect(
			pending.actives.filter((a, i) => a !== pending.actives[i - 1]),
		).toEqual(["none", "digital", "none"])
	})

	it("admitted pending voice satisfies the start buffer by its age: playing in the block after the call event", () => {
		const list = frames(40)
		const sim = new Sim()
		for (let i = 0; i < 20; i++) sim.step({ frames: [list[i] as Buffer] })
		expect(sim.written("dmr")).toBe(0)
		expect(sim.actives.every(a => a === "none")).toBe(true)
		sim.voice.tap?.call("dmr", call())
		sim.step({ frames: [list[20] as Buffer], call: call() })
		expect(sim.actives.at(-1)).toBe("digital")
	})

	it("at the bound all 36 frames are kept; past it the oldest go first (frames handed over at once)", () => {
		for (const extra of [0, 1, 5]) {
			const list = frames(PENDING_FRAMES + extra)
			const sim = new Sim()
			for (const f of list) sim.voice.tap?.frame("dmr", f, null)
			sim.voice.tap?.call("dmr", call())
			for (let i = 0; i < 60; i++) sim.step()
			sim.voice.tap?.call("dmr", call({ active: false }))
			for (let i = 0; i < 40; i++) sim.step()
			// The reference: only the newest 36 frames, admitted as a call.
			const ref = new Sim()
			ref.voice.tap?.call("dmr", call())
			for (const f of list.slice(extra)) ref.voice.tap?.frame("dmr", f, call())
			for (let i = 0; i < 60; i++) ref.step()
			ref.voice.tap?.call("dmr", call({ active: false }))
			for (let i = 0; i < 40; i++) ref.step()
			expect(sim.played.get("dmr")).toEqual(ref.played.get("dmr"))
			expect(sim.router.droppedSamples).toBe(0)
		}
	})

	it("voice older than 720 ms at the call event is let go: 1 s before the call keeps the newest 36 frames", () => {
		const list = frames(50)
		const sim = playCall(list, 50)
		// No frame arrived during the call; the call event admits the frames from 280 ms on.
		const ref = new Sim()
		for (let i = 0; i < 50; i++) ref.step()
		ref.voice.tap?.call("dmr", call())
		for (const f of list.slice(50 - PENDING_FRAMES))
			ref.voice.tap?.frame("dmr", f, call())
		ref.voice.tap?.call("dmr", call({ active: false }))
		for (let i = 0; i < 40; i++) ref.step()
		expect(sim.played.get("dmr")).toEqual(ref.played.get("dmr"))
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("an encrypted call lets its pending voice go uncounted: nothing written, nothing dropped", () => {
		const sim = playCall(frames(40), 20, call({ encrypted: true }))
		expect(sim.written("dmr")).toBe(0)
		expect(sim.actives.every(a => a === "none")).toBe(true)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("a call whose encryption is not explicitly false is not clear (fail closed)", () => {
		const unknown = {
			...call(),
			encrypted: undefined,
		} as unknown as VoiceTapCall
		const sim = playCall(frames(40), 20, unknown)
		expect(sim.written("dmr")).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("the call ending before it turns active lets pending voice go", () => {
		const sim = new Sim()
		for (const f of frames(20)) sim.step({ frames: [f] })
		sim.voice.tap?.call("dmr", call({ active: false }))
		sim.voice.tap?.call("dmr", call())
		for (let i = 0; i < 30; i++) sim.step()
		expect(sim.written("dmr")).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("a decoder that does not cover the tuned channel never keeps or admits pending voice", () => {
		const sim = new Sim()
		sim.coverage.answer = "no"
		const list = frames(40)
		for (let i = 0; i < 20; i++) sim.step({ frames: [list[i] as Buffer] })
		// Coverage turns yes (a retune settles) before the call: the earlier voice is not kept.
		sim.coverage.answer = "yes"
		sim.coverage.generation++
		sim.voice.tap?.call("dmr", call())
		for (let i = 20; i < 40; i++)
			sim.step({ frames: [list[i] as Buffer], call: call() })
		const ref = playCall(list.slice(20), 0)
		expect(sim.played.get("dmr")).toEqual(
			ref.played.get("dmr")?.slice(0, sim.read("dmr")),
		)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("a coverage change while voice is pending lets it go (never admitted for another channel)", () => {
		const sim = new Sim()
		for (const f of frames(20)) sim.step({ frames: [f] })
		sim.coverage.answer = "no"
		sim.coverage.generation++
		sim.step()
		sim.coverage.answer = "yes"
		sim.coverage.generation++
		sim.voice.tap?.call("dmr", call())
		for (let i = 0; i < 30; i++) sim.step()
		expect(sim.written("dmr")).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("under analog no voice is kept pending", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("analog", false)
		for (const f of frames(20)) sim.step({ frames: [f] })
		sim.router.setListenPolicy("auto", false)
		sim.voice.tap?.call("dmr", call())
		for (let i = 0; i < 30; i++) sim.step()
		expect(sim.written("dmr")).toBe(0)
	})

	describe("encryptionKnown seam", () => {
		it("reads the optional field without widening the type", () => {
			expect(encryptionUnresolved(call())).toBe(false)
			expect(encryptionUnresolved(callWithKnown(true))).toBe(false)
			expect(encryptionUnresolved(callWithKnown(false))).toBe(true)
		})

		it("encryptionKnown false: not clear; voice stays pending and goes when the call ends unresolved", () => {
			const sim = playCall(frames(40), 10, callWithKnown(false))
			expect(sim.written("dmr")).toBe(0)
			expect(sim.actives.every(a => a === "none")).toBe(true)
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("encryptionKnown false then resolved clear: the voice of the last 720 ms is admitted in order", () => {
			const list = frames(60)
			const sim = new Sim()
			const unresolved = callWithKnown(false)
			sim.voice.tap?.call("dmr", unresolved)
			for (let i = 0; i < 20; i++)
				sim.step({ frames: [list[i] as Buffer], call: unresolved })
			expect(sim.written("dmr")).toBe(0)
			const clear = callWithKnown(true)
			sim.voice.tap?.call("dmr", clear)
			for (let i = 20; i < 60; i++)
				sim.step({ frames: [list[i] as Buffer], call: clear })
			sim.voice.tap?.call("dmr", call({ active: false }))
			for (let i = 0; i < 40; i++) sim.step()
			expect(sim.played.get("dmr")).toEqual(playCall(list, 0).played.get("dmr"))
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("encryptionKnown false then encrypted: nothing is ever written", () => {
			const sim = new Sim()
			const unresolved = callWithKnown(false)
			for (const f of frames(20)) sim.step({ frames: [f], call: unresolved })
			sim.voice.tap?.call("dmr", callWithKnown(true, { encrypted: true }))
			for (let i = 0; i < 30; i++) sim.step()
			expect(sim.written("dmr")).toBe(0)
			expect(sim.router.droppedSamples).toBe(0)
		})
	})

	// Feature: listen-modes, Property 3: Pending voice is admitted in order or not at all
	// Validates: Router change (a): pending voice up to 720 ms, admitted when active and clear, fail-closed
	it("property: whatever the split before the call event, the played voice is a suffix of the call's audio (no gap, no duplicate)", () => {
		const list = frames(70, 17)
		const full = playCall(list, 0).played.get("dmr") ?? []
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 60 }), pre => {
				const got = playCall(list, pre).played.get("dmr") ?? []
				expect(got.length).toBeGreaterThan(0)
				// Up to 36 pending frames are kept: with at most 36 before the call, all of it plays.
				if (pre <= PENDING_FRAMES) expect(got).toEqual(full)
				else {
					// Older frames were let go: what plays is the call's audio from a later frame on,
					// a contiguous run; the resampler starts fresh at its first admitted sample, so
					// its first `taps` inputs (× 6 outputs at 48 kHz) differ from the full run's.
					const edge = new PolyphaseResampler(8_000, 48_000).taps * 6
					const tail = full.slice(full.length - got.length + edge)
					expect(got.slice(edge)).toEqual(tail)
					expect(got.length).toBeLessThan(full.length)
				}
			}),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("takeover of unchecked analog (AUTO_ROUTE_TAKEOVER_MS)", () => {
	/** Continuous audible analog; a clear call's frames from block 50 to 150. */
	function scene(checked: boolean): { sim: Sim; firstFrameAt: number } {
		const sim = new Sim()
		sim.router.setAnalogVoiceChecked(checked)
		const list = frames(100)
		let firstFrameAt = 0
		for (let b = 0; b < 300; b++) {
			if (b === 50) {
				sim.voice.tap?.call("dmr", call())
				firstFrameAt = sim.clock.t
			}
			if (b === 150) sim.voice.tap?.call("dmr", call({ active: false }))
			const f = b >= 50 && b < 150 ? list[b - 50] : undefined
			sim.step({
				analog: true,
				...(f !== undefined ? { frames: [f], call: call() } : {}),
			})
		}
		return { sim, firstFrameAt }
	}

	it("the takeover bound is the 200 ms start buffer", () => {
		expect(AUTO_ROUTE_TAKEOVER_MS).toBe(200)
	})

	it("unchecked: the call takes over after its start buffer, nothing counted, no analog queued during the call plays after it", () => {
		const { sim, firstFrameAt } = scene(false)
		const firstDigital = sim.actives.indexOf("digital")
		const takeoverMs = (firstDigital + 1) * 20 - firstFrameAt
		// Selected in the block where the oldest frame has waited 200 ms (one block of slack).
		expect(takeoverMs).toBeGreaterThanOrEqual(AUTO_ROUTE_TAKEOVER_MS)
		expect(takeoverMs).toBeLessThanOrEqual(AUTO_ROUTE_TAKEOVER_MS + 20)
		expect(sim.router.droppedSamples).toBe(0)
		// One switch to digital, one back to analog after the call's release.
		const changes = sim.actives.filter((a, i) => a !== sim.actives[i - 1])
		expect(changes).toEqual(["analog", "digital", "analog"])
		// Analog after the call is new audio: its first played sample was written after the call
		// released (the analog queued during the call was let go, traced as discards).
		const discards = sim.traces.filter(
			t => t.source === "analog" && t.kind === "discard",
		)
		expect(discards.reduce((n, t) => n + t.count, 0)).toBeGreaterThan(90 * 960)
	})

	it("checked (Voice only on): the 1.5 s preemption bound and its counted drop, as before", () => {
		const { sim, firstFrameAt } = scene(true)
		const firstDigital = sim.actives.indexOf("digital")
		const preemptMs = (firstDigital + 1) * 20 - firstFrameAt
		expect(preemptMs).toBeGreaterThanOrEqual(1_500)
		expect(preemptMs).toBeLessThanOrEqual(1_520)
		expect(sim.router.droppedSamples).toBeGreaterThan(0)
	})

	it("a pending analog keeps an unchecked over from the takeover", () => {
		const sim = new Sim()
		sim.router.setAnalogVoiceChecked(false)
		for (let b = 0; b < 10; b++) sim.step({ analog: true })
		sim.router.setListenPolicy("analog", false)
		const list = frames(60)
		for (const f of list) sim.step({ analog: true, frames: [f], call: call() })
		expect(sim.actives.every(a => a === "analog")).toBe(true)
		expect(sim.router.droppedSamples).toBe(0)
	})
})

describe("digital in force skips analog resampling (pushAnalog)", () => {
	it("writes nothing to the analog FIFO under digital, keeps audibility, and resumes on the sample grid", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("digital", false)
		for (let b = 0; b < 20; b++) sim.step({ analog: true })
		expect(sim.written("analog")).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
		sim.router.setListenPolicy("auto", false)
		for (let b = 0; b < 20; b++) sim.step({ analog: true })
		expect(sim.written("analog")).toBeGreaterThan(0)
		expect(sim.actives.at(-1)).toBe("analog")
	})

	it("AnalogInput.skip keeps a split sample exact: a constant resumes as that constant", () => {
		const stream = { rate: 48_000, format: "s16le" as const }
		const input = new AnalogInput({ droppedSamples: 0 }, undefined)
		const pcm = Buffer.alloc(2_000)
		for (let i = 0; i < 1_000; i++) pcm.writeInt16LE(1_000, i * 2)
		// A first push builds the resampler, then odd spans are skipped (a sample split across them).
		input.push(pcm, 0, 200, FLAG_AUDIBLE, stream, 0)
		input.skip(pcm, 0, 101, FLAG_SILENT, stream, 1)
		expect(input.audibleNow).toBe(false)
		input.skip(pcm, 101, 333, FLAG_AUDIBLE, stream, 2)
		expect(input.audibleNow).toBe(true)
		expect(input.lastAudibleAt).toBe(2)
		const before = input.out.queued
		// 333 bytes skipped from an aligned start: the next span starts with byte 2 of a sample.
		input.push(pcm, 1, 2_000, FLAG_AUDIBLE, stream, 3)
		const queued = input.out.queued
		expect(queued).toBeGreaterThan(before)
		const out = new Int16Array(queued)
		input.out.read(out, queued)
		// Past the fresh resampler's edge the constant comes back: no byte-swapped samples.
		const tail = Array.from(out.slice(-200))
		expect(tail.every(v => Math.abs(v - 1_000) <= 2)).toBe(true)
	})
})

describe("AnalogInput.skip before the input was set up for the stream", () => {
	/** 1 001-byte spans: no span is whole samples, so every boundary splits a sample. */
	const SPAN = 1_001
	const SPANS = 20
	const SKIPPED = 3

	/**
	 * A constant in `format`, `SKIPPED` spans skipped, then the rest pushed; optionally a
	 * first push of another stream (the format changes while skipping). Returns the output.
	 */
	function skipThenPush(
		format: "s16le" | "f32le",
		prior: "s16le" | "f32le" | null,
	): Int16Array {
		const stream = { rate: 48_000, format }
		const fb = format === "f32le" ? 4 : 2
		const pcm = Buffer.alloc(Math.ceil((SPAN * SPANS) / fb) * fb)
		for (let i = 0; i < pcm.length / fb; i++)
			if (format === "f32le") pcm.writeFloatLE(0.5, i * 4)
			else pcm.writeInt16LE(1_000, i * 2)
		const input = new AnalogInput({ droppedSamples: 0 }, undefined)
		if (prior !== null) {
			const other = Buffer.alloc(1_000)
			input.push(
				other,
				0,
				999,
				FLAG_AUDIBLE,
				{ rate: 48_000, format: prior },
				0,
			)
			input.out.read(new Int16Array(input.out.queued), input.out.queued)
		}
		let at = 0
		for (let k = 0; k < SKIPPED; k++) {
			input.skip(pcm, at, at + SPAN, FLAG_AUDIBLE, stream, 1 + k)
			at += SPAN
		}
		expect(input.out.queued).toBe(0)
		expect(input.audibleNow).toBe(true)
		for (let k = SKIPPED; k < SPANS; k++) {
			input.push(pcm, at, at + SPAN, FLAG_AUDIBLE, stream, 1 + k)
			at += SPAN
		}
		const out = new Int16Array(input.out.queued)
		input.out.read(out, out.length)
		return out
	}

	it("f32le: a constant 0.5 resumes exact after skipped odd spans (route started under digital)", () => {
		const out = skipThenPush("f32le", null)
		// 17 pushed spans of 1 001 bytes: 4 254 whole f32 samples at 48 kHz in, as many out.
		expect(out.length).toBeGreaterThan(4_000)
		// 0.5 × 32 767 = 16 383.5, rounded half away: 16 384; past the fresh resampler's edge.
		const tail = Array.from(out.slice(-2_000))
		expect(tail.every(v => Math.abs(v - 16_384) <= 2)).toBe(true)
	})

	it("s16le: a constant resumes exact after skipped odd spans (route started under digital)", () => {
		const out = skipThenPush("s16le", null)
		const tail = Array.from(out.slice(-4_000))
		expect(tail.every(v => Math.abs(v - 1_000) <= 2)).toBe(true)
	})

	it("a format change while skipping (s16le → f32le) takes the new geometry: the constant resumes exact", () => {
		const out = skipThenPush("f32le", "s16le")
		const tail = Array.from(out.slice(-2_000))
		expect(tail.every(v => Math.abs(v - 16_384) <= 2)).toBe(true)
	})

	it("router: started under digital with f32le analog, then auto plays the analog exact", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("digital", false)
		const stream = { rate: 48_000, format: "f32le" as const }
		const pcm = Buffer.alloc(SPAN * 60 + 3)
		for (let i = 0; i < pcm.length / 4 - 1; i++) pcm.writeFloatLE(0.5, i * 4)
		let at = 0
		for (let k = 0; k < SKIPPED; k++) {
			sim.router.pushAnalog(pcm, at, at + SPAN, true, stream)
			at += SPAN
			sim.clock.tick(20)
		}
		expect(sim.written("analog")).toBe(0)
		sim.router.setListenPolicy("auto", false)
		for (let k = SKIPPED; k < 60; k++) {
			sim.router.pushAnalog(pcm, at, at + SPAN, true, stream)
			at += SPAN
			sim.clock.tick(20)
		}
		const played = sim.played.get("analog") ?? []
		expect(played.length).toBeGreaterThan(5_000)
		expect(played.slice(-3_000).every(v => Math.abs(v - 16_384) <= 2)).toBe(
			true,
		)
	})
})

describe("pending voice after a call ends (AUTO_ROUTE_PENDING_END_GUARD_MS)", () => {
	it("the guard is two 60 ms bursts: 120 ms", () => {
		expect(AUTO_ROUTE_PENDING_END_GUARD_MS).toBe(120)
	})

	/**
	 * A first call (frames 0..9) ends with `end`; then 10 steps of 20 ms whose voice comes with
	 * no call (step i at i × 20 ms after the end, kept when `late(i)`), `gap` empty steps, then a
	 * clear call (frames 20..34) and its end. Returns the played decoded voice.
	 */
	function overThenClear(
		first: VoiceTapCall,
		end: VoiceTapCall,
		late: (i: number) => boolean,
		gap = 0,
	): number[] {
		const sim = new Sim()
		const list = frames(35, 9)
		sim.voice.tap?.call("dmr", first)
		for (let i = 0; i < 10; i++)
			sim.step({ frames: [list[i] as Buffer], call: first })
		sim.voice.tap?.call("dmr", end)
		for (let i = 0; i < gap; i++) sim.step()
		for (let i = 0; i < 10; i++)
			sim.step(late(i) ? { frames: [list[10 + i] as Buffer] } : {})
		const next = call({ callId: "c2" })
		sim.voice.tap?.call("dmr", next)
		for (let i = 20; i < 35; i++)
			sim.step({ frames: [list[i] as Buffer], call: next })
		sim.voice.tap?.call("dmr", call({ callId: "c2", active: false }))
		for (let i = 0; i < 60; i++) sim.step()
		expect(sim.router.droppedSamples).toBe(0)
		return sim.played.get("dmr") ?? []
	}

	const all = (): boolean => true
	const none = (): boolean => false

	it("an encrypted call's late voice (no call) is never admitted at a clear call's head", () => {
		const enc = call({ callId: "e1", encrypted: true })
		const end = call({ callId: "e1", active: false, encrypted: true })
		const played = overThenClear(enc, end, all)
		expect(played.length).toBeGreaterThan(0)
		// Exactly the clear call's own voice: the same as with no late voice at all.
		expect(played).toEqual(overThenClear(enc, end, none))
	})

	it("after an encrypted end, voice with no call is dropped until the next call event, however late", () => {
		const enc = call({ callId: "e1", encrypted: true })
		const end = call({ callId: "e1", active: false, encrypted: true })
		// 1 s after the end: past the guard, still within 720 ms of the clear call.
		expect(overThenClear(enc, end, all, 50)).toEqual(
			overThenClear(enc, end, none, 50),
		)
	})

	it("an unresolved end (encryptionKnown false) drops the late voice the same way", () => {
		const unresolved = callWithKnown(false, { callId: "u1" })
		const end = callWithKnown(false, { callId: "u1", active: false })
		const played = overThenClear(unresolved, end, all)
		expect(played.length).toBeGreaterThan(0)
		expect(played).toEqual(overThenClear(unresolved, end, none))
	})

	it("after a clear end, voice within 120 ms is the over's tail (not prepended); from 120 ms on it is the next call's pre-voice", () => {
		const first = call({ callId: "c1" })
		const end = call({ callId: "c1", active: false })
		const played = overThenClear(first, end, all)
		// Steps 0..5 (0..100 ms after the end) are let go; step 6 (120 ms, at the bound) is kept.
		expect(played).toEqual(overThenClear(first, end, i => i >= 6))
		expect(played).not.toEqual(overThenClear(first, end, i => i >= 7))
		expect(played).not.toEqual(overThenClear(first, end, none))
	})

	it("an active encrypted call's voice with no call is never pending either", () => {
		const sim = new Sim()
		const list = frames(30, 3)
		sim.voice.tap?.call("dmr", call({ callId: "e1", encrypted: true }))
		for (let i = 0; i < 10; i++) sim.step({ frames: [list[i] as Buffer] })
		// The same call turns out clear: only its voice from now on plays.
		const clear = call({ callId: "e1" })
		sim.voice.tap?.call("dmr", clear)
		expect(sim.written("dmr")).toBe(0)
	})
})

describe("analog requested lets pending voice go", () => {
	it("voice pending on another decoder while a call plays and analog waits is let go, not admitted later", () => {
		const sim = new Sim()
		const a = frames(20, 21)
		const b = frames(10, 22)
		const other = call({ callId: "o1" })
		sim.voice.tap?.call("dmr2", other)
		// dmr2 plays its call; dmr hands over voice with no call meanwhile (pending).
		for (let i = 0; i < 15; i++) {
			sim.voice.tap?.frame("dmr2", a[i] as Buffer, other)
			sim.step(i >= 10 ? { frames: [b[i - 10] as Buffer] } : {})
		}
		expect(sim.actives.at(-1)).toBe("digital")
		sim.router.setListenPolicy("analog", false)
		expect(
			sim.router.status({ httpUrl: "h", wavUrl: "w" }).pendingListenMode,
		).toBe("analog")
		sim.step({ frames: [b[5] as Buffer] })
		sim.router.setListenPolicy("auto", false)
		sim.voice.tap?.call("dmr2", call({ callId: "o1", active: false }))
		sim.voice.tap?.call("dmr", call({ callId: "c9" }))
		expect(sim.written("dmr")).toBe(0)
	})
})

describe("analogChecked returns to the safe default", () => {
	function preemptMs(prepare: (sim: Sim) => void): number {
		const sim = new Sim()
		sim.router.setAnalogVoiceChecked(false)
		prepare(sim)
		const list = frames(100)
		let firstFrameAt = 0
		for (let b = 0; b < 200; b++) {
			if (b === 50) {
				sim.voice.tap?.call("dmr", call())
				firstFrameAt = sim.clock.t
			}
			const f = b >= 50 && b < 150 ? list[b - 50] : undefined
			sim.step({
				analog: true,
				...(f !== undefined ? { frames: [f], call: call() } : {}),
			})
		}
		return (sim.actives.indexOf("digital") + 1) * 20 - firstFrameAt
	}

	it("unchecked stays unchecked without a reset: the 200 ms takeover", () => {
		expect(preemptMs(() => undefined)).toBeLessThanOrEqual(
			AUTO_ROUTE_TAKEOVER_MS + 20,
		)
	})

	it("resetAnalog: checked again, the 1.5 s preemption bound", () => {
		expect(
			preemptMs(sim => {
				sim.router.resetAnalog()
			}),
		).toBeGreaterThanOrEqual(1_500)
	})

	it("a route stop (last client gone): checked again on the next start", () => {
		expect(
			preemptMs(sim => {
				sim.router.registry.closeAll("test", false)
				sim.router.registry.register(
					new FakeResponse() as unknown as http.ServerResponse,
					"127.0.0.1",
					AUTO_ROUTE_STREAM,
				)
			}),
		).toBeGreaterThanOrEqual(1_500)
	})
})
