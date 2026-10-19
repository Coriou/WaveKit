/** WG12 ID.4: a claimed capture whose plan includes analog runs the replay trial. */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyTrial,
	TuningTrust,
} from "@wavekit/api-types"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	ANALOG_REPLAY_TRIAL_DEADLINE_MS,
	IdentifyRunner,
	identifyScores,
	normaliseIdentify,
	planIdentifyTrials,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import * as probePool from "../../../../src/core/scanner/probes/probe-pool.js"
import type {
	ProbeMode,
	ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { IdentifyAnalogEvidence } from "../../../../src/core/scanner/identify-analog-contract.js"
import type { IqCaptureView } from "../../../../src/core/scanner/iq-capture-contract.js"
import type {
	AnalogTrialMode,
	AnalogTrialResult,
	AnalogTrialRunner,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { IQ_REPLAY_MAX_TRIALS } from "../../../../src/core/scanner/iq-capture-contract.js"
import type {
	Discovery,
	ScannerProtocol,
	ScannerSettings,
} from "../../../../src/core/scanner/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	flushAsync,
	linkLine,
	poolHarness,
} from "../../../mocks/scanner/probe-fakes.js"
import { FakeMemory, FakePort } from "./identify-heard-fakes.js"

const FINAL = new Set(["identified", "candidate", "unidentified"])

function capture(
	id: string,
	trust: TuningTrust | string = "commanded",
): IqCaptureView {
	return {
		captureId: id,
		sourceId: "rtl",
		observationId: "o_t1",
		epoch: 1,
		rfHz: TARGET_HZ,
		tuningTrust: trust as TuningTrust,
		capturedAtMs: 1,
		durationMs: 3000,
		gapSamples: 0,
	}
}

function analogTrack() {
	return trackOf({ spectralShape: "peaked", obwHz: 12_000, blocks: 20 })
}

function resultOf(
	outcome: AnalogTrialResult["outcome"],
	over: Partial<AnalogTrialResult> = {},
): AnalogTrialResult {
	return {
		outcome,
		mode: "nfm",
		voice: outcome === "heard" || outcome === "decoded",
		tones: { ctcssHz: null, dcs: null, audioSeconds: 2 },
		stats: null,
		...over,
	}
}

function captureLogger(): { logger: Logger; text: () => string } {
	const chunks: string[] = []
	const logger = pino(
		{ level: "info" },
		new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk))
				cb()
			},
		}),
	)
	return { logger, text: () => chunks.join("") }
}

function replayHarness(opts: {
	protocols?: ScannerProtocol[]
	captures?: IqCaptureView[] | null
	analogTrial?: AnalogTrialRunner | null
	analogEvidence?: IdentifyAnalogEvidence | null
	knownProtocols?: FakeMemory
	discovery?: Discovery
	logger?: Logger
	timeoutMs?: number
	patch?: (s: ScannerSettings) => void
	narrowRasterAt?: (hz: number) => boolean
}) {
	const captures = opts.captures ?? []
	const claimed = new Map<string, string>()
	const port = {
		near: () => captures.slice(0, 5),
		capture: () => ({ captureId: "requested-should-not-happen" }),
		end: () => undefined,
		claim: (id: string, holder: string) => {
			if (claimed.has(id)) return false
			claimed.set(id, holder)
			return true
		},
		settle: (id: string) => {
			claimed.delete(id)
		},
		confirmLive: () => 0,
		openReplay: () => null,
		view: (id: string) => captures.find(c => c.captureId === id) ?? null,
	}
	const settings = testSettings(opts.patch)
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			timeoutMs: opts.timeoutMs ?? 2000,
			...(opts.protocols ? { protocols: opts.protocols } : {}),
		}),
		inner: fakeInner(record, () => pool.clock.now),
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => opts.discovery,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: opts.logger ?? pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(opts.captures !== null ? { iqCapture: port } : {}),
		...(opts.analogTrial ? { analogTrial: opts.analogTrial } : {}),
		...(opts.analogEvidence ? { analogEvidence: opts.analogEvidence } : {}),
		...(opts.knownProtocols ? { knownProtocols: opts.knownProtocols } : {}),
		...(opts.narrowRasterAt ? { narrowRasterAt: opts.narrowRasterAt } : {}),
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const settle = async (): Promise<void> => {
		await runner.start()
		tracks.push(viewOf(analogTrack()))
		for (let i = 0; i < 16; i++) {
			const state = events.at(-1)?.state
			if (state && FINAL.has(state)) break
			await advance(100)
		}
	}
	return {
		pool,
		record,
		tracks,
		events,
		runner,
		advance,
		settle,
		last: () => events.at(-1),
		trials: (): ScannerIdentifyTrial[] => events.at(-1)?.trials ?? [],
		held: (): string[] => [...claimed.keys()],
		destroy: async () => {
			await runner.dispose()
			await pool.pool.destroy()
		},
	}
}

