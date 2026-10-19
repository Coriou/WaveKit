import { Writable } from "node:stream"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { ScanJobProgress } from "@wavekit/api-types"
import {
	JobRunner,
	chooseLeaseHolder,
	impactGrew,
	undecodedForDeferral,
	undecodedForProbe,
	type JobRecord,
	type JobRunnerDeps,
	type LiveObservation,
	type ProbeOutcome,
} from "../../../../src/core/scanner/job-runner.js"
import type { ProbeStatus } from "../../../../src/core/scanner/probes/probe-pool.js"
import type { JobActivityView } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import type { Impact } from "../../../../src/core/scanner/types.js"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PendingEpoch } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const impact = (over: Partial<Impact> = {}): Impact => ({
	liveAudioClients: 0,
	digitalVoiceListeners: 0,
	runningDecoders: [],
	pinnedDecoders: [],
	scannerJobs: [],
	unrestorable: [],
	...over,
})

describe("chooseLeaseHolder", () => {
	// Feature: signal-discovery-scanner, Property 16: Priority
	// Validates: spec § 10.2
	it("picks the highest priority, earliest on ties, and only from the candidates", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(
					fc.record({
						jobId: fc.string({ minLength: 1, maxLength: 6 }),
						priority: fc.integer({ min: 0, max: 100 }),
						createdAt: fc.nat(1000),
					}),
					{ selector: c => c.jobId, maxLength: 12 },
				),
				cands => {
					const chosen = chooseLeaseHolder(cands)
					if (cands.length === 0) {
						expect(chosen).toBeNull()
						return
					}
					const c = cands.find(x => x.jobId === chosen)!
					expect(c).toBeDefined()
					for (const o of cands) {
						expect(o.priority).toBeLessThanOrEqual(c.priority)
						if (o.priority === c.priority)
							expect(o.createdAt).toBeGreaterThanOrEqual(c.createdAt)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("impactGrew", () => {
	it("is false for a subset of the consented impact and true for anything new", () => {
		const consented = impact({
			liveAudioClients: 1,
			runningDecoders: ["dmr"],
			scannerJobs: ["a"],
		})
		expect(impactGrew(impact({ runningDecoders: ["dmr"] }), consented)).toBe(
			false,
		)
		expect(impactGrew(impact({ liveAudioClients: 2 }), consented)).toBe(true)
		expect(impactGrew(impact({ pinnedDecoders: ["pager"] }), consented)).toBe(
			true,
		)
		expect(impactGrew(impact({ unrestorable: ["gain"] }), consented)).toBe(true)
		expect(impactGrew(impact(), null)).toBe(false)
		expect(impactGrew(impact({ digitalVoiceListeners: 1 }), null)).toBe(true)
	})
})

describe("undecoded reasons (H3)", () => {
	it("maps probe deferrals to undecodedReason and ignores stale requests", () => {
		expect(undecodedForDeferral("budget")).toBe("budget")
		expect(undecodedForDeferral("max-probes")).toBe("budget")
		expect(undecodedForDeferral("cpu")).toBe("budget")
		expect(undecodedForDeferral("no-transport")).toBe("no-probe-transport")
		expect(undecodedForDeferral("format")).toBe("unsupported-format")
		expect(undecodedForDeferral("stale-epoch")).toBeNull()
	})

	it("classifies a probe that used its hold without accepted evidence", () => {
		const o = (over: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
			startedAt: 0,
			holdMs: 1000,
			output: false,
			crcFailures: 0,
			confirmed: false,
			...over,
		})
		expect(undecodedForProbe(o(), 1000)).toBe("no-sync")
		expect(undecodedForProbe(o({ output: true }), 1000)).toBe("timeout")
		expect(undecodedForProbe(o({ output: true, crcFailures: 2 }), 1000)).toBe(
			"crc-errors",
		)
		expect(
			undecodedForProbe(o({ output: true, confirmed: true }), 1000),
		).toBeNull()
		// released early (track closed, epoch change, preemption): not a decode failure
		expect(undecodedForProbe(o(), 500)).toBeNull()
	})
})

// ---- JobRunner with fakes: own-epoch recognition (D1) and the rate-change hop re-send ----

class RunnerArbiter {
	lease: Lease | null = null
	/** The next acquire is refused with this detail. */
	refuse: string | null = null
	/** Sent with the refusal (the arbiter names the lease holder). */
	refuseHolder: string | null = null
	readonly retunes: {
		target: { centreHz: number }
		resolve: (p: PendingEpoch) => void
	}[] = []
	acquire(jobId: string, sourceId: string) {
		if (this.refuse !== null)
			return {
				ok: false as const,
				code: "SCANNER_SOURCE_BUSY" as const,
				detail: this.refuse,
				...(this.refuseHolder !== null
					? { holderJobId: this.refuseHolder }
					: {}),
			}
		this.lease = {
			sourceId,
			jobId,
			acquiredAt: 0,
			snapshot: {},
			changedFields: new Set(),
		}
		return { ok: true as const, lease: this.lease }
	}
	/** Deferred: the test decides when the arbiter's writes finish. */
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
	/** The other job named by `refuseHolder` holds at an equal priority: the acquire is refused. */
	holderPriority() {
		return this.lease || this.refuseHolder !== null ? 50 : undefined
	}
	operatorIdleSince() {
		return null
	}
}

const HOP0 = 450_100_000
const epochAt = (
	epoch: number,
	centreHz: number,
	over: Partial<EngineEpoch> = {},
): EngineEpoch => ({
	stream: 0,
	epoch,
	startSample: 10_000,
	centreHz,
	sampleRateHz: 1_024_000,
	gainKey: "m:496",
	tuningTrust: "commanded",
	settleMode: "timer",
	...over,
})
const pendingFor = (epoch: number, centreHz: number): PendingEpoch => ({
	epoch,
	commandSample: 0,
	bufferedSamples: 0,
	settleSamples: 0,
	expectMarker: false,
	markerTimeoutSamples: 0,
	pllSettleSamples: 0,
	centreHz,
	sampleRateHz: 1_024_000,
	gainKey: "m:496",
	tuningTrust: "commanded",
	centreChanged: true,
})
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function runnerHarness(
	autoResumeReady?: () => boolean,
	extra?: Partial<JobRunnerDeps>,
) {
	const arbiter = new RunnerArbiter()
	const record: JobRecord = {
		id: "j_test",
		name: null,
		passive: false,
		rawSpec: { sourceId: "rtl", mode: "sweep" },
		spec: makeNormalisedSpec({ sourceId: "rtl" }),
		plan: makeHopPlan([HOP0, 452_000_000]),
		issues: [],
		impact: null,
		consentedImpact: null,
		state: "pending",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	}
	const engineCfg = {
		integrationMs: 50,
		sampleRateHz: 1_024_000,
		fftSize: 2048,
	}
	const engine = {
		currentEpoch: () => epochAt(0, 446_100_000, { settleMode: "none" }),
		config: () => ({ ...engineCfg }),
		stats: () => ({ observedSamples: 1 }),
	}
	const runner = new JobRunner({
		record,
		...(autoResumeReady ? { autoResumeReady } : {}),
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
		impact: () => impact(),
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
		...extra,
	})
	return { runner, arbiter, record, engineCfg }
}

/** Unstarted harness progress at the commit this field set was added. Coverage is NaN: the fake reports observed samples and no settled samples. */
const BASE_PROGRESS: ScanJobProgress = {
	sweepIndex: 0,
	hopIndex: 0,
	hopCount: 2,
	sweepPeriodMs: null,
	coverage: Number.NaN,
	holdingOn: null,
	settleMode: "none",
	probes: [],
	counts: {
		observations: 0,
		transients: 0,
		discoveries: { activity: 0, candidate: 0, classified: 0, decoded: 0 },
	},
}

const quietActivity = (): JobActivityView => ({
	capturing: 0,
	replaying: null,
	replayQueueDepth: 0,
})

function captureLogger(): { logger: pino.Logger; text: () => string } {
	const chunks: string[] = []
	const logger = pino(
		{ level: "warn" },
		new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk))
				cb()
			},
		}),
	)
	return { logger, text: () => chunks.join("") }
}

