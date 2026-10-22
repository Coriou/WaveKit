import { afterAll, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { CPU_COST, probeCores } from "../../../../src/core/scanner/plan/cost.js"
import {
	ProbePool,
	probeModesFor,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { ProbePoolDeps } from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	FakeEngineView,
	PROBE_STORAGE_DIR,
	flushAsync,
	linkLine,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"

afterAll(() => rm(PROBE_STORAGE_DIR, { recursive: true, force: true }))

function poolDeps(pool: ProbePool): ProbePoolDeps {
	return (pool as unknown as { deps: ProbePoolDeps }).deps
}

function held<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(yes => {
		resolve = yes
	})
	return { promise, resolve }
}

function pocsag(address: number, at: number): DecoderOutputLike {
	// message "" is not a plausible payload: the capcode needs a second decode
	return {
		type: "message",
		timestamp: new Date(at),
		data: {
			protocol: "POCSAG1200",
			address,
			function: 0,
			messageType: "alpha",
			message: "",
		},
	}
}
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
			perCallRecordingDir: join(
				PROBE_STORAGE_DIR,
				"recordings",
				"dv",
				`probe-${res.started}`,
			),
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

	it("admits never-served queued requests by SNR when the running probe stops", async () => {
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
		expect(h.pool.status().map(p => p.trackId)).toEqual(["t2"])
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

	it.each(["decoder", "dv"] as const)(
		"contains failed %s preemption while retaining the original and draining its sibling",
		async failed => {
			const gate = held<void>()
			const removeDv = vi.fn(async () => {
				if (failed === "dv")
					throw new WaveKitError("Original DV stop failed", "TEST")
				await gate.promise
			})
			const h = poolHarness({
				digitalVoice: {
					addChannel: async config => ({
						...config,
						options: { ...config.options, output: "udp" },
					}),
					ensureStarted: async () => undefined,
					attachDecoder: () => undefined,
					removeChannel: removeDv,
				},
			})
			const admitted = h.pool.request(
				probeRequest({
					jobId: "low",
					priority: 10,
					record: true,
					holdMs: 60_000,
				}),
			)
			if (!("started" in admitted))
				throw new WaveKitError("Probe not admitted", "TEST")
			const boundary = h.pool as unknown as {
				records: Map<string, { launchSettled: boolean; cleanupState: string }>
				log: { warn: (...args: unknown[]) => void }
			}
			const original = boundary.records.get(admitted.started)!
			await vi.waitFor(() => expect(original.launchSettled).toBe(true))
			const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
			const removeDecoder = vi
				.spyOn(h.decoders, "removeEphemeralDecoder")
				.mockImplementation(async id => {
					if (failed === "decoder") {
						h.decoders.created.delete(id)
						throw new WaveKitError("Original decoder stop failed", "TEST")
					}
					await gate.promise
					h.decoders.created.delete(id)
				})
			const warning = vi.spyOn(boundary.log, "warn")
			const publication = vi.fn()
			h.pool.on("recordings", publication)
			expect(
				h.pool.request(
					probeRequest({ jobId: "high", priority: 90, trackId: "t2" }),
				),
			).toEqual({ deferred: "max-probes" })
			await flushAsync()
			expect(removeDecoder).toHaveBeenCalledOnce()
			expect(removeDv).toHaveBeenCalledOnce()
			expect(original.cleanupState).toBe("unknown")
			let explicitSettled = false
			const explicit = h.pool
				.release(admitted.started)
				.catch((err: unknown) => {
					explicitSettled = true
					return err
				})
			await flushAsync()
			expect(explicitSettled).toBe(false)
			expect(publication).not.toHaveBeenCalled()
			expect(create).not.toHaveBeenCalled()
			gate.resolve()
			expect(await explicit).toMatchObject({
				code: "SCANNER_PROBE_CLEANUP_FAILED",
			})
			await flushAsync()
			expect(warning).toHaveBeenCalledWith(
				expect.objectContaining({
					probeId: admitted.started,
					err: expect.objectContaining({
						code: "SCANNER_PROBE_CLEANUP_FAILED",
					}),
				}),
				"Preempted probe cleanup failed",
			)
			expect(boundary.records.get(admitted.started)).toBe(original)
			expect(original.cleanupState).toBe("unknown")
			expect(h.pool.channelBaselineKnown).toBe(false)
			expect(h.states.filter(state => state.state === "stopped")).toEqual([])
			expect(publication).not.toHaveBeenCalled()
			expect(create).not.toHaveBeenCalled()
			await expect(h.pool.release(admitted.started)).rejects.toMatchObject({
				code: "SCANNER_PROBE_CLEANUP_FAILED",
			})
			await expect(h.pool.destroy()).rejects.toMatchObject({
				code: "SCANNER_PROBE_CLEANUP_FAILED",
			})
		},
	)

	it("steps to the next mode when the hold ends without accepted evidence", async () => {
		vi.useFakeTimers()
		try {
			const h = poolHarness()
			h.pool.request(probeRequest({ holdMs: 600 }))
			await vi.advanceTimersByTimeAsync(10)
			expect(h.pool.status()[0]?.decoderType).toBe("dsd-fme")
			const firstDecoder = [...h.decoders.created.keys()][0]!
			// WG11 req 1.4: the DMR (auto) mode keeps its 1800 ms late entry (was 600 ms)
			await vi.advanceTimersByTimeAsync(1780)
			expect(h.pool.status()[0]?.decoderId).toBe(firstDecoder)
			await vi.advanceTimersByTimeAsync(40)
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

	it("does not re-request an identify probe (priority > 100) on an epoch change: identify re-plans itself", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ targetHz: 446_125_000, priority: 101 }))
		await flushAsync()
		expect(h.decoders.created.size).toBe(1)
		h.engine.setEpoch(2, 446_200_000)
		await h.pool.onEpoch("rtl", 2, 446_200_000)
		await flushAsync()
		expect(h.pool.status()).toEqual([])
		expect(h.decoders.created.size).toBe(0)
		expect(h.decoders.removed).toHaveLength(1)
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
		// let the launch get past its mkdir, so "nothing created" is not just "not created yet"
		const dir = join(
			PROBE_STORAGE_DIR,
			"recordings",
			"dv",
			`probe-${r2.started}`,
		)
		await vi.waitFor(() => expect(existsSync(dir)).toBe(true))
		await flushAsync()
		await flushAsync()
		expect(late.decoders.created.size).toBe(0)
		expect(late.decoders.retired.size).toBe(0)
		// mkdir completion is not launch/cleanup settlement. Wait the actual old owner to drain.
		await vi.waitFor(() => expect(late.pool.status()).toEqual([]))
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

	it("pairs two decodes of one capcode 3 s apart inside the 4 s hold", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ cls: "fsk2-wide", holdMs: 60_000 }))
		await flushAsync()
		const decoderId = h.pool.status()[0]!.decoderId
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toEqual([])
		h.clock.now += 3000
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence.map(e => e.ev.identity)).toEqual([
			{ kind: "pocsag-capcode", value: "1234567" },
		])
	})

	it("does not pair decodes of one capcode straddling hold end + 2 s", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ cls: "fsk2-wide", holdMs: 60_000 }))
		await flushAsync()
		const decoderId = h.pool.status()[0]!.decoderId
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		h.clock.now += 4000 + 2000 + 1
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toEqual([])
		// that decode opened a fresh window: the next one 1 s later pairs
		h.clock.now += 1000
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toHaveLength(1)
	})

	it("does not keep an old capcode pairable through a busy stream of other capcodes", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ cls: "fsk2-wide", holdMs: 60_000 }))
		await flushAsync()
		const decoderId = h.pool.status()[0]!.decoderId
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		for (let i = 0; i < 10; i++) {
			h.clock.now += 1000
			h.decoders.emitOutput(decoderId, pocsag(2_000_000 + i, h.clock.now))
		}
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toEqual([])
	})

	it("ends a source's probes when another engine instance replaces its watch", async () => {
		const h = poolHarness()
		h.pool.watchEngine("rtl", h.engine)
		h.engine.push(1000)
		const res = h.pool.request(probeRequest({ preRollFromSample: 500 }))
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		expect(h.engine.tapCount).toBe(1)
		h.pool.watchEngine("rtl", new FakeEngineView())
		expect(h.engine.tapCount).toBe(0)
		await flushAsync()
		expect(h.pool.status()).toEqual([])
		expect(h.states.at(-1)).toEqual({ probeId: res.started, state: "stopped" })
		expect(h.decoders.removed).toContain(res.started)
	})

	it("resolves a second stop only once the first stop's teardown is done", async () => {
		const h = poolHarness()
		const res = h.pool.request(probeRequest())
		if (!("started" in res)) throw new Error("not started")
		await flushAsync()
		let open = (): void => undefined
		h.decoders.removeGate = new Promise<void>(resolve => {
			open = resolve
		})
		const first = h.pool.release(res.started)
		let secondDone = false
		const second = h.pool.release(res.started).then(() => {
			secondDone = true
		})
		await flushAsync()
		expect(secondDone).toBe(false)
		open()
		await Promise.all([first, second])
		expect(secondDone).toBe(true)
		expect(h.decoders.removed).toContain(res.started)
		expect(h.states.filter(s => s.state === "stopped")).toHaveLength(1)
	})

	it("keeps every mode's recorded calls across a mode step", async () => {
		// fake setTimeout only: the mode hold is driven by the test, the real mkdir still completes
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const h = poolHarness()
			const modes = [
				{ ...probeModesFor("tdma-ms", [])[0]!, holdMs: 1000 },
				{ ...probeModesFor("tdma-ms", [])[1]!, holdMs: 1000 },
			]
			const res = h.pool.request(
				probeRequest({ record: true, holdMs: 2000, modes }),
			)
			if (!("started" in res)) throw new Error("not started")
			const recordings: { calls: { callId: string }[] }[] = []
			h.pool.on("recordings", (r: { calls: { callId: string }[] }) =>
				recordings.push(r),
			)
			const confirming = async (notDecoder: string | null): Promise<string> => {
				for (let i = 0; i < 10_000; i++) {
					const p = h.pool.status()[0]
					if (p?.state === "confirming" && p.decoderId !== notDecoder)
						return p.decoderId
					await flushAsync()
				}
				throw new Error("probe never reached confirming")
			}
			const callEnd = (decoderId: string, callId: string): void =>
				h.decoders.emitOutput(decoderId, {
					type: "call_end",
					timestamp: new Date(h.clock.now),
					data: {
						callId,
						protocol: "dmr",
						startedAt: new Date(h.clock.now - 100).toISOString(),
						encrypted: false,
					},
				})
			const firstDecoder = await confirming(null)
			callEnd(firstDecoder, "c1")
			await vi.advanceTimersByTimeAsync(1001)
			const secondDecoder = await confirming(firstDecoder)
			expect(
				h.decoders.created.get(secondDecoder)?.config.options["mode"],
			).toBe("nxdn")
			callEnd(secondDecoder, "c2")
			await h.pool.release(res.started)
			expect(recordings).toHaveLength(1)
			expect(recordings[0]!.calls.map(c => c.callId)).toEqual(["c1", "c2"])
		} finally {
			vi.useRealTimers()
		}
	})

	it("clamps a long pre-roll so it and the live bytes fit the input cap, with no gap between them", async () => {
		const h = poolHarness()
		const total = 6_000_000 // 12 MB of CU8, more than the 8 MiB input cap
		h.engine.push(total)
		const res = h.pool.request(probeRequest({ preRollFromSample: 0 }))
		if (!("started" in res)) throw new Error("not started")
		h.engine.push(1000)
		await flushAsync()
		await flushAsync()
		const got = h.decoders.created.get(res.started)!.received()
		const preRollSamples = Math.floor((8 * 1024 * 1024 - 2 * 1024 * 1024) / 2)
		expect(got.length).toBe((preRollSamples + 1000) * 2)
		const first = total - preRollSamples
		// every sample in order, from the clamped start through the live bytes
		for (let i = 0; i < preRollSamples + 1000; i += 997) {
			expect(got[2 * i]).toBe((first + i) & 255)
			expect(got[2 * i + 1]).toBe(((first + i) >> 8) & 255)
		}
		const last = preRollSamples + 999
		expect(got[2 * last]).toBe((first + last) & 255)
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

	it("drops a stopped engine's watch and never watches it again (S1-B final review, finding 9)", () => {
		const h = poolHarness()
		h.pool.watchEngine("rtl", h.engine)
		expect(h.engine.listenerCount("stream")).toBe(1)
		h.engine.emit("stream", 0, "stop")
		expect(h.engine.listenerCount("stream")).toBe(0)
		h.pool.watchEngine("rtl", h.engine)
		expect(h.engine.listenerCount("stream")).toBe(0)
		// A request still naming the stopped engine is stale; it never re-subscribes to it.
		expect(h.pool.request(probeRequest())).toEqual({ deferred: "stale-epoch" })
		expect(h.engine.listenerCount("stream")).toBe(0)
		// The next engine instance of the source is watched as usual.
		const next = new FakeEngineView()
		h.pool.watchEngine("rtl", next)
		expect(next.listenerCount("stream")).toBe(1)
	})

	it("keeps an accepted capcode's evidence flowing after its window ended, within the probe", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ cls: "fsk2-wide", holdMs: 60_000 }))
		await flushAsync()
		const decoderId = h.pool.status()[0]!.decoderId
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		h.clock.now += 1000
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toHaveLength(1)
		h.clock.now += 5 * 60_000
		h.decoders.emitOutput(decoderId, pocsag(1234567, h.clock.now))
		expect(h.evidence).toHaveLength(2)
		expect(h.evidence[1]!.ev.identity).toEqual({
			kind: "pocsag-capcode",
			value: "1234567",
		})
		// a never-accepted capcode decoded once: nothing
		h.decoders.emitOutput(decoderId, pocsag(7654321, h.clock.now))
		expect(h.evidence).toHaveLength(2)
	})

	it("never admits a request built against an engine instance that a lazy watch just replaced", async () => {
		const a = new FakeEngineView()
		const engines = [a]
		// room for two probes, so only the replacement can keep the queued one from starting
		const settings = testSettings(s => {
			s.maxProbes.offset = 2
			s.cpuBudgetCores = 4
		})
		const h = poolHarness({ engines, settings })
		const first = h.pool.request(probeRequest({ trackId: "t1" }))
		if (!("started" in first)) throw new Error("not started")
		h.cpu.normalisedPercent = 95
		expect(h.pool.request(probeRequest({ trackId: "t2" }))).toEqual({
			deferred: "cpu",
		})
		h.cpu.normalisedPercent = null
		await flushAsync()
		// the source's engine is replaced without watchEngine; the new instance's epochs restart at 1
		const b = new FakeEngineView()
		engines[0] = b
		h.pool.pump()
		await flushAsync()
		await flushAsync()
		expect(h.pool.status()).toEqual([])
		expect(h.decoders.created.size).toBe(0)
		expect(a.tapCount).toBe(0)
		expect(b.tapCount).toBe(0)
		// request() path: the request that discovers the replacement is stale too
		const c = new FakeEngineView()
		engines[0] = c
		expect(h.pool.request(probeRequest({ trackId: "t3" }))).toEqual({
			deferred: "stale-epoch",
		})
		// once the new instance is watched, a fresh request starts on it
		expect(h.pool.request(probeRequest({ trackId: "t3" }))).toHaveProperty(
			"started",
		)
		expect(c.tapCount).toBe(1)
	})
})

