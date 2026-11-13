// tests/unit/core/scanner/tuner-arbiter-noop-harness.ts
/**
 * Shared fakes for the R 1.2 arbiter no-op tests: a controllable epoch clock, a real tuning ledger
 * the fake tuner's writes are receipted into (settle 0: a receipt proves at once), and an arbiter.
 */
import { EventEmitter } from "node:events"
import pino from "pino"
import type { TunerStateField } from "@wavekit/api-types"
import {
	TunerArbiter,
	type ArbiterDeps,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import type {
	EngineEpoch,
	EpochClock,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PendingEpoch } from "../../../../src/core/spectrum/types.js"
import { ArbiterFakeTuner } from "../../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import { FakeReceiverLedger } from "../../../mocks/fake-receiver-ledger.js"
import type { TuningLedger } from "../../../../src/core/tuning-ledger.js"

class Sources extends EventEmitter {
	tuningLedger?: TuningLedger
	isRtlTcpSource(id: string): boolean {
		return id === "rtl"
	}
}

/** An epoch clock whose current epoch the test controls (trust, start, an external epoch). */
export class NoopClock implements EpochClock {
	readonly submitted: PendingEpoch[] = []
	markerSupported: boolean | null = null
	epoch = 0
	sample = 0
	centreHz = 446_100_000
	trust: EngineEpoch["tuningTrust"] = "commanded"
	startSample: number | null = 0
	sampleClock() {
		this.sample += 1000
		return {
			commandSample: this.sample,
			bufferedSamples: 64,
			sampleRateHz: 2_048_000,
		}
	}
	allocateEpoch(): number {
		this.epoch += 1
		return this.epoch
	}
	submitEpoch(p: PendingEpoch): void {
		this.submitted.push(p)
		this.centreHz = p.centreHz
	}
	suppressExternal(): void {}
	/** The engine's doubt on an untracked retune (set by the harness). */
	onExternal: (() => void) | null = null
	/** An epoch nobody commanded (untracked retune, host-centre mismatch): the engine doubts both. */
	external(): void {
		this.epoch += 1
		this.trust = "unverified"
		this.onExternal?.()
	}
	currentEpoch(): EngineEpoch {
		return {
			stream: 0,
			epoch: this.epoch,
			startSample: this.startSample,
			centreHz: this.centreHz,
			sampleRateHz: 2_048_000,
			gainKey: "m:296",
			tuningTrust: this.trust,
			settleMode: "marker",
		}
	}
}

export function noopHarness(
	unknown: TunerStateField[] = [],
	extra: Partial<ArbiterDeps> = {},
) {
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl", unknown)
	const sources = new Sources()
	const clock = new NoopClock()
	// The live session already holds receipts of the tuner's centre and rate (settle 0).
	const ledger = new FakeReceiverLedger("rtl", {
		rateHz: 2_048_000,
		settleMs: 0,
	})
	const state = tuner.states.get("rtl")!
	ledger.prove(state.frequency, state.sampleRate)
	sources.tuningLedger = ledger.ledger
	tuner.receipts = (_id, command, value, writer, jobId) =>
		ledger.write(command, value, writer, jobId)
	clock.onExternal = () =>
		ledger.ledger.raiseDoubt("rtl", "both", "untracked-retune")
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
		...extra,
	}
	const arbiter = new TunerArbiter(deps)
	return { tuner, sources, clock, arbiter, ledger }
}