function liveProbe(over: Partial<ProbeStatus> = {}): ProbeStatus {
	return {
		probeId: "p1",
		decoderId: "dec-1",
		jobId: "j_test",
		sourceId: "rtl",
		trackId: "t1",
		observationId: "o1",
		discoveryId: "d1",
		targetHz: 450_100_000,
		epoch: 1,
		protocol: "dmr",
		decoderType: "dsd-fme",
		transport: "offset",
		state: "confirming",
		startedAt: 10,
		cores: 0.2,
		...over,
	}
}

describe("JobRunner own epochs", () => {
	it("claims a commanded epoch at the hop centre that starts while its retune is in flight", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		expect(arbiter.retunes).toHaveLength(1)
		expect(arbiter.retunes[0]!.target.centreHz).toBe(HOP0)
		// the engine starts the hop's epoch before retune() resolves (inline host, timer settle)
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		expect(record.state).toBe("running")
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await runner.idle()
	})

	it("does not claim it once the lease was revoked (REST write) while the retune was in flight", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		expect(arbiter.retunes).toHaveLength(1)
		// the arbiter revokes the lease synchronously on an operator write
		arbiter.lease = null
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		expect(record.state).toBe("starting")
	})

	it("re-sends the hop when a rate-change restart dropped the hop's epoch (a stream it did not start)", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		// the rate write restarted the stream: the hop's pending epoch 11 never starts
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		expect(record.state).toBe("starting")
		// the restarted stream opens after retune() resolved (worker), at the new centre a
		// caps-updating controller reports
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 1, startSample: 0, settleMode: "none" }),
		)
		await flush()
		expect(arbiter.retunes).toHaveLength(2)
		expect(arbiter.retunes[1]!.target.centreHz).toBe(HOP0)
		expect(record.state).toBe("starting")
		// the rate now matches: the re-sent hop gets a normal pending epoch, which is the job's own
		arbiter.retunes[1]!.resolve(pendingFor(12, HOP0))
		await flush()
		runner.onEpochStarted(epochAt(12, HOP0, { stream: 1 }))
		await flush()
		expect(record.state).toBe("running")
		await runner.idle()
	})

	it("re-sends at most once until an own epoch starts (R1)", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 1, startSample: 0, settleMode: "none" }),
		)
		await flush()
		expect(arbiter.retunes).toHaveLength(2)
		// the re-sent hop's epoch is dropped again (the caps never follow the rate): no loop
		arbiter.retunes[1]!.resolve(pendingFor(12, HOP0))
		await flush()
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 2, startSample: 0, settleMode: "none" }),
		)
		runner.onEpochStarted(
			epochAt(2, HOP0, { stream: 2, startSample: 0, settleMode: "none" }),
		)
		await flush()
		expect(arbiter.retunes).toHaveLength(2)
		expect(record.state).toBe("starting")
	})

	it("re-sends again after an own epoch started in between", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 1, startSample: 0, settleMode: "none" }),
		)
		await flush()
		arbiter.retunes[1]!.resolve(pendingFor(12, HOP0))
		await flush()
		runner.onEpochStarted(epochAt(12, HOP0, { stream: 1 }))
		await flush()
		expect(record.state).toBe("running")
		// a later reconnect boundary: a new foreign stream re-sends the hop once more
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 2, startSample: 0, settleMode: "none" }),
		)
		await flush()
		expect(arbiter.retunes).toHaveLength(3)
		arbiter.retunes[2]!.resolve(pendingFor(13, HOP0))
		await runner.idle()
	})

	it("never claims a new stream's opening epoch during an in-flight retune: it re-sends (R2)", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		expect(arbiter.retunes).toHaveLength(1)
		// inline host: the rate restart's opening epoch arrives while the retune is still in flight
		runner.onEpochStarted(
			epochAt(1, HOP0, { stream: 1, startSample: 0, settleMode: "none" }),
		)
		await flush()
		expect(record.state).toBe("starting")
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		// the re-send waited for the in-flight retune, and its epoch is settled normally
		expect(arbiter.retunes).toHaveLength(2)
		arbiter.retunes[1]!.resolve(pendingFor(12, HOP0))
		await flush()
		runner.onEpochStarted(epochAt(12, HOP0, { stream: 1 }))
		await flush()
		expect(record.state).toBe("running")
		await runner.idle()
	})
})

