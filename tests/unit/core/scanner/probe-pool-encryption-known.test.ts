/**
 * Call-first dsd-fme probe calls: a call that ended before its encryption was
 * known (`encryptionKnown` present and not true, malformed values included) is
 * recorded as encrypted, so it is never linked as a clear recording; the call
 * itself is kept. An absent field is a legacy call whose encryption is known.
 */
import { afterAll, describe, expect, it, vi } from "vitest"
import { rm } from "node:fs/promises"
import {
	PROBE_STORAGE_DIR,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

afterAll(() => rm(PROBE_STORAGE_DIR, { recursive: true, force: true }))

interface RecordedCalls {
	calls: Array<{ callId: string; encrypted: boolean }>
}

async function recordedCall(
	extra: Record<string, unknown>,
): Promise<RecordedCalls[]> {
	const h = poolHarness()
	const res = h.pool.request(probeRequest({ record: true }))
	if (!("started" in res)) throw new Error("not started")
	await vi.waitFor(() => expect(h.decoders.created.has(res.started)).toBe(true))
	const recordings: RecordedCalls[] = []
	h.pool.on("recordings", (r: RecordedCalls) => recordings.push(r))
	h.decoders.emitOutput(res.started, {
		type: "call_end",
		timestamp: new Date(1_000_500),
		data: {
			callId: "c1",
			protocol: "dmr",
			startedAt: new Date(1_000_100).toISOString(),
			endedAt: new Date(1_000_400).toISOString(),
			talkgroup: 9,
			source: 2060945,
			encrypted: false,
			...extra,
		},
	})
	await h.pool.release(res.started)
	return recordings
}

describe("ProbePool call-first encryption", () => {
	it("records a call whose encryption was never known as encrypted, not clear", async () => {
		const recordings = await recordedCall({ encryptionKnown: false })
		expect(recordings).toHaveLength(1)
		expect(recordings[0]!.calls).toEqual([
			expect.objectContaining({ callId: "c1", encrypted: true }),
		])
	})

	it.each([["true"], [1], [null], [0], [{}], ["false"]])(
		"fails closed on a malformed encryptionKnown %j: the call is kept and not clear",
		async value => {
			const recordings = await recordedCall({ encryptionKnown: value })
			expect(recordings[0]!.calls).toEqual([
				expect.objectContaining({ callId: "c1", encrypted: true }),
			])
		},
	)

	it("a call known clear is recorded clear", async () => {
		const recordings = await recordedCall({ encryptionKnown: true })
		expect(recordings[0]!.calls).toEqual([
			expect.objectContaining({ callId: "c1", encrypted: false }),
		])
	})

	it("a call known encrypted stays encrypted", async () => {
		const recordings = await recordedCall({
			encryptionKnown: true,
			encrypted: true,
		})
		expect(recordings[0]!.calls).toEqual([
			expect.objectContaining({ callId: "c1", encrypted: true }),
		])
	})

	it("absent encryptionKnown is a legacy known call", async () => {
		const recordings = await recordedCall({})
		expect(recordings[0]!.calls).toEqual([
			expect.objectContaining({ callId: "c1", encrypted: false }),
		])
	})
})
