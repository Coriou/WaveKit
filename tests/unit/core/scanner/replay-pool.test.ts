import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
	REPLAY_END_GRACE_MS,
	REPLAY_HELD_EVIDENCE_MAX,
	offsetTransport,
	type ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import {
	flushAsync,
	linkLine,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

const wait = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

/** A replay input that already reached its EOF (the capture was read to its end). */
function endedInput(): PassThrough {
	const s = new PassThrough()
	s.end()
	return s
}

function harness(stream: PassThrough | null = endedInput()) {
	const openReplay = vi.fn(() => stream)
	const h = poolHarness({
		transports: [offsetTransport, createReplayTransport({ openReplay })],
	})
	const ends: string[] = []
	h.pool.on("replay-end", (probeId: string) => ends.push(probeId))
	const req = (over: Partial<ProbeRequest> = {}): ProbeRequest =>
		probeRequest({
			modes: [
				{
					decoderType: "multimon-ng",
					protocol: "pocsag",
					covers: [],
					options: {},
					holdMs: 4000,
				},
			],
			replay: { captureId: "cap-1" },
			...over,
		})
	return { ...h, openReplay, ends, req }
}

describe("probe pool replay requests", () => {
	it("run on the replay transport with the capture as the decoder input", async () => {
		const h = harness()
		const res = h.pool.request(h.req())
		expect(res).toHaveProperty("started")
		await flushAsync()
		expect(h.openReplay).toHaveBeenCalledWith("cap-1", "multimon-ng")
		const status = h.pool.status()
		expect(status.map(s => s.transport)).toEqual(["replay"])
		const decoder = [...h.decoders.created.values()][0]!
		expect(decoder.config.options).toMatchObject({
			inputIqFormat: "cf32",
			inputSampleRate: 48_000,
			channelHz: 446_125_000,
		})
		expect(h.engine.tapCount).toBe(0)
		expect(decoder.input).not.toBeNull()
	})

	it("never takes the offset transport, and a live request never the replay one", async () => {
		const h = harness()
		const { replay: _replay, ...liveReq } = h.req({ trackId: "t2" })
		const live = h.pool.request(liveReq)
		expect(live).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.status().map(s => s.transport)).toEqual(["offset"])
		expect(h.openReplay).not.toHaveBeenCalled()
	})

	it("counts IQ_REPLAY_MAX_PROBES: a second replay waits", async () => {
		const h = harness()
		expect(h.pool.request(h.req())).toHaveProperty("started")
		expect(h.pool.request(h.req({ replay: { captureId: "cap-2" } }))).toEqual({
			deferred: "max-probes",
		})
	})

	it("ends without a verdict when the capture is gone", async () => {
		const h = harness(null)
		h.pool.request(h.req())
		await flushAsync()
		await flushAsync()
		expect(h.decoders.created.size).toBe(0)
		expect(h.states.map(s => s.state)).toEqual(["starting", "stopped"])
		expect(h.ends).toEqual([])
		expect(h.evidence).toEqual([])
	})

	it("a clean decoder exit ends the probe after the grace and reports replay-end first", async () => {
		const h = harness()
		h.pool.request(h.req())
		await flushAsync()
		const [id, decoder] = [...h.decoders.created.entries()][0]!
		decoder.emit("exit", 0, null)
		await flushAsync()
		expect(h.pool.status()).toHaveLength(1)
		await wait(REPLAY_END_GRACE_MS + 150)
		expect(h.ends).toHaveLength(1)
		expect(h.pool.status()).toHaveLength(0)
		expect(h.states.map(s => s.state)).toEqual([
			"starting",
			"confirming",
			"stopped",
		])
		expect(h.decoders.removed).toEqual([id])
	})

	it("a failing exit without output ends the probe with no replay-end", async () => {
		const h = harness()
		h.pool.request(h.req())
		await flushAsync()
		const decoder = [...h.decoders.created.values()][0]!
		decoder.emit("exit", 1, null)
		await wait(REPLAY_END_GRACE_MS + 150)
		expect(h.ends).toEqual([])
		expect(h.pool.status()).toHaveLength(0)
		expect(h.states.at(-1)?.state).toBe("stopped")
	})

	it("an epoch change leaves a replay probe running and does not re-request it", async () => {
		const h = harness()
		h.pool.request(h.req())
		await flushAsync()
		h.engine.setEpoch(2, 446_100_000)
		await h.pool.onEpoch("rtl", 2, 446_100_000)
		expect(h.pool.status()).toHaveLength(1)
		expect(h.openReplay).toHaveBeenCalledTimes(1)
	})

	it("starts a replay of an older-epoch capture", async () => {
		const h = harness()
		h.engine.setEpoch(5, 446_100_000)
		expect(h.pool.request(h.req({ epoch: 3 }))).toHaveProperty("started")
	})

	it("a replay input that failed ends the probe cancelled, with no verdict, even after a clean decoder exit (Astra MAJOR e)", async () => {
		const stream = new PassThrough()
		const h = harness(stream)
		h.pool.request(h.req())
		await flushAsync()
		stream.destroy(new Error("native replay failed"))
		await flushAsync()
		const decoder = [...h.decoders.created.values()][0]!
		decoder.emit("exit", 0, null)
		await wait(REPLAY_END_GRACE_MS + 150)
		expect(h.ends).toEqual([])
		expect(h.pool.status()).toHaveLength(0)
	})

	it("an input error during the grace after a clean decoder exit still wins: cancelled, no verdict (Astra MAJOR 1)", async () => {
		const stream = new PassThrough()
		const h = harness(stream)
		h.pool.request(h.req())
		await flushAsync()
		const decoder = [...h.decoders.created.values()][0]!
		decoder.emit("exit", 0, null)
		await wait(50)
		stream.destroy(new Error("native replay failed"))
		await wait(REPLAY_END_GRACE_MS + 150)
		expect(h.ends).toEqual([])
		expect(h.pool.status()).toHaveLength(0)
	})

	it("a clean decoder exit without the input's EOF is no clean end: cancelled (Astra re-review 2 #2)", async () => {
		const h = harness(new PassThrough())
		h.pool.request(h.req())
		await flushAsync()
		const decoder = [...h.decoders.created.values()][0]!
		decoder.emit("exit", 0, null)
		await wait(REPLAY_END_GRACE_MS + 150)
		expect(h.ends).toEqual([])
		expect(h.pool.status()).toHaveLength(0)
	})

	describe("replay evidence is held until the clean end (Astra re-review 2 #1)", () => {
		const dmr = {
			decoderType: "dsd-fme" as const,
			protocol: "dmr" as const,
			covers: ["dmr" as const],
			options: {},
			holdMs: 4000,
		}
		async function run(fail: boolean) {
			const stream = new PassThrough()
			const h = harness(stream)
			const evidence: string[] = []
			h.pool.on("evidence", (probeId: string) => evidence.push(probeId))
			h.pool.request(h.req({ modes: [dmr] }))
			await flushAsync()
			const [id, decoder] = [...h.decoders.created.entries()][0]!
			h.decoders.emitLink(id, linkLine(1, h.clock.now))
			h.decoders.emitLink(id, linkLine(1, h.clock.now + 30))
			await flushAsync()
			const beforeEnd = evidence.length
			if (fail) stream.destroy(new Error("native replay failed"))
			else stream.end()
			await flushAsync()
			decoder.emit("exit", 0, null)
			await wait(REPLAY_END_GRACE_MS + 150)
			return { beforeEnd, after: evidence.length, ends: h.ends.length }
		}

		it("nothing is emitted before the end; all of it right before replay-end", async () => {
			const r = await run(false)
			expect(r.beforeEnd).toBe(0)
			expect(r.after).toBeGreaterThan(0)
			expect(r.ends).toBe(1)
		})

		it("an input error drops the held evidence: never emitted, no verdict", async () => {
			expect(await run(true)).toEqual({ beforeEnd: 0, after: 0, ends: 0 })
		})
	})

	describe("held replay evidence is bounded (Astra r7 B3)", () => {
		const dmr = {
			decoderType: "dsd-fme" as const,
			protocol: "dmr" as const,
			covers: ["dmr" as const],
			options: {},
			holdMs: 4000,
		}
		/** `evidence` held entries: the first link line only acquires sync, each later one is evidence. */
		async function feedLines(evidenceLines: number) {
			const lines = evidenceLines + 1
			const stream = new PassThrough()
			const h = harness(stream)
			const evidence: string[] = []
			h.pool.on("evidence", (probeId: string) => evidence.push(probeId))
			h.pool.request(h.req({ modes: [dmr] }))
			await flushAsync()
			const [id, decoder] = [...h.decoders.created.entries()][0]!
			for (let i = 0; i < lines; i++)
				h.decoders.emitLink(id, linkLine(1, h.clock.now + i))
			await flushAsync()
			stream.end()
			await flushAsync()
			decoder.emit("exit", 0, null)
			await wait(REPLAY_END_GRACE_MS + 150)
			return {
				evidence: evidence.length,
				ends: h.ends.length,
				running: h.pool.status().length,
			}
		}

		it(`at the bound (${REPLAY_HELD_EVIDENCE_MAX} lines): all of it lands at the clean end`, async () => {
			expect(await feedLines(REPLAY_HELD_EVIDENCE_MAX)).toEqual({
				evidence: REPLAY_HELD_EVIDENCE_MAX,
				ends: 1,
				running: 0,
			})
		})

		it("one past the bound: the probe ends cancelled, nothing lands, no verdict", async () => {
			expect(await feedLines(REPLAY_HELD_EVIDENCE_MAX + 1)).toEqual({
				evidence: 0,
				ends: 0,
				running: 0,
			})
		})

		it("20 000 lines: still nothing held past the bound", async () => {
			expect(await feedLines(20_000)).toEqual({
				evidence: 0,
				ends: 0,
				running: 0,
			})
		})
	})
})
