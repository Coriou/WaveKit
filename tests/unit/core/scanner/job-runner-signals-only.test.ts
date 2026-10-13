import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	JobRunner,
	type JobRecord,
} from "../../../../src/core/scanner/job-runner.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import type { Impact } from "../../../../src/core/scanner/types.js"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PendingEpoch,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import {
	classification,
	makeTrack,
} from "../../../mocks/scanner/observations.js"

const impact = (): Impact => ({
	liveAudioClients: 0,
	digitalVoiceListeners: 0,
	runningDecoders: [],
	pinnedDecoders: [],
	scannerJobs: [],
	unrestorable: [],
})

class RunnerArbiter {
	lease: Lease | null = null
	readonly retunes: {
		target: { centreHz: number }
		resolve: (p: PendingEpoch) => void
	}[] = []
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
	retune(_lease: Lease, target: { centreHz: number }): Promise<PendingEpoch> {
		return new Promise(resolve => this.retunes.push({ target, resolve }))
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

const HOP0 = 450_100_000
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function liveFor(track: TrackSnapshot): LiveObservation {
	return {
		observationId: `o-${track.trackId}`,
		sourceId: track.sourceId,
		trackId: track.trackId,
		epoch: track.epoch,
		jobIds: ["j_test"],
		discoveryId: null,
		startedAt: 0,
		classification: classification("unknown"),
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
}

function runnerFor(
	signalsOnly: boolean | undefined,
	policy: "hold" | "confirm" | "never",
	requested: string[],
	mode: "in-window" | "sweep" = "in-window",
) {
	const spec = makeNormalisedSpec({
		sourceId: "rtl",
		mode,
		hold: {
			policy,
			confirmHoldMs: { "tdma-ms": 1_800 },
			maxHoldMs: 60_000,
			hangMs: 2_000,
		},
	})
	if (signalsOnly !== undefined) spec.signalsOnly = signalsOnly
	const record: JobRecord = {
		id: "j_test",
		name: null,
		passive: false,
		rawSpec: { sourceId: "rtl", mode },
		spec,
		plan: makeHopPlan([HOP0, 452_000_000]),
		issues: [],
		impact: null,
		consentedImpact: null,
		state: "running",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	}
	const engine = {
		currentEpoch: () => ({
			stream: 0,
			epoch: 1,
			startSample: 0,
			centreHz: HOP0,
			sampleRateHz: 1_024_000,
			gainKey: "m:496",
			tuningTrust: "commanded" as const,
			settleMode: "none" as const,
		}),
		config: () => ({
			integrationMs: 50,
			sampleRateHz: 1_024_000,
			fftSize: 2048,
		}),
		stats: () => ({ observedSamples: 1 }),
		accounting: () => ({ stream: 0, liveEdge: 0 }),
		readRing: () => null,
		markerSupported: null,
	}
	const arbiter = new RunnerArbiter()
	const runner = new JobRunner({
		record,
		arbiter: arbiter as never,
		probes: {
			request: req => {
				requested.push(req.trackId)
				return { deferred: "budget" as const }
			},
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
		impact,
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
	})
	return { runner, record, arbiter }
}

function confirmRequests(
	signalsOnly: boolean | undefined,
	policy: "hold" | "confirm" | "never",
	needs: readonly boolean[],
): string[] {
	const requested: string[] = []
	const { runner } = runnerFor(signalsOnly, policy, requested)
	needs.forEach((needsConfirm, i) => {
		const track = makeTrack({
			id: String(i),
			centreHz: HOP0,
			startedAt: i,
		})
		runner.onTrack(liveFor(track), track, needsConfirm)
	})
	return requested
}

describe("signals-only jobs", () => {
	it("covers only enabled ranges and covers nothing when every range is disabled", () => {
		const { runner, record } = runnerFor(undefined, "hold", [])
		record.spec = makeNormalisedSpec({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [
				{ startHz: 100, endHz: 200, enabled: false },
				{ startHz: 300, endHz: 400 },
			],
		})
		record.state = "running"
		expect(runner.covers("rtl", 150)).toBe(false)
		expect(runner.covers("rtl", 350)).toBe(true)
		record.spec = {
			...record.spec,
			ranges: [{ startHz: 100, endHz: 200, enabled: false }],
			exclusions: [],
		}
		expect(runner.covers("rtl", 150)).toBe(false)
		record.spec = {
			...record.spec,
			ranges: [{ startHz: 100, endHz: 200 }],
			exclusions: [{ startHz: 100, endHz: 200 }],
		}
		expect(runner.covers("rtl", 150)).toBe(false)
		record.spec = { ...record.spec, ranges: [], exclusions: [] }
		expect(runner.covers("rtl", 150)).toBe(true)
	})

	it("does not hold a sweep or request a probe when the job is signals-only", async () => {
		const settings = testSettings()
		const block = 25 * 2048
		const spec = makeNormalisedSpec({ sourceId: "rtl" })
		const operator = Math.round(
			((spec.dwellMs - spec.settleMs) * 1_024_000) / 1000,
		)
		const floor = (settings.detection.minSurfaceBlocks + 1) * block
		const dwell = Math.max(floor, operator)
		const run = async (signalsOnly: boolean | undefined) => {
			const requested: string[] = []
			const { runner, arbiter, record } = runnerFor(
				signalsOnly,
				"hold",
				requested,
				"sweep",
			)
			record.state = "pending"
			await runner.start()
			await flush()
			const epoch: EngineEpoch = {
				stream: 0,
				epoch: 11,
				startSample: 10_000,
				centreHz: HOP0,
				sampleRateHz: 1_024_000,
				gainKey: "m:496",
				tuningTrust: "commanded",
				settleMode: "timer",
			}
			runner.onEpochStarted(epoch)
			await flush()
			const pending: PendingEpoch = {
				epoch: 11,
				commandSample: 0,
				bufferedSamples: 0,
				settleSamples: 0,
				expectMarker: false,
				markerTimeoutSamples: 0,
				pllSettleSamples: 0,
				centreHz: HOP0,
				sampleRateHz: 1_024_000,
				gainKey: "m:496",
				tuningTrust: "commanded",
				centreChanged: true,
			}
			arbiter.retunes[0]?.resolve(pending)
			await flush()
			await flush()
			const track = makeTrack({ id: "sweep", centreHz: HOP0, startedAt: 0 })
			runner.onTrack(liveFor(track), track, true)
			runner.onBlock(10_000 + dwell, false)
			await flush()
			await flush()
			return { requested: [...requested], retunes: arbiter.retunes.length }
		}
		const quiet = await run(true)
		const today = await run(undefined)
		expect(quiet.requested).toEqual([])
		expect(quiet.retunes).toBe(2)
		expect(today.requested).toEqual(["t-sweep"])
		expect(today.retunes).toBe(1)
	})

	// Feature: scanner-followups, Property 6: Signals only
	// Validates: Requirements 3.2, 3.3
	it("requests no probe for a signals-only track sequence and the same probes without the flag", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("hold" as const, "confirm" as const, "never" as const),
				fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
				(policy, needs) => {
					const today = needs.flatMap((confirm, i) =>
						confirm && policy !== "never" ? [`t-${i}`] : [],
					)
					expect(confirmRequests(true, policy, needs)).toEqual([])
					expect(confirmRequests(undefined, policy, needs)).toEqual(today)
					expect(confirmRequests(false, policy, needs)).toEqual(today)
				},
			),
			{ numRuns: 100 },
		)
	})
})