describe("R14 direct-only observed decoder gate", () => {
	it("denies selected channel transport before decoder, DV and recording effects without offset fallback", async () => {
		const dv = {
			addChannel: vi.fn(),
			removeChannel: vi.fn(),
			ensureStarted: vi.fn(),
			attachDecoder: vi.fn(),
		}
		const h = poolHarness({
			digitalVoice: dv,
			transports: [
				{
					kind: "channel",
					preRoll: false,
					maxProbes: () => 4,
					cores: () => 0,
					supports: () => true,
					configure: config => config,
				},
			],
		})
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		h.pool.request(probeRequest({ preRollFromSample: null }))
		await flushAsync()
		expect(create).not.toHaveBeenCalled()
		expect(dv.addChannel).not.toHaveBeenCalled()
		expect(dv.ensureStarted).not.toHaveBeenCalled()
		expect(h.decoders.created.size).toBe(0)
		await h.pool.destroy()
	})
	it("early seal makes queued and later requests unable to start", async () => {
		const h = poolHarness()
		h.pool.sealAdmission()
		expect(h.pool.request(probeRequest())).toEqual({ deferred: "no-transport" })
		h.pool.pump()
		expect(h.decoders.created.size).toBe(0)
		await h.pool.destroy()
	})
})

describe("original probe launch capabilities across early sealing", () => {
	it("waits for the first port allocation's actual close but never allocates the second port", async () => {
		const h = poolHarness()
		expect(h.pool.channelBaselineKnown).toBe(true)
		const gate = held<number>()
		const allocate = vi.fn(() => gate.promise)
		poolDeps(h.pool).allocatePort = allocate
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		h.pool.request(probeRequest({ cls: "afsk-fm" }))
		expect(allocate).toHaveBeenCalledTimes(1)
		h.pool.sealAdmission()
		expect(h.pool.channelBaselineKnown).toBe(false)
		let settled = false
		const stopping = h.pool.destroy().then(() => {
			settled = true
		})
		await flushAsync()
		expect(settled).toBe(false)
		gate.resolve(40_001)
		await stopping
		expect(allocate).toHaveBeenCalledTimes(1)
		expect(create).not.toHaveBeenCalled()
		expect(h.engine.tapCount).toBe(0)
		expect(h.pool.status()).toEqual([])
		expect(h.states.some(s => s.state === "confirming")).toBe(false)
	})

	it("owns a channel returned by held addChannel and removes it without server startup or decoder creation", async () => {
		const gate = held<void>()
		const channels = new Set<string>()
		const actualRemovals: string[] = []
		const dv = {
			addChannel: vi.fn(async (config: DecoderConfig) => {
				await gate.promise
				channels.add(config.id)
				return {
					...config,
					options: { ...config.options, output: "udp", udpPort: 50_000 },
				}
			}),
			removeChannel: vi.fn(async (id: string) => {
				if (channels.delete(id)) actualRemovals.push(id)
			}),
			ensureStarted: vi.fn(async () => undefined),
			attachDecoder: vi.fn(),
		}
		const h = poolHarness({ digitalVoice: dv })
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		expect(dv.addChannel).toHaveBeenCalledTimes(1)
		h.pool.sealAdmission()
		let settled = false
		const stopping = h.pool.destroy().then(() => {
			settled = true
		})
		await flushAsync()
		expect(settled).toBe(false)
		gate.resolve()
		await stopping
		expect(actualRemovals).toEqual([result.started])
		expect(channels.size).toBe(0)
		expect(dv.ensureStarted).not.toHaveBeenCalled()
		expect(dv.attachDecoder).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it("fences a held ensureStarted continuation before create and retains channel cleanup", async () => {
		const gate = held<void>()
		const dv = {
			addChannel: vi.fn(async (config: DecoderConfig) => ({
				...config,
				options: { ...config.options, output: "udp" },
			})),
			removeChannel: vi.fn(async () => undefined),
			ensureStarted: vi.fn(() => gate.promise),
			attachDecoder: vi.fn(),
		}
		const h = poolHarness({ digitalVoice: dv })
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		h.pool.request(probeRequest())
		await flushAsync()
		expect(dv.ensureStarted).toHaveBeenCalledTimes(1)
		h.pool.sealAdmission()
		const stopping = h.pool.destroy()
		gate.resolve()
		await stopping
		expect(create).not.toHaveBeenCalled()
		expect(dv.attachDecoder).not.toHaveBeenCalled()
		expect(dv.removeChannel).toHaveBeenCalled()
	})

	it("removes a decoder returned after sealing, without attaching DV or installing link intake", async () => {
		const gate = held<void>()
		const dv = {
			addChannel: vi.fn(async (config: DecoderConfig) => ({
				...config,
				options: { ...config.options, output: "udp" },
			})),
			removeChannel: vi.fn(async () => undefined),
			ensureStarted: vi.fn(async () => undefined),
			attachDecoder: vi.fn(),
		}
		const h = poolHarness({ digitalVoice: dv })
		const original = h.decoders.createEphemeralDecoder.bind(h.decoders)
		vi.spyOn(h.decoders, "createEphemeralDecoder").mockImplementation(
			async (config, options) => {
				await gate.promise
				return original(config, options)
			},
		)
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		await flushAsync()
		expect(h.engine.tapCount).toBe(1)
		h.pool.sealAdmission()
		let settled = false
		const stopping = h.pool.destroy().then(() => {
			settled = true
		})
		await flushAsync()
		expect(settled).toBe(false)
		expect(h.engine.tapCount).toBe(0)
		gate.resolve()
		await stopping
		const retired = h.decoders.retired.get(result.started)!
		expect(retired).toBeDefined()
		expect(retired.listenerCount("link")).toBe(0)
		expect(retired.input?.destroyed).toBe(true)
		expect(h.decoders.removed).toEqual([result.started])
		expect(dv.attachDecoder).not.toHaveBeenCalled()
		expect(h.states.some(s => s.state === "confirming")).toBe(false)
	})

	it("drops active output and bytes synchronously between early seal and phase40", async () => {
		const h = poolHarness()
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		await flushAsync()
		const decoder = h.decoders.created.get(result.started)!
		const bytes = decoder.bytesIn
		h.pool.sealAdmission()
		h.engine.push(500)
		h.decoders.emitLink(result.started, linkLine(7, h.clock.now))
		h.decoders.emitOutput(result.started, {
			type: "sync",
			timestamp: new Date(h.clock.now),
			data: { protocol: "dmr" },
		})
		expect(decoder.bytesIn).toBe(bytes)
		expect(h.evidence).toEqual([])
		await h.pool.destroy()
	})

	it("captures a tap remover returned after synchronous sealing inside tap installation", async () => {
		const h = poolHarness()
		const tap = h.engine.tap.bind(h.engine)
		vi.spyOn(h.engine, "tap").mockImplementation(callback => {
			const remove = tap(callback)
			h.pool.sealAdmission()
			return remove
		})
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		h.pool.request(probeRequest())
		await h.pool.destroy()
		expect(h.engine.tapCount).toBe(0)
		expect(create).not.toHaveBeenCalled()
	})

	it("owns reentrant teardown before untap callbacks and does not await itself", async () => {
		const h = poolHarness()
		const tap = h.engine.tap.bind(h.engine)
		let probeId = ""
		let nested: Promise<void> | undefined
		vi.spyOn(h.engine, "tap").mockImplementation(callback => {
			const untap = tap(callback)
			return () => {
				nested = h.pool.release(probeId)
				untap()
			}
		})
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		probeId = result.started
		await flushAsync()
		await h.pool.release(probeId)
		await nested
		expect(h.engine.tapCount).toBe(0)
		expect(h.decoders.removed).toEqual([probeId])
		expect(h.states.filter(s => s.state === "stopped")).toHaveLength(1)
		await h.pool.destroy()
	})

	it("preserves cleanup-only settlement of already-owned DV artifacts after the intake seal", async () => {
		const h = poolHarness()
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		await flushAsync()
		const records = (
			h.pool as unknown as {
				records: Map<string, { recordDir: string | null }>
			}
		).records
		records.get(result.started)!.recordDir = "already-owned-dv-directory"
		const settlements: unknown[] = []
		h.pool.on("recordings", value => settlements.push(value))
		h.pool.sealAdmission()
		await h.pool.destroy()
		expect(settlements).toEqual([
			expect.objectContaining({
				probeId: result.started,
				probeDir: "already-owned-dv-directory",
				calls: [],
			}),
		])
		expect(h.evidence).toEqual([])
	})

	it("attempts decoder, DV and sibling probe cleanup even when one remover throws and another is held", async () => {
		const gate = held<void>()
		const removedDv: string[] = []
		const dv = {
			addChannel: async (config: DecoderConfig) => ({
				...config,
				options: { ...config.options, output: "udp" },
			}),
			ensureStarted: async () => undefined,
			attachDecoder: () => undefined,
			removeChannel: async (id: string) => {
				removedDv.push(id)
			},
		}
		const settings = testSettings()
		settings.maxProbes.offset = 2
		settings.cpuBudgetCores = 4
		const h = poolHarness({ settings, digitalVoice: dv })
		expect(h.pool.request(probeRequest({ trackId: "a" }))).toHaveProperty(
			"started",
		)
		expect(h.pool.request(probeRequest({ trackId: "b" }))).toHaveProperty(
			"started",
		)
		await flushAsync()
		const ids = h.pool.status().map(s => s.decoderId)
		expect(ids).toHaveLength(2)
		const remove = h.decoders.removeEphemeralDecoder.bind(h.decoders)
		const attempts: string[] = []
		vi.spyOn(h.decoders, "removeEphemeralDecoder").mockImplementation(
			async id => {
				attempts.push(id)
				if (id === ids[0]) throw new WaveKitError("Removal failed", "TEST")
				await gate.promise
				await remove(id)
			},
		)
		const stopping = h.pool.destroy()
		const handled = stopping.catch((err: unknown) => err)
		await flushAsync()
		expect(attempts).toEqual(expect.arrayContaining(ids))
		expect(removedDv).toEqual(expect.arrayContaining(ids))
		expect(h.engine.tapCount).toBe(0)
		gate.resolve()
		expect(await handled).toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(h.decoders.created.has(ids[0]!)).toBe(true)
		expect(h.decoders.created.has(ids[1]!)).toBe(false)
		expect(h.pool.channelBaselineKnown).toBe(false)
		expect(h.pool.request(probeRequest({ trackId: "c" }))).toEqual({
			deferred: "no-transport",
		})
	})
})

describe("ProbePool exact constructor subscription ownership", () => {
	it("a remover invoked while on is in progress seals it and cleans the eventual installation", async () => {
		const h = poolHarness()
		await h.pool.destroy()
		const owned: (() => void)[] = []
		let initialRemoval: unknown
		h.decoders.on("newListener", event => {
			if (event !== "decoder:output") return
			try {
				owned[0]!()
			} catch (err: unknown) {
				initialRemoval = err
			}
		})
		expect(
			() =>
				new ProbePool({
					...poolDeps(h.pool),
					ownConstructorListener: remove => {
						owned.push(remove)
						return true
					},
				}),
		).toThrow(expect.objectContaining({ code: "SCANNER_OWNER_UNAVAILABLE" }))
		expect(initialRemoval).toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_UNKNOWN",
		})
		expect(h.decoders.listenerCount("decoder:output")).toBe(0)
		expect(() => owned[0]!()).not.toThrow()
	})

	it("owns before install and cleans an install-then-throw while preserving the original exception", async () => {
		const h = poolHarness()
		await h.pool.destroy()
		const unrelated = (): void => undefined
		h.decoders.on("decoder:output", unrelated)
		const originalFailure = new WaveKitError(
			"Installed then threw",
			"TEST_CONSTRUCTION",
		)
		const on = h.decoders.on.bind(h.decoders)
		const owned: (() => void)[] = []
		vi.spyOn(h.decoders, "on").mockImplementation((event, callback) => {
			if (event === "decoder:output") expect(owned).toHaveLength(1)
			on(event, callback)
			if (event === "decoder:output") throw originalFailure
			return h.decoders
		})
		expect(
			() =>
				new ProbePool({
					...poolDeps(h.pool),
					ownConstructorListener: remove => {
						owned.push(remove)
						return true
					},
				}),
		).toThrow(originalFailure)
		expect(h.decoders.listeners("decoder:output")).toEqual([unrelated])
		expect(() => owned[0]!()).not.toThrow()
	})

	it("denies before installation when the external constructor owner refuses", async () => {
		const h = poolHarness()
		await h.pool.destroy()
		const on = vi.spyOn(h.decoders, "on")
		expect(
			() =>
				new ProbePool({
					...poolDeps(h.pool),
					ownConstructorListener: () => false,
				}),
		).toThrow(expect.objectContaining({ code: "SCANNER_OWNER_UNAVAILABLE" }))
		expect(on).not.toHaveBeenCalled()
	})

	it("retains a failed exact remover after constructor throw instead of claiming absence", async () => {
		const h = poolHarness()
		await h.pool.destroy()
		const originalFailure = new WaveKitError(
			"Installed then threw",
			"TEST_CONSTRUCTION",
		)
		const on = h.decoders.on.bind(h.decoders)
		const off = h.decoders.off.bind(h.decoders)
		let refuse = true
		const owned: (() => void)[] = []
		vi.spyOn(h.decoders, "on").mockImplementation((event, callback) => {
			on(event, callback)
			if (event === "decoder:output") throw originalFailure
			return h.decoders
		})
		vi.spyOn(h.decoders, "off").mockImplementation((event, callback) => {
			if (refuse && event === "decoder:output") return h.decoders
			return off(event, callback)
		})
		expect(
			() =>
				new ProbePool({
					...poolDeps(h.pool),
					ownConstructorListener: remove => {
						owned.push(remove)
						return true
					},
				}),
		).toThrow(originalFailure)
		expect(h.decoders.listenerCount("decoder:output")).toBe(1)
		expect(() => owned[0]!()).toThrow(
			expect.objectContaining({ code: "SCANNER_COMPONENT_CLEANUP_UNKNOWN" }),
		)
		refuse = false
		owned[0]!()
		expect(h.decoders.listenerCount("decoder:output")).toBe(0)
	})

	it("destroy attempts stream/probe cleanup even when exact output removal fails", async () => {
		const h = poolHarness()
		const result = h.pool.request(probeRequest())
		if (!("started" in result))
			throw new WaveKitError("Probe not started", "TEST")
		await flushAsync()
		const off = h.decoders.off.bind(h.decoders)
		let refuse = true
		vi.spyOn(h.decoders, "off").mockImplementation((event, callback) => {
			if (refuse && event === "decoder:output")
				throw new WaveKitError("off failed", "TEST")
			return off(event, callback)
		})
		await expect(h.pool.destroy()).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(h.decoders.removed).toContain(result.started)
		expect(h.engine.tapCount).toBe(0)
		expect(h.engine.listenerCount("stream")).toBe(0)
		expect(h.decoders.listenerCount("decoder:output")).toBe(1)
		refuse = false
		await expect(h.pool.destroy()).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(h.decoders.listenerCount("decoder:output")).toBe(0)
	})
})

