/**
 * Listen (2026-11-15): the auto listen route's policy per `listenMode`. `auto` is the route as it
 * was; `analog` never plays decoded voice; `digital` never plays analog (silence otherwise, with
 * `reason: "no-decoder"` when no decoder covers the tuned channel); the open squelch forces
 * `analog`. A mode change is put in force at a transmission boundary, never mid-over.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	LiveAudioAutoRouteLevel,
	LiveAudioListenMode,
} from "@wavekit/api-types"
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
import { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { lcg } from "./helpers.js"

const logger = createLogger({ level: "fatal" })

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
	ids: string[] | undefined = undefined
	addVoiceTap(tap: VoiceTap): () => void {
		this.tap = tap
		return () => {
			if (this.tap === tap) this.tap = null
		}
	}
}

/** A voice source that lists its decoders (`voiceDecoderIds`). */
class ListingVoice extends FakeVoice {
	voiceDecoderIds(): readonly string[] {
		return this.ids ?? []
	}
}

class FakeCoverage implements VoiceCoveragePort {
	generation = 0
	readonly answer = new Map<string, VoiceCoverage>()
	calls = 0
	covers(id: string): VoiceCoverage {
		this.calls++
		return this.answer.get(id) ?? "yes"
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

function noise(n: number, rand: () => number, amp = 20_000): Int16Array {
	return Int16Array.from({ length: n }, () => {
		const v = Math.round((rand() * 2 - 1) * amp)
		return v === 0 ? 1 : v
	})
}

function bytes(a: Int16Array): Buffer {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
}

interface Rec extends AutoRouteTrace {
	at: number
}

/** Router at 48 kHz analog, one fake client, fake voice and coverage; 20 ms per step. */
class Sim {
	readonly clock = new FakeClock()
	readonly traces: Rec[] = []
	readonly events: LiveAudioAutoRouteLevel[] = []
	readonly actives: string[] = []
	readonly voice: FakeVoice
	readonly coverage = new FakeCoverage()
	readonly router: AutoListenRouter
	private readonly rand = lcg(7)
	/** One audible span reused per step (the property runs thousands of steps). */
	private readonly loud = noise(960, lcg(11))
	private readonly quiet = new Int16Array(960)
	record = true

	constructor(voice: FakeVoice | null = new FakeVoice()) {
		this.voice = voice ?? new FakeVoice()
		this.router = new AutoListenRouter(logger, {
			clock: this.clock,
			wallClock: () => 1_700_000_000_000 + this.clock.t,
			trace: t => {
				this.traces.push({ ...t, at: this.clock.t })
			},
		})
		this.router.on("auto-route-changed", (level: LiveAudioAutoRouteLevel) =>
			this.events.push(level),
		)
		if (voice !== null) this.router.attachVoice(this.voice, this.coverage)
	}

	connect(): void {
		this.router.registry.register(
			new FakeResponse() as unknown as http.ServerResponse,
			"127.0.0.1",
			AUTO_ROUTE_STREAM,
		)
	}

	/** One 20 ms step: optional analog span and voice frame, then one pacer block. */
	step(
		opts: { analog?: boolean | null; frame?: VoiceTapCall | null } = {},
	): void {
		if (opts.analog !== undefined && opts.analog !== null) {
			const buf = bytes(opts.analog ? this.loud : this.quiet)
			this.router.pushAnalog(buf, 0, buf.length, opts.analog, {
				rate: 48_000,
				format: "s16le",
			})
		}
		if (opts.frame !== undefined && opts.frame !== null)
			this.voice.tap?.frame("dmr", bytes(noise(160, this.rand)), opts.frame)
		this.clock.tick(20)
		if (this.record)
			this.actives.push(
				this.router.status({ httpUrl: "h", wavUrl: "w" }).active,
			)
	}

	steps(n: number, opts: Parameters<Sim["step"]>[0] = {}): void {
		for (let i = 0; i < n; i++) this.step(opts)
	}

	read(source: string): number {
		let n = 0
		for (const t of this.traces)
			if (t.source === source && t.kind === "read") n += t.count
		return n
	}

	status() {
		return this.router.status({ httpUrl: "h", wavUrl: "w" })
	}
}

describe("AutoListenRouter listen mode", () => {
	it("auto (default): analog plays, then a clear call plays decoded", () => {
		const sim = new Sim()
		sim.connect()
		expect(sim.router.listenMode).toBe("auto")
		sim.steps(25, { analog: true })
		expect(sim.actives).toContain("analog")
		sim.steps(30, { analog: false })
		sim.steps(30, { analog: false, frame: call() })
		expect(sim.actives.at(-1)).toBe("digital")
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("analog: decoded voice is never queued or played, nothing is counted dropped", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("analog", false)
		sim.connect()
		// A 4 s call: longer than the 3 s FIFO, so queued voice would age out (counted) if kept.
		sim.steps(200, { analog: false, frame: call() })
		expect(sim.actives.every(a => a !== "digital")).toBe(true)
		expect(sim.traces.some(t => t.source === "dmr" && t.kind === "write")).toBe(
			false,
		)
		sim.steps(25, { analog: true })
		expect(sim.actives.at(-1)).toBe("analog")
		expect(sim.router.droppedSamples).toBe(0)
		expect(sim.status().listenMode).toBe("analog")
		expect("reason" in sim.status()).toBe(false)
	})

	it("digital: analog never plays (no counted drop over 4 s of audible analog); a clear call plays", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("digital", false)
		sim.connect()
		sim.steps(200, { analog: true })
		expect(sim.read("analog")).toBe(0)
		expect(sim.actives.every(a => a === "none")).toBe(true)
		expect(sim.router.droppedSamples).toBe(0)
		sim.steps(30, { analog: true, frame: call() })
		expect(sim.actives.at(-1)).toBe("digital")
		expect(sim.read("analog")).toBe(0)
		expect(sim.router.droppedSamples).toBe(0)
	})

	it("digital: an encrypted call is silence, never analog", () => {
		const sim = new Sim()
		sim.router.setListenPolicy("digital", false)
		sim.connect()
		sim.steps(60, { analog: true, frame: call({ encrypted: true }) })
		expect(sim.actives.every(a => a === "none")).toBe(true)
		expect(sim.read("analog")).toBe(0)
		expect(sim.read("dmr")).toBe(0)
	})

	describe("reason", () => {
		it("no-decoder: digital with no voice source at all", () => {
			const sim = new Sim(null)
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().reason).toBe("no-decoder")
			expect(sim.router.level()).toEqual({
				active: "none",
				reason: "no-decoder",
			})
			sim.router.setListenPolicy("auto", false)
			expect("reason" in sim.status()).toBe(false)
			expect(sim.router.level()).toEqual({ active: "none" })
		})

		it("no-decoder from the listed decoders; covers() once per generation", () => {
			const voice = new ListingVoice()
			const sim = new Sim(voice)
			sim.router.setListenPolicy("digital", false)
			voice.ids = []
			expect(sim.status().reason).toBe("no-decoder")
			voice.ids = ["dmr", "p25"]
			sim.coverage.answer.set("dmr", "no")
			sim.coverage.answer.set("p25", "no")
			expect(sim.status().reason).toBe("no-decoder")
			const calls = sim.coverage.calls
			sim.router.level()
			sim.status()
			expect(sim.coverage.calls).toBe(calls)
			sim.coverage.answer.set("p25", "yes")
			sim.coverage.generation++
			expect("reason" in sim.status()).toBe(false)
		})

		it("unknown coverage (an unknown answer or a throwing covers) reports no reason, and still routes silence", () => {
			const voice = new ListingVoice()
			const sim = new Sim(voice)
			sim.router.setListenPolicy("digital", false)
			voice.ids = ["dmr", "p25"]
			sim.coverage.answer.set("dmr", "no")
			sim.coverage.answer.set("p25", "unknown")
			expect("reason" in sim.status()).toBe(false)
			expect(sim.router.level()).toEqual({ active: "none" })
			const throwing = new Sim(voice)
			throwing.router.setListenPolicy("digital", false)
			throwing.coverage.covers = () => {
				throw new Error("down")
			}
			expect("reason" in throwing.status()).toBe(false)
			// Routed as not covered: the call of an unknown-coverage decoder is silence.
			sim.coverage.answer.set("dmr", "unknown")
			sim.coverage.generation++
			sim.connect()
			sim.steps(30, { analog: true, frame: call() })
			expect(sim.actives.every(a => a === "none")).toBe(true)
			expect(sim.read("dmr")).toBe(0)
			expect("reason" in sim.status()).toBe(false)
		})

		it("without decoder ids: unknown coverage reports nothing (never a false no-decoder)", () => {
			const sim = new Sim()
			sim.router.setListenPolicy("digital", false)
			expect("reason" in sim.status()).toBe(false)
		})

		it("squelch-open: forces analog over auto or digital, analog configured has no reason", () => {
			const sim = new Sim()
			for (const mode of ["auto", "digital"] as const) {
				sim.router.setListenPolicy(mode, true)
				expect(sim.status().listenMode).toBe("analog")
				expect(sim.status().reason).toBe("squelch-open")
			}
			sim.router.setListenPolicy("analog", true)
			expect(sim.status().listenMode).toBe("analog")
			expect("reason" in sim.status()).toBe(false)
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().listenMode).toBe("digital")
		})

		it("an unknown mode keeps auto", () => {
			const sim = new Sim()
			sim.router.setListenPolicy("decoded" as LiveAudioListenMode, false)
			expect(sim.status().listenMode).toBe("auto")
		})
	})

	describe("transmission boundary", () => {
		it("applies at once while nothing plays", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(5, { analog: false })
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().listenMode).toBe("digital")
			expect("pendingListenMode" in sim.status()).toBe(false)
		})

		it("a change while analog plays waits for the over's release; the over plays whole", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(10, { analog: true })
			expect(sim.actives.at(-1)).toBe("analog")
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().listenMode).toBe("auto")
			expect(sim.status().pendingListenMode).toBe("digital")
			sim.steps(40, { analog: true })
			// Still the same over: no switch.
			expect(sim.actives.slice(10).every(a => a === "analog")).toBe(true)
			sim.steps(30, { analog: false })
			expect(sim.status().listenMode).toBe("digital")
			expect("pendingListenMode" in sim.status()).toBe(false)
			// 50 audible blocks of 960 were written and every sample of them was read.
			expect(sim.read("analog")).toBeGreaterThanOrEqual(50 * 960 - 64)
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("a change to analog while a call plays keeps the call to its release", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(30, { analog: false, frame: call() })
			expect(sim.actives.at(-1)).toBe("digital")
			sim.router.setListenPolicy("analog", false)
			expect(sim.status().pendingListenMode).toBe("analog")
			sim.steps(30, { analog: false, frame: call() })
			expect(sim.actives.slice(30).every(a => a === "digital")).toBe(true)
			sim.voice.tap?.call("dmr", call({ active: false }))
			sim.steps(40, { analog: false })
			expect(sim.status().listenMode).toBe("analog")
			expect(sim.router.droppedSamples).toBe(0)
			// Now analog only: a new call is not played.
			sim.steps(30, { analog: false, frame: call({ callId: "c2" }) })
			expect(sim.actives.at(-1)).toBe("none")
		})

