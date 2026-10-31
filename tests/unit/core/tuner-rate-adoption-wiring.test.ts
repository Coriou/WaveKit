/**
 * Rate adoption after a plain resume, through wireTunerControl: the rate-truth mismatch keeps
 * updating its measurement without another transition, so adoption is retried on the metrics
 * interval while the rate is unverified (fake source manager, no sockets).
 */

import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type {
	SourceCaps,
	SourceManager,
	SourceResumeKind,
} from "../../../src/core/source-manager.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import type { RateMismatch } from "../../../src/core/rate-truth.js"

const testLogger = createLogger({ level: "fatal" })

/** The SourceManager surface wireTunerControl and TunerController use, over a recorded link. */
class FakeSourceManager extends EventEmitter {
	caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	frames: Array<[number, number]> = []
	pendingResume: SourceResumeKind | null = null
	mismatch: RateMismatch | undefined
	statusReads = 0

	isRtlTcpSource(): boolean {
		return true
	}
	getCaps(): SourceCaps {
		return { ...this.caps }
	}
	getConfig(): undefined {
		return undefined
	}
	resumeKind(): SourceResumeKind | null {
		return this.pendingResume
	}
	getStatus(): { rateMismatch?: RateMismatch } {
		this.statusReads++
		return this.mismatch ? { rateMismatch: { ...this.mismatch } } : {}
	}
	assertTunerCommandActive(): void {}
	writeToSource(_id: string, payload: Buffer): boolean {
		this.frames.push([payload.readUInt8(0), payload.readUInt32BE(1)])
		return true
	}
	updateSourceCaps(_id: string, updates: Partial<SourceCaps>): SourceCaps {
		Object.assign(this.caps, updates)
		return this.caps
	}
	setTuningCaps(
		_id: string,
		tuning: { sampleRate: number; centerFreq?: number | undefined },
	): SourceCaps {
		this.caps.sampleRate = tuning.sampleRate
		if (tuning.centerFreq === undefined) delete this.caps.centerFreq
		else this.caps.centerFreq = tuning.centerFreq
		return this.caps
	}

	/** A new session announced on the wire: connected, then its first payload. */
	session(resume: SourceResumeKind | null = null): void {
		this.pendingResume = resume
		this.emit("connected", "rtl")
		this.emit("payload-started", "rtl")
		this.pendingResume = null
	}

	measure(measuredSampleRateHz: number, transition: boolean): void {
		const declaredSampleRateHz = this.caps.sampleRate
		this.mismatch = {
			declaredSampleRateHz,
			measuredSampleRateHz,
			deviation: measuredSampleRateHz / declaredSampleRateHz - 1,
			since: new Date(0),
		}
		if (transition) this.emit("rate-truth-changed", "rtl")
		this.emit("metrics", "rtl", { bytesReceived: 0, dataRate: 0 })
	}
}

function wired() {
	const manager = new FakeSourceManager()
	const tuner = new TunerController(
		testLogger,
		manager as unknown as SourceManager,
	)
	wireTunerControl({
		log: testLogger,
		sourceManager: manager as unknown as SourceManager,
		tunerController: tuner,
		tunerRelay: Object.assign(new EventEmitter(), {
			handleSourceConnected: () => undefined,
		}) as unknown as TunerRelay,
		relayEnabled: false,
	})
	return { manager, tuner }
}

async function plainResumed() {
	const ctx = wired()
	const { manager, tuner } = ctx
	manager.session()
	await tuner.setFrequency("rtl", 145_000_000)
	manager.emit("feed-changed", "rtl", { state: "paused", since: 0 })
	manager.session("plain")
	manager.frames.length = 0
	return ctx
}

describe("rate adoption after a plain resume (wired)", () => {
	it("a first estimate outside every window is retried when the measurement settles", async () => {
		const { manager, tuner } = await plainResumed()
		// 2.10 Msps sits between 2.048 and 2.16 (both windows ±1.5 %): nothing adopted.
		manager.measure(2_100_000, true)
		expect(manager.caps.sampleRate).toBe(2_048_000)
		expect(tuner.getState("rtl")!.unknownFields).toContain("sampleRate")
		// The flagged run's mean settles without another rate-truth transition.
		manager.measure(2_150_000, false)
		expect(manager.caps.sampleRate).toBe(2_160_000)
		expect(tuner.getState("rtl")!.sampleRate).toBe(2_160_000)
		// Adopted, not written: nothing goes to the receiver.
		expect(manager.frames).toEqual([])
	})

	it("repeated identical measurements adopt once (no state churn)", async () => {
		const { manager, tuner } = await plainResumed()
		let changes = 0
		tuner.on("state-changed", () => {
			changes++
		})
		manager.measure(2_160_000, true)
		expect(changes).toBe(1)
		// Caps follow the adopted rate; a stale measurement against them is no news.
		manager.mismatch = { ...manager.mismatch!, measuredSampleRateHz: 2_160_000 }
		manager.emit("metrics", "rtl", { bytesReceived: 0, dataRate: 0 })
		expect(changes).toBe(1)
	})

	it("reads no status on metrics while the rate is not in doubt", () => {
		const { manager } = wired()
		manager.session()
		manager.statusReads = 0
		manager.measure(2_160_000, false)
		expect(manager.statusReads).toBe(0)
		expect(manager.caps.sampleRate).toBe(2_048_000)
	})
})
