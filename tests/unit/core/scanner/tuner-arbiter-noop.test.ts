// tests/unit/core/scanner/tuner-arbiter-noop.test.ts
/**
 * Scanner redesign R 1.2: a same-centre retune by the lease holder writes nothing when the
 * centre, rate and gain were written and accepted on this connection and the current epoch is
 * the verified one. Every other input takes today's write path.
 */
import { describe, expect, it } from "vitest"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import { noopHarness } from "./tuner-arbiter-noop-harness.js"

const C = 446_500_000
const target = (over: Partial<Target> = {}): Target => ({
	centreHz: C,
	gainTenthsDb: 400,
	sampleRateHz: 2_048_000,
	...over,
})
interface Target {
	centreHz: number
	gainTenthsDb: number | null
	sampleRateHz: number | null
}

async function verifiedLease(h: ReturnType<typeof noopHarness>, job = "a") {
	const r = h.arbiter.acquire(job, "rtl", 50)
	if (!r.ok) throw new Error(r.detail)
	const first = await h.arbiter.retune(r.lease, target())
	return { lease: r.lease, first }
}

/** Writes and submitted epochs caused by one retune. */
async function measure(
	h: ReturnType<typeof noopHarness>,
	lease: Lease,
	t: Target = target(),
) {
	const sent = h.tuner.sent.length
	const submitted = h.clock.submitted.length
	const pending = await h.arbiter.retune(lease, t)
	return {
		pending,
		writes: h.tuner.sent.slice(sent).map(c => c.name),
		newEpochs: h.clock.submitted.length - submitted,
	}
}

describe("TunerArbiter same-centre no-op (R 1.2)", () => {
	it("same centre/rate/gain on a verified commanded started epoch writes nothing, no markers, returns the same epoch", async () => {
		const h = noopHarness()
		const { lease, first } = await verifiedLease(h)
		expect(lease.verified).toEqual({
			centreHz: C,
			sampleRateHz: 2_048_000,
			gainTenthsDb: 400,
			epoch: first.epoch,
		})
		const changed = new Set(lease.changedFields)
		const m = await measure(h, lease)
		expect(m.writes).toEqual([])
		expect(m.newEpochs).toBe(0)
		expect(m.pending.epoch).toBe(first.epoch)
		expect(m.pending.settleSamples).toBe(0)
		expect(m.pending.expectMarker).toBe(false)
		expect(m.pending.centreChanged).toBe(false)
		expect(lease.changedFields).toEqual(changed)
		// and again: still nothing
		expect((await measure(h, lease)).writes).toEqual([])
	})

	it("different gain writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		const m = await measure(h, lease, target({ gainTenthsDb: 300 }))
		expect(m.writes).toContain("set-gain")
		expect(m.newEpochs).toBe(1)
	})

	it("different centre or rate writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		expect(
			(await measure(h, lease, target({ centreHz: C + 1 }))).writes,
		).toContain("set-frequency")
		const h2 = noopHarness()
		const v2 = await verifiedLease(h2)
		expect(
			(await measure(h2, v2.lease, target({ sampleRateHz: 1_024_000 }))).writes,
		).toContain("set-sample-rate")
	})

	it("an unverified epoch (operator settle window open) writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.clock.trust = "unverified"
		const m = await measure(h, lease)
		expect(m.writes).toContain("set-frequency")
		expect(m.newEpochs).toBe(1)
	})

	it("an epoch that has not started (null startSample) writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.clock.startSample = null
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("an epoch the arbiter did not post (untracked retune, host-centre mismatch) writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.clock.external()
		h.clock.trust = "commanded" // even if the new epoch read as commanded
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("distrust (untracked retune reported by the pipeline) makes the next retune write", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.arbiter.distrust("rtl")
		expect(lease.verified).toBeNull()
		expect((await measure(h, lease)).writes).toContain("set-frequency")
		// the write verified the lease again
		expect((await measure(h, lease)).writes).toEqual([])
	})

	it("after a reconnect, the first same-centre retune writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("a payload restart alone writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("a control-mode change writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.tuner.emit("control-mode-changed", "rtl", "internal")
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("a config or replay write on the source writes", async () => {
		for (const origin of ["config", "replay"] as const) {
			const h = noopHarness()
			const { lease } = await verifiedLease(h)
			h.tuner.external("rtl", "set-frequency", C, origin)
			expect((await measure(h, lease)).writes).toContain("set-frequency")
		}
	})

	it("after handover to another job, the same target writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		const b = h.arbiter.acquire("b", "rtl", 90)
		if (!b.ok) throw new Error(b.detail)
		expect(lease.verified).toBeNull()
		expect(b.lease.verified ?? null).toBeNull()
		expect((await measure(h, b.lease)).writes).toContain("set-frequency")
	})

	it("after release and a new acquire, the same target writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		await h.arbiter.release(lease, { restore: false })
		expect(lease.verified).toBeNull()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error(r.detail)
		expect((await measure(h, r.lease)).writes).toContain("set-frequency")
	})

	it("the rate in declaredOnlyFields writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.tuner.declared.set("rtl", new Set(["sampleRate"]))
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("gain or gain mode in unknownFields writes", async () => {
		for (const f of ["gain", "gainMode", "frequency"] as const) {
			const h = noopHarness()
			const { lease } = await verifiedLease(h)
			h.tuner.known.get("rtl")!.delete(f)
			expect((await measure(h, lease)).writes).toContain("set-frequency")
		}
	})

	it("tuningWrittenOnConnection false, throwing or absent writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.tuner.connectionWrites = new Set()
		expect((await measure(h, lease)).writes).toContain("set-frequency")

		const t = noopHarness()
		const v = await verifiedLease(t)
		t.tuner.tuningWrittenOnConnection = () => {
			throw new Error("controller gone")
		}
		// never a skip: today's path runs, and today it fails on the same call
		await expect(t.arbiter.retune(v.lease, target())).rejects.toThrow(
			"controller gone",
		)

		const a = noopHarness()
		const va = await verifiedLease(a)
		Object.defineProperty(a.tuner, "tuningWrittenOnConnection", {
			value: undefined,
		})
		expect((await measure(a, va.lease)).writes).toContain("set-frequency")
	})

	it("a device state that drifted from the accepted write writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.tuner.states.get("rtl")!.gain = 100
		expect((await measure(h, lease)).writes).toContain("set-frequency")
	})

	it("a failed write leaves the lease unverified, so the retry writes", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.tuner.failNext = new Error("socket closed")
		await expect(
			h.arbiter.retune(lease, target({ gainTenthsDb: 300 })),
		).rejects.toThrow()
		expect(lease.verified).toBeNull()
		expect(
			(await measure(h, lease, target({ gainTenthsDb: 300 }))).writes,
		).toContain("set-frequency")
	})

	it("a lease that is not held never skips: it throws as today", async () => {
		const h = noopHarness()
		const { lease } = await verifiedLease(h)
		h.arbiter.acquire("b", "rtl", 90)
		await expect(h.arbiter.retune(lease, target())).rejects.toMatchObject({
			code: "SCANNER_LEASE_LOST",
		})
	})
})
