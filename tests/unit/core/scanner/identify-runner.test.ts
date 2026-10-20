import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ArtefactKind } from "../../../../src/core/spectrum/artefacts.js"
import {
	FLAGS,
	TARGET_HZ,
	identifyHarness,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	flushAsync,
	linkLine,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

type Harness = ReturnType<typeof identifyHarness>
const ENDED = ["completed", "cancelled", "failed"]
const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })

async function settle(
	h: Harness,
	stepMs: number,
	steps: number,
): Promise<void> {
	for (let i = 0; i < steps && !ENDED.includes(h.record.state); i++)
		await h.advance(stepMs)
}

/** Records `<type>:<options.mode>` of every probe decoder in creation order. */
function decoderOrder(h: Harness): string[] {
	const order: string[] = []
	h.decoders.on("decoder:created", (id: string) => {
		const c = h.decoders.created.get(id)!.config
		order.push(`${c.type}:${String(c.options["mode"] ?? "")}`)
	})
	return order
}

function emitDmrIdentity(h: Harness, probeId: string): void {
	h.decoders.emitLink(probeId, linkLine(1, h.clock.now))
	h.decoders.emitLink(probeId, linkLine(1, h.clock.now + 30))
}

const outcomes = (h: Harness) =>
	Object.fromEntries((h.last()?.trials ?? []).map(t => [t.protocol, t.outcome]))