describe("IdentifyRunner analog replay trial (WG12 ID.4)", () => {
	it("Claimed capture + CTCSS decoded on commanded → identified, trial decoder analog-demod transport replay", async () => {
		const calls: { captureId: string; mode: AnalogTrialMode }[] = []
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-1", "commanded")],
			analogTrial: {
				run: (captureId, mode) => {
					calls.push({ captureId, mode })
					return Promise.resolve(
						resultOf("decoded", {
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					)
				},
			},
		})
		try {
			await h.settle()
			const last = h.last()
			expect(last?.state).toBe("identified")
			expect(last?.result?.protocol).toBe("analog-fm")
			expect(last?.result?.analog).toMatchObject({
				source: "live-audio",
				modulation: "nfm",
				ctcssHz: 88.5,
				tuningTrust: "commanded",
				transmissionId: "o_t1",
			})
			expect(JSON.stringify(h.events)).not.toContain("cap-1")
			expect(h.trials().find(t => t.decoder === "analog-demod")).toMatchObject({
				protocol: "analog-fm",
				decoder: "analog-demod",
				transport: "replay",
				mode: "nfm",
				outcome: "decoded",
			})
			expect(calls).toEqual([{ captureId: "cap-1", mode: "nfm" }])
			expect(h.pool.decoders.created.size).toBe(0)
		} finally {
			await h.destroy()
		}
	})

	it("relay trust with a tone identifies the same way", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-relay", "relay")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("decoded", {
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 1 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).toBe("identified")
			expect(h.last()?.result?.analog?.tuningTrust).toBe("relay")
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"decoded",
			)
		} finally {
			await h.destroy()
		}
	})

	it("Unverified → candidate", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-unverified", "unverified")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("decoded", {
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).toBe("candidate")
			expect(h.last()?.state).not.toBe("identified")
			expect(h.last()?.result?.analog).toMatchObject({
				source: "live-audio",
				ctcssHz: 88.5,
				tuningTrust: "unverified",
			})
			expect(h.trials().find(t => t.decoder === "analog-demod")).toMatchObject({
				decoder: "analog-demod",
				transport: "replay",
				mode: "nfm",
				outcome: "decoded",
			})
		} finally {
			await h.destroy()
		}
	})

	it("heard maps to the trial outcome heard and does not identify", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-heard", "commanded")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("heard", {
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).not.toBe("identified")
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"heard",
			)
			expect(h.last()?.result?.analog).toMatchObject({
				source: "live-audio",
				ctcssHz: null,
				dcs: null,
				tuningTrust: "commanded",
			})
		} finally {
			await h.destroy()
		}
	})

	it("a decoded tone outside the standard table does not identify", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-odd", "commanded")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("decoded", {
							tones: { ctcssHz: 12.34, dcs: null, audioSeconds: 2 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).not.toBe("identified")
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"heard",
			)
			expect(h.last()?.result?.analog?.ctcssHz).toBeNull()
		} finally {
			await h.destroy()
		}
	})

	it("malformed capture trust does not identify", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-bogus", "not-a-trust")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("decoded", {
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).not.toBe("identified")
			expect(h.last()?.result?.analog?.tuningTrust).toBe("unverified")
		} finally {
			await h.destroy()
		}
	})

	it("No analogTrial dep → trial list deep-equal to base", async () => {
		const base = replayHarness({
			protocols: ["analog-fm"],
			captures: null,
		})
		const withCapture = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-base", "commanded")],
		})
		try {
			await base.settle()
			await withCapture.settle()
			expect(withCapture.trials()).toEqual(base.trials())
			expect(base.trials().some(t => t.decoder === "analog-demod")).toBe(false)
			expect(withCapture.trials().some(t => t.decoder === "analog-demod")).toBe(
				false,
			)
			expect(base.last()?.state).toBe(withCapture.last()?.state)
		} finally {
			await base.destroy()
			await withCapture.destroy()
		}
	})

	it("Analog no-sync is not a known-protocol miss", async () => {
		const mem = new FakeMemory(
			new Map([["d_1", { protocol: "analog-fm", confidence: "decoded" }]]),
		)
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-nosync", "commanded")],
			knownProtocols: mem,
			discovery: {
				id: "d_1",
				protocol: "analog-fm",
				confidence: "decoded",
			} as Discovery,
			analogTrial: {
				run: () => Promise.resolve(resultOf("no-sync")),
			},
		})
		try {
			await h.settle()
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"no-sync",
			)
			expect(h.last()?.result?.analog).toBeUndefined()
			expect(h.last()?.state).not.toBe("identified")
			expect(mem.calls.filter(c => c.startsWith("miss:"))).toEqual([])
		} finally {
			await h.destroy()
		}
	})

	it("a throwing analog runner stays a candidate and logs no capture path", async () => {
		const log = captureLogger()
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-SECRET")],
			logger: log.logger,
			analogTrial: {
				run: () => {
					throw new Error("SECRET capture path /tmp/iq/abc")
				},
			},
		})
		try {
			await h.settle()
			expect(h.last()?.state).not.toBe("identified")
			expect(h.last()?.state).toBe("candidate")
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"cancelled",
			)
			expect(h.last()?.result?.analog).toBeUndefined()
			const text = log.text()
			expect(text).toContain("Analog replay trial failed")
			expect(text).toContain('"type":"Error"')
			expect(text).not.toContain("SECRET")
			expect(text).not.toContain("/tmp")
			expect(JSON.stringify(h.events)).not.toContain("SECRET")
			expect(JSON.stringify(h.events)).not.toContain("/tmp")
		} finally {
			await h.destroy()
		}
	})

	it("each claimed capture gets its own analog replay trial", async () => {
		const seen: AnalogTrialMode[] = []
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-a", "commanded"), capture("cap-b", "relay")],
			analogTrial: {
				run: (_id, mode) => {
					seen.push(mode)
					return Promise.resolve(resultOf("no-sync"))
				},
			},
		})
		try {
			await h.settle()
			const analog = h.trials().filter(t => t.decoder === "analog-demod")
			expect(analog).toHaveLength(2)
			expect(
				analog.every(t => t.transport === "replay" && t.mode === "nfm"),
			).toBe(true)
			expect(seen).toEqual(["nfm", "nfm"])
			expect(JSON.stringify(h.events)).not.toContain("cap-a")
			expect(JSON.stringify(h.events)).not.toContain("cap-b")
		} finally {
			await h.destroy()
		}
	})

	it("analog-am is the replay mode when it is the only analog protocol", async () => {
		const seen: AnalogTrialMode[] = []
		const h = replayHarness({
			protocols: ["analog-am"],
			captures: [capture("cap-am", "commanded")],
			analogEvidence: new FakePort(),
			timeoutMs: 1000,
			analogTrial: {
				run: (_id, mode) => {
					seen.push(mode)
					return Promise.resolve(
						resultOf("decoded", {
							mode: "am",
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					)
				},
			},
		})
		try {
			await h.settle()
			expect(seen).toEqual(["am"])
			expect(h.trials().find(t => t.decoder === "analog-demod")).toMatchObject({
				protocol: "analog-am",
				decoder: "analog-demod",
				transport: "replay",
				mode: "am",
				outcome: "decoded",
			})
			expect(h.last()?.state).toBe("identified")
			expect(h.last()?.result?.protocol).toBe("analog-am")
			expect(h.last()?.result?.analog?.modulation).toBe("am")
		} finally {
			await h.destroy()
		}
	})

	it("data-like and carrier-only stay on the trial and do not identify", async () => {
		for (const outcome of ["data-like", "carrier-only"] as const) {
			const h = replayHarness({
				protocols: ["analog-fm"],
				captures: [capture(`cap-${outcome}`, "commanded")],
				analogTrial: { run: () => Promise.resolve(resultOf(outcome)) },
			})
			try {
				await h.settle()
				expect(
					h.trials().find(t => t.decoder === "analog-demod")?.outcome,
				).toBe(outcome)
				expect(h.last()?.state).not.toBe("identified")
				expect(h.last()?.result?.analog).toBeUndefined()
			} finally {
				await h.destroy()
			}
		}
	})

	it("two claimed captures run their analog trials strictly one after another", async () => {
		const order: string[] = []
		let inflight = 0
		let maxInflight = 0
		const held: { release: (() => void) | null } = { release: null }
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-a", "commanded"), capture("cap-b", "relay")],
			analogTrial: {
				run: (captureId, _mode, signal) =>
					new Promise((resolve, reject) => {
						order.push(`start:${captureId}`)
						inflight += 1
						maxInflight = Math.max(maxInflight, inflight)
						const finish = (): void => {
							inflight -= 1
							order.push(`end:${captureId}`)
							resolve(resultOf("no-sync"))
						}
						signal.addEventListener("abort", () => {
							inflight -= 1
							reject(new DOMException("aborted", "AbortError"))
						})
						if (held.release === null) held.release = finish
						else finish()
					}),
			},
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(analogTrack()))
			await h.advance(100)
			await h.advance(100)
			expect(order).toEqual(["start:cap-a"])
			expect(maxInflight).toBe(1)
			expect(inflight).toBe(1)
			for (let i = 0; i < 4; i++) await h.advance(500)
			expect(order).toEqual(["start:cap-a"])
			expect(maxInflight).toBe(1)
			const release = held.release
			expect(release).not.toBeNull()
			release?.()
			await flushAsync()
			await h.advance(100)
			await h.advance(100)
			expect(order).toEqual([
				"start:cap-a",
				"end:cap-a",
				"start:cap-b",
				"end:cap-b",
			])
			expect(maxInflight).toBe(1)
			expect(inflight).toBe(0)
			const analog = h.trials().filter(t => t.decoder === "analog-demod")
			expect(analog).toHaveLength(2)
			// The analog trial is one of the eight replay trials on each capture.
			expect(analog.length).toBeLessThanOrEqual(IQ_REPLAY_MAX_TRIALS)
			expect(IQ_REPLAY_MAX_TRIALS).toBe(8)
		} finally {
			await h.destroy()
		}
	})

	it("starts the analog trial when a local core reservation would not fit", async () => {
		const calls: string[] = []
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-budget", "commanded")],
			patch: s => {
				s.cpuBudgetCores = 0.1
			},
			analogTrial: {
				run: captureId => {
					calls.push(captureId)
					return Promise.resolve(resultOf("heard"))
				},
			},
		})
		try {
			await h.settle()
			expect(calls).toEqual(["cap-budget"])
			expect(h.trials().find(t => t.decoder === "analog-demod")).toMatchObject({
				decoder: "analog-demod",
				transport: "replay",
				mode: "nfm",
				outcome: "heard",
			})
			expect(h.last()?.state).not.toBe("trying")
		} finally {
			await h.destroy()
		}
	})

	it("cancels a result whose mode differs from the requested mode and keeps no match", async () => {
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-mode", "commanded")],
			analogTrial: {
				run: () =>
					Promise.resolve(
						resultOf("decoded", {
							mode: "am",
							tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
						}),
					),
			},
		})
		try {
			await h.settle()
			expect(h.trials().find(t => t.decoder === "analog-demod")).toMatchObject({
				decoder: "analog-demod",
				mode: "nfm",
				transport: "replay",
				outcome: "cancelled",
			})
			expect(h.last()?.state).toBe("candidate")
			expect(h.last()?.result?.analog).toBeUndefined()
			expect(h.last()?.result?.confidence).toBe("activity")
		} finally {
			await h.destroy()
		}
	})

	it("a stalled analog replay still ends on window move and ignores a late result", async () => {
		const signals: AbortSignal[] = []
		const held: { release: ((result: AnalogTrialResult) => void) | null } = {
			release: null,
		}
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-stall", "commanded")],
			analogTrial: {
				run: (_id, _mode, signal) => {
					signals.push(signal)
					return new Promise(resolve => {
						held.release = resolve
					})
				},
			},
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(analogTrack()))
			await h.advance(100)
			await h.advance(100)
			expect(signals).toHaveLength(1)
			expect(h.last()?.state).toBe("trying")
			h.pool.engine.setEpoch(2, 447_500_000)
			await h.advance(100)
			expect(h.last()?.result?.ended).toBe("window-moved")
			expect(signals[0]?.aborted).toBe(true)
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"cancelled",
			)
			const events = h.events.length
			held.release?.(
				resultOf("decoded", {
					tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
				}),
			)
			await flushAsync()
			await h.advance(100)
			expect(h.events.length).toBe(events)
			expect(h.last()?.result?.ended).toBe("window-moved")
			expect(h.last()?.state).not.toBe("identified")
			expect(h.last()?.result?.analog).toBeUndefined()
		} finally {
			await h.destroy()
		}
	})

	it("dispose aborts an analog replay and drops a result that arrives afterwards", async () => {
		const signals: AbortSignal[] = []
		const held: { release: ((result: AnalogTrialResult) => void) | null } = {
			release: null,
		}
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-dispose", "commanded")],
			analogTrial: {
				run: (_id, _mode, signal) => {
					signals.push(signal)
					return new Promise(resolve => {
						held.release = resolve
					})
				},
			},
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(analogTrack()))
			await h.advance(100)
			await h.advance(100)
			expect(signals).toHaveLength(1)
			const events = h.events.length
			await h.runner.dispose()
			expect(signals[0]?.aborted).toBe(true)
			held.release?.(
				resultOf("decoded", {
					tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
				}),
			)
			await flushAsync()
			await flushAsync()
			expect(h.events.length).toBe(events)
			expect(h.events.some(e => e.state === "identified")).toBe(false)
			expect(h.events.some(e => e.result?.analog !== undefined)).toBe(false)
		} finally {
			await h.pool.pool.destroy()
		}
	})

	it("analog heard does not start a later digital replay of that capture", async () => {
		// R4.6: after heard, the remaining digital replays of that capture are not run.
		const replay = await captureReplayRequests({
			protocols: ["analog-fm", "dmr"],
			captures: [capture("cap-heard", "commanded")],
			resultFor: () => resultOf("heard"),
		})
		expect(replay.analogOutcome).toBe("heard")
		expect(digitalReplays(replay.requests, "dmr")).toEqual([])
	})

	it("analog tone does not start a later digital replay of that capture", async () => {
		const replay = await captureReplayRequests({
			protocols: ["analog-fm", "dmr"],
			captures: [capture("cap-tone", "commanded")],
			resultFor: () =>
				resultOf("decoded", {
					tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 2 },
				}),
		})
		expect(replay.analogOutcome).toBe("decoded")
		expect(digitalReplays(replay.requests, "dmr")).toEqual([])
	})

	it("data-like still starts the digital replay of that capture", async () => {
		const replay = await captureReplayRequests({
			protocols: ["analog-fm", "dmr"],
			captures: [capture("cap-data", "commanded")],
			resultFor: () => resultOf("data-like"),
		})
		expect(replay.analogOutcome).toBe("data-like")
		expect(digitalReplays(replay.requests, "dmr")).toEqual(["cap-data"])
	})

	it("only the capture that was heard skips its later digital replay", async () => {
		const replay = await captureReplayRequests({
			protocols: ["analog-fm", "dmr"],
			captures: [
				capture("cap-heard", "commanded"),
				capture("cap-open", "commanded"),
			],
			resultFor: id => resultOf(id === "cap-heard" ? "heard" : "no-sync"),
		})
		expect(digitalReplays(replay.requests, "dmr")).toEqual(["cap-open"])
	})

	it("keeps the known-protocol replay that already ran and skips a later digital replay", async () => {
		const mem = new FakeMemory(
			new Map([["d_1", { protocol: "dmr", confidence: "decoded" }]]),
		)
		const replay = await captureReplayRequests({
			protocols: ["analog-fm", "dmr", "aprs"],
			captures: [capture("cap-known", "commanded")],
			knownProtocols: mem,
			discovery: {
				id: "d_1",
				protocol: "dmr",
				confidence: "decoded",
			} as Discovery,
			resultFor: () => resultOf("heard"),
		})
		expect(replay.analogOutcome).toBe("heard")
		expect(digitalReplays(replay.requests, "dmr")).toEqual(["cap-known"])
		expect(digitalReplays(replay.requests, "aprs")).toEqual([])
	})

	it("runs eight mixed replay trials and does not run a ninth", async () => {
		// The built-in probe catalog has six mode keys, so eight or nine proposed
		// trials never occur. Each requested protocol gets its own mode key here.
		// The cap under test is still identify's slice(0, IQ_REPLAY_MAX_TRIALS):
		// analog is first, and the last probe is the one a ninth trial drops.
		const original = probePool.probeModesFor
		const spy = vi
			.spyOn(probePool, "probeModesFor")
			.mockImplementation((cls, protocols) => {
				const unique = uniqueTrialMode(protocols)
				return unique ?? original(cls, protocols)
			})
		try {
			await expectReplayBound(
				["dmr", "ysf", "p25p1", "nxdn96", "pocsag", "flex", "aprs"],
				8,
			)
			await expectReplayBound(
				["dmr", "ysf", "p25p1", "nxdn96", "pocsag", "flex", "aprs", "nxdn48"],
				9,
			)
		} finally {
			spy.mockRestore()
		}
	})

	it("cancels a stalled analog replay at its deadline and releases the capture", async () => {
		let signal: AbortSignal | undefined
		const mem = new FakeMemory(
			new Map([["d_1", { protocol: "analog-fm", confidence: "decoded" }]]),
		)
		const h = replayHarness({
			protocols: ["analog-fm"],
			captures: [capture("cap-stall", "commanded")],
			knownProtocols: mem,
			discovery: {
				id: "d_1",
				protocol: "analog-fm",
				confidence: "decoded",
			} as Discovery,
			analogTrial: {
				run: (_captureId, _mode, next) => {
					signal = next
					return new Promise(() => undefined)
				},
			},
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(analogTrack()))
			let startedAt: number | null = null
			for (let i = 0; i < 20 && startedAt === null; i++) {
				await h.advance(100)
				const trial = h.trials().find(t => t.decoder === "analog-demod")
				if (trial?.outcome === "running") startedAt = h.pool.clock.now
			}
			expect(startedAt).not.toBeNull()
			const start = startedAt ?? 0
			expect(h.held()).toEqual(["cap-stall"])
			expect(h.record.state).toBe("running")
			h.pool.clock.now = start + ANALOG_REPLAY_TRIAL_DEADLINE_MS - 1
			h.runner.tick(h.pool.clock.now)
			h.pool.pool.pump()
			await flushAsync()
			await flushAsync()
			expect(h.last()?.state).toBe("trying")
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"running",
			)
			expect(signal?.aborted).toBe(false)
			expect(h.held()).toEqual(["cap-stall"])
			expect(h.last()?.result?.ended).not.toBe("window-moved")
			h.pool.clock.now = start + ANALOG_REPLAY_TRIAL_DEADLINE_MS
			h.runner.tick(h.pool.clock.now)
			h.pool.pool.pump()
			await flushAsync()
			await flushAsync()
			expect(h.trials().find(t => t.decoder === "analog-demod")?.outcome).toBe(
				"cancelled",
			)
			expect(h.last()?.result?.analog).toBeUndefined()
			expect(h.last()?.result?.ended).not.toBe("window-moved")
			expect(FINAL.has(h.last()?.state ?? "")).toBe(true)
			expect(signal?.aborted).toBe(true)
			expect(h.held()).toEqual([])
			expect(mem.calls.filter(c => c.startsWith("miss:"))).toEqual([])
			await h.advance(100)
			expect(h.record.state).toBe("completed")
		} finally {
			await h.destroy()
		}
	})

	it("a live decode skips analog replay still queued for the same plan", async () => {
		const calls: string[] = []
		const h = replayHarness({
			protocols: ["dmr", "analog-fm"],
			captures: [capture("cap-dmr", "commanded")],
			analogTrial: {
				run: captureId => {
					calls.push(captureId)
					return new Promise(() => undefined)
				},
			},
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99, blocks: 20 })))
			for (let i = 0; i < 12 && h.pool.decoders.created.size === 0; i++)
				await h.advance(100)
			expect(h.pool.decoders.created.size).toBeGreaterThan(0)
			const id = [...h.pool.decoders.created.values()][0]?.id ?? ""
			h.pool.decoders.emitLink(id, linkLine(1, h.pool.clock.now))
			h.pool.decoders.emitLink(id, linkLine(1, h.pool.clock.now + 30))
			await flushAsync()
			expect(h.trials().find(t => t.protocol === "dmr")?.outcome).toBe(
				"decoded",
			)
			expect(FINAL.has(h.last()?.state ?? "")).toBe(false)
			await h.advance(100)
			expect(calls).toEqual([])
			expect(h.trials().some(t => t.decoder === "analog-demod")).toBe(false)
			expect(h.last()?.result?.analog).toBeUndefined()
			expect(h.last()?.state).toBe("identified")
			await h.advance(100)
			expect(h.record.state).toBe("completed")
		} finally {
			await h.destroy()
		}
	})

	it("an in-window restart does not reuse an analog replay outcome as live audio", async () => {
		const h = replayHarness({
			protocols: ["dmr", "aprs", "analog-fm"],
			analogEvidence: new FakePort(),
			captures: null,
		})
		try {
			await h.runner.start()
			h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99, blocks: 20 })))
			for (let i = 0; i < 12 && h.pool.decoders.created.size === 0; i++)
				await h.advance(100)
			expect(h.trials().find(t => t.decoder === "live-audio")?.outcome).toBe(
				"running",
			)
			const internal = h.runner as unknown as {
				targets: { trials: ScannerIdentifyTrial[] }[]
			}
			internal.targets[0]?.trials.push({
				protocol: "analog-fm",
				decoder: "analog-demod",
				mode: "nfm",
				transport: "replay",
				outcome: "no-sync",
			})
			h.pool.engine.setEpoch(2, 446_100_000)
			await h.pool.pool.onEpoch("rtl", 2, 446_100_000)
			await flushAsync()
			await h.advance(100)
			expect(h.last()?.state).toBe("waiting-for-signal")
			h.tracks.length = 0
			h.tracks.push(
				viewOf(
					trackOf({
						trackId: "t2",
						epoch: 2,
						acf30: -0.94,
						acf60: 0.99,
						blocks: 20,
					}),
				),
			)
			await h.advance(100)
			expect(
				h
					.trials()
					.find(t => t.decoder === "live-audio" && t.protocol === "analog-fm")
					?.outcome,
			).toBe("running")
		} finally {
			await h.destroy()
		}
	})
})

