// tests/unit/core/scanner/scheduler-parked-job-runner.test.ts
/**
 * Parking (R 1.1, 1.3): a parked job's runner never waits for a tune that never comes.
 * The real JobRunner drives a one-hop plan with a fake arbiter and an injected clock: it keeps
 * dwelling and counting sweeps after the only tune.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	JobRunner,
	type JobRecord,
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
const BLOCK = 51_200 // 50 ms at 1.024 Msps
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

describe("JobRunner with a parked scheduler", () => {
	it.each([
		[false, false],
		[true, false],
		[true, true],
	])(
		"counts received dwells (stalled: %s, pause/resume: %s)",
		async (stalled, paused) => {
			let clock = 0
			const arbiter = new Arbiter()
			const record: JobRecord = {
				id: "j_park",
				name: null,
				passive: false,
				rawSpec: { sourceId: "rtl", mode: "sweep" },
				// Each parked dwell counts received 50 ms blocks, including after a stall
				spec: makeNormalisedSpec({
					sourceId: "rtl",
					dwellMs: stalled ? 1_000 : 200,
					stop: {
						afterSweeps: stalled ? 3 : null,
						afterMs: null,
						onFirstDecoded: false,
					},
				}),
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
				now: () => clock,
			})
			await runner.start()
			await flush()
			expect(arbiter.retunes).toEqual([
				{ centreHz: HOP, gainTenthsDb: 496, sampleRateHz: null },
			])
			runner.onEpochStarted(epoch)
			await flush()
			expect(record.state).toBe("running")
			const start = runner.progress().sweepIndex
			let sample = 0
			if (paused) {
				// A same-centre no-op explicitly resumes the parked visit without
				// an epoch-started event (R 1.2).
				for (let block = 0; block < 19; block++) {
					sample += BLOCK
					clock += 50
					runner.onBlock(sample, false)
					await flush()
				}
				expect(runner.progress().sweepIndex - start).toBe(0)
				await runner.dispatch({ type: "pause" })
				clock += 600_000
				sample += 600 * FS
				runner.tick(clock)
				expect(record.state).toBe("paused")
				await runner.dispatch({ type: "resume", takeover: false })
				await runner.idle()
				expect(record.state).toBe("running")
				expect(arbiter.retunes).toHaveLength(2)
			}
			const blocksPerDwell = stalled ? 20 : 4
			const dwells = stalled ? 3 : 10
			for (let block = 0; block < dwells * blocksPerDwell; block++) {
				if (stalled && !paused && block === 10) {
					clock += 10_000
					sample += 10 * FS
				}
				sample += BLOCK
				clock += 50
				runner.onBlock(sample, false)
				runner.tick(clock)
				await flush()
				if (stalled && block < dwells * blocksPerDwell - 1) {
					expect(record.state).toBe("running")
					expect(runner.progress().sweepIndex - start).toBe(
						Math.floor((block + 1) / blocksPerDwell),
					)
				}
			}
			await runner.idle()
			const p = runner.progress()
			expect(p.sweepIndex - start).toBe(dwells)
			expect(p.sweepPeriodMs).toBeNull()
			expect(p.hopCount).toBe(1)
			expect(p.coverage).toBe(1)
			expect(arbiter.retunes).toHaveLength(paused ? 2 : 1)
			expect(record.state).toBe(stalled ? "completed" : "running")
		},
	)
})
