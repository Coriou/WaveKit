import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import pino from "pino"
import {
	TunerArbiter,
	type ArbiterDeps,
	type Lease,
	type LeaseLostReason,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import {
	ArbiterFakeTuner,
	FakeClock,
} from "../../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

class Sources extends EventEmitter {
	isRtlTcpSource(id: string): boolean {
		return id === "rtl"
	}
}

function harness() {
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl", [])
	const sources = new Sources()
	const clock = new FakeClock()
	let now = 1_000
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: sources as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: () => Promise.resolve(),
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger: pino({ level: "silent" }),
		now: () => now,
	}
	const arbiter = new TunerArbiter(deps)
	const lost: { jobId: string; reason: LeaseLostReason }[] = []
	arbiter.on("lease-lost", (lease: Lease, reason: LeaseLostReason) =>
		lost.push({ jobId: lease.jobId, reason }),
	)
	return {
		tuner,
		sources,
		arbiter,
		lost,
		advance: (ms: number) => (now += ms),
	}
}

describe("TunerArbiter: configured tuning origin (WG11 req 4.1)", () => {
	it("keeps a lease across a reconnect with configured tuning and leaves the operator idle clock unchanged", async () => {
		const h = harness()
		const a = h.arbiter.acquire("a", "rtl", 50)
		if (!a.ok) throw new Error("acquire failed")
		const idleBefore = h.arbiter.operatorIdleSince("rtl")
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.advance(5_000)
		h.tuner.external("rtl", "set-gain-mode", 1, "config")
		h.tuner.external("rtl", "set-gain", 496, "config")
		h.tuner.external("rtl", "set-agc-mode", 0, "config")
		expect(h.lost).toEqual([])
		expect(h.arbiter.holder("rtl")).toBe(a.lease)
		expect(h.arbiter.operatorIdleSince("rtl")).toBe(idleBefore)
		// Control: an operator write still preempts and moves the clock.
		h.tuner.external("rtl", "set-gain", 300, "rest")
		expect(h.lost).toEqual([{ jobId: "a", reason: "preempted-operator" }])
		expect(h.arbiter.operatorIdleSince("rtl")).not.toBe(idleBefore)
	})
})