describe("NC2 failed original drain cannot authorize a mode successor", () => {
	it("retains the failed writer despite later missing-map removal and never starts the next mode", async () => {
		const h = poolHarness()
		const result = h.pool.request(probeRequest({ holdMs: 60_000 }))
		if (!("started" in result))
			throw new WaveKitError("Probe not admitted", "TEST")
		await flushAsync()
		const originalDecoder = h.decoders.created.get(result.started)!
		expect(originalDecoder).toBeDefined()
		let first = true
		const remove = vi
			.spyOn(h.decoders, "removeEphemeralDecoder")
			.mockImplementation(async id => {
				h.decoders.created.delete(id)
				if (first) {
					first = false
					throw new WaveKitError("Original writer unknown", "TEST")
				}
			})
		const create = vi.spyOn(h.decoders, "createEphemeralDecoder")
		const boundary = h.pool as unknown as {
			records: Map<string, { cleanupState: string; recordDir: string | null }>
			onModeTimeout(record: unknown): Promise<void>
		}
		const record = boundary.records.get(result.started)!
		record.recordDir = "original-owned-directory"
		const publication = vi.fn()
		h.pool.on("recordings", publication)
		await expect(boundary.onModeTimeout(record)).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(record.cleanupState).toBe("unknown")
		expect(create).not.toHaveBeenCalled()
		await expect(h.pool.release(result.started)).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(remove).toHaveBeenCalledOnce()
		expect(publication).not.toHaveBeenCalled()
		expect(h.pool.status()[0]?.state).toBe("stopping")
		await expect(h.pool.destroy()).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
	})
})