function digitalReplays(
	requests: readonly ProbeRequest[],
	protocol: ScannerProtocol,
): string[] {
	return requests.flatMap(r =>
		r.replay && r.protocols.includes(protocol) ? [r.replay.captureId] : [],
	)
}

/** Drive one identify until it ends and return the replay probe requests it made. */
async function captureReplayRequests(opts: {
	protocols: ScannerProtocol[]
	captures: IqCaptureView[]
	resultFor: (captureId: string) => AnalogTrialResult
	knownProtocols?: FakeMemory
	discovery?: Discovery
}): Promise<{ requests: ProbeRequest[]; analogOutcome: string | undefined }> {
	const requests: ProbeRequest[] = []
	const h = replayHarness({
		protocols: opts.protocols,
		captures: opts.captures,
		timeoutMs: 400_000,
		analogTrial: {
			run: captureId => Promise.resolve(opts.resultFor(captureId)),
		},
		...(opts.knownProtocols ? { knownProtocols: opts.knownProtocols } : {}),
		...(opts.discovery ? { discovery: opts.discovery } : {}),
	})
	const request = h.pool.pool.request.bind(h.pool.pool)
	h.pool.pool.request = req => {
		if (req.replay) requests.push(req)
		return request(req)
	}
	try {
		await h.runner.start()
		h.tracks.push(viewOf(analogTrack()))
		for (let i = 0; i < 40 && !FINAL.has(h.last()?.state ?? ""); i++)
			await h.advance(1000)
		expect(FINAL.has(h.last()?.state ?? "")).toBe(true)
		return {
			requests,
			analogOutcome: h.trials().find(t => t.decoder === "analog-demod")
				?.outcome,
		}
	} finally {
		await h.destroy()
	}
}

