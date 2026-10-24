/**
 * Auto listen route acceptance (docs/specs/auto-listen-route requirements 9.1 and 9.2, design
 * "Fake-link acceptance plan"): the real live demodulator and evidence pre-roll, the real digital
 * voice service fed over loopback UDP, a coverage port stub with the seam's semantics, an injected
 * router clock and `/auto` clients over HTTP (127.0.0.1, port 0) or in memory. Each scenario
 * checks the `/auto` samples against references (no lost, doubled or overlapping samples) and the
 * `autoRoute` status and level across the timeline.
 */
import { Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import { AUTO_ROUTE_STREAM } from "../../../../src/core/auto-listen/contract.js"
import { waitFor } from "../live-demodulator-continuity-fakes.js"
import {
	analogReference,
	autoSamples,
	digitalReference,
	disposeAll,
	evidenceScript,
	firstDifference,
	harness,
	scriptedEvidence,
	voiceFrame,
	yieldIo,
} from "./acceptance-fixture.js"
import type { Harness, Span } from "./acceptance-fixture.js"

afterEach(disposeAll)

/** Analog rate of the default NFM pipeline on the fake stages (25 kHz: 500 samples per 20 ms). */
const RATE = 25_000
/** Bytes of analog audio per 20 ms step: 500 samples × 2. */
const STEP_BYTES = 1_000
/** Output samples per 20 ms step at 48 kHz. */
const BLOCK = 960
/** Analog resampler ringing after the last audible input sample, in output samples (generous). */
const RING = Math.ceil(
	(new PolyphaseResampler(RATE, 48_000).taps * 48_000) / RATE,
)

const EVIDENCE = {
	config: { modulation: "nfm", squelchMode: "auto" },
	factory: scriptedEvidence,
}
const MANUAL = { config: { squelchMode: "manual" } }

interface Step {
	open?: boolean
	frames?: Array<[string, Int16Array]>
	before?: () => void | Promise<void>
	/** No pacer tick after this step (the event loop is stalled). */
	noTick?: boolean
}

/** One 20 ms step per index: hooks, 20 ms of analog, voice datagrams, one pacer tick. */
async function drive(
	h: Harness,
	from: number,
	to: number,
	plan: (i: number) => Step,
): Promise<void> {
	for (let i = from; i < to; i++) {
		const step = plan(i)
		await step.before?.()
		h.stage.open = step.open ?? false
		h.feedAnalog20()
		for (const [id, frame] of step.frames ?? []) await h.voice(id, frame)
		if (step.noTick === true) h.routeClock.stall(20)
		else h.routeClock.tick(20)
		await yieldIo()
	}
}

/** `frames[k]` for a call of `count` frames starting at step `first`. */
function callFrames(count: number, seed: number): Int16Array[] {
	return Array.from({ length: count }, (_, k) => voiceFrame(k, seed))
}

function inCall(
	i: number,
	first: number,
	frames: readonly Int16Array[],
	id: string,
): Array<[string, Int16Array]> {
	const f = frames[i - first]
	return f === undefined ? [] : [[id, f]]
}

/**
 * Walks `want` through `auto` from `at`: samples match one for one, except that an underrun
 * (requirement 4.8) fills the rest of a 20 ms block with zeros and the source resumes at its
 * next queued sample in the next block. So every reference sample appears exactly once, in
 * order (none lost or repeated). Returns the end index (exclusive) and the underrun gaps.
 */
function matchWithUnderruns(
	auto: readonly number[],
	want: readonly number[],
	at: number,
): { end: number; gaps: number } {
	let k = at
	let gaps = 0
	for (let j = 0; j < want.length; ) {
		if (k >= auto.length) throw new Error(`output ended at reference ${j}`)
		if (auto[k] === want[j]) {
			k++
			j++
			continue
		}
		const blockEnd = (Math.floor(k / BLOCK) + 1) * BLOCK
		const rest = auto.slice(k, blockEnd)
		if (rest.some(v => v !== 0))
			throw new Error(`sample ${k} differs from reference ${j}`)
		gaps++
		k = blockEnd
	}
	return { end: k, gaps }
}

/**
 * The analog over in `/auto`: from `at` (the block analog was selected for) the reference from
 * its first audible sample to its last (at most `limit` samples), with underrun gaps only.
 */
function expectAnalogOver(
	h: Harness,
	auto: readonly number[],
	at: number,
	limit = Number.POSITIVE_INFINITY,
): number {
	const ref = analogReference(h.spans, RATE)
	const r0 = ref.flags.indexOf(1)
	const r1 = ref.flags.lastIndexOf(1)
	expect(r0).toBeGreaterThanOrEqual(0)
	const want = ref.samples.slice(r0, Math.min(r1 + 1, r0 + limit))
	expect(want.length).toBeGreaterThan(0)
	const { end, gaps } = matchWithUnderruns(auto, want, at)
	// Analog plays from its first queued sample without a start buffer, so the first block of an
	// over can come up short by the resampler's group delay: one underrun gap at most.
	expect(gaps).toBeLessThanOrEqual(1)
	expect(gaps).toBeLessThanOrEqual(h.router.underruns)
	return end
}

/** The digital call in `/auto` from `at`: its full resampled voice and tail, exactly once. */
function expectDigitalCall(
	h: Harness,
	auto: readonly number[],
	frames: readonly Int16Array[],
	at: number,
	maxGaps = 0,
): number {
	const { end, gaps } = matchWithUnderruns(auto, digitalReference(frames), at)
	expect(gaps).toBeLessThanOrEqual(maxGaps)
	expect(gaps).toBeLessThanOrEqual(h.router.underruns)
	return end
}

function expectZero(auto: readonly number[], from: number, to: number): void {
	const slice = auto.slice(from, to)
	expect(slice.findIndex(v => v !== 0)).toBe(-1)
}

function actives(h: Harness): string[] {
	return h.changes.map(c => c.level.active)
}

function changeAt(h: Harness, active: string, nth = 0): number {
	const found = h.changes.filter(c => c.level.active === active)[nth]
	if (found === undefined) throw new Error(`no ${active} switch`)
	return found.at
}

/** Per stream sample: the qualification of the span holding its first byte. */
function sampleFlags(spans: readonly Span[]): boolean[] {
	const flags: boolean[] = []
	let at = 0
	for (const span of spans)
		for (let b = 0; b < span.bytes.length; b++, at++)
			if (at % 2 === 0) flags.push(span.audible)
	return flags
}

describe("auto listen route acceptance: the fake link (9.1)", () => {
	it("an analog over, then a DMR call, on one channel: /auto plays both in full, zeros elsewhere", async () => {
		// Over at the antenna: steps 10 to 159 (3 s); the gate latches 200 ms in (step 20), so the
		// pre-roll delays the over by 200 ms. 0.5 s gap, then a 3 s DMR call (150 frames of 20 ms,
		// slot 1) from step 185, its end at step 335, then 1 s of silence and more.
		evidenceScript.latchByte = 20 * STEP_BYTES
		evidenceScript.guardBytes = 0
		const h = await harness({ ...EVIDENCE, decoders: ["dsd-a"] })
		expect(h.rate()).toBe(RATE)
		const client = await h.connectHttp()
		expect(client.status).toBe(200)
		expect(client.headers["x-sample-rate"]).toBe("48000")
		const frames = callFrames(150, 0)
		const statuses: Array<Record<string, unknown> | undefined> = []
		await drive(h, 0, 400, i => ({
			open: i >= 10 && i < 160,
			frames: inCall(i, 185, frames, "dsd-a"),
			before: () => {
				if (i === 185) h.voiceCall("dsd-a")
				if (i === 335) h.voiceCall("dsd-a", { active: false })
				if (i === 100 || i === 260 || i === 399)
					statuses.push(
						h.demod.getStatus().autoRoute as
							| Record<string, unknown>
							| undefined,
					)
			},
		}))
		// Every block the router produced reached the HTTP client, byte for byte.
		const produced = Buffer.concat(h.blocks)
		await waitFor(() => client.received().length >= produced.length, 5_000)
		expect(client.received().equals(produced)).toBe(true)
		const auto = autoSamples(produced)
		expect(auto.length).toBe(400 * BLOCK)

		expect(actives(h)).toEqual(["analog", "none", "digital", "none"])
		const digitalChange = h.changes[2]
		expect(digitalChange?.level).toEqual({ active: "digital", protocol: "DMR" })
		expect(digitalChange?.decoderId).toBe("dsd-a")
		expect(digitalChange?.slot).toBe(1)
		expect(statuses[0]).toMatchObject({ active: "analog" })
		expect(statuses[1]).toMatchObject({
			active: "digital",
			protocol: "DMR",
			decoderId: "dsd-a",
			slot: 1,
			digitalAvailable: true,
		})
		expect(statuses[2]).toMatchObject({ active: "none", droppedMs: 0 })

		const a0 = changeAt(h, "analog")
		const aEnd = expectAnalogOver(h, auto, a0)
		// About 3 s of the over at 48 kHz (the whole delayed over plays once).
		expect(aEnd - a0).toBeGreaterThan(3 * 48_000 - 2 * RING)
		expect(aEnd - a0).toBeLessThan(3 * 48_000 + 2 * RING)
		const d0 = changeAt(h, "digital")
		expect(d0).toBeGreaterThanOrEqual(aEnd)
		const dEnd = expectDigitalCall(h, auto, frames, d0)
		expectZero(auto, 0, a0)
		expectZero(auto, aEnd + RING, d0)
		expectZero(auto, dEnd, auto.length)
		expect(h.router.droppedSamples).toBe(0)
		client.close()
	}, 30_000)
})

describe("auto listen route acceptance: 9.2 scenarios", () => {
	it("digital arriving while the analog tail drains: handover without loss", async () => {
		// Over steps 10 to 109, latched 1 s in (step 60): the final drain plays until step 160.
		// A 1 s DMR call from step 115, inside the drain and past it.
		evidenceScript.latchByte = 60 * STEP_BYTES
		evidenceScript.guardBytes = 0
		const h = await harness({ ...EVIDENCE, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		const frames = callFrames(50, 7)
		await drive(h, 0, 300, i => ({
			open: i >= 10 && i < 110,
			frames: inCall(i, 115, frames, "dsd-a"),
			before: () => {
				if (i === 115) h.voiceCall("dsd-a")
				if (i === 165) h.voiceCall("dsd-a", { active: false })
			},
		}))
		const auto = autoSamples(transport.received())
		expect(actives(h).filter(a => a !== "none")).toEqual(["analog", "digital"])
		const aEnd = expectAnalogOver(h, auto, changeAt(h, "analog"))
		const d0 = changeAt(h, "digital")
		expect(d0).toBeGreaterThanOrEqual(aEnd)
		const dEnd = expectDigitalCall(h, auto, frames, d0)
		expectZero(auto, dEnd, auto.length)
		expect(h.router.droppedSamples).toBe(0)
	}, 30_000)

	it("a short (0.5 s) digital over wholly inside the analog handover delay plays in full afterwards", async () => {
		evidenceScript.latchByte = 60 * STEP_BYTES
		evidenceScript.guardBytes = 0
		const h = await harness({ ...EVIDENCE, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		// Steps 115 to 139, ended at 140: before the drain ends (step 160) and analog releases.
		const frames = callFrames(25, 3)
		await drive(h, 0, 260, i => ({
			open: i >= 10 && i < 110,
			frames: inCall(i, 115, frames, "dsd-a"),
			before: () => {
				if (i === 115) h.voiceCall("dsd-a")
				if (i === 140) h.voiceCall("dsd-a", { active: false })
			},
		}))
		const auto = autoSamples(transport.received())
		const aEnd = expectAnalogOver(h, auto, changeAt(h, "analog"))
		const d0 = changeAt(h, "digital")
		// The call had ended before digital was selected.
		expect(d0 / BLOCK).toBeGreaterThan(140)
		expect(d0).toBeGreaterThanOrEqual(aEnd)
		const dEnd = expectDigitalCall(h, auto, frames, d0)
		expectZero(auto, dEnd, auto.length)
		expect(h.router.droppedSamples).toBe(0)
	}, 30_000)

	it("a stuck-open manual squelch: digital preempts at 1.5 s and the drop is counted", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		const frames = callFrames(100, 11)
		let firstQueuedMs = 0
		await drive(h, 0, 320, i => ({
			open: true,
			frames: inCall(i, 50, frames, "dsd-a"),
			before: () => {
				if (i === 50) {
					h.voiceCall("dsd-a")
					firstQueuedMs = h.routeClock.now()
				}
				if (i === 150) h.voiceCall("dsd-a", { active: false })
			},
		}))
		const auto = autoSamples(transport.received())
		expect(actives(h)).toEqual(["analog", "digital", "analog"])
		const a0 = changeAt(h, "analog")
		const d0 = changeAt(h, "digital")
		// Selected for the first block whose time passes the 1 500 ms bound (one block of slack).
		const selectedMs = d0 / 48
		expect(selectedMs - firstQueuedMs).toBeGreaterThanOrEqual(1_500 - 20)
		expect(selectedMs - firstQueuedMs).toBeLessThanOrEqual(1_500 + 20)
		// Analog played contiguously until the preemption, then its queue was dropped and counted.
		expectAnalogOver(h, auto, a0, d0 - a0 - 2 * BLOCK)
		expect(h.router.droppedSamples).toBeGreaterThan(0)
		const dEnd = expectDigitalCall(h, auto, frames, d0)
		// Analog never preempted digital: it came back only after the whole call.
		expect(changeAt(h, "analog", 1)).toBeGreaterThanOrEqual(dEnd)
	}, 30_000)

	it("an encrypted call is never routed", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		const frames = callFrames(100, 5)
		await drive(h, 0, 160, i => ({
			frames: inCall(i, 10, frames, "dsd-a"),
			before: () => {
				if (i === 10) h.voiceCall("dsd-a", { encrypted: true })
				if (i === 80) expect(h.demod.getStatus().autoRoute?.active).toBe("none")
			},
		}))
		expect(h.changes).toEqual([])
		expect(transport.received().every(b => b === 0)).toBe(true)
		expect(transport.received().length).toBe(160 * BLOCK * 2)
	}, 30_000)

	it("clear then encrypted with audio queued and no further datagram: nothing more is routed", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		// 100 ms of clear voice: under the 200 ms start buffer, so queued and not yet playing.
		const frames = callFrames(5, 1)
		await drive(h, 0, 80, i => ({
			frames: inCall(i, 10, frames, "dsd-a"),
			before: () => {
				if (i === 10) h.voiceCall("dsd-a")
				if (i === 15) h.voiceCall("dsd-a", { encrypted: true })
			},
		}))
		expect(h.changes).toEqual([])
		expect(transport.received().every(b => b === 0)).toBe(true)
		expect(h.router.droppedSamples).toBeGreaterThan(0)
	}, 30_000)

	it("two covering decoders: the first selected stays until it releases (stickiness)", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a", "dsd-b"] })
		const { transport } = h.addAutoClient()
		const a = callFrames(100, 2)
		const b = callFrames(100, 9)
		await drive(h, 0, 400, i => ({
			frames: [...inCall(i, 10, a, "dsd-a"), ...inCall(i, 30, b, "dsd-b")],
			before: () => {
				if (i === 10) h.voiceCall("dsd-a", { callId: "a-1" })
				if (i === 30) h.voiceCall("dsd-b", { callId: "b-1", slot: 2 })
				if (i === 110) h.voiceCall("dsd-a", { callId: "a-1", active: false })
				if (i === 130) h.voiceCall("dsd-b", { callId: "b-1", active: false })
			},
		}))
		const auto = autoSamples(transport.received())
		const digital = h.changes.filter(c => c.level.active === "digital")
		expect(digital.map(c => c.decoderId)).toEqual(["dsd-a", "dsd-b"])
		expect(digital[1]?.slot).toBe(2)
		const a0 = digital[0]?.at ?? -1
		const aEnd = expectDigitalCall(h, auto, a, a0)
		// B's queued voice was older than A's for most of A's call, yet A kept playing.
		const b0 = digital[1]?.at ?? -1
		expect(b0).toBeGreaterThanOrEqual(aEnd)
		const bEnd = expectDigitalCall(h, auto, b, b0)
		expectZero(auto, bEnd, auto.length)
		expect(h.router.droppedSamples).toBe(0)
	}, 30_000)

	it("a pipeline restart with a connected client: the client is kept at 48 kHz", async () => {
		const h = await harness(MANUAL)
		const client = await h.connectHttp()
		await drive(h, 0, 30, () => ({ open: true }))
		const before = h.rate()
		await h.demod.reconfigure({ bandwidth: 50_000 })
		h.script()
		expect(h.rate()).not.toBe(before)
		expect(h.router.registry.size).toBe(1)
		await drive(h, 30, 80, () => ({ open: true }))
		const produced = Buffer.concat(h.blocks)
		expect(produced.length).toBe(80 * BLOCK * 2)
		await waitFor(() => client.received().length >= produced.length, 5_000)
		expect(client.received().equals(produced)).toBe(true)
		expect(h.spans.at(-1)?.stream.rate).toBe(h.rate())
		expect(h.demod.getStatus().autoRoute).toMatchObject({
			active: "analog",
			clientCount: 1,
		})
		// Analog plays again after the restart.
		expect(
			autoSamples(produced.subarray(70 * BLOCK * 2)).some(v => v !== 0),
		).toBe(true)
		client.close()
	}, 30_000)

	describe("first connect and reconnect during pending, playback and the final drain", () => {
		// Over steps 10 to 109, latched at step 40 (600 ms pending); the drain ends at step 140.
		const plan = (i: number): Step => ({ open: i >= 10 && i < 110 })
		const phases: Array<[string, number]> = [
			["pending", 25],
			["playback", 70],
			["final drain", 120],
		]

		async function reference(): Promise<boolean[]> {
			evidenceScript.latchByte = 40 * STEP_BYTES
			evidenceScript.guardBytes = 0
			const h = await harness(EVIDENCE)
			h.addAutoClient()
			await drive(h, 0, 180, plan)
			return sampleFlags(h.spans)
		}

		for (const [name, at] of phases) {
			it(`${name}: qualification after the connect equals a client connected from the start`, async () => {
				const ref = await reference()
				evidenceScript.latchByte = 40 * STEP_BYTES
				const first = await harness(EVIDENCE)
				await drive(first, 0, at, plan)
				const late = first.addAutoClient()
				await drive(first, at, 180, plan)
				const fromConnect = ref.slice((at * STEP_BYTES) / 2)
				expect(firstDifference(sampleFlags(first.spans), fromConnect)).toBe(-1)
				// The over (or what is left of its drain) still plays on the late client.
				expect(autoSamples(late.transport.received()).some(v => v !== 0)).toBe(
					true,
				)

				// Reconnect: connected from the start, gone 10 steps before `at`, back at `at`.
				const again = await harness(EVIDENCE)
				const early = again.addAutoClient()
				await drive(again, 0, at - 10, plan)
				again.router.registry.close(early.client, "test", true)
				await drive(again, at - 10, at, plan)
				const mark = again.spans.length
				again.addAutoClient()
				await drive(again, at, 180, plan)
				expect(
					firstDifference(sampleFlags(again.spans.slice(mark)), fromConnect),
				).toBe(-1)
			}, 30_000)
		}
	})

	it("several coverage changes between two pacer ticks with no frames: queued voice is dropped, covers runs once per generation", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		const early = callFrames(5, 4)
		const later = callFrames(30, 6)
		await drive(h, 0, 10, () => ({}))
		h.voiceCall("dsd-a")
		await drive(h, 10, 15, i => ({ frames: inCall(i, 10, early, "dsd-a") }))
		const dropped = h.router.droppedSamples
		// A → B → A between two ticks (yes → no → yes), then one more event, no frames.
		h.coverage.answers.set("dsd-a", "no")
		h.coverage.bump()
		h.coverage.answers.set("dsd-a", "yes")
		h.coverage.bump()
		h.coverage.bump()
		h.coverage.answers.set("dsd-a", "unknown")
		h.coverage.bump()
		h.coverage.answers.set("dsd-a", "yes")
		h.coverage.bump()
		await drive(h, 15, 40, () => ({}))
		expect(h.router.droppedSamples).toBeGreaterThan(dropped)
		expect(h.changes).toEqual([])
		expect(transport.received().every(b => b === 0)).toBe(true)
		// The call's later frames still play (coverage is "yes" again), and only those.
		await drive(h, 40, 160, i => ({
			frames: inCall(i, 40, later, "dsd-a"),
			before: () => {
				if (i === 70) h.voiceCall("dsd-a", { active: false })
			},
		}))
		const auto = autoSamples(transport.received())
		const d0 = changeAt(h, "digital")
		const dEnd = expectDigitalCall(h, auto, later, d0)
		expectZero(auto, 0, d0)
		expectZero(auto, dEnd, auto.length)
		// At most one covers() per input per generation.
		const perGeneration = new Map<number, number>()
		for (const call of h.coverage.calls)
			perGeneration.set(
				call.generation,
				(perGeneration.get(call.generation) ?? 0) + 1,
			)
		for (const count of perGeneration.values()) expect(count).toBe(1)
	}, 30_000)

	for (const ending of ["call end", "hold expiry"] as const) {
		it(`a call ending in a non-zero impulse with no further datagram (${ending}): the full tail plays once`, async () => {
			const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
			const { transport } = h.addAutoClient()
			const frames = callFrames(15, 8)
			const impulse = new Int16Array(160)
			impulse[159] = 20_000
			frames.push(impulse)
			await drive(h, 0, 120, i => ({
				frames: inCall(i, 10, frames, "dsd-a"),
				before: () => {
					if (i === 10) h.voiceCall("dsd-a")
					if (i === 26 && ending === "call end")
						h.voiceCall("dsd-a", { active: false })
				},
			}))
			const auto = autoSamples(transport.received())
			const d0 = changeAt(h, "digital")
			const want = digitalReference(frames)
			// The impulse's response reaches the last N − 1 inputs of support: non-zero to the end.
			expect(want.slice(-6 * 5).some(v => v !== 0)).toBe(true)
			// Hold expiry: the FIFO runs dry while the 300 ms hold runs before the flush, so the tail
			// follows underrun blocks: at most 300 / 20 = 15 gaps.
			const dEnd = expectDigitalCall(
				h,
				auto,
				frames,
				d0,
				ending === "hold expiry" ? 15 : 0,
			)
			expectZero(auto, dEnd, auto.length)
			expect(actives(h)).toEqual(["digital", "none"])
		}, 30_000)
	}

	it("a retune with digital audio queued: the queued audio is dropped, never played", async () => {
		const h = await harness({ ...MANUAL, decoders: ["dsd-a"] })
		const { transport } = h.addAutoClient()
		const frames = callFrames(5, 12)
		await drive(h, 0, 10, () => ({}))
		h.voiceCall("dsd-a")
		await drive(h, 10, 15, i => ({ frames: inCall(i, 10, frames, "dsd-a") }))
		const generation = h.coverage.generation
		h.sourceManager.emitCaps({ centerFreq: 446_100_000 })
		expect(h.coverage.generation).toBeGreaterThan(generation)
		await drive(h, 15, 80, () => ({}))
		expect(h.changes).toEqual([])
		expect(transport.received().every(b => b === 0)).toBe(true)
		expect(h.router.droppedSamples).toBeGreaterThan(0)
		expect(h.demod.getStatus().autoRoute?.droppedMs).toBeGreaterThan(0)
	}, 30_000)

	it("chunks spanning the open, the latch, the close and the final drain are sample-exact", async () => {
		evidenceScript.latchByte = 1_000
		evidenceScript.guardBytes = 0
		const h = await harness(EVIDENCE)
		const stream = h.addStreamClient()
		const { transport } = h.addAutoClient()
		// One chunk holds the open, the 500 pending samples and the latch; the next holds the
		// close and the whole final drain.
		h.stage.open = true
		const over = Buffer.alloc(4_000)
		for (let i = 0; i < 2_000; i++) over.writeInt16LE(1_000 + (i % 700), 2 * i)
		h.feed(over)
		h.stage.open = false
		h.feed(Buffer.from(over))
		h.feed(Buffer.alloc(20_000, 1))
		for (let i = 0; i < 40; i++) h.routeClock.tick(20)
		const out = stream.received()
		const playing: boolean[] = []
		for (let s = 0; s * 2 + 1 < out.length; s++)
			playing.push(out[2 * s] !== 0 || out[2 * s + 1] !== 0)
		const qualified = sampleFlags(h.spans).slice(0, playing.length)
		expect(firstDifference(qualified, playing)).toBe(-1)
		expect(qualified.indexOf(true)).toBe(500)
		expect(qualified.lastIndexOf(true)).toBe(2_499)
		const auto = autoSamples(transport.received())
		const aEnd = expectAnalogOver(h, auto, changeAt(h, "analog"))
		expectZero(auto, aEnd + RING, auto.length)
	})

	it("an event-loop stall: one rebase, no sample lost or repeated", async () => {
		const h = await harness(MANUAL)
		const { transport } = h.addAutoClient()
		await drive(h, 0, 50, i => ({ open: i >= 5 }))
		// 600 ms of audio arrives while the pacer does not run, then one late tick.
		await drive(h, 50, 80, () => ({ open: true, noTick: true }))
		h.routeClock.tick(20)
		expect(h.router.clockRebases).toBe(1)
		await drive(h, 80, 130, () => ({ open: true }))
		await drive(h, 130, 260, () => ({}))
		expect(h.router.clockRebases).toBe(1)
		const auto = autoSamples(transport.received())
		const aEnd = expectAnalogOver(h, auto, changeAt(h, "analog"))
		expectZero(auto, aEnd + RING, auto.length)
		expect(h.router.droppedSamples).toBe(0)
		expect(h.demod.getStatus().autoRoute?.clockRebases).toBe(1)
	}, 30_000)

	it("a delayed client drain: every block arrives intact", async () => {
		const h = await harness(MANUAL)
		// A socket that withholds its drain: writes complete only when released.
		const held: Array<() => void> = []
		const chunks: Buffer[] = []
		let hold = true
		const slow = new Writable({
			highWaterMark: 1_920,
			write(chunk: Buffer, _enc, cb) {
				chunks.push(chunk)
				if (hold) held.push(cb)
				else cb()
			},
		})
		const client = h.router.registry.register(
			slow as never,
			"slow",
			AUTO_ROUTE_STREAM,
		)
		let waited = false
		await drive(h, 0, 40, i => ({
			open: i >= 2,
			before: () => {
				if (client.waitingDrain) waited = true
			},
		}))
		expect(waited).toBe(true)
		hold = false
		for (const cb of held.splice(0)) cb()
		await waitFor(() => !client.waitingDrain && client.queuedBytes === 0)
		const got = Buffer.concat(chunks)
		expect(got.equals(Buffer.concat(h.blockCopies))).toBe(true)
		expect(got.length).toBe(40 * BLOCK * 2)
		expect(client.droppedBytes).toBe(0)
		expect(got.some(b => b !== 0)).toBe(true)
	}, 30_000)
})