describe("JobRunner block geometry (S1-B final review, finding 2)", () => {
	it("sizes the dwell with the engine's current block on the next own epoch after a reconfigure", async () => {
		const { runner, arbiter, engineCfg } = runnerHarness()
		const blocks = (): number =>
			(
				runner as unknown as {
					scheduler: { blockGeometry(): { blockSamples: number } }
				}
			).scheduler.blockGeometry().blockSamples
		await runner.start()
		await flush()
		runner.onEpochStarted(epochAt(11, HOP0))
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		expect(blocks()).toBe(25 * 2048)
		// Another holder's (or the defaults') integration: the engine blocks 100 ms from now on.
		engineCfg.integrationMs = 100
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		expect(blocks()).toBe(50 * 2048)
		await runner.dispose()
	})
})

describe("JobRunner resume of an operator pause without its lease (R4)", () => {
	async function pausedWithoutLease() {
		const h = runnerHarness()
		await h.runner.start()
		await flush()
		h.runner.onEpochStarted(epochAt(11, HOP0))
		h.arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await flush()
		await h.runner.dispatch({ type: "pause" })
		const lease = h.arbiter.lease!
		h.arbiter.lease = null
		await h.runner.leaseLost(lease, "preempted-operator")
		expect(h.record).toMatchObject({ state: "paused", reason: "operator" })
		return h
	}

	it("stays paused(operator) with a plain 409 on a transient refusal", async () => {
		for (const detail of [
			"releasing",
			"recovery pending",
			"holder is starting",
		]) {
			const { runner, arbiter, record } = await pausedWithoutLease()
			arbiter.refuse = detail
			await expect(
				runner.dispatch({ type: "resume", takeover: false }),
			).rejects.toMatchObject({ statusCode: 409, code: "SCANNER_SOURCE_BUSY" })
			expect(record).toMatchObject({ state: "paused", reason: "operator" })
		}
	})

	it("goes to paused(resume-blocked) when another job holds the lease", async () => {
		const { runner, arbiter, record } = await pausedWithoutLease()
		arbiter.refuse = "Lease held by scanner job j_other"
		arbiter.refuseHolder = "j_other"
		await expect(
			runner.dispatch({ type: "resume", takeover: false }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			details: { holderJobId: "j_other" },
		})
		expect(record).toMatchObject({ state: "paused", reason: "resume-blocked" })
	})
})