/** One dsd-fme mode per protocol, so plan runs do not collapse onto the six built-in keys. */
function uniqueTrialMode(
	protocols: readonly ScannerProtocol[],
): ProbeMode[] | null {
	if (protocols.length !== 1) return null
	const protocol = protocols[0]
	if (!protocol) return null
	return [
		{
			decoderType: "dsd-fme",
			protocol,
			covers: [protocol],
			options: { mode: `trial-${protocol}` },
			holdMs: 1800,
		},
	]
}

async function expectReplayBound(
	probeProtocols: ScannerProtocol[],
	proposed: number,
): Promise<void> {
	const protocols: ScannerProtocol[] = [...probeProtocols, "analog-fm"]
	const calls: string[] = []
	const replayAsked: ProbeRequest[] = []
	const h = replayHarness({
		protocols,
		captures: [capture("cap-bound", "commanded")],
		timeoutMs: 400_000,
		narrowRasterAt: () => true,
		analogTrial: {
			run: captureId => {
				calls.push(captureId)
				return Promise.resolve(resultOf("no-sync"))
			},
		},
	})
	const request = h.pool.pool.request.bind(h.pool.pool)
	h.pool.pool.request = req => {
		if (req.replay) replayAsked.push(req)
		return request(req)
	}
	const track = analogTrack()
	const plan = planIdentifyTrials(
		identifyScores(track, { priors: {}, protocols, narrow: true }),
		{ format: "U8_IQ", channelizer: false },
	)
	try {
		expect(plan.runs.length).toBe(probeProtocols.length)
		expect(plan.trials.some(t => t.protocol === "analog-fm")).toBe(true)
		expect(plan.runs.length + 1).toBe(proposed)
		await h.runner.start()
		h.tracks.push(viewOf(track))
		for (let i = 0; i < 40 && !FINAL.has(h.last()?.state ?? ""); i++)
			await h.advance(4000)
		expect(FINAL.has(h.last()?.state ?? "")).toBe(true)
		const kept = Math.min(plan.runs.length, IQ_REPLAY_MAX_TRIALS - 1)
		expect(calls).toEqual(["cap-bound"])
		expect(replayAsked).toHaveLength(kept)
		expect(replayAsked.map(r => r.protocols)).toEqual(
			plan.runs.slice(0, kept).map(r => r.protocols),
		)
		expect(calls.length + replayAsked.length).toBe(
			Math.min(proposed, IQ_REPLAY_MAX_TRIALS),
		)
		if (proposed > IQ_REPLAY_MAX_TRIALS) {
			const dropped = plan.runs[plan.runs.length - 1]?.protocols[0]
			expect(dropped).toBeDefined()
			expect(replayAsked.flatMap(r => r.protocols)).not.toContain(dropped)
		}
	} finally {
		await h.destroy()
	}
}