describe("IdentifyRunner (spec § 10.8)", () => {
	it("decodes a DMR handheld with one pre-roll offset probe and stops at the first accepted identity", async () => {
		const h = identifyHarness()
		h.engine.push(1_100_000)
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100) // no artefact at the target
		await h.advance(100) // resolved, planned, first run requested
		await flushAsync()
		const [probe] = [...h.decoders.created.values()]
		expect(probe?.config).toMatchObject({
			type: "dsd-fme",
			options: { mode: "auto", offsetHz: 25_000 },
		})
		// § 6.5 pre-roll: from the track start − 300 ms (614 400 samples at 2.048 Msps) up to the live edge
		expect(probe?.bytesIn).toBe((1_100_000 - (1_000_000 - 614_400)) * 2)
		emitDmrIdentity(h, probe!.id)
		await settle(h, 100, 5)
		const last = h.last()!
		expect(last.state).toBe("identified")
		expect(last.result).toMatchObject({
			protocol: "dmr",
			identity: { kind: "dmr-cc", value: "1" },
			observationId: "o_t1",
			measurements: {
				source: "track",
				centreHz: TARGET_HZ,
				obwHz: 9000,
				class: "tdma-ms",
			},
		})
		expect(last.trials[0]).toMatchObject({
			protocol: "dmr",
			decoder: "dsd-fme",
			mode: "auto",
			transport: "offset",
			outcome: "decoded",
		})
		expect(outcomes(h)).toMatchObject({
			dstar: "not-needed",
			ysf: "not-needed",
			aprs: "not-needed",
			nxdn96: "not-needed",
			"analog-fm": "unsupported",
		})
		expect(h.decoders.created.size).toBe(0)
		expect(h.record.state).toBe("completed")
	})

	it("tries every plausible decoder in score order, one offset probe at a time, each for its hold", async () => {
		const h = identifyHarness()
		const order = decoderOrder(h)
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
		await settle(h, 1000, 40)
		expect(order).toEqual([
			"multimon-ng:",
			"direwolf:",
			"dsd-fme:auto",
			"dsd-fme:nxdn",
		])
		expect(h.last()).toMatchObject({
			state: "unidentified",
			result: { confidence: "activity" },
		})
		expect(h.last()?.result).not.toHaveProperty("protocol")
		expect(h.last()?.result).toMatchObject({
			proof: { kind: "digital-undecoded" },
		})
		expect(outcomes(h)).toEqual({
			pocsag: "no-sync",
			flex: "no-sync",
			aprs: "no-sync",
			"analog-fm": "unsupported",
			dmr: "no-sync",
			ysf: "no-sync",
			p25p1: "no-sync",
			nxdn96: "no-sync",
		})
		expect(h.record.state).toBe("completed")
	})

	it("preempts a passive probe at once (identify priority) instead of waiting for it", async () => {
		const h = identifyHarness()
		const passive = h.pool.request(
			probeRequest({
				jobId: "passive-rtl",
				priority: 0,
				trackId: "t9",
				targetHz: 446_150_000,
			}),
		)
		await flushAsync()
		expect("started" in passive).toBe(true)
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		await h.advance(10)
		expect(h.pool.status().map(p => p.jobId)).toEqual(["j_ident"])
		expect(h.last()!.trials[0]).toMatchObject({
			protocol: "dmr",
			outcome: "running",
		})
	})

	it("answers an artefact target without a trial and measures it from the spectrum", async () => {
		const h = identifyHarness({ artefact: "spur" })
		await h.runner.start()
		h.tracks.push(viewOf(trackOf()))
		await settle(h, 100, 5)
		expect(h.last()).toMatchObject({
			state: "unidentified",
			trials: [],
			result: {
				artefact: "spur",
				confidence: "activity",
				measurements: {
					source: "spectrum",
					centreHz: TARGET_HZ,
					peakDbfs: -50,
					snrDb: 30,
					floorDbfs: -80,
				},
			},
		})
		expect(h.decoders.created.size + h.decoders.removed.length).toBe(0)
		expect(h.record.state).toBe("completed")
	})

	it("reports an IQ image or a spur-flagged track as that artefact", async () => {
		for (const [flags, artefact] of [
			[{ ...FLAGS, iqImage: true }, "image"],
			[{ ...FLAGS, spur: true }, "spur"],
		] as const) {
			const h = identifyHarness()
			await h.runner.start()
			h.tracks.push(viewOf(trackOf({ flags })))
			await settle(h, 100, 5)
			expect(h.last()).toMatchObject({
				state: "unidentified",
				trials: [],
				result: { artefact, measurements: { source: "track" } },
			})
			expect(h.decoders.created.size + h.decoders.removed.length).toBe(0)
		}
	})

	it("waits for the signal, then reports rfi or nothing with spectrum measurements", async () => {
		const quiet = identifyHarness()
		await quiet.runner.start()
		await settle(quiet, 1000, 20)
		expect(quiet.last()).toMatchObject({
			state: "unidentified",
			trials: [],
			result: {
				confidence: "activity",
				measurements: { source: "spectrum", peakDbfs: -50 },
			},
		})
		expect(quiet.last()!.result!.artefact).toBeUndefined()
		// rfi is evidence of absence (Task 7a): no short-circuit at start, the answer once the wait found nothing
		const rfi = identifyHarness({ artefact: "rfi" })
		await rfi.runner.start()
		await rfi.advance(1000)
		expect(rfi.last()?.state).toBe("waiting-for-signal")
		await settle(rfi, 1000, 20)
		expect(rfi.last()).toMatchObject({
			state: "unidentified",
			result: { artefact: "rfi" },
		})
	})

	it("keeps trying after a decode when exhaustive", async () => {
		const h = identifyHarness({ request: { exhaustive: true } })
		const order = decoderOrder(h)
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		emitDmrIdentity(h, [...h.decoders.created.keys()][0]!)
		await settle(h, 1000, 30)
		expect(order).toEqual([
			"dsd-fme:auto",
			"direwolf:",
			"multimon-ng:",
			"dsd-fme:nxdn",
		])
		expect(h.last()?.state).toBe("identified")
		expect(outcomes(h)).toEqual({
			dmr: "decoded",
			aprs: "no-sync",
			"analog-fm": "unsupported",
			dstar: "no-sync",
			pocsag: "no-sync",
			ysf: "no-sync",
			flex: "no-sync",
			p25p1: "no-sync",
			nxdn96: "no-sync",
		})
	})

	it("[S2] runs trials in parallel within maxProbes.channel once the channelizer serves probes", async () => {
		const h = identifyHarness({
			channelizer: true,
			patch: s => {
				s.maxProbes.offset = 3
				s.maxProbes.channel = 3
				s.cpuBudgetCores = 4
			},
		})
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		const running = [...h.decoders.created.values()]
		expect(running.map(d => d.config.type).sort()).toEqual([
			"direwolf",
			"dsd-fme",
			"multimon-ng",
		])
		emitDmrIdentity(h, running.find(d => d.config.type === "dsd-fme")!.id)
		await settle(h, 100, 5)
		expect(h.last()?.state).toBe("identified")
		expect(outcomes(h)).toMatchObject({
			dmr: "decoded",
			aprs: "not-needed",
			pocsag: "not-needed",
			flex: "not-needed",
			nxdn96: "not-needed",
		})
		expect(h.decoders.created.size).toBe(0)
	})

	it("still tries decoders on a transmission that keys up just before the timeout", async () => {
		const h = identifyHarness({ request: { timeoutMs: 2000 } })
		await h.runner.start()
		await settle(h, 100, 19) // 1.9 s of nothing
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99, blocks: 2 })))
		await h.advance(100)
		await h.advance(100) // past the deadline with a young (2-block) track: it waits to settle instead of giving up
		expect(h.last()?.state).toBe("waiting-for-signal")
		h.tracks[0] = viewOf(trackOf({ acf30: -0.94, acf60: 0.99, blocks: 8 }))
		await h.advance(100)
		await flushAsync()
		expect(h.last()?.state).toBe("trying")
		expect([...h.decoders.created.values()][0]?.config).toMatchObject({
			type: "dsd-fme",
			options: { mode: "auto" },
		})
	})

	it("starts identify under the CPU guard by immediately preempting a passive probe", async () => {
		const h = identifyHarness({
			patch: s => {
				s.cpuBudgetCores = 4
			},
		})
		const passive = h.pool.request(
			probeRequest({
				jobId: "passive-rtl",
				priority: 0,
				trackId: "t9",
				targetHz: 446_150_000,
			}),
		)
		await flushAsync()
		expect("started" in passive).toBe(true)
		h.cpu.normalisedPercent = 95
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		expect(h.pool.status().some(p => p.jobId === "passive-rtl")).toBe(false)
		expect(h.last()!.trials[0]).toMatchObject({
			protocol: "dmr",
			outcome: "running",
		})
	})

	it("asks for the masks again while the worker's are an epoch behind, then answers the artefact at once", async () => {
		const h = identifyHarness()
		h.state.artefact = "stale"
		await h.runner.start()
		await h.advance(100)
		await h.advance(100)
		expect(h.last()?.state).toBe("waiting-for-signal")
		h.state.artefact = "dc"
		await settle(h, 100, 5)
		expect(h.last()).toMatchObject({
			state: "unidentified",
			trials: [],
			result: { artefact: "dc" },
		})
		expect(h.record.state).toBe("completed")
	})

	it("completes with no targets and no scanner:identify message when all: true finds nothing surfaced", async () => {
		const h = identifyHarness({
			request: { target: { all: true }, timeoutMs: 2000 },
		})
		await h.runner.start()
		await settle(h, 500, 10)
		expect(h.record.state).toBe("completed")
		expect(h.runner.view().targets).toEqual([])
		expect(h.events).toEqual([])
	})

	it("runs trials while the CPU stays above the guard, and keeps spectral classification as a hint", async () => {
		const h = identifyHarness({ cpuPercent: 99 })
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await settle(h, 1000, 30)
		expect(h.decoders.created.size + h.decoders.removed.length).toBeGreaterThan(
			0,
		)
		expect(h.last()).toMatchObject({
			state: "unidentified",
			result: { hint: "tdma-ms" },
		})
		expect(h.last()!.result!.identity).toBeUndefined()
		expect(Object.values(outcomes(h))).not.toContain("skipped-budget")
	})

	it("refuses pause, and cancels with every probe released and open trials marked cancelled", async () => {
		const h = identifyHarness()
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		expect(h.decoders.created.size).toBe(1)
		await expect(h.runner.dispatch({ type: "pause" })).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_IDENTIFY_NOT_PAUSABLE",
		})
		await h.runner.dispatch({ type: "cancel" })
		await flushAsync()
		expect(h.record.state).toBe("cancelled")
		expect(h.decoders.created.size).toBe(0)
		expect(new Set(Object.values(outcomes(h)))).toEqual(
			new Set(["cancelled", "unsupported"]),
		)
	})

	it("identifies every surfaced emission in the window for all: true, strongest first", async () => {
		const h = identifyHarness({ request: { target: { all: true } } })
		await h.runner.start()
		h.tracks.push(
			viewOf(
				trackOf({
					trackId: "a",
					centreHz: 446_125_000,
					snrDb: 20,
					spectralShape: "narrow",
				}),
				"d_a",
			),
			viewOf(
				trackOf({
					trackId: "b",
					centreHz: 446_300_000,
					snrDb: 40,
					spectralShape: "narrow",
				}),
				"d_b",
			),
			viewOf(
				trackOf({
					trackId: "c",
					centreHz: 446_400_000,
					snrDb: 50,
					spectralShape: "narrow",
				}),
				null,
			),
		)
		await settle(h, 1000, 40)
		const view = h.runner.view()
		expect(view.targets.map(t => [t.targetHz, t.state])).toEqual([
			[446_300_000, "unidentified"],
			[446_125_000, "unidentified"],
		])
		expect(
			view.targets.every(
				t =>
					t.result?.protocol === undefined &&
					t.trials.some(trial => trial.protocol === "analog-fm"),
			),
		).toBe(true)
		expect(h.record.state).toBe("completed")
	})

	// Feature: signal-discovery-scanner, Property 25: Identify trials
	// Validates: spec § 10.8
	it("never starts a trial on an artefact target, and every result carries measurements", async () => {
		const scenario = fc.record({
			artefact: fc.constantFrom<ArtefactKind | null>(
				null,
				"dc",
				"spur",
				"image",
				"rfi",
			),
			track: fc.option(
				fc.record({
					obwHz: fc.integer({ min: 300, max: 30_000 }),
					shape: fc.constantFrom(
						"flat" as const,
						"peaked" as const,
						"narrow" as const,
					),
					// a sticky artefact flag on the resolved track: IQ image (Task 11a) or spur line (Task 7a)
					flag: fc.constantFrom(null, "iqImage" as const, "spur" as const),
					snrDb: fc.integer({ min: 3, max: 60 }),
				}),
				{ nil: null },
			),
			decode: fc.boolean(),
		})
		await fc.assert(
			fc.asyncProperty(scenario, async s => {
				const h = identifyHarness({
					artefact: s.artefact,
					request: { timeoutMs: 2000 },
				})
				try {
					await h.runner.start()
					if (s.track) {
						h.tracks.push(
							viewOf(
								trackOf({
									obwHz: s.track.obwHz,
									spectralShape: s.track.shape,
									snrDb: s.track.snrDb,
									flags: {
										...FLAGS,
										iqImage: s.track.flag === "iqImage",
										spur: s.track.flag === "spur",
									},
								}),
							),
						)
					}
					for (let i = 0; i < 60 && !ENDED.includes(h.record.state); i++) {
						await h.advance(1000)
						if (!s.decode) continue
						for (const [id, d] of h.decoders.created)
							if (d.config.type === "dsd-fme") emitDmrIdentity(h, id)
					}
					const last = h.last()!
					expect(["identified", "candidate", "unidentified"]).toContain(
						last.state,
					)
					expect(last.result?.measurements.centreHz).toEqual(expect.any(Number))
					expect(
						last.trials.every(
							t => t.outcome !== "pending" && t.outcome !== "running",
						),
					).toBe(true)
					// rfi short-circuits nothing; it is reported only when no signal resolves
					const flagged =
						s.track?.flag === "iqImage"
							? "image"
							: s.track?.flag === "spur"
								? "spur"
								: null
					const artefact =
						s.artefact === "dc" ||
						s.artefact === "spur" ||
						s.artefact === "image"
							? s.artefact
							: (flagged ?? (s.track ? null : s.artefact))
					if (artefact) {
						expect(h.decoders.created.size + h.decoders.removed.length).toBe(0)
						expect(last).toMatchObject({
							state: "unidentified",
							trials: [],
							result: { artefact },
						})
					}
				} finally {
					await h.pool.destroy()
				}
			}),
			{ numRuns: 100, seed: 2510 },
		)
	}, 120_000)
})

