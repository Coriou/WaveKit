/**
 * WG10 req 2.3: an offset-only change swaps the front stage (make before
 * break); the back process and clients stay. Fake stages, injected clock.
 */

import { describe, it, expect, afterEach } from "vitest"
import fc from "fast-check"
import { LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS } from "@wavekit/api-types"
import {
	channelIq,
	createDemodHarness,
	delay,
	waitFor,
	writeAndSettle,
	type FakeProcess,
} from "./live-demodulator-continuity-fakes.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>
let harness: Harness | null = null

afterEach(async () => {
	await harness?.dispose()
	harness = null
})

/** Records every byte the channel squelch is given. */
function spySquelchInput(h: Harness): Buffer[] {
	const run = h.internals.run!
	const seen: Buffer[] = []
	const original = run.squelch.process.bind(run.squelch)
	run.squelch.process = (chunk: Buffer) => {
		seen.push(Buffer.from(chunk))
		return original(chunk)
	}
	return seen
}

/** Every complex sample's I and Q as read at 8-byte boundaries. */
function sampleValues(chunks: Buffer[]): number[] {
	const data = Buffer.concat(chunks)
	const values: number[] = []
	for (let i = 0; i + 8 <= data.length; i += 8)
		values.push(data.readFloatLE(i), data.readFloatLE(i + 4))
	return values
}

const BLOCK_SAMPLES = 250 // 10 ms at the 25 kHz default channel rate

async function startHarness(config: Record<string, unknown> = {}) {
	harness = await createDemodHarness({ config })
	await harness.demod.start()
	return harness
}