describe("JobRunner startup deadline (review F2)", () => {
	it("fails at the cap, releases ownership, and ignores a late own epoch", async () => {
		const { runner, arbiter, record } = runnerHarness()
		await runner.start()
		await flush()
		arbiter.retunes[0]!.resolve(pendingFor(11, HOP0))
		await runner.idle()
		runner.tick(14_999)
		await runner.idle()
		expect(record.state).toBe("starting")
		// Readiness was queued just before the deadline: it must not defeat the expired admission.
		runner.onEpochStarted(epochAt(11, HOP0))
		runner.tick(15_000)
		await flush()
		await runner.idle()
		expect(record).toMatchObject({
			state: "failed",
			reason: "tuner-unavailable",
		})
		expect(arbiter.lease).toBeNull()
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		expect(record.state).toBe("failed")
	})
})

describe("automatic resume reentry", () => {
	it("hands back a job lease even while operator activity holds automatic resume", async () => {
		const h = runnerHarness(() => false)
		h.record.state = "paused"
		h.record.reason = "preempted-job"
		await h.runner.dispatch({ type: "preemptor-idle", impactGrew: false })
		expect(h.record.state).toBe("running")
		expect(h.arbiter.holder()).toBeDefined()
	})
	it("a queued idle event cannot acquire after activity starts", async () => {
		let quiet = true
		const h = runnerHarness(() => quiet)
		h.record.state = "paused"
		h.record.reason = "preempted-operator"
		const queued = h.runner.dispatch({
			type: "preemptor-idle",
			impactGrew: false,
		})
		quiet = false
		await queued
		expect(h.record.state).toBe("paused")
		expect(h.arbiter.holder()).toBeUndefined()
		expect(h.arbiter.retunes).toHaveLength(0)
	})
})