/** Starts a DMR target and lets its first run (dsd-fme auto) start. */
async function dmrTrial(h: Harness): Promise<void> {
	await h.runner.start()
	h.tracks.push(viewOf(dmrTrack()))
	await h.advance(100)
	await h.advance(100)
	await flushAsync()
	expect(h.decoders.created.size).toBe(1)
	expect(outcomes(h)["dmr"]).toBe("running")
}

describe("IdentifyRunner window moves, cut-short runs and endings", () => {
	it("ends the target within one tick when the window moves far mid-trial: trials cancelled, no further probe", async () => {
		const h = identifyHarness()
		const order = decoderOrder(h)
		await dmrTrial(h)
		// the operator retunes 1.4 MHz away: the service hands the pool the new epoch
		h.engine.setEpoch(2, 447_500_000)
		await h.pool.onEpoch("rtl", 2, 447_500_000)
		await flushAsync()
		await h.advance(100)
		// it ends with what it has: the spectral class still speaks (the TDMA ACF), no decoder verdict
		expect(h.last()).toMatchObject({
			state: "unidentified",
			result: {
				ended: "window-moved",
				measurements: { source: "track", centreHz: TARGET_HZ },
			},
		})
		expect(
			h
				.last()!
				.trials.every(t => ["cancelled", "unsupported"].includes(t.outcome)),
		).toBe(true)
		expect(
			h.events.some(e => e.trials.some(t => t.outcome === "no-sync")),
		).toBe(false)
		await settle(h, 1000, 10)
		expect(h.record.state).toBe("completed")
		expect(order).toEqual(["dsd-fme:auto"])
		expect(h.decoders.created.size).toBe(0)
	})

	it("cancels a run cut short by an in-window epoch change, re-resolves, and keeps the original deadline", async () => {
		const h = identifyHarness({ request: { timeoutMs: 2000 } })
		const startedAt = h.clock.now
		await dmrTrial(h)
		// same centre (a gain change): the pool stops the probe and does not re-request it (identify re-plans)
		h.engine.setEpoch(2, 446_100_000)
		await h.pool.onEpoch("rtl", 2, 446_100_000)
		await flushAsync()
		expect(h.decoders.created.size).toBe(0)
		expect(outcomes(h)["dmr"]).toBe("cancelled")
		await h.advance(100)
		expect(h.last()?.state).toBe("waiting-for-signal")
		// the epoch-1 track no longer resolves; nothing transmits in epoch 2
		while (!ENDED.includes(h.record.state) && h.clock.now - startedAt < 5000)
			await h.advance(100)
		expect(h.record.state).toBe("completed")
		// the deadline is the original start + 2 s (+ one tick to finish), not 2 s after the epoch change
		expect(h.clock.now - startedAt).toBeLessThanOrEqual(2300)
		// the evidence survives the restart: the resolved track still gives a class hint without a protocol
		expect(h.last()).toMatchObject({
			state: "unidentified",
			result: {
				observationId: "o_t1",
				measurements: { source: "track", class: "tdma-ms" },
			},
		})
		expect(h.last()!.result!.ended).toBeUndefined()
		expect(outcomes(h)["dmr"]).toBe("cancelled")
		expect(
			h
				.last()!
				.trials.every(t => ["cancelled", "unsupported"].includes(t.outcome)),
		).toBe(true)
		expect(
			h.events.some(e => e.trials.some(t => t.outcome === "no-sync")),
		).toBe(false)
	})

	it("keeps completed trial outcomes across an in-window epoch change and does not run them again", async () => {
		const h = identifyHarness()
		const order = decoderOrder(h)
		await dmrTrial(h)
		// dsd-fme auto holds 2 s (+ start latency), then direwolf starts
		while (order.length < 2) await h.advance(500)
		expect(order).toEqual(["dsd-fme:auto", "direwolf:"])
		expect(outcomes(h)).toMatchObject({ dmr: "no-sync", aprs: "running" })
		h.engine.setEpoch(2, 446_100_000)
		await h.pool.onEpoch("rtl", 2, 446_100_000)
		await flushAsync()
		await h.advance(100)
		expect(h.last()).toMatchObject({ state: "waiting-for-signal" })
		expect(outcomes(h)).toMatchObject({ dmr: "no-sync", aprs: "cancelled" })
		// the handheld is seen again in the new epoch: the dsd-fme run is not repeated, direwolf is
		h.tracks.push(
			viewOf(trackOf({ trackId: "t2", epoch: 2, acf30: -0.94, acf60: 0.99 })),
		)
		await h.advance(100)
		await flushAsync()
		expect(order).toEqual(["dsd-fme:auto", "direwolf:", "direwolf:"])
		expect(outcomes(h)).toMatchObject({
			dmr: "no-sync",
			dstar: "no-sync",
			ysf: "no-sync",
			p25p1: "no-sync",
			aprs: "running",
		})
	})

	it("never reports window-moved for a collected all: true track whose OBW reaches past the usable edge (R2)", async () => {
		const h = identifyHarness({ request: { target: { all: true } } })
		await h.runner.start()
		// FakeEngineView: 446.1 MHz ± 819.2 kHz usable; a DMR handheld whose centre is inside but whose
		// upper band edge (+4.5 kHz) is 1.3 kHz outside
		h.tracks.push(
			viewOf(
				trackOf({
					trackId: "e",
					centreHz: 446_916_000,
					acf30: -0.94,
					acf60: 0.99,
					flags: { ...FLAGS, edge: true },
				}),
				"d_e",
			),
		)
		await h.advance(100) // collected, planned, first run started
		await h.advance(100)
		await h.advance(100)
		const [target] = h.runner.view().targets
		expect(target).toMatchObject({ targetHz: 446_916_000, state: "trying" })
		expect(target!.result).toBeUndefined()
		expect(h.decoders.created.size).toBe(1)
	})

	it("ends with the results so far on source-down", async () => {
		const h = identifyHarness()
		await dmrTrial(h)
		await h.runner.dispatch({ type: "source-down" })
		await flushAsync()
		expect(h.record.state).toBe("completed")
		expect(h.decoders.created.size).toBe(0)
		expect(h.last()).toMatchObject({
			state: "unidentified",
			result: { measurements: { source: "track" } },
		})
		expect(outcomes(h)["dmr"]).toBe("cancelled")
	})

	it("ends like source-down on a lease loss (never expected: identify holds no lease)", async () => {
		const h = identifyHarness()
		await dmrTrial(h)
		await h.runner.leaseLost()
		await flushAsync()
		expect(h.record.state).toBe("completed")
		expect(h.decoders.created.size).toBe(0)
	})

	it("detaches its pool listeners when it completes, is cancelled, or fails to start", async () => {
		const counts = (h: Harness) => [
			h.pool.listenerCount("probe-state"),
			h.pool.listenerCount("evidence"),
		]
		// the harness's own recorders are the baseline: one listener of each
		const completed = identifyHarness({ artefact: "dc" })
		expect(counts(completed)).toEqual([2, 2])
		await completed.runner.start()
		await settle(completed, 100, 5)
		expect(completed.record.state).toBe("completed")
		expect(counts(completed)).toEqual([1, 1])

		const cancelled = identifyHarness()
		await dmrTrial(cancelled)
		await cancelled.runner.dispatch({ type: "cancel" })
		expect(cancelled.record.state).toBe("cancelled")
		expect(counts(cancelled)).toEqual([1, 1])

		// ScannerService disposes a driver whose start failed
		const failed = identifyHarness()
		failed.record.state = "running"
		await expect(failed.runner.start()).rejects.toMatchObject({
			code: "SCANNER_INVALID_TRANSITION",
		})
		await failed.runner.dispose()
		expect(counts(failed)).toEqual([1, 1])
	})

	it("owns confirmation of the whole window only until all: true has collected its targets", async () => {
		const h = identifyHarness({ request: { target: { all: true } } })
		await h.runner.start()
		expect(h.runner.owns("rtl", 446_400_000)).toBe(true)
		h.tracks.push(viewOf(dmrTrack(), "d_a"))
		await h.advance(100) // collected: one target (tolerance 4.5 kHz), its first run started
		expect(h.last()?.state).toBe("trying")
		expect(h.runner.owns("rtl", TARGET_HZ + 4000)).toBe(true)
		expect(h.runner.owns("rtl", 446_400_000)).toBe(false)
		expect(h.runner.owns("other", TARGET_HZ)).toBe(false)
		await settle(h, 1000, 30)
		expect(h.record.state).toBe("completed")
		expect(h.runner.owns("rtl", TARGET_HZ)).toBe(false)
	})
})

describe("IdentifyRunner fatal engine cleanup (review F5)", () => {
	it("releases an active trial, reports cancellation, and ignores late probe evidence", async () => {
		const h = identifyHarness()
		h.engine.push(1_100_000)
		await h.runner.start()
		h.tracks.push(viewOf(dmrTrack()))
		await h.advance(100)
		await h.advance(100)
		const probe = h.pool.status()[0]!
		const listeners = h.pool.listenerCount("probe-state")
		expect(probe).toBeDefined()
		await h.runner.dispatch({ type: "engine-failed" })
		expect(h.record).toMatchObject({
			state: "failed",
			reason: "tuner-unavailable",
		})
		expect(h.pool.status()).toEqual([])
		expect(h.last()?.trials.some(t => t.outcome === "cancelled")).toBe(true)
		const last = h.last()
		emitDmrIdentity(h, probe.probeId)
		await h.advance(100)
		expect(h.last()).toBe(last)
		// The harness owns one recorder listener; only the runner subscription must disappear.
		expect(h.pool.listenerCount("probe-state")).toBe(listeners - 1)
	})
})