describe("LiveDemodulator front swap (WG10 req 2.3)", () => {
	it("keeps the back and clients, feeds both fronts, then stops the old front", async () => {
		const h = await startHarness()
		const { front: oldFront, back } = h.current()
		const { transport } = h.addClient()
		const errors: Error[] = []
		h.demod.on("error", err => errors.push(err))
		const branchSeenByOld: Buffer[] = []
		oldFront.stdin.on("data", (c: Buffer) => branchSeenByOld.push(c))

		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		const newFront = h.processes[2]!
		expect(newFront.command).toContain("csdr shift -0.0025000000")
		const branchSeenByNew: Buffer[] = []
		newFront.stdin.on("data", (c: Buffer) => branchSeenByNew.push(c))
		await writeAndSettle(h.fanout.branch, Buffer.from([1, 2, 3, 4]))
		expect(Buffer.concat(branchSeenByOld)).toEqual(Buffer.from([1, 2, 3, 4]))
		expect(Buffer.concat(branchSeenByNew)).toEqual(Buffer.from([1, 2, 3, 4]))
		expect(oldFront.signals).toEqual([])

		await writeAndSettle(newFront.stdout, channelIq(10, 0.5))
		await done
		expect(h.processes).toHaveLength(3)
		expect(back.signals).toEqual([])
		await waitFor(() => !oldFront.alive)
		expect(oldFront.signals).toEqual(["SIGTERM"])
		expect(h.current().front).toBe(newFront)
		expect(h.current().back).toBe(back)
		expect(h.demod.getStatus().clientCount).toBe(1)
		expect(transport.writableEnded).toBe(false)
		// The old front's exit is not a run failure.
		await delay(10)
		expect(errors).toEqual([])
		expect(h.demod.getStatus().pipelineHealth).toBe("running")
		expect(h.demod.getStatus().pipelineRestarts).toBe(0)
		// The branch no longer feeds the stopped front.
		const before = branchSeenByNew.length
		await writeAndSettle(h.fanout.branch, Buffer.from([9, 9]))
		expect(branchSeenByNew.length).toBe(before + 1)
	})

	it("switches the squelch input at a whole complex sample (old partial sample dropped)", async () => {
		const h = await startHarness()
		const seen = spySquelchInput(h)
		const { front: oldFront } = h.current()
		await writeAndSettle(oldFront.stdout, channelIq(BLOCK_SAMPLES, 1))
		// A partial complex sample: 3 bytes of the next one.
		await writeAndSettle(oldFront.stdout, channelIq(1, 1).subarray(0, 3))
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		const newFront = h.processes[2]!
		await writeAndSettle(newFront.stdout, channelIq(BLOCK_SAMPLES * 2, 0.5))
		await done
		await delay(5)
		const values = sampleValues(seen)
		expect(values.length).toBe(BLOCK_SAMPLES * 3 * 2)
		expect(values.slice(0, BLOCK_SAMPLES * 2).every(v => v === 1)).toBe(true)
		expect(values.slice(BLOCK_SAMPLES * 2).every(v => v === 0.5)).toBe(true)
	})

	it("falls back to the full restart with silence when the new front stays silent for the timeout", async () => {
		const h = await startHarness()
		const { front: oldFront, back: oldBack } = h.current()
		const { transport } = h.addClient()
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		const newFront = h.processes[2]!
		h.clock.advance(LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS - 1)
		await delay(5)
		expect(h.processes).toHaveLength(3)
		expect(newFront.signals).toEqual([])
		h.clock.advance(1)
		await done
		expect(newFront.signals).toEqual(["SIGTERM"])
		expect(oldFront.signals).toEqual(["SIGTERM"])
		expect(oldBack.signals).toEqual(["SIGTERM"])
		expect(h.processes).toHaveLength(5)
		expect(h.processes[3]!.command).toContain("csdr shift -0.0025000000")
		expect(transport.writableEnded).toBe(false)
		// Silence covers the restart until real audio.
		const silent = transport.received()
		expect(silent.length).toBeGreaterThan(0)
		expect(silent.every(byte => byte === 0)).toBe(true)
	})

	for (const failure of ["exit", "error"] as const) {
		it(`falls back to the full restart when the new front ${failure}s before its first output`, async () => {
			const h = await startHarness()
			const errors: Error[] = []
			h.demod.on("error", err => errors.push(err))
			const done = h.demod.reconfigure({ offsetHz: 6000 })
			await waitFor(() => h.processes.length === 3)
			const newFront = h.processes[2]!
			if (failure === "exit") newFront.exit(1)
			else newFront.emit("error", new Error("spawn failed"))
			await done
			expect(h.processes).toHaveLength(5)
			expect(h.demod.getStatus().pipelineHealth).toBe("running")
			expect(errors).toEqual([])
		})
	}

	it("a full restart for any other pipeline key (gain) or a mixed change", async () => {
		const h = await startHarness()
		await h.demod.reconfigure({ gain: 5 })
		expect(h.processes).toHaveLength(4)
		await h.demod.reconfigure({ offsetHz: 6000, modulation: "am" })
		expect(h.processes).toHaveLength(6)
	})

	it("a second offset change supersedes a pending swap; one back throughout", async () => {
		const h = await startHarness()
		const { back } = h.current()
		const first = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		const second = h.demod.reconfigure({ offsetHz: 12_000 })
		await waitFor(() => h.processes.length === 4)
		await first
		await waitFor(() => !h.processes[2]!.alive)
		const newest = h.processes[3]!
		await writeAndSettle(newest.stdout, channelIq(10, 0.5))
		await second
		expect(h.current().front).toBe(newest)
		expect(h.current().back).toBe(back)
		expect(back.signals).toEqual([])
		await waitFor(() => !h.processes[0]!.alive)
	})

	it("stop during a pending swap stops every stage", async () => {
		const h = await startHarness()
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		await h.demod.stop()
		await done
		await waitFor(() => h.processes.every(p => !p.alive))
	})

	it("closes the transmission as config during the swap and reopens on the new front", async () => {
		const h = await startHarness()
		expect(h.demod.isSquelchOpen()).toBe(true)
		const edges: string[] = []
		h.demod.on("squelch-changed", open =>
			edges.push(`${open}:${h.demod.transmissionCloseOverride()}`),
		)
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		expect(h.demod.isSquelchOpen()).toBe(false)
		await writeAndSettle(h.processes[2]!.stdout, channelIq(10, 0.5))
		await done
		expect(edges).toEqual(["false:config", "true:null"])
		expect(h.demod.transmissionCloseOverride()).toBeNull()
	})

	it("applies the retune floor handling at the switch (auto squelch)", async () => {
		const h = await startHarness({})
		await h.demod.reconfigure({ squelchMode: "auto" })
		await writeAndSettle(
			h.current().front.stdout,
			channelIq(BLOCK_SAMPLES * 5, 0.001),
		)
		expect(h.demod.getStatus().noiseFloorDbfs).toBeDefined()
		const done = h.demod.reconfigure({ offsetHz: 6000 })
		await waitFor(() => h.processes.length === 3)
		// 9 bytes: one whole sample and a partial one; no block is measured yet.
		await writeAndSettle(
			h.processes[2]!.stdout,
			channelIq(2, 0.001).subarray(0, 9),
		)
		await done
		expect(h.demod.getStatus().noiseFloorDbfs).toBeUndefined()
	})

	// Feature: web-gaps-10, Property 5: Offset swap keeps the back
	// Validates: Requirements 2.3
	it("property 5: random offset changes never respawn the back, spawn one front each, stop the old one, and keep the squelch input aligned", async () => {
		const h = await startHarness()
		const { back } = h.current()
		const seen = spySquelchInput(h)
		let value = 1
		// Bytes of a partial sample the current front still owes (a real
		// stage completes its sample; only a swap drops it).
		let owed = 0
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: -400, max: 400 }).map(k => k * 250),
				fc.integer({ min: 0, max: 7 }),
				fc.integer({ min: 0, max: 7 }),
				async (offsetHz, oldStray, newStray) => {
					const before = h.processes.length
					const config = h.demod.getStatus().config
					const oldFront = h.current().front
					if (owed > 0)
						await writeAndSettle(
							oldFront.stdout,
							channelIq(1, value).subarray(8 - owed),
						)
					owed = 0
					// Whole samples then a partial one from the old front.
					await writeAndSettle(oldFront.stdout, channelIq(3, value))
					if (oldStray > 0)
						await writeAndSettle(
							oldFront.stdout,
							channelIq(1, value).subarray(0, oldStray),
						)
					const done = h.demod.reconfigure({ offsetHz })
					if ((config.offsetHz ?? 0) === offsetHz) {
						owed = oldStray === 0 ? 0 : 8 - oldStray
						await done
						expect(h.processes).toHaveLength(before)
						return
					}
					await waitFor(() => h.processes.length === before + 1)
					value = value === 1 ? 0.5 : 1
					const newFront = h.processes[before]!
					await writeAndSettle(
						newFront.stdout,
						Buffer.concat([
							channelIq(3, value),
							channelIq(1, value).subarray(0, newStray),
						]),
					)
					owed = newStray === 0 ? 0 : 8 - newStray
					await done
					expect(h.processes).toHaveLength(before + 1)
					expect(h.current().front).toBe(newFront)
					expect(h.current().back).toBe(back)
					await waitFor(() => !oldFront.alive)
					expect(oldFront.signals).toEqual(["SIGTERM"])
					expect(newFront.signals).toEqual([])
				},
			),
			{ numRuns: 100 },
		)
		// Drain the aligned remainder into whole blocks and check every sample.
		if (owed > 0)
			await writeAndSettle(
				h.current().front.stdout,
				channelIq(1, value).subarray(8 - owed),
			)
		await writeAndSettle(
			h.current().front.stdout,
			channelIq(BLOCK_SAMPLES, value),
		)
		expect(back.signals).toEqual([])
		for (const v of sampleValues(seen)) expect(v === 1 || v === 0.5).toBe(true)
		const fronts: FakeProcess[] = h.processes.filter(p => p !== back)
		expect(fronts.filter(p => p.alive)).toEqual([h.current().front])
	}, 60_000)
})

