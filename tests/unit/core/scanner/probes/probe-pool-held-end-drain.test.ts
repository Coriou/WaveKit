/**
 * A dsd-fme probe decoder holds a call_end up to DSD_FME_WAV_END_WAIT_MS for its WAV lookup and
 * publishes it from stop(): the pool, already stopping, still takes that end (call and evidence)
 * for the stopping record until the decoder's removal returns, under deliver's epoch rule. The fake
 * manager's removal plays the adapter's stop: it publishes the held end after the hold, then
 * resolves. Fake setTimeout only; the real mkdir of the recording dir completes.
 */
import { afterAll, describe, expect, it, vi } from "vitest"
import { rm } from "node:fs/promises"
import { DSD_FME_WAV_END_WAIT_MS } from "../../../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutputLike } from "../../../../../src/core/scanner/probes/confirm/double-match.js"
import type { ProbeRecordings } from "../../../../../src/core/scanner/probes/probe-pool.js"
import {
	PROBE_STORAGE_DIR,
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../../mocks/scanner/probe-fakes.js"
import { verifiedLinkLine } from "../verified-link-fake.js"

afterAll(() => rm(PROBE_STORAGE_DIR, { recursive: true, force: true }))

type Harness = ReturnType<typeof poolHarness>

function callEnd(callId: string, at: number): DecoderOutputLike {
	return {
		type: "call_end",
		timestamp: new Date(at),
		data: {
			callId,
			protocol: "dmr",
			startedAt: new Date(at - 400).toISOString(),
			endedAt: new Date(at).toISOString(),
			talkgroup: 9,
			source: 2001,
			encrypted: false,
			encryptionKnown: true,
			wavFile: `/rec/${callId}.wav`,
		},
	}
}

async function confirming(h: Harness): Promise<string> {
	for (let i = 0; i < 10_000; i++) {
		const p = h.pool.status()[0]
		if (p?.state === "confirming") return p.decoderId
		await flushAsync()
	}
	throw new Error("probe never reached confirming")
}

/** The removal publishes `held` after the adapter's hold, as dsd-fme's stop() drains its outbox. */
function holdOnRemoval(h: Harness, held: () => DecoderOutputLike[]): void {
	const remove = h.decoders.removeEphemeralDecoder.bind(h.decoders)
	vi.spyOn(h.decoders, "removeEphemeralDecoder").mockImplementation(
		async (id: string) => {
			await new Promise(resolve => setTimeout(resolve, DSD_FME_WAV_END_WAIT_MS))
			for (const out of held()) h.decoders.emitOutput(id, out)
			await remove(id)
		},
	)
}

async function startRecording(h: Harness): Promise<{
	probeId: string
	decoderId: string
	recordings: ProbeRecordings[]
}> {
	const res = h.pool.request(probeRequest({ record: true }))
	if (!("started" in res)) throw new Error("not started")
	const decoderId = await confirming(h)
	const recordings: ProbeRecordings[] = []
	h.pool.on("recordings", (r: ProbeRecordings) => recordings.push(r))
	return { probeId: res.started, decoderId, recordings }
}

describe("ProbePool: a dsd-fme end held across the probe's stop", () => {
	it("keeps a call whose end the decoder publishes during an epoch hop's stop", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const h = poolHarness()
			const { probeId, decoderId, recordings } = await startRecording(h)
			h.decoders.emitLink(decoderId, verifiedLinkLine(1, h.clock.now - 300))
			h.decoders.emitLink(decoderId, verifiedLinkLine(1, h.clock.now - 200))
			// The terminator came 100 ms before the hop; the end waits for its lookup.
			const producedAt = h.clock.now - 100
			// One produced after the hop (the adapter's stop() force-ending a call) is the next epoch's.
			const lateAt = h.clock.now + 50
			holdOnRemoval(h, () => [callEnd("c1", producedAt), callEnd("c2", lateAt)])
			const evidenceBefore = h.evidence.length
			h.engine.setEpoch(2, 446_200_000)
			let settled = false
			const hop = h.pool.onEpoch("rtl", 2, 446_200_000).then(() => {
				settled = true
			})
			// No pool wait of its own: teardown lasts the adapter's hold, no longer.
			await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS - 1)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			await hop
			expect(settled).toBe(true)
			expect(recordings).toHaveLength(1)
			expect(recordings[0]).toMatchObject({ probeId })
			expect(recordings[0]!.calls).toEqual([
				{
					callId: "c1",
					startedAt: producedAt - 400,
					endedAt: producedAt,
					talkgroup: "9",
					source: "2001",
					encrypted: false,
				},
			])
			// Its evidence is the stopping epoch's (stamped before the hop); c2's is not delivered.
			const drained = h.evidence.slice(evidenceBefore)
			expect(drained.map(e => e.ev.callId)).toContain("c1")
			expect(drained.map(e => e.ev.callId)).not.toContain("c2")
			expect(drained.every(e => e.probeId === probeId)).toBe(true)
			expect(drained.every(e => e.ev.at < lateAt)).toBe(true)
			expect(drained.every(e => e.ev.epoch === 1)).toBe(true)
			// Published after the removal returned: dropped, the settled result unchanged.
			h.decoders.emitOutput(decoderId, callEnd("c3", producedAt))
			expect(recordings[0]!.calls.map(c => c.callId)).toEqual(["c1"])
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps a call whose end the decoder publishes during a release", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const h = poolHarness()
			const { probeId, decoderId, recordings } = await startRecording(h)
			// Two checked voice LCs accept the identity, so the call's end is evidence too.
			h.decoders.emitLink(decoderId, verifiedLinkLine(1, h.clock.now - 300))
			h.decoders.emitLink(decoderId, verifiedLinkLine(1, h.clock.now - 200))
			const producedAt = h.clock.now - 20
			holdOnRemoval(h, () => [callEnd("c1", producedAt)])
			const evidenceBefore = h.evidence.length
			const release = h.pool.release(probeId)
			await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
			await release
			expect(recordings).toHaveLength(1)
			expect(recordings[0]!.calls.map(c => c.callId)).toEqual(["c1"])
			const drained = h.evidence.slice(evidenceBefore)
			expect(drained.length).toBeGreaterThan(0)
			expect(drained.every(e => e.probeId === probeId)).toBe(true)
			expect(drained.some(e => e.ev.callId === "c1")).toBe(true)
			// After the release resolved: neither the call nor its evidence is taken.
			const evidenceAfter = h.evidence.length
			h.decoders.emitOutput(decoderId, callEnd("c2", producedAt))
			expect(recordings[0]!.calls.map(c => c.callId)).toEqual(["c1"])
			expect(h.evidence.length).toBe(evidenceAfter)
		} finally {
			vi.useRealTimers()
		}
	})

	it("takes only call_ends from a stopping decoder", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const h = poolHarness()
			const { probeId, recordings } = await startRecording(h)
			const at = h.clock.now - 20
			holdOnRemoval(h, () => [{ ...callEnd("c1", at), type: "call_start" }])
			const evidenceBefore = h.evidence.length
			const release = h.pool.release(probeId)
			await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
			await release
			expect(recordings[0]!.calls).toEqual([])
			expect(h.evidence.length).toBe(evidenceBefore)
		} finally {
			vi.useRealTimers()
		}
	})
})
