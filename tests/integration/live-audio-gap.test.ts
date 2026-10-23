/**
 * WG10 req 2.4 (structural): the audio a client receives across an offset
 * change and a full restart, counted in bytes against an injected clock.
 * Fake stages echo at fixed ratios (front: 192 capture bytes → one CF32
 * sample; back: one CF32 sample → one s16le sample); a new front produces
 * nothing until it is "started". No wall-clock assertion: every quantity is
 * a byte count against the injected stream clock.
 */

import { describe, it, expect, afterEach } from "vitest"
import {
	LIVE_AUDIO_SILENCE_CHUNK_MS,
	LIVE_AUDIO_SILENCE_FILL_MAX_MS,
} from "@wavekit/api-types"
import {
	createDemodHarness,
	delay,
	waitFor,
	type FakeProcess,
} from "../unit/core/live-demodulator-continuity-fakes.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>
let harness: Harness | null = null

afterEach(async () => {
	await harness?.dispose()
	harness = null
})

const TICK_MS = 10
const CAPTURE_BYTES_PER_TICK = 2_400_000 * 2 * (TICK_MS / 1000) // 48 000
const AUDIO_BYTES_PER_TICK = 25_000 * 2 * (TICK_MS / 1000) // 500

function isBack(proc: FakeProcess): boolean {
	return proc.command.includes("demod") || proc.command.includes("-o s16")
}

/** Wires a fake stage to echo its input at the stage's ratio once started. */
function echo(proc: FakeProcess, started: Set<FakeProcess>): void {
	const back = isBack(proc)
	const inBytes = back ? 8 : 192
	const outBytes = back ? 2 : 8
	let pending = 0
	proc.stdin.on("data", (chunk: Buffer) => {
		if (!started.has(proc)) return
		pending += chunk.length
		const samples = Math.floor(pending / inBytes)
		if (samples === 0) return
		pending -= samples * inBytes
		const out = Buffer.alloc(samples * outBytes)
		if (!back)
			for (let i = 0; i < samples * 2; i++) out.writeFloatLE(0.1, i * 4)
		else out.fill(1)
		proc.stdout.write(out)
	})
}

async function setup() {
	const started = new Set<FakeProcess>()
	let autoStart = true
	harness = await createDemodHarness({
		config: { squelchMode: "manual" },
		onSpawn: proc => {
			if (autoStart) started.add(proc)
			echo(proc, started)
		},
	})
	await harness.demod.start()
	const h = harness
	const { transport } = h.addClient()
	/** One tick of stream time: capture in, clock forward. */
	const tick = async () => {
		h.fanout.branch.write(Buffer.alloc(CAPTURE_BYTES_PER_TICK, 127))
		await delay(1)
		h.clock.advance(TICK_MS)
	}
	return {
		h,
		transport,
		started,
		tick,
		setAutoStart(value: boolean) {
			autoStart = value
		},
	}
}

describe("live audio gap, counted (WG10 req 2.4)", () => {
	it("an offset change keeps every audio byte flowing while the new front starts", async () => {
		const { h, transport, started, tick, setAutoStart } = await setup()
		for (let i = 0; i < 10; i++) await tick()
		expect(transport.received().length).toBe(10 * AUDIO_BYTES_PER_TICK)
		setAutoStart(false)
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		const newFront = h.processes[2]!
		// The new front takes 15 ticks (150 ms) to start; the old one keeps going.
		for (let i = 0; i < 15; i++) await tick()
		expect(transport.received().length).toBe(25 * AUDIO_BYTES_PER_TICK)
		started.add(newFront)
		await tick()
		await done
		for (let i = 0; i < 10; i++) await tick()
		// Not one tick of audio missing, no silence inserted, client attached.
		// The tick that started the new front reached the squelch from both
		// fronts (the old one before the switch, the new one's first output
		// after it): one 10 ms overlap, never a gap.
		const received = transport.received()
		expect(received.length).toBe((36 + 1) * AUDIO_BYTES_PER_TICK)
		expect(received.every(byte => byte === 1)).toBe(true)
		expect(transport.writableEnded).toBe(false)
		expect(h.processes).toHaveLength(3)
	})

	it("a full restart is covered by silence for every 20 ms of stream time until the new audio", async () => {
		const { h, transport, started, tick, setAutoStart } = await setup()
		for (let i = 0; i < 10; i++) await tick()
		setAutoStart(false)
		await h.demod.reconfigure({ gain: 5 })
		const [front, back] = [h.processes[2]!, h.processes[3]!]
		const before = 10 * AUDIO_BYTES_PER_TICK
		// The new pipeline takes 37 ticks (370 ms) to produce audio.
		for (let i = 0; i < 37; i++) await tick()
		const silence = transport.received().length - before
		const chunkBytes = (25_000 * LIVE_AUDIO_SILENCE_CHUNK_MS * 2) / 1000
		// Stream time 370 ms → chunks for each started 20 ms: 19 chunks.
		expect(silence).toBe(19 * chunkBytes)
		expect(silence).toBeGreaterThanOrEqual(37 * AUDIO_BYTES_PER_TICK)
		started.add(front)
		started.add(back)
		for (let i = 0; i < 10; i++) await tick()
		const received = transport.received()
		expect(received.length).toBe(before + silence + 10 * AUDIO_BYTES_PER_TICK)
		expect(
			received.subarray(before, before + silence).every(b => b === 0),
		).toBe(true)
		expect(transport.writableEnded).toBe(false)
	})

	it("a restart whose pipeline never produces is filled up to the bound only", async () => {
		const { h, transport, tick, setAutoStart } = await setup()
		await tick()
		setAutoStart(false)
		await h.demod.reconfigure({ gain: 5 })
		const before = AUDIO_BYTES_PER_TICK
		for (let i = 0; i < LIVE_AUDIO_SILENCE_FILL_MAX_MS / TICK_MS + 50; i++)
			h.clock.advance(TICK_MS)
		expect(transport.received().length - before).toBe(250 * 1000)
	})
})