		it("open set mid analog over, then a DMR call: analog applies at once, no voice queued, nothing dropped", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(10, { analog: true })
			expect(sim.actives.at(-1)).toBe("analog")
			const events = sim.events.length
			sim.router.setListenPolicy("auto", true)
			// Analog still plays analog: no switch follows, so the mode is in force at once.
			expect(sim.status().listenMode).toBe("analog")
			expect("pendingListenMode" in sim.status()).toBe(false)
			expect(sim.status().reason).toBe("squelch-open")
			expect(sim.events.length).toBe(events + 1)
			// The open squelch passes everything: analog never releases; a 4 s DMR call comes.
			sim.steps(200, { analog: true, frame: call() })
			expect(sim.actives.slice(10).every(a => a === "analog")).toBe(true)
			expect(
				sim.traces.some(t => t.source === "dmr" && t.kind === "write"),
			).toBe(false)
			expect(sim.status().droppedMs).toBe(0)
			expect("pendingListenMode" in sim.status()).toBe(false)
			// Squelch closed again: auto plays analog too, so auto is in force at once.
			sim.router.setListenPolicy("auto", false)
			expect(sim.status().listenMode).toBe("auto")
			expect("pendingListenMode" in sim.status()).toBe(false)
		})

		// Fable major (2026-11-15): an operator change no longer waits forever on a continuous
		// carrier; it is in force at the 1.5 s bound (AUTO_ROUTE_OPERATOR_MODE_MAX_MS).
		it("analog -> digital on a continuous carrier applies at the 1.5 s operator bound; no voice is queued before", () => {
			const sim = new Sim()
			sim.router.setListenPolicy("analog", false)
			sim.connect()
			sim.steps(10, { analog: true })
			const changedAt = sim.clock.t
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().listenMode).toBe("analog")
			expect(sim.status().pendingListenMode).toBe("digital")
			// A call during the carrier: while analog is in force its voice is not queued.
			sim.steps(73, { analog: true, frame: call() })
			// 73 blocks: 1 460 ms after the change, under the bound: still pending, still analog.
			expect(sim.clock.t - changedAt).toBe(1_460)
			expect(sim.status().pendingListenMode).toBe("digital")
			expect(sim.actives.slice(10).every(a => a === "analog")).toBe(true)
			expect(
				sim.traces.some(t => t.source === "dmr" && t.kind === "write"),
			).toBe(false)
			sim.step({ analog: true, frame: call() })
			// 1 480 ms: still under.
			expect(sim.status().pendingListenMode).toBe("digital")
			sim.step({ analog: true, frame: call() })
			// 1 500 ms: at the bound, in force mid-carrier; pending cleared.
			expect(sim.clock.t - changedAt).toBe(1_500)
			expect(sim.status().listenMode).toBe("digital")
			expect("pendingListenMode" in sim.status()).toBe(false)
			expect(sim.actives.at(-1)).not.toBe("analog")
			// The call (still on) plays decoded after its start buffer; analog never again.
			const analogRead = sim.read("analog")
			sim.steps(30, { analog: true, frame: call() })
			expect(sim.actives.at(-1)).toBe("digital")
			expect(sim.read("analog")).toBe(analogRead)
			// Analog queued at the switch is let go uncounted (the mode never plays it).
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("auto -> digital with unchecked analog (Voice only off) on continuous analog applies within 1.5 s", () => {
			const sim = new Sim()
			sim.router.setAnalogVoiceChecked(false)
			sim.connect()
			sim.steps(10, { analog: true })
			expect(sim.actives.at(-1)).toBe("analog")
			const changedAt = sim.clock.t
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().pendingListenMode).toBe("digital")
			// Repeating the same change (a config re-sync) does not restart the bound.
			sim.steps(40, { analog: true })
			sim.router.setListenPolicy("digital", false)
			sim.steps(34, { analog: true })
			expect(sim.clock.t - changedAt).toBe(1_480)
			expect(sim.status().pendingListenMode).toBe("digital")
			sim.step({ analog: true })
			expect(sim.status().listenMode).toBe("digital")
			expect("pendingListenMode" in sim.status()).toBe(false)
			sim.steps(100, { analog: true })
			expect(sim.actives.slice(-100).every(a => a === "none")).toBe(true)
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("a newer operator change restarts the bound from that change", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(10, { analog: true })
			sim.router.setListenPolicy("digital", false)
			sim.steps(50, { analog: true })
			// Back to auto (plays analog: at once), then digital again 1 s after the first change.
			sim.router.setListenPolicy("auto", false)
			expect("pendingListenMode" in sim.status()).toBe(false)
			const changedAt = sim.clock.t
			sim.router.setListenPolicy("digital", false)
			sim.steps(74, { analog: true })
			expect(sim.clock.t - changedAt).toBe(1_480)
			expect(sim.status().pendingListenMode).toBe("digital")
			sim.step({ analog: true })
			expect(sim.status().listenMode).toBe("digital")
		})

		it("without an operator change the route never switches mid-over: a checked analog over outlasts the bound", () => {
			const sim = new Sim()
			sim.connect()
			// 4 s of continuous analog, no call: analog plays throughout, no mode change pending.
			sim.steps(200, { analog: true })
			expect(sim.actives.every(a => a === "analog")).toBe(true)
			expect(sim.status().listenMode).toBe("auto")
			expect("pendingListenMode" in sim.status()).toBe(false)
		})

		it("digital requested during a call applies at once; analog requested during a call queues no other decoder and applies at the 1.5 s bound", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(30, { analog: false, frame: call() })
			expect(sim.actives.at(-1)).toBe("digital")
			sim.router.setListenPolicy("digital", false)
			expect(sim.status().listenMode).toBe("digital")
			expect("pendingListenMode" in sim.status()).toBe(false)
			const changedAt = sim.clock.t
			sim.router.setListenPolicy("analog", false)
			expect(sim.status().pendingListenMode).toBe("analog")
			// A second decoder's call while the first plays on: never queued under pending analog.
			const second = () => {
				sim.voice.tap?.frame(
					"p25",
					bytes(noise(160, lcg(sim.clock.t + 1))),
					call(),
				)
				sim.step({ frame: call() })
			}
			for (let i = 0; i < 74; i++) second()
			expect(sim.clock.t - changedAt).toBe(1_480)
			expect(sim.status().pendingListenMode).toBe("analog")
			expect(sim.actives.slice(30).every(a => a === "digital")).toBe(true)
			// The call is continuous: at the 1.5 s bound the operator's analog is in force.
			second()
			expect(sim.status().listenMode).toBe("analog")
			expect("pendingListenMode" in sim.status()).toBe(false)
			for (let i = 0; i < 125; i++) second()
			expect(sim.actives.slice(105).every(a => a !== "digital")).toBe(true)
			expect(
				sim.traces.some(t => t.source === "p25" && t.kind === "write"),
			).toBe(false)
			// The cut call's queue is let go uncounted (analog never plays decoded voice).
			expect(sim.router.droppedSamples).toBe(0)
		})

		it("one route event per mode change applied in a block", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(30, { analog: false, frame: call() })
			sim.router.setListenPolicy("analog", false)
			sim.voice.tap?.call("dmr", call({ active: false }))
			const before = sim.events.length
			sim.steps(40, { analog: true })
			// Release: analog in force and analog selected in the same block, one event.
			const after = sim.events.slice(before)
			expect(sim.status().listenMode).toBe("analog")
			expect(after.filter(e => e.active === "analog")).toHaveLength(1)
			expect(after.at(-1)).toEqual({ active: "analog" })
			expect(after.some(e => e.active === "digital")).toBe(false)
		})

		it("a pending analog keeps the analog over from digital preemption", () => {
			const sim = new Sim()
			sim.connect()
			sim.steps(10, { analog: true })
			sim.router.setListenPolicy("analog", false)
			// A call arrives during the over: auto would preempt after 1.5 s; pending analog does not.
			sim.steps(120, { analog: true, frame: call() })
			expect(sim.actives.slice(10).every(a => a === "analog")).toBe(true)
			expect(sim.router.droppedSamples).toBe(0)
		})

		// Feature: listen-modes, Property 1: No mid-over switch on a listen mode change
		// Validates: Source "decision per transmission, never mid-over"; Open forces Analog
		it("property: whatever the mode changes, an over that started playing is never cut", () => {
			const modes: LiveAudioListenMode[] = ["auto", "analog", "digital"]
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							at: fc.integer({ min: 0, max: 239 }),
							mode: fc.constantFrom(...modes),
							open: fc.boolean(),
						}),
						{ maxLength: 8 },
					),
					changes => {
						const sim = new Sim()
						sim.record = false
						sim.connect()
						// Analog over A 0-1 s, gap, call D 1.6-2.6 s, gap, analog over B 3.2-4.2 s.
						const inA = (b: number) => b < 50
						const inD = (b: number) => b >= 80 && b < 130
						const inB = (b: number) => b >= 160 && b < 210
						const reads: string[] = []
						for (let b = 0; b < 240; b++) {
							for (const c of changes)
								if (c.at === b) sim.router.setListenPolicy(c.mode, c.open)
							const before = sim.traces.length
							sim.step({
								analog: inA(b) || inB(b),
								frame: inD(b) ? call() : null,
							})
							if (b === 130) sim.voice.tap?.call("dmr", call({ active: false }))
							for (let i = before; i < sim.traces.length; i++) {
								const t = sim.traces[i]
								if (t?.kind === "read") reads.push(`${b}:${t.source}`)
							}
						}
						// Once an over's source is read, it is read in every block until that over
						// has drained: no switch away inside an over.
						for (const [source, from, to] of [
							["analog", 0, 50],
							["dmr", 80, 130],
							["analog", 160, 210],
						] as const) {
							const blocks = reads
								.filter(r => r.endsWith(`:${source}`))
								.map(r => Number(r.split(":")[0]))
								.filter(b => b >= from && b < to + 15)
							if (blocks.length === 0) continue
							const first = Math.min(...blocks)
							for (let b = first; b < to; b++) expect(blocks).toContain(b)
						}
						expect(sim.router.droppedSamples).toBe(0)
					},
				),
				{ numRuns: 100 },
			)
		}, 120_000)

		// Feature: listen-modes, Property 2: A pending mode never stalls on a source it still plays
		// Validates: Source "decision per transmission, never mid-over"; Open forces Analog
		it("property: open toggled mid-over with continuous audibility never leaves a stuck pending mode or queued voice under analog", () => {
			const modes: LiveAudioListenMode[] = ["auto", "analog", "digital"]
			fc.assert(
				fc.property(
					fc.constantFrom(...modes),
					fc.boolean(),
					fc.array(
						fc.record({
							at: fc.integer({ min: 0, max: 239 }),
							mode: fc.constantFrom(...modes),
							open: fc.boolean(),
						}),
						{ maxLength: 8 },
					),
					(startMode, startOpen, changes) => {
						const sim = new Sim()
						sim.record = false
						sim.router.setListenPolicy(startMode, startOpen)
						sim.connect()
						// Analog audible throughout (an open squelch's noise or a long carrier) but a
						// 0.6 s release at 2.4-3 s; a DMR call 0.8-4 s overlapping both.
						const audible = (b: number) => b < 120 || b >= 150
						const inCall = (b: number) => b >= 40 && b < 200
						for (let b = 0; b < 240; b++) {
							for (const c of changes)
								if (c.at === b) sim.router.setListenPolicy(c.mode, c.open)
							const modeBefore = sim.router.listenMode
							const before = sim.traces.length
							sim.step({ analog: audible(b), frame: inCall(b) ? call() : null })
							if (b === 200) sim.voice.tap?.call("dmr", call({ active: false }))
							const st = sim.status()
							// A pending mode waits only on a source it does not play.
							if (st.pendingListenMode !== undefined) {
								expect(st.pendingListenMode).not.toBe("auto")
								expect(st.active).toBe(
									st.pendingListenMode === "analog" ? "digital" : "analog",
								)
							}
							// Under analog in force for the whole block, no decoded voice is queued.
							if (modeBefore === "analog" && st.listenMode === "analog")
								for (let i = before; i < sim.traces.length; i++) {
									const t = sim.traces[i]
									expect(t?.source === "dmr" && t.kind === "write").toBe(false)
								}
						}
						// After the scene, quiet for the 3 s FIFO bound (an analog backlog queued during a
						// call plays out first): whatever was pending is in force.
						sim.steps(170, { analog: false })
						expect("pendingListenMode" in sim.status()).toBe(false)
					},
				),
				{ numRuns: 100 },
			)
		}, 120_000)
	})
})
