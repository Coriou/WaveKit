// tests/unit/core/scanner/job-runner-recording.test.ts
/**
 * The job runner's optional `recordingActive` dependency reaches the sweep scheduler bound to the
 * job's source and the engine's current epoch, and only while the job's own hop epoch runs.
 * The real JobRunner with a fake arbiter and engine (as scheduler-parked-job-runner.test.ts).
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	JobRunner,
	type JobRecord,
	type JobRunnerDeps,
} from "../../../../src/core/scanner/job-runner.js"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PendingEpoch } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const HOP = 446_100_000
const FS = 1_024_000
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

class Arbiter {
	lease: Lease | null = null
	readonly retunes: { centreHz: number }[] = []
	acquire(jobId: string, sourceId: string) {
		this.lease = {
			sourceId,
			jobId,
			acquiredAt: 0,
			snapshot: {},
			changedFields: new Set(),
		}
		return { ok: true as const, lease: this.lease }
	}
	retune(
		_lease: Lease,
		target: { centreHz: number },
	): Promise<PendingEpoch & { skipped?: true }> {
		this.retunes.push(target)
		return Promise.resolve({
			...(this.retunes.length > 1 ? { skipped: true as const } : {}),
			epoch: 11,
			commandSample: 0,
			bufferedSamples: 0,
			settleSamples: 0,
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz: target.centreHz,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
			centreChanged: true,
		})
	}
	release() {
		this.lease = null
		return Promise.resolve({ restored: [], unrestorable: [] })
	}
	setAgc() {
		return Promise.resolve()
	}
	holder() {
		return this.lease ?? undefined
	}
	isConnected() {
		return true
	}
	holderPriority() {
		return this.lease ? 50 : undefined
	}
	operatorIdleSince() {
		return null
	}
}

const epoch: EngineEpoch = {
	stream: 0,
	epoch: 11,
	startSample: 0,
	centreHz: HOP,
	sampleRateHz: FS,
	gainKey: "m:496",
	tuningTrust: "commanded",
	settleMode: "timer",
}

type Recording = NonNullable<JobRunnerDeps["recordingActive"]>

/** Starts a sweep job on HOP; returns the runner and the scheduler's bound `recordingActive`. */
async function startJob(recordingActive?: Recording) {
	const arbiter = new Arbiter()
	const record: JobRecord = {
		id: "j_rec",
		name: null,
		passive: false,
		rawSpec: { sourceId: "rtl", mode: "sweep" },
		spec: makeNormalisedSpec({ sourceId: "rtl", dwellMs: 200 }),
		plan: makeHopPlan([HOP]),
		issues: [],
		impact: null,
		consentedImpact: null,
		state: "pending",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	}
	const engine = {
		currentEpoch: () => epoch,
		config: () => ({ integrationMs: 50, sampleRateHz: FS, fftSize: 2048 }),
		stats: () => ({ observedSamples: 1 }),
	}
	const runner = new JobRunner({
		record,
		arbiter: arbiter as never,
		probes: {
			request: () => ({ deferred: "budget" as const }),
			release: () => Promise.resolve(),
			releaseJob: () => Promise.resolve(),
			follow: () => undefined,
			status: () => [],
			startLatencyMs: () => 400,
		},
		decoders: {
			holdSource: () => Promise.resolve(),
			releaseSource: () => Promise.resolve(),
		},
		settings: () => testSettings(),
		openEngine: () => Promise.resolve(engine as never),
		closeEngine: () => Promise.resolve(),
		engine: () => engine as never,
		refreshTuning: () => Promise.resolve(),
		impact: () => ({
			liveAudioClients: 0,
			digitalVoiceListeners: 0,
			runningDecoders: [],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}),
		undecoded: () => undefined,
		discoveryCounts: () => ({
			activity: 0,
			candidate: 0,
			classified: 0,
			decoded: 0,
		}),
		awaitRestoredCaps: () => Promise.resolve(),
		persist: () => undefined,
		changed: () => undefined,
		logger: pino({ level: "silent" }),
		now: () => 0,
		...(recordingActive ? { recordingActive } : {}),
	})
	await runner.start()
	await flush()
	const bound = (): (() => boolean) | undefined =>
		(
			runner as unknown as {
				scheduler: { recordingActive?: () => boolean } | null
			}
		).scheduler?.recordingActive
	return { runner, bound }
}

describe("JobRunner recordingActive", () => {
	it("absent: the scheduler gets none", async () => {
		const { runner, bound } = await startJob()
		runner.onEpochStarted(epoch)
		await flush()
		expect(bound()).toBeUndefined()
	})

	it("asks for the job's source and the engine's current stream and epoch, only once its own hop epoch runs", async () => {
		const calls: [string, { stream: number; epoch: number }][] = []
		let answer = true
		const { runner, bound } = await startJob((sourceId, at) => {
			calls.push([sourceId, at])
			return answer
		})
		const ask = bound()
		expect(ask).toBeDefined()
		// Before the hop's own epoch started: no recording of this hop's window.
		expect(ask!()).toBe(false)
		expect(calls).toEqual([])
		runner.onEpochStarted(epoch)
		await flush()
		expect(ask!()).toBe(true)
		answer = false
		expect(ask!()).toBe(false)
		expect(calls).toEqual([
			["rtl", { stream: 0, epoch: 11 }],
			["rtl", { stream: 0, epoch: 11 }],
		])
	})

	it("a dependency that throws counts as no recording", async () => {
		const { runner, bound } = await startJob(() => {
			throw new Error("recorder gone")
		})
		runner.onEpochStarted(epoch)
		await flush()
		expect(bound()!()).toBe(false)
	})
})