describe("job progress phase", () => {
	it("No activity dep → progress deep-equal to base", () => {
		const { runner, record } = runnerHarness()
		expect(runner.progress()).toEqual(BASE_PROGRESS)
		record.spec.mode = "in-window"
		expect(runner.progress()).toEqual(BASE_PROGRESS)
		expect(runner.progress()).not.toHaveProperty("phase")
		expect(runner.progress()).not.toHaveProperty("parked")
		expect(runner.progress()).not.toHaveProperty("holding")
		expect(runner.progress()).not.toHaveProperty("trial")
		expect(runner.progress()).not.toHaveProperty("replayQueueDepth")
	})

	it("In-window job → parked true", () => {
		const { runner, record } = runnerHarness(undefined, {
			activity: quietActivity,
		})
		record.spec.mode = "in-window"
		const progress = runner.progress()
		expect(progress.parked).toBe(true)
		expect(progress.phase).toBe("watching")
		expect(progress.holding).toBeUndefined()
		expect(progress.trial).toBeUndefined()
		expect(progress.replayQueueDepth).toBe(0)
		expect(progress.sweepPeriodMs).toBeNull()
	})

	it("a sweep is settling until its own epoch, then watching", async () => {
		const { runner } = runnerHarness(undefined, { activity: quietActivity })
		await runner.start()
		await flush()
		expect(runner.progress()).toMatchObject({
			phase: "settling",
			parked: false,
		})
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		expect(runner.progress().phase).toBe("watching")
		expect(runner.progress().parked).toBe(false)
	})

	it("throwing activity", () => {
		const logs = captureLogger()
		let next: () => unknown = () => {
			throw new Error("tune 446.100 secret payload")
		}
		const { runner, record } = runnerHarness(undefined, {
			logger: logs.logger,
			activity: () => next() as JobActivityView,
		})
		record.spec.mode = "in-window"
		expect(() => runner.progress()).not.toThrow()
		expect(runner.progress()).toMatchObject({
			phase: "watching",
			parked: true,
			replayQueueDepth: 0,
		})
		expect(runner.progress().trial).toBeUndefined()
		const logged = logs.text()
		expect(logged).toContain("Scan job activity view failed")
		expect(logged).not.toContain("446.100")
		expect(logged).not.toContain("secret")
		const once = logs.text()
		runner.progress()
		expect(logs.text()).toBe(once)

		next = () => ({
			capturing: 1,
			replaying: {
				protocol: "dmr",
				decoder: "446.100 secret",
				discoveryId: null,
			},
			replayQueueDepth: -5,
		})
		expect(runner.progress().phase).toBe("watching")
		expect(logs.text()).toBe(once)
		expect(logs.text()).not.toContain("secret")

		next = () => ({ capturing: 2, replaying: null, replayQueueDepth: 3 })
		expect(runner.progress()).toMatchObject({
			phase: "capturing",
			replayQueueDepth: 3,
		})
		expect(logs.text()).toBe(once)

		const malformed = captureLogger()
		const bad = runnerHarness(undefined, {
			logger: malformed.logger,
			activity: () =>
				({
					capturing: Number.NaN,
					replaying: { decoder: "446.100 secret payload" },
					replayQueueDepth: 1,
				}) as JobActivityView,
		})
		expect(() => bad.runner.progress()).not.toThrow()
		expect(bad.runner.progress()).toMatchObject({
			phase: "watching",
			replayQueueDepth: 0,
		})
		const line = malformed.text()
		expect(line).toContain("Scan job activity view failed")
		expect(line).toContain("SCANNER_ACTIVITY_VIEW")
		expect(line).not.toContain("446.100")
		expect(line).not.toContain("secret")
		expect(line).not.toContain("payload")
		bad.runner.progress()
		expect(malformed.text()).toBe(line)
	})

	it("an in-window live probe stays trialing when activity throws", () => {
		const logs = captureLogger()
		const { runner, record } = runnerHarness(undefined, {
			logger: logs.logger,
			activity: () => {
				throw new Error("446.100 secret")
			},
			probes: {
				request: () => ({ deferred: "budget" as const }),
				release: () => Promise.resolve(),
				releaseJob: () => Promise.resolve(),
				follow: () => undefined,
				status: () => [
					liveProbe({ probeId: "later", startedAt: 50, protocol: "aprs" }),
					liveProbe(),
					liveProbe({ probeId: "replay", transport: "replay", startedAt: 1 }),
				],
				startLatencyMs: () => 400,
			},
		})
		record.spec.mode = "in-window"
		const progress = runner.progress()
		expect(progress.phase).toBe("trialing")
		expect(progress.parked).toBe(true)
		expect(progress.holding).toEqual({
			discoveryId: "d1",
			frequencyHz: 450_100_000,
			trackId: "t1",
		})
		expect(progress.trial).toEqual({
			protocol: "dmr",
			decoder: "dsd-fme",
			transport: "offset",
			discoveryId: "d1",
		})
		expect(progress.replayQueueDepth).toBe(0)
		expect(logs.text()).not.toContain("446.100")
		expect(logs.text()).not.toContain("secret")
	})

	it("a hold whose track and probe are gone does not publish 0 Hz", async () => {
		const probes: ProbeStatus[] = []
		const { runner } = runnerHarness(undefined, {
			activity: quietActivity,
			probes: {
				request: () => ({ deferred: "budget" as const }),
				release: () => Promise.resolve(),
				releaseJob: () => Promise.resolve(),
				follow: () => undefined,
				status: () => probes,
				startLatencyMs: () => 400,
			},
		})
		await runner.start()
		await flush()
		runner.onEpochStarted(epochAt(11, HOP0))
		await flush()
		const track = trackOf({
			trackId: "t-hold",
			sourceId: "rtl",
			centreHz: 450_125_000,
		})
		const live: LiveObservation = {
			observationId: "o-hold",
			sourceId: "rtl",
			trackId: track.trackId,
			epoch: track.epoch,
			jobIds: ["j_test"],
			discoveryId: "d-hold",
			startedAt: 0,
			classification: {
				class: "tdma-ms",
				hypotheses: [],
				tier: "spectral",
			},
			probeIds: new Set(),
			lastActivityAt: 0,
			lastIngestAt: 0,
			lastTrack: track,
			decoded: false,
			encrypted: false,
		}
		runner.onTrack(live, track, true)
		runner.onBlock(10_000_000, false)
		await flush()
		expect(runner.progress()).toMatchObject({
			phase: "holding",
			holding: {
				discoveryId: "d-hold",
				frequencyHz: 450_125_000,
				trackId: "t-hold",
			},
		})
		runner.onTrackClosed(track.trackId)
		probes.push(
			liveProbe({
				trackId: track.trackId,
				targetHz: 450_118_750,
				discoveryId: "d-probe",
			}),
		)
		expect(runner.progress().holding).toEqual({
			discoveryId: "d-probe",
			frequencyHz: 450_118_750,
			trackId: "t-hold",
		})
		probes.length = 0
		const gone = runner.progress()
		expect(gone.phase).toBe("watching")
		expect(gone.holding).toBeUndefined()
	})
})
