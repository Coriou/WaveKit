/** Review majors 1 and 2: the memory-ordered plan, executed by the real replay queue. */
import { describe, expect, it } from "vitest"
import {
	createIqReplayQueue,
	type IqReplayProbeRequest,
	type IqReplayProbes,
	type IqReplayQueuePort,
} from "../../../../src/core/iq-capture/replay-queue.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import {
	narrowestPriors,
	withScannerOverlays,
} from "../../../../src/core/scanner/classify/priors.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
	IqReplayPlanInput,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import {
	TRIAL_BACKOFF_BASE_MS,
	type TrialMemoryEntry,
} from "../../../../src/core/scanner/trial-memory.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { flush, spyLogger } from "../iq-capture/helpers.js"

const CAPTURE = "00000000-0000-4000-8000-000000000001"
// Synthetic: a pager-range frequency and a land-mobile one outside it.
const PAGER_HZ = 466_100_000
const OTHER_HZ = 455_000_000
const EU = withScannerOverlays(bandplansFor("EU").flatMap(p => p.ranges))

const view = (rfHz: number, capturedAtMs: number): IqCaptureView => ({
	captureId: CAPTURE,
	sourceId: "s",
	observationId: "o",
	epoch: 1,
	rfHz,
	tuningTrust: "commanded",
	capturedAtMs,
	durationMs: 3000,
	gapSamples: 0,
})

class Port implements IqReplayQueuePort {
	view_: IqCaptureView | null = null
	holder: string | null = null
	discarded: [string, IqCaptureDiscardReason][] = []
	onFinished() {
		return () => {}
	}
	view(_id: string) {
		return this.view_
	}
	holderOf(_id: string) {
		return this.view_ ? this.holder : undefined
	}
	claim(id: string, holder: string) {
		if (!this.view_ || id !== CAPTURE || this.holder !== null) return false
		this.holder = holder
		return true
	}
	settle(id: string, holder: string) {
		if (!this.view_ || id !== CAPTURE || this.holder !== holder) return
		this.view_ = null
		this.holder = null
	}
	discard(id: string, reason: IqCaptureDiscardReason) {
		if (!this.view_ || id !== CAPTURE) return false
		this.view_ = null
		this.discarded.push([id, reason])
		return true
	}
}

/** Runs one capture through the real queue; analog always `heard`, digital always `no-sync`. */
async function execute(plan: readonly IqReplayTrial[], v: IqCaptureView) {
	const requests: string[] = []
	const probes: IqReplayProbes = {
		request(req: IqReplayProbeRequest) {
			requests.push(req.protocol)
			return {
				run: {
					result: Promise.resolve({ outcome: "no-sync", decoded: null }),
					cancel: () => {},
				},
			}
		},
		onSlotRelease: () => () => {},
	}
	const port = new Port()
	const results: IqReplayResult[] = []
	const q = createIqReplayQueue({
		port,
		probes,
		planner: () => plan,
		sink: r => results.push(r),
		planInput: capture => ({
			capture,
			track: null,
			knownProtocol: null,
			priors: {},
			narrowRaster: false,
		}),
		logger: spyLogger().logger,
		analog: {
			run: (_id, mode) =>
				Promise.resolve({
					outcome: "heard" as const,
					mode,
					voice: true,
					tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
					stats: {
						mode,
						frames: [
							{
								carrierDb: -20,
								hfNoiseDb: -40,
								audioDb: -12,
								syllabic: 0.4,
								cluster: 0.1,
							},
						],
						gapSamples: 0,
						floorDb: -90,
					},
				}),
		},
	})
	q.start()
	port.view_ = v
	q.enqueue(v)
	await flush(10)
	await q.stop()
	expect(results).toHaveLength(1)
	return { requests, result: results[0]! }
}

const entry = (over: Partial<TrialMemoryEntry>): TrialMemoryEntry => ({
	protocol: "pocsag",
	decoder: "multimon-ng",
	attempts: 1,
	decoded: 0,
	consecutiveFailures: 1,
	lastOutcome: "no-sync",
	lastAt: 0,
	...over,
})

function input(rfHz: number, over: Partial<IqReplayPlanInput>) {
	return {
		capture: view(rfHz, 0),
		track: makeTrack({
			id: "p",
			centreHz: rfHz,
			startedAt: 0,
			obwHz: 9000,
			blocks: 8,
		}),
		knownProtocol: null,
		priors: narrowestPriors(EU, rfHz),
		narrowRaster: true,
		...over,
	} satisfies IqReplayPlanInput
}

describe("memory order as the queue executes it", () => {
	it("major 1: a remembered analog heard never closes the pager trial in a paging range", async () => {
		// POCSAG no-sync, then analog heard; plan again after POCSAG's backoff expired.
		const memory = [
			entry({ lastAt: 0 }),
			entry({
				protocol: "analog-fm",
				decoder: "analog-demod",
				decoded: 1,
				consecutiveFailures: 0,
				lastOutcome: "heard",
				lastAt: 10,
				lastDecodedAt: 10,
			}),
		]
		for (const nowMs of [TRIAL_BACKOFF_BASE_MS + 10, 20]) {
			// also while POCSAG is still in backoff: pager trials are never cut
			const plan = planReplayTrials(
				input(PAGER_HZ, { trialMemory: memory, nowMs }),
			)
			const { requests, result } = await execute(plan, view(PAGER_HZ, nowMs))
			expect(requests[0]).toBe("pocsag")
			const pocsag = result.trials.find(t => t.protocol === "pocsag")
			expect(pocsag?.outcome).toBe("no-sync")
			expect(result.analog?.outcome).toBe("heard")
		}
	})

	it("major 2: a remembered POCSAG success runs before a known DMR, in and outside a paging range", async () => {
		const memory = [
			entry({
				decoded: 1,
				consecutiveFailures: 0,
				lastOutcome: "decoded",
				lastAt: 5,
				lastDecodedAt: 5,
			}),
		]
		for (const rfHz of [OTHER_HZ, PAGER_HZ]) {
			const plan = planReplayTrials(
				input(rfHz, {
					knownProtocol: "dmr",
					priors: { ...narrowestPriors(EU, rfHz), "analog-fm": 0 },
					trialMemory: memory,
					nowMs: 100,
				}),
			)
			// only a leading run of trials is flagged known (the queue partitions on it)
			const firstPlain = plan.findIndex(t => !t.known)
			expect(plan.slice(firstPlain).some(t => t.known)).toBe(false)
			const { requests } = await execute(plan, view(rfHz, 100))
			expect(requests[0]).toBe("pocsag")
			expect(requests.indexOf("dmr")).toBeGreaterThan(0)
		}
	})

	it("without memory the known trial still runs first", async () => {
		const plan = planReplayTrials(
			input(OTHER_HZ, {
				knownProtocol: "dmr",
				priors: { ...narrowestPriors(EU, OTHER_HZ), "analog-fm": 0 },
			}),
		)
		expect(plan[0]).toMatchObject({ protocol: "dmr", known: true })
		const { requests } = await execute(plan, view(OTHER_HZ, 0))
		expect(requests[0]).toBe("dmr")
	})
})
