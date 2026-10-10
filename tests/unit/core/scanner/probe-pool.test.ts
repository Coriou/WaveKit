import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { CPU_COST, probeCores } from "../../../../src/core/scanner/plan/cost.js"
import { probeModesFor } from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	FakeEngineView,
	flushAsync,
	linkLine,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

describe("probeModesFor", () => {
	it("follows the confirmation map and the job's protocol filter", () => {
		expect(
			probeModesFor("tdma-ms", []).map(m => [m.decoderType, m.options["mode"]]),
		).toEqual([
			["dsd-fme", "auto"],
			["dsd-fme", "nxdn"],
		])
		expect(probeModesFor("fsk4-6k25", []).map(m => m.options["mode"])).toEqual([
			"nxdn48",
			"dpmr",
		])
		expect(probeModesFor("fsk2-wide", [])[0]).toMatchObject({
			decoderType: "multimon-ng",
			options: { modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"] },
		})
		expect(probeModesFor("afsk-fm", [])[0]?.decoderType).toBe("direwolf")
		expect(probeModesFor("ook-burst", [])).toEqual([])
		expect(probeModesFor("carrier", [])).toEqual([])
		expect(
			probeModesFor("tdma-ms", ["nxdn96"]).map(m => m.options["mode"]),
		).toEqual(["nxdn"])
		expect(probeModesFor("fsk2-wide", ["dmr"])).toEqual([])
	})
})

describe("ProbePool", () => {
	it("starts an offset probe with the epoch offset, pre-roll and live bytes without gaps", async () => {
		const h = poolHarness()
		h.engine.push(3000)
		const res = h.pool.request(
			probeRequest({ preRollFromSample: 1000, targetHz: 446_125_000 }),
		)
		expect(res).toHaveProperty("started")
		await flushAsync()
		h.engine.push(500)
		await flushAsync()
		const decoder = [...h.decoders.created.values()][0]!
		expect(decoder.config).toMatchObject({
			type: "dsd-fme",
			sourceId: "rtl",
			options: { mode: "auto", offsetHz: 25_000 },
		})
		const got = decoder.received()
		expect(got.length).toBe((3500 - 1000) * 2)
		for (let i = 0; i < 2500; i++) {
			expect(got[2 * i]).toBe((1000 + i) & 255)
			expect(got[2 * i + 1]).toBe(((1000 + i) >> 8) & 255)
		}
	})

	it("records dsd-fme probe calls into a per-probe directory with pruning off", async () => {
		const h = poolHarness()
		const res = h.pool.request(probeRequest({ record: true }))
		if (!("started" in res)) throw new Error("not started")
		// the launch awaits a real mkdir of the recording dir: more than one setImmediate
		await vi.waitFor(() =>
			expect(h.decoders.created.has(res.started)).toBe(true),
		)
		const decoder = h.decoders.created.get(res.started)!
		expect(decoder.config.options).toMatchObject({
			enablePerCallRecording: true,
			perCallRecordingPrune: false,
			perCallRecordingDir: `/tmp/wk-probes-${process.pid}/recordings/dv/probe-${res.started}`,
		})
		const recordings: unknown[] = []
		h.pool.on("recordings", (r: unknown) => recordings.push(r))
		h.decoders.emitOutput(res.started, {
			type: "call_end",
			timestamp: new Date(1_000_500),
			data: {
				callId: "c1",
				protocol: "dmr",
				startedAt: new Date(1_000_100).toISOString(),
				endedAt: new Date(1_000_400).toISOString(),
				talkgroup: 9,
				source: 2060945,
				encrypted: false,
			},
		})
		await h.pool.release(res.started)
		expect(recordings).toEqual([
			expect.objectContaining({
				probeId: res.started,
				jobId: "job-a",
				calls: [
					{
						callId: "c1",
						startedAt: 1_000_100,
						endedAt: 1_000_400,
						talkgroup: "9",
						source: "2060945",
						encrypted: false,
					},
				],
			}),
		])
	})

	it("defers on format, window and CPU guard", () => {
		const s16 = new FakeEngineView()
		s16.format = "S16_IQ"
		expect(
			poolHarness({ engines: [s16] }).pool.request(probeRequest()),
		).toEqual({ deferred: "format" })
		expect(
			poolHarness().pool.request(probeRequest({ targetHz: 448_000_000 })),
		).toEqual({ deferred: "no-transport" })
		expect(
			poolHarness({ cpuPercent: 95 }).pool.request(probeRequest()),
		).toEqual({ deferred: "cpu" })
		expect(
			poolHarness().pool.request(probeRequest({ cls: "ook-burst" })),
		).toEqual({ deferred: "no-transport" })
		expect(poolHarness().pool.request(probeRequest({ epoch: 7 }))).toEqual({
			deferred: "stale-epoch",
		})
	})

	it("admits a queued request when the running probe stops, in admission order", async () => {
		const h = poolHarness()
		const first = h.pool.request(probeRequest({ trackId: "t1" }))
		expect(
			h.pool.request(
				probeRequest({
					trackId: "t2",
					admission: { kind: "reconfirm", snrDb: 40 },
				}),
			),
		).toEqual({ deferred: "max-probes" })
		expect(
			h.pool.request(
				probeRequest({
					trackId: "t3",
					admission: { kind: "undecoded", snrDb: 10 },
				}),
			),
		).toEqual({ deferred: "max-probes" })
		await flushAsync()
		if (!("started" in first)) throw new Error("not started")
		await h.pool.release(first.started)
		await flushAsync()
		expect(h.pool.status().map(p => p.trackId)).toEqual(["t3"])
	})

	it("lets a higher-priority job preempt a lower-priority probe", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ jobId: "low", priority: 10, trackId: "t1" }))
		await flushAsync()
		expect(
			h.pool.request(
				probeRequest({ jobId: "high", priority: 90, trackId: "t2" }),
			),
		).toEqual({ deferred: "max-probes" })
		await flushAsync()
		await flushAsync()
		expect(h.pool.status().map(p => p.jobId)).toEqual(["high"])
	})

	it("steps to the next mode when the hold ends without accepted evidence", async () => {
		vi.useFakeTimers()
		try {
			const h = poolHarness()
			h.pool.request(probeRequest({ holdMs: 600 }))
			await vi.advanceTimersByTimeAsync(10)
			expect(h.pool.status()[0]?.decoderType).toBe("dsd-fme")
			const firstDecoder = [...h.decoders.created.keys()][0]!
			await vi.advanceTimersByTimeAsync(700)
			const [current] = h.pool.status()
			expect(current?.decoderId).not.toBe(firstDecoder)
			expect(
				h.decoders.created.get(current!.decoderId)?.config.options["mode"],
			).toBe("nxdn")
			expect(h.decoders.removed).toContain(firstDecoder)
		} finally {
			vi.useRealTimers()
		}
	})

	it("splits the class hold so the second mode runs within it", async () => {
		vi.useFakeTimers()
		try {
			const h = poolHarness()
			// tdma-ms: dsd-fme auto then nxdn (2000 ms) inside the scheduler's 3800 ms class hold
			h.pool.request(probeRequest({ cls: "tdma-ms", holdMs: 3800 }))
			await vi.advanceTimersByTimeAsync(10)
			const firstDecoder = [...h.decoders.created.keys()][0]!
			await vi.advanceTimersByTimeAsync(1700)
			expect(h.pool.status()[0]?.decoderId).toBe(firstDecoder)
			await vi.advanceTimersByTimeAsync(200)
			const [current] = h.pool.status()
			expect(current?.decoderId).not.toBe(firstDecoder)
			expect(
				h.decoders.created.get(current!.decoderId)?.config.options["mode"],
			).toBe("nxdn")
		} finally {
			vi.useRealTimers()
		}
	})

	// Feature: signal-discovery-scanner, Property 11: Bounded state
	// Validates: spec § 9
	it("never runs more offset probes than allowed or more estimated CPU than the budget", async () => {
		type Op =
			| { t: "req"; track: number; priority: number; snr: number }
			| { t: "rel"; idx: number }
			| { t: "cpu"; percent: number | null }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				t: fc.constant("req" as const),
				track: fc.nat(9),
				priority: fc.integer({ min: 0, max: 100 }),
				snr: fc.integer({ min: 0, max: 60 }),
			}),
			fc.record({ t: fc.constant("rel" as const), idx: fc.nat(4) }),
			fc.record({
				t: fc.constant("cpu" as const),
				percent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 3 }),
				fc.constantFrom(0.4, 0.6, 1.0, 1.6, 2.5),
				fc.array(op, { minLength: 1, maxLength: 40 }),
				async (maxOffset, budget, ops) => {
					const settings = testSettings(s => {
						s.maxProbes.offset = maxOffset
						s.cpuBudgetCores = budget
					})
					const h = poolHarness({ settings })
					for (const o of ops) {
						const startedBefore = h.states.filter(
							x => x.state === "starting",
						).length
						if (o.t === "req") {
							h.pool.request(
								probeRequest({
									trackId: `t${o.track}`,
									priority: o.priority,
									admission: { kind: "undecoded", snrDb: o.snr },
								}),
							)
						} else if (o.t === "rel") {
							const p = h.pool.status()[o.idx]
							if (p) await h.pool.release(p.probeId)
						} else {
							h.cpu.normalisedPercent = o.percent
						}
						await flushAsync()
						const running = h.pool.status()
						expect(
							running.filter(p => p.transport === "offset").length,
						).toBeLessThanOrEqual(maxOffset)
						const cores =
							CPU_COST.engine + running.reduce((sum, p) => sum + p.cores, 0)
						if (running.length > 0)
							expect(cores).toBeLessThanOrEqual(budget + 1e-9)
						for (const p of running)
							expect(p.cores).toBe(probeCores("offset", p.decoderType))
						const guard =
							h.cpu.normalisedPercent !== null &&
							h.cpu.normalisedPercent > settings.cpuGuardPercent
						if (guard && o.t === "req") {
							expect(h.states.filter(x => x.state === "starting").length).toBe(
								startedBefore,
							)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 17: Epoch-bound evidence
	// Validates: spec § 6.5 (H5)
	it("never emits evidence from another epoch or stamped after the probe's epoch ended", async () => {
		type Op =
			| { t: "line"; cc: number; crcErr: boolean; jitter: number }
			| { t: "epoch"; inWindow: boolean }
			| { t: "tick"; ms: number }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				t: fc.constant("line" as const),
				cc: fc.constantFrom(1, 1, 1, 5),
				crcErr: fc.boolean(),
				jitter: fc.integer({ min: -80, max: 0 }),
			}),
			fc.record({ t: fc.constant("epoch" as const), inWindow: fc.boolean() }),
			fc.record({
				t: fc.constant("tick" as const),
				ms: fc.integer({ min: 1, max: 200 }),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(op, { minLength: 1, maxLength: 40 }),
				async ops => {
					const h = poolHarness()
					// when each epoch ended, and how much evidence had been emitted by then
					const epochEnds = new Map<number, { at: number; emitted: number }>()
					h.pool.request(probeRequest({ holdMs: 60_000 }))
					await flushAsync()
					let epoch = 1
					for (const o of ops) {
						if (o.t === "tick") h.clock.now += o.ms
						else if (o.t === "epoch") {
							epochEnds.set(epoch, {
								at: h.clock.now,
								emitted: h.evidence.length,
							})
							epoch += 1
							const centre = o.inWindow
								? 446_100_000 + 12_500 * epoch
								: 460_000_000
							h.engine.setEpoch(epoch, centre)
							await h.pool.onEpoch("rtl", epoch, centre)
							await flushAsync()
						} else {
							for (const p of h.pool.status()) {
								h.decoders.emitLink(
									p.decoderId,
									linkLine(o.cc, h.clock.now + o.jitter, o.crcErr),
								)
							}
							// a late line from every removed decoder of an ended epoch
							for (const id of h.decoders.removed)
								h.decoders.emitLink(id, linkLine(o.cc, h.clock.now, false))
						}
					}
					for (const [i, { req, ev }] of h.evidence.entries()) {
						expect(ev.epoch).toBe(req.epoch)
						const end = epochEnds.get(ev.epoch)
						if (end === undefined) continue
						// emitted after the epoch ended: stamped before the end; emitted before it: a same-ms stamp is a tie
						if (i >= end.emitted) expect(ev.at).toBeLessThan(end.at)
						else expect(ev.at).toBeLessThanOrEqual(end.at)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("re-creates a probe for the new epoch with a recomputed offset when the target stays in the window", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ targetHz: 446_125_000 }))
		await flushAsync()
		h.engine.setEpoch(2, 446_200_000)
		await h.pool.onEpoch("rtl", 2, 446_200_000)
		await flushAsync()
		const [p] = h.pool.status()
		expect(p).toMatchObject({ epoch: 2, targetHz: 446_125_000 })
		expect(
			h.decoders.created.get(p!.decoderId)?.config.options["offsetHz"],
		).toBe(-75_000)
	})

	it("ends a probe on a stream boundary of its source and never reads the new stream's ring", async () => {
		const h = poolHarness()
		h.engine.push(2000)
		const res = h.pool.request(probeRequest({ preRollFromSample: 1000 }))
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		const decoder = h.decoders.created.get(res.started)!
		expect(decoder.received().length).toBe(1000 * 2)
		// reconnect boundary: sample indices restart, the epoch lags the ring (thread host)
		h.engine.newStream()
		h.engine.push(500)
		await flushAsync()
		expect(decoder.received().length).toBe(1000 * 2)
		expect(h.pool.status()).toEqual([])
		expect(h.decoders.removed).toContain(res.started)
		expect(h.states.at(-1)).toEqual({ probeId: res.started, state: "stopped" })
		// the lagging epoch still says epoch 1: its sample indices belong to the old stream
		expect(
			h.pool.request(probeRequest({ trackId: "t2", preRollFromSample: 100 })),
		).toEqual({ deferred: "stale-epoch" })
		h.engine.setEpoch(2, 446_100_000, 1)
		expect(
			h.pool.request(probeRequest({ trackId: "t2", epoch: 2 })),
		).toHaveProperty("started")
		// a boundary while the launch awaits (recording dir): the pre-roll range is gone, nothing is read
		const late = poolHarness()
		late.engine.push(2000)
		const r2 = late.pool.request(
			probeRequest({ preRollFromSample: 1000, record: true }),
		)
		if (!("started" in r2)) throw new Error("not started")
		late.engine.newStream()
		late.engine.push(300)
		await flushAsync()
		await flushAsync()
		expect(late.decoders.created.get(r2.started)?.bytesIn ?? 0).toBe(0)
		expect(late.pool.status()).toEqual([])
	})

	it("adds the voice channel, starts the server, creates the decoder, then attaches it", async () => {
		const calls: string[] = []
		const digitalVoice = {
			addChannel: (config: DecoderConfig) => {
				calls.push("addChannel")
				return Promise.resolve({
					...config,
					options: { ...config.options, output: "udp", udpPort: 50_000 },
				})
			},
			ensureStarted: () => {
				calls.push("ensureStarted")
				return Promise.resolve()
			},
			attachDecoder: () => {
				calls.push("attachDecoder")
			},
			removeChannel: () => {
				calls.push("removeChannel")
				return Promise.resolve()
			},
		}
		const h = poolHarness({ digitalVoice })
		h.decoders.on("decoder:created", () => calls.push("create"))
		const res = h.pool.request(probeRequest())
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		expect(calls).toEqual([
			"addChannel",
			"ensureStarted",
			"create",
			"attachDecoder",
		])
		expect(h.decoders.created.get(res.started)?.config.options["output"]).toBe(
			"udp",
		)
		await h.pool.release(res.started)
		expect(calls.at(-1)).toBe("removeChannel")
	})

	it("treats a probe removed during its start as stopped, not failed", async () => {
		const h = poolHarness()
		h.decoders.failNext = new WaveKitError(
			"removed during start",
			"PROBE_REMOVED",
		)
		const res = h.pool.request(probeRequest())
		if (!("started" in res)) throw new Error("not started")
		await h.pool.release(res.started)
		await flushAsync()
		expect(h.pool.status()).toEqual([])
		expect(h.states.filter(s => s.state === "stopped")).toHaveLength(1)
	})

	it("pairs multimon capcodes only within 2 s of each other", async () => {
		const h = poolHarness()
		const res = h.pool.request(
			probeRequest({ cls: "fsk2-wide", holdMs: 60_000 }),
		)
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		const decoderId = h.pool.status()[0]!.decoderId
		const page = () =>
			h.decoders.emitOutput(decoderId, {
				type: "message",
				timestamp: new Date(h.clock.now),
				data: {
					protocol: "POCSAG1200",
					address: 1234567,
					function: 0,
					messageType: "alpha",
					message: "",
				},
			})
		page()
		h.clock.now += 3000
		page()
		expect(h.evidence).toEqual([])
		h.clock.now += 1000
		page()
		expect(h.evidence.map(e => e.ev.identity)).toEqual([
			{ kind: "pocsag-capcode", value: "1234567" },
		])
	})

	it("watches an engine's streams from its open, so a first request during a lag is stale", () => {
		const h = poolHarness()
		h.pool.watchEngine("rtl", h.engine)
		h.pool.watchEngine("rtl", h.engine)
		expect(h.engine.listenerCount("stream")).toBe(1)
		h.engine.push(2000)
		// reconnect boundary before any request: the epoch still names the old stream
		h.engine.newStream()
		expect(h.pool.request(probeRequest({ preRollFromSample: 1000 }))).toEqual({
			deferred: "stale-epoch",
		})
		h.engine.setEpoch(2, 446_100_000, 1)
		expect(h.pool.request(probeRequest({ epoch: 2 }))).toHaveProperty("started")
		expect(h.engine.listenerCount("stream")).toBe(1)
		// a replaced engine instance takes over the subscription
		const replacement = new FakeEngineView()
		h.pool.watchEngine("rtl", replacement)
		expect(h.engine.listenerCount("stream")).toBe(0)
		expect(replacement.listenerCount("stream")).toBe(1)
	})
})