describe("NC2 original failure versus later missing-map completion", () => {
	it("an early failed writer stop remains unknown after the pending create and late empty-map removal settle", async () => {
		const h = poolHarness()
		const gate = held<void>()
		const create = h.decoders.createEphemeralDecoder.bind(h.decoders)
		vi.spyOn(h.decoders, "createEphemeralDecoder").mockImplementation(
			async (...args) => {
				const decoder = await create(...args)
				await gate.promise
				return decoder
			},
		)
		const result = h.pool.request(
			probeRequest({ record: true, holdMs: 60_000 }),
		)
		if (!("started" in result))
			throw new WaveKitError("Probe not admitted", "TEST")
		await vi.waitFor(() =>
			expect(h.decoders.created.has(result.started)).toBe(true),
		)
		const originalWriter = h.decoders.created.get(result.started)!
		let first = true
		const remove = vi
			.spyOn(h.decoders, "removeEphemeralDecoder")
			.mockImplementation(async id => {
				h.decoders.created.delete(id)
				if (first) {
					first = false
					throw new WaveKitError("Original writer stop failed", "TEST")
				}
			})
		const publication = vi.fn()
		h.pool.on("recordings", publication)
		const stopping = h.pool
			.release(result.started)
			.catch((error: unknown) => error)
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
		expect(h.engine.tapCount).toBe(0)
		gate.resolve()
		expect(await stopping).toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
		expect(remove).toHaveBeenCalledTimes(2)
		expect(originalWriter).toBeDefined()
		expect(publication).not.toHaveBeenCalled()
		expect(h.pool.channelBaselineKnown).toBe(false)
		await expect(h.pool.destroy()).rejects.toMatchObject({
			code: "SCANNER_PROBE_CLEANUP_FAILED",
		})
	})
})
