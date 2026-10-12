import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	JobRunner,
	chooseLeaseHolder,
	impactGrew,
	undecodedForDeferral,
	undecodedForProbe,
	type JobRecord,
	type ProbeOutcome,
} from "../../../../src/core/scanner/job-runner.js"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import type { Impact } from "../../../../src/core/scanner/types.js"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PendingEpoch } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
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

function runnerHarness(autoResumeReady?: () => boolean) {
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
	})
	return { runner, arbiter, record, engineCfg }
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
