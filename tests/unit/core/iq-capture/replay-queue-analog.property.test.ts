/** WG12 Property 12: replay order, the analog stop rule, one result and one discard. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	createIqReplayQueue,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayProbeAnswer,
	type IqReplayProbeRequest,
	type IqReplayProbes,
	type IqReplayQueuePort,
} from "../../../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
	IqReplayResult,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flush, spyLogger } from "./helpers.js"

const CAPTURE = "00000000-0000-4000-8000-000000000001"

class Port implements IqReplayQueuePort {
	view_: IqCaptureView | null = null
	holder: string | null = null
	discarded: [string, IqCaptureDiscardReason][] = []
	add(): void {
		this.view_ = {
			captureId: CAPTURE,
			sourceId: "s",
			observationId: "o",
			epoch: 1,
			rfHz: 1e8,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 1000,
			gapSamples: 0,
		}
		this.holder = null
	}
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
		this.discarded.push([id, "result"])
	}
	discard(id: string, reason: IqCaptureDiscardReason, holder?: string) {
		if (!this.view_ || id !== CAPTURE) return false
		if (this.holder !== null && this.holder !== holder) return false
		this.view_ = null
		this.holder = null
		this.discarded.push([id, reason])
		return true
	}
}

describe("replay queue analog stop", () => {
	// Feature: scanner-redesign, Property 12: Replay order and stop
	// Validates: Requirements 4.4, 4.6, 5.5
	// known first, ≤ 1 analog, digital by score; no digital after analog decoded/heard; ≤ 8 run;
	// exactly one result and one discard per capture. numRuns: 100
	it("stops digital trials after analog decoded or heard, one result and one discard", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					hasTrack: fc.boolean(),
					obwHz: fc.integer({ min: 2_000, max: 16_000 }),
					shape: fc.constantFrom("flat" as const, "peaked" as const),
					known: fc.oneof(
						fc.constant(null),
						fc.constantFrom("dmr" as const, "pocsag" as const, "aprs" as const),
					),
					analogPrior: fc.constantFrom(0, 0.25, 1),
					narrow: fc.boolean(),
					amBand: fc.boolean(),
					analogOutcome: fc.constantFrom(
						"decoded" as const,
						"heard" as const,
						"data-like" as const,
						"carrier-only" as const,
						"no-sync" as const,
					),
					digitalHit: fc.boolean(),
				}),
				async c => {
					const rfHz = c.amBand ? 120_000_000 : TARGET_HZ
					const plan = planReplayTrials({
						capture: {
							captureId: CAPTURE,
							sourceId: "s",
							observationId: "o",
							epoch: 1,
							rfHz,
							tuningTrust: "commanded",
							capturedAtMs: 0,
							durationMs: 2000,
							gapSamples: 0,
						},
						track: c.hasTrack
							? trackOf({
									obwHz: c.obwHz,
									spectralShape: c.shape,
									centreHz: rfHz,
								})
							: null,
						knownProtocol: c.known,
						priors: {
							"analog-fm": c.analogPrior,
							"analog-am": c.analogPrior,
							dmr: 1,
						},
						narrowRaster: c.narrow,
					})
					expect(plan.length).toBeLessThanOrEqual(8)
					const analogs = plan.filter(t => t.kind === "analog")
					expect(analogs.length).toBeLessThanOrEqual(1)
					if (c.analogPrior > 0) expect(analogs).toHaveLength(1)
					if (c.known !== null)
						expect(plan[0]).toMatchObject({ protocol: c.known, known: true })
					if (analogs.length === 1)
						expect(plan.indexOf(analogs[0]!)).toBe(
							plan.filter(t => t.known).length,
						)

					const analogIndex = plan.findIndex(t => t.kind === "analog")
					const requests: string[] = []
					let analogRuns = 0
					let hitUsed = false
					const probes: IqReplayProbes = {
						request(req: IqReplayProbeRequest) {
							requests.push(req.protocol)
							const after = analogIndex >= 0 && requests.length > analogIndex
							const decode = after && c.digitalHit && !hitUsed
							if (decode) hitUsed = true
							const answer: IqReplayProbeAnswer = decode
								? {
										outcome: "decoded",
										decoded: {
											protocol: req.protocol,
											identity: { kind: "dmr-cc", value: "1" },
										},
									}
								: { outcome: "no-sync", decoded: null }
							return {
								run: {
									result: Promise.resolve(answer),
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
						sink: r => {
							expect(port.holderOf(r.captureId)).toBe(IQ_REPLAY_QUEUE_HOLDER)
							results.push(r)
						},
						planInput: capture => ({
							capture,
							track: null,
							knownProtocol: null,
							priors: {},
							narrowRaster: false,
						}),
						logger: spyLogger().logger,
						analog: {
							run: (_id, mode) => {
								analogRuns++
								const positive =
									c.analogOutcome === "heard" || c.analogOutcome === "decoded"
								return Promise.resolve({
									outcome: c.analogOutcome,
									mode,
									voice: positive,
									tones: {
										ctcssHz: c.analogOutcome === "decoded" ? 88.5 : null,
										dcs: null,
										audioSeconds: 1,
									},
									stats:
										c.analogOutcome === "heard"
											? {
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
												}
											: null,
								})
							},
						},
					})
					q.start()
					port.add()
					q.enqueue(port.view(CAPTURE)!)
					await flush(8)
					expect(q.size()).toBe(0)
					expect(results).toHaveLength(1)
					expect(port.discarded).toEqual([[CAPTURE, "result"]])
					const result = results[0]!
					const stop =
						analogIndex >= 0 &&
						(c.analogOutcome === "decoded" || c.analogOutcome === "heard")
					expect(analogRuns).toBe(analogIndex >= 0 ? 1 : 0)
					expect(requests.length + analogRuns).toBeLessThanOrEqual(8)
					if (stop) {
						expect(requests).toEqual(
							plan.slice(0, analogIndex).map(t => t.protocol),
						)
						expect(
							result.trials.slice(analogIndex + 1).map(t => t.outcome),
						).toEqual(
							plan.slice(analogIndex + 1).map(() => "not-needed" as const),
						)
						expect(result.decoded).toBeNull()
						expect(result.analog?.outcome).toBe(c.analogOutcome)
					} else if (analogIndex >= 0) {
						expect(result.analog?.outcome).toBe(c.analogOutcome)
						const before = plan.slice(0, analogIndex).map(t => t.protocol)
						const after = plan.slice(analogIndex + 1).map(t => t.protocol)
						if (c.digitalHit && after.length > 0) {
							expect(requests).toEqual([...before, after[0]])
							expect(result.decoded?.protocol).toBe(after[0])
						} else {
							expect(requests).toEqual([...before, ...after])
							expect(result.decoded).toBeNull()
						}
					}
					await q.stop()
				},
			),
			{ numRuns: 100 },
		)
	})
})