describe("front swap helpers (WG10 req 2.3)", () => {
	it("FrontSwapFeed writes below the queue bound and drops frame-aligned heads at and past it", async () => {
		const { FrontSwapFeed, FRONT_SWAP_FEED_MAX_QUEUED_BYTES } =
			await import("../../../src/core/live-audio-aligner.js")
		expect(FRONT_SWAP_FEED_MAX_QUEUED_BYTES).toBe(1_048_576)
		const written: Buffer[] = []
		const target = {
			writableLength: 0,
			write(chunk: Buffer) {
				written.push(chunk)
				return true
			},
		}
		const feed = new FrontSwapFeed(target as never, 100)
		target.writableLength = 99
		feed.push(Buffer.alloc(13, 1))
		expect(written).toHaveLength(1)
		target.writableLength = 100 // at the bound
		feed.push(Buffer.alloc(13, 2))
		target.writableLength = 101 // past it
		feed.push(Buffer.alloc(16, 3))
		expect(feed.droppedBytes).toBe(8 + 16)
		expect(feed.droppedBytes % 8).toBe(0)
		// The 5 tail bytes of the dropped 13-byte chunk keep the framing.
		expect(written.map(c => c.length)).toEqual([13, 5])
	})

	it("ComplexSampleAligner forwards whole samples only and reports the first data once", async () => {
		const { ComplexSampleAligner } =
			await import("../../../src/core/live-audio-aligner.js")
		let firsts = 0
		const aligner = new ComplexSampleAligner(() => firsts++)
		const out: Buffer[] = []
		aligner.on("data", (c: Buffer) => out.push(c))
		aligner.write(Buffer.alloc(5, 1))
		aligner.write(Buffer.alloc(5, 1))
		aligner.write(Buffer.alloc(3, 1))
		await delay(1)
		expect(Buffer.concat(out).length).toBe(8)
		aligner.resetAlignment()
		expect(aligner.droppedBytes).toBe(5)
		aligner.write(Buffer.alloc(8, 2))
		await delay(1)
		expect(Buffer.concat(out).length).toBe(16)
		expect(firsts).toBe(1)
	})
})
