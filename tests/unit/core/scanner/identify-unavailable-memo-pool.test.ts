/**
 * WG10 req 3.5 (pool half): the probe pool remembers a decoder type that reported
 * unavailable for PROBE_UNAVAILABLE_MEMO_MS (exclusive bound), a successful start clears it,
 * a genuine no-sync records nothing.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	PROBE_UNAVAILABLE_MEMO_MS,
	type ScannerProbeDecoderType,
} from "@wavekit/api-types"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import {
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

function spawnError(): DecoderSpawnError {
	const cause = new Error("spawn failed") as NodeJS.ErrnoException
	cause.code = "ENOENT"
	return new DecoderSpawnError("probe", "/bin/sh", cause)
}

type Harness = ReturnType<typeof poolHarness>

async function failStart(h: Harness): Promise<void> {
	h.decoders.failNext = spawnError()
	const res = h.pool.request(probeRequest())
	expect(res).toHaveProperty("started")
	await flushAsync()
	await flushAsync()
}

async function goodStart(h: Harness): Promise<void> {
	const res = h.pool.request(probeRequest())
	expect(res).toHaveProperty("started")
	await flushAsync()
	await flushAsync()
}

describe("ProbePool unavailable memo", () => {
	it("starts empty", () => {
		const h = poolHarness()
		expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual([])
	})

	it("records the type on decoder-unavailable", async () => {
		const h = poolHarness()
		const events: string[] = []
		h.pool.on("decoder-unavailable", () => events.push("u"))
		await failStart(h)
		expect(events).toEqual(["u"])
		expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual(["dsd-fme"])
	})

	it("is cleared by a successful start of the type", async () => {
		const h = poolHarness()
		await failStart(h)
		expect(h.pool.unavailableTypes(h.clock.now).has("dsd-fme")).toBe(true)
		await h.pool.release([...h.decoders.created.keys()][0] ?? "")
		h.clock.now += 1000
		await goodStart(h)
		expect(h.decoders.created.size).toBe(1)
		expect(h.pool.unavailableTypes(h.clock.now).size).toBe(0)
	})

	it("expires: still present just inside the bound, gone at exactly 300 s and past", async () => {
		const h = poolHarness()
		await failStart(h)
		const at = h.clock.now
		expect(
			h.pool.unavailableTypes(at + PROBE_UNAVAILABLE_MEMO_MS - 1).size,
		).toBe(1)
		// the bound is exclusive: an entry exactly 300 000 ms old has expired
		expect(h.pool.unavailableTypes(at + PROBE_UNAVAILABLE_MEMO_MS).size).toBe(0)
		expect(
			h.pool.unavailableTypes(at + PROBE_UNAVAILABLE_MEMO_MS + 1).size,
		).toBe(0)
	})

	it("records nothing for a failure that is not unavailable (genuine failure)", async () => {
		const h = poolHarness()
		h.decoders.failNext = new Error("boom")
		h.pool.request(probeRequest())
		await flushAsync()
		await flushAsync()
		expect(h.pool.unavailableTypes(h.clock.now).size).toBe(0)
	})

	it("a 127 exit before output records the type", async () => {
		const h = poolHarness()
		const res = h.pool.request(probeRequest())
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		await flushAsync()
		h.decoders.created.get(res.started)?.emit("exit", 127, null)
		await flushAsync()
		expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual(["dsd-fme"])
	})

	it("is bounded by the number of decoder types", async () => {
		const h = poolHarness()
		for (let i = 0; i < 5; i++) {
			await failStart(h)
			h.clock.now += 10
		}
		expect(h.pool.unavailableTypes(h.clock.now).size).toBeLessThanOrEqual(4)
	})

	// Feature: web-gaps-10, Property 10: Memo is honest
	// Validates: Requirements 3.5
	it("property: a type is listed exactly while recorded less than 300 s ago and not cleared", async () => {
		const ops = fc.array(
			fc.oneof(
				fc.record({ kind: fc.constant("fail" as const) }),
				fc.record({ kind: fc.constant("start" as const) }),
				fc.record({
					kind: fc.constant("wait" as const),
					ms: fc.integer({ min: 0, max: 400_000 }),
				}),
			),
			{ minLength: 1, maxLength: 8 },
		)
		await fc.assert(
			fc.asyncProperty(ops, async list => {
				const h = poolHarness()
				let model: number | null = null
				for (const op of list) {
					if (op.kind === "wait") h.clock.now += op.ms
					else if (op.kind === "fail") {
						await failStart(h)
						model = h.clock.now
						for (const id of [...h.decoders.created.keys()])
							await h.pool.release(id)
					} else {
						await goodStart(h)
						model = null
						for (const id of [...h.decoders.created.keys()])
							await h.pool.release(id)
					}
					const expected: ScannerProbeDecoderType[] =
						model !== null && h.clock.now - model < PROBE_UNAVAILABLE_MEMO_MS
							? ["dsd-fme"]
							: []
					expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual(expected)
				}
			}),
			{ numRuns: 100 },
		)
	})
})
