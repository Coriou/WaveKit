import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	createIqReplayQueue,
	IQ_REPLAY_DEFER_MAX_MS,
	IQ_REPLAY_DEFER_RETRY_MS,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayProbeAnswer,
	type IqReplayProbeRequest,
	type IqReplayProbes,
	type IqReplayQueueDeps,
	type IqReplayQueuePort,
	type IqReplayQueueTimers,
} from "../../../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
	IqReplayPlanInput,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { ProbeMode } from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	ANALOG_TRIAL_CORES,
	type AnalogTrialOutcome,
	type AnalogTrialResult,
	type AnalogTrialRunner,
	type ObservationEvidenceSink,
	type ProofAnalogInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import { flush, spyLogger } from "./helpers.js"

const mode = (protocol: ScannerProtocol): ProbeMode => ({
	decoderType: protocol === "pocsag" ? "multimon-ng" : "dsd-fme",
	protocol,
	covers: [protocol],
	options: {},
	holdMs: 1000,
})
const trial = (protocol: ScannerProtocol, known = false): IqReplayTrial => ({
	protocol,
	mode: mode(protocol),
	known,
})

class FakePort implements IqReplayQueuePort {
	entries = new Map<
		string,
		{ view: IqCaptureView; holder: string | null; replayed: boolean }
	>()
	discarded: [string, IqCaptureDiscardReason][] = []
	private listeners = new Set<(v: IqCaptureView) => void>()
	add(id: string, sourceId = "s"): IqCaptureView {
		const view: IqCaptureView = {
			captureId: id,
			sourceId,
			observationId: "o",
			epoch: 1,
			rfHz: 1e8,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 1000,
			gapSamples: 0,
		}
		this.entries.set(id, { view, holder: null, replayed: false })
		for (const l of this.listeners) l(view)
		return view
	}
	onFinished(l: (v: IqCaptureView) => void) {
		this.listeners.add(l)
		return () => this.listeners.delete(l)
	}
	view(id: string) {
		return this.entries.get(id)?.view ?? null
	}
	holderOf(id: string) {
		const e = this.entries.get(id)
		return e ? e.holder : undefined
	}
	claim(id: string, holder: string) {
		const e = this.entries.get(id)
		if (!e || e.holder !== null || e.replayed) return false
		e.holder = holder
		return true
	}
	settle(id: string, holder: string) {
		const e = this.entries.get(id)
		if (!e || e.holder !== holder) return
		this.entries.delete(id)
		this.discarded.push([id, "result"])
	}
	discard(id: string, reason: IqCaptureDiscardReason, holder?: string) {
		const e = this.entries.get(id)
		if (!e || (e.holder !== null && e.holder !== holder)) return false
		this.entries.delete(id)
		this.discarded.push([id, reason])
		return true
	}
}

class Timers implements IqReplayQueueTimers {
	q = new Map<number, () => void>()
	seq = 0
	setTimeout(fn: () => void) {
		this.q.set(++this.seq, fn)
		return this.seq
	}
	clearTimeout(h: unknown) {
		this.q.delete(h as number)
	}
	fireAll() {
		const fns = [...this.q.values()]
		this.q.clear()
		for (const f of fns) f()
	}
}

type Script = (
	req: IqReplayProbeRequest,
	n: number,
) => { deferred: string } | IqReplayProbeAnswer

function makeProbes(script: Script) {
	const requests: IqReplayProbeRequest[] = []
	let running = 0
	let maxRunning = 0
	const release = new Set<() => void>()
	let cancels = 0
	const probes: IqReplayProbes = {
		request(req) {
			requests.push(req)
			const a = script(req, requests.length)
			if ("deferred" in a) return { deferred: a.deferred }
			running++
			maxRunning = Math.max(maxRunning, running)
			let resolve!: (x: IqReplayProbeAnswer) => void
			const result = new Promise<IqReplayProbeAnswer>(r => (resolve = r))
			queueMicrotask(() => {
				running--
				resolve(a)
			})
			return {
				run: {
					result,
					cancel: () => {
						cancels++
					},
				},
			}
		},
		onSlotRelease(l) {
			release.add(l)
			return () => release.delete(l)
		},
	}
	return {
		probes,
		requests,
		maxRunning: () => maxRunning,
		releaseSlot: () => {
			for (const l of [...release]) l()
		},
		listeners: () => release.size,
		cancels: () => cancels,
	}
}

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function make(
	script: Script,
	trials: readonly IqReplayTrial[] = [trial("dmr", true), trial("pocsag")],
	now?: () => number,
) {
	const port = new FakePort()
	const p = makeProbes(script)
	const results: IqReplayResult[] = []
	const timers = new Timers()
	const q = createIqReplayQueue({
		port,
		probes: p.probes,
		planner: () => trials,
		sink: r => results.push(r),
		planInput: capture => ({
			capture,
			track: null,
			knownProtocol: null,
			priors: {},
			narrowRaster: false,
		}),
		logger: spyLogger().logger,
		timers,
		...(now ? { now } : {}),
	})
	q.start()
	return { q, port, p, results, timers }
}

const miss: IqReplayProbeAnswer = { outcome: "no-sync", decoded: null }
const hit: IqReplayProbeAnswer = {
	outcome: "decoded",
	decoded: { protocol: "dmr", identity: { kind: "dmr-cc", value: "1" } },
}

describe("IqReplayQueue", () => {
	it("runs trials in order, stops at the first decode, one result then discard", async () => {
		const { port, p, results } = make(() => hit)
		port.add(id(1))
		await flush()
		expect(p.requests.map(r => r.protocol)).toEqual(["dmr"])
		expect(results).toHaveLength(1)
		expect(results[0]?.decoded?.protocol).toBe("dmr")
		expect(port.discarded).toEqual([[id(1), "result"]])
	})

	it("no decode: every trial ran, result null, then discard", async () => {
		const { port, p, results } = make(() => miss)
		port.add(id(1))
		await flush()
		expect(p.requests.map(r => r.protocol)).toEqual(["dmr", "pocsag"])
		expect(results[0]?.decoded).toBeNull()
		expect(
			results[0]?.trials.map(t => [t.protocol, t.known, t.outcome]),
		).toEqual([
			["dmr", true, "no-sync"],
			["pocsag", false, "no-sync"],
		])
	})

	it("a 'decoded' outcome without a decode or a hostile answer is not a result decode", async () => {
		const { port, results } = make(
			(_r, n) =>
				(n === 1
					? { outcome: "decoded", decoded: null }
					: { outcome: "bogus", decoded: hit.decoded }) as IqReplayProbeAnswer,
		)
		port.add(id(1))
		await flush()
		expect(results[0]?.decoded).toBeNull()
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"no-sync",
			"cancelled",
		])
	})

	it("known trials first, at most 8", async () => {
		const many = [
			...Array.from({ length: 9 }, () => trial("pocsag")),
			trial("dmr", true),
		]
		const { port, p } = make(() => miss, many)
		port.add(id(1))
		await flush(20)
		expect(p.requests).toHaveLength(8)
		expect(p.requests[0]?.protocol).toBe("dmr")
	})

	it("skips captures claimed by identify and gone ones", async () => {
		const { q, port, p, results } = make(() => miss)
		const v = port.add(id(1))
		await flush()
		expect(results).toHaveLength(1)
		port.entries.set(id(2), {
			view: { ...v, captureId: id(2) },
			holder: "identify-job",
			replayed: false,
		})
		q.enqueue({ ...v, captureId: id(2) })
		q.enqueue({ ...v, captureId: id(3) })
		await flush()
		expect(results).toHaveLength(1)
		expect(q.counters().skipped).toBe(2)
		expect(port.entries.get(id(2))?.holder).toBe("identify-job")
		expect(p.requests.every(r => r.captureId === id(1))).toBe(true)
	})

	it("a capture confirmed live while its first request is deferred gets no result", async () => {
		const { port, p, results, timers } = make(() => ({ deferred: "cpu" }))
		port.add(id(1))
		await flush()
		expect(p.requests).toHaveLength(1)
		port.discard(id(1), "confirmed-live", IQ_REPLAY_QUEUE_HOLDER)
		timers.fireAll()
		await flush()
		expect(results).toHaveLength(0)
		expect(p.requests).toHaveLength(1)
	})

	it("a deferral waits without spinning: retried on slot release or the 1 s timer", async () => {
		let defer = 2
		const { port, p, results, timers } = make(() =>
			defer-- > 0 ? { deferred: "budget" } : miss,
		)
		port.add(id(1))
		await flush()
		expect(p.requests).toHaveLength(1)
		expect(p.listeners()).toBe(1)
		expect(timers.q.size).toBe(1)
		await flush()
		expect(p.requests).toHaveLength(1)
		p.releaseSlot()
		expect(p.requests).toHaveLength(2)
		expect(timers.q.size).toBe(1)
		timers.fireAll()
		await flush()
		expect(p.requests).toHaveLength(4)
		expect(results).toHaveLength(1)
		expect(p.listeners()).toBe(0)
		expect(IQ_REPLAY_DEFER_RETRY_MS).toBe(1000)
	})

	it("a non-retriable deferral (no-transport, format, stale-epoch, thrown, unknown) cancels the trial at once", async () => {
		for (const reason of [
			"no-transport",
			"format",
			"stale-epoch",
			"weird",
			"throw",
		]) {
			const { port, p, results, timers } = make((_r, n) => {
				if (n === 1) {
					if (reason === "throw") throw new Error("boom")
					return { deferred: reason }
				}
				return miss
			})
			port.add(id(1))
			await flush()
			expect(timers.q.size).toBe(0)
			expect(p.listeners()).toBe(0)
			expect(p.requests.map(r => r.protocol)).toEqual(["dmr", "pocsag"])
			expect(results).toHaveLength(1)
			expect(results[0]?.trials.map(t => t.outcome)).toEqual([
				"cancelled",
				"no-sync",
			])
			expect(port.discarded).toEqual([[id(1), "result"]])
		}
	})

	it("a head whose source has no transport does not hold another source's capture", async () => {
		const { port, results, timers } = make(r =>
			r.sourceId === "s" ? { deferred: "no-transport" } : hit,
		)
		port.add(id(1))
		port.add(id(2), "s2")
		await flush()
		expect(timers.q.size).toBe(0)
		expect(results.map(r => [r.captureId, r.decoded !== null])).toEqual([
			[id(1), false],
			[id(2), true],
		])
	})

	it("transient deferrals are retried up to IQ_REPLAY_DEFER_MAX_MS, then the remaining trials end cancelled", async () => {
		let t = 0
		const { port, p, results, timers, q } = make(
			() => ({ deferred: "max-probes" }),
			[trial("dmr", true), trial("pocsag")],
			() => t,
		)
		port.add(id(1))
		port.add(id(2))
		await flush()
		expect(IQ_REPLAY_DEFER_MAX_MS).toBe(60_000)
		t = IQ_REPLAY_DEFER_MAX_MS - 1
		timers.fireAll()
		await flush()
		// 59 999 ms: still waiting on the head.
		expect(p.requests).toHaveLength(2)
		expect(results).toHaveLength(0)
		expect(timers.q.size).toBe(1)
		t = IQ_REPLAY_DEFER_MAX_MS
		timers.fireAll()
		await flush()
		// 60 000 ms: the head gives up; both trials cancelled, one result, the next capture runs.
		expect(results).toHaveLength(1)
		expect(results[0]?.captureId).toBe(id(1))
		expect(results[0]?.trials.map(x => x.outcome)).toEqual([
			"cancelled",
			"cancelled",
		])
		expect(q.counters().deferGiveUps).toBe(1)
		expect(p.requests.at(-1)?.captureId).toBe(id(2))
		// The second capture's window starts at its own first deferral.
		t += IQ_REPLAY_DEFER_MAX_MS - 1
		timers.fireAll()
		await flush()
		expect(results).toHaveLength(1)
		t += 1
		timers.fireAll()
		await flush()
		expect(results).toHaveLength(2)
		expect(q.size()).toBe(0)
	})

	it("stop cancels the running replay and discards everything without a result", async () => {
		const port = new FakePort()
		let cancelled = 0
		const q = createIqReplayQueue({
			port,
			probes: {
				request: () => ({
					run: {
						result: new Promise<IqReplayProbeAnswer>(() => {}),
						cancel: () => cancelled++,
					},
				}),
				onSlotRelease: () => () => {},
			},
			planner: () => [trial("dmr")],
			sink: () => {
				throw new Error("no result expected")
			},
			planInput: capture => ({
				capture,
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			}),
			logger: spyLogger().logger,
		})
		q.start()
		port.add(id(1))
		port.add(id(2))
		port.add(id(3))
		port.entries.get(id(3))!.holder = "identify"
		await q.stop()
		expect(cancelled).toBe(1)
		expect(port.discarded).toEqual([
			[id(1), "shutdown"],
			[id(2), "shutdown"],
		])
		expect(port.entries.has(id(3))).toBe(true)
		port.add(id(4))
		expect(q.size()).toBe(0)
	})

	it("a throwing planner or sink never stalls the queue", async () => {
		const port = new FakePort()
		let calls = 0
		const q = createIqReplayQueue({
			port,
			probes: makeProbes(() => miss).probes,
			planner: () => {
				calls++
				if (calls === 1) throw new Error("planner")
				return [trial("dmr")]
			},
			sink: () => {
				throw new Error("sink")
			},
			planInput: capture => ({
				capture,
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			}),
			logger: spyLogger().logger,
		})
		q.start()
		port.add(id(1))
		port.add(id(2))
		await flush()
		expect(port.discarded.map(d => d[0])).toEqual([id(1), id(2)])
		expect(q.counters()).toMatchObject({
			plannerErrors: 1,
			sinkErrors: 2,
			results: 2,
		})
	})
})

// Feature: web-gaps-11, Property 15: Queue order holds
// Validates: Requirements 6.4, 6.5, 6.8
describe("Property 15: queue order holds", () => {
	type Ev =
		| { k: "arrive" }
		| { k: "claim"; i: number }
		| { k: "live"; i: number }
		| { k: "release" }
		| { k: "timer" }
		| { k: "tick" }
	const ev: fc.Arbitrary<Ev> = fc.oneof(
		fc.constant({ k: "arrive" as const }),
		fc.record({ k: fc.constant("claim" as const), i: fc.nat(20) }),
		fc.record({ k: fc.constant("live" as const), i: fc.nat(20) }),
		fc.constant({ k: "release" as const }),
		fc.constant({ k: "timer" as const }),
		fc.constant({ k: "tick" as const }),
	)
	const answer = fc.oneof(
		fc.constant<"defer">("defer"),
		fc.constantFrom<IqReplayProbeAnswer>(
			hit,
			miss,
			{ outcome: "timeout", decoded: null },
			{ outcome: "cancelled", decoded: null },
			{ outcome: "crc-errors", decoded: null },
		),
	)

	it("capture → queue → trials (known first, one at a time) → one result → discard", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(ev, { maxLength: 40 }),
				fc.array(answer, { minLength: 1, maxLength: 30 }),
				fc.integer({ min: 0, max: 5 }),
				async (events, answers, nTrials) => {
					const trials = [
						trial("dmr", true),
						trial("pocsag"),
						trial("p25p1"),
						trial("ysf"),
						trial("nxdn48"),
					].slice(0, nTrials)
					let a = 0
					let running = 0
					let maxRunning = 0
					const pending: (() => void)[] = []
					const release = new Set<() => void>()
					const requests: IqReplayProbeRequest[] = []
					const probes: IqReplayProbes = {
						request(req) {
							const x = answers[a++ % answers.length]
							requests.push(req)
							if (x === "defer" || x === undefined) return { deferred: "cpu" }
							running++
							maxRunning = Math.max(maxRunning, running)
							let resolve!: (v: IqReplayProbeAnswer) => void
							const result = new Promise<IqReplayProbeAnswer>(
								r => (resolve = r),
							)
							pending.push(() => {
								running--
								resolve(x)
							})
							return { run: { result, cancel: () => {} } }
						},
						onSlotRelease: l => {
							release.add(l)
							return () => release.delete(l)
						},
					}
					const port = new FakePort()
					const results: IqReplayResult[] = []
					const timers = new Timers()
					const q = createIqReplayQueue({
						port,
						probes,
						planner: () => trials,
						sink: r => {
							// The capture is still held by the queue when its result is delivered.
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
						timers,
					})
					q.start()
					let n = 0
					const claimedByIdentify = new Set<string>()
					const step = async () => {
						const fn = pending.shift()
						fn?.()
						await flush(2)
					}
					for (const e of events) {
						if (e.k === "arrive") port.add(id(n++))
						else if (e.k === "claim") {
							const cid = id(e.i % Math.max(1, n))
							if (port.claim(cid, "identify")) claimedByIdentify.add(cid)
						} else if (e.k === "live") {
							const cid = id(e.i % Math.max(1, n))
							const entry = port.entries.get(cid)
							// A live confirmation only discards captures whose replay has not started.
							if (entry && !requests.some(r => r.captureId === cid))
								port.discard(cid, "confirmed-live", entry.holder ?? undefined)
						} else if (e.k === "release") for (const l of [...release]) l()
						else if (e.k === "timer") timers.fireAll()
						else await step()
						expect(maxRunning).toBeLessThanOrEqual(1)
					}
					// Drain: answers settle, deferrals retried until the queue is empty.
					for (let i = 0; i < 400 && q.size() > 0; i++) {
						await step()
						timers.fireAll()
						await flush(1)
						if (i > 300) answers.fill(miss)
					}
					expect(q.size()).toBe(0)
					expect(maxRunning).toBeLessThanOrEqual(1)
					const seen = new Set<string>()
					for (const r of results) {
						expect(seen.has(r.captureId)).toBe(false)
						seen.add(r.captureId)
						expect(claimedByIdentify.has(r.captureId)).toBe(false)
						// Stops at the first decode; known first.
						const firstHit = r.trials.findIndex(t => t.outcome === "decoded")
						if (r.decoded) expect(firstHit).toBe(r.trials.length - 1)
						else expect(r.trials.length).toBe(trials.length)
						if (r.trials.length > 0 && trials[0]?.known)
							expect(r.trials[0]?.known).toBe(true)
						// Discarded right after its one result.
						expect(port.entries.has(r.captureId)).toBe(false)
						expect(port.discarded.filter(d => d[0] === r.captureId)).toEqual([
							[r.captureId, "result"],
						])
					}
					for (const cid of claimedByIdentify) {
						expect(requests.some(r => r.captureId === cid)).toBe(false)
						// Still held by identify unless a live confirmation discarded it.
						if (port.entries.has(cid))
							expect(port.entries.get(cid)?.holder).toBe("identify")
						else expect(port.discarded).toContainEqual([cid, "confirmed-live"])
					}
					// Every capture the queue saw and that was not taken by identify or
					// confirmed live reached exactly one result.
					for (let i = 0; i < n; i++) {
						const cid = id(i)
						const live = port.discarded.some(
							d => d[0] === cid && d[1] === "confirmed-live",
						)
						if (!claimedByIdentify.has(cid) && !live)
							expect(seen.has(cid)).toBe(true)
					}
					await q.stop()
				},
			),
			{ numRuns: 150 },
		)
	}, 30_000)
})

describe("IqReplayQueue leaves identify's captures alone (Main review M2)", () => {
	function withSkip(skip: (v: IqCaptureView) => boolean) {
		const port = new FakePort()
		const p = makeProbes(() => miss)
		const results: IqReplayResult[] = []
		const q = createIqReplayQueue({
			port,
			probes: p.probes,
			planner: () => [trial("dmr")],
			sink: r => results.push(r),
			planInput: capture => ({
				capture,
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			}),
			skip,
			logger: spyLogger().logger,
			timers: new Timers(),
		})
		q.start()
		return { q, port, p, results }
	}

	it("a capture whose observation has an active identify target is parked unclaimed", async () => {
		const s = withSkip(v => v.captureId === id(1))
		s.port.add(id(1))
		s.port.add(id(2))
		await flush()
		expect(s.port.holderOf(id(1))).toBeNull()
		expect(s.results.map(r => r.captureId)).toEqual([id(2)])
		expect(s.q.counters().parked).toBe(1)
	})

	it("a throwing predicate fails closed: the capture is skipped", async () => {
		const s = withSkip(() => {
			throw new Error("boom")
		})
		s.port.add(id(1))
		await flush()
		expect(s.p.requests).toEqual([])
		expect(s.port.holderOf(id(1))).toBeNull()
	})

	it("a capture reserved for an identify job (held at capture) is never replayed", async () => {
		const s = withSkip(() => false)
		const view: IqCaptureView = {
			captureId: id(3),
			sourceId: "s",
			observationId: "o",
			epoch: 1,
			rfHz: 1e8,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 1000,
			gapSamples: 0,
		}
		s.port.entries.set(id(3), {
			view,
			holder: "identify-job",
			replayed: false,
		})
		s.q.enqueue(view)
		await flush()
		expect(s.p.requests).toEqual([])
		expect(s.port.holderOf(id(3))).toBe("identify-job")
	})
})

describe("IqReplayQueue keeps skipped captures queued", () => {
	function parked() {
		const port = new FakePort()
		const p = makeProbes(() => miss)
		const timers = new Timers()
		const state = { activeIdentify: true }
		const results: IqReplayResult[] = []
		const q = createIqReplayQueue({
			port,
			probes: p.probes,
			planner: () => [trial("dmr")],
			sink: r => results.push(r),
			planInput: capture => ({
				capture,
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			}),
			skip: () => state.activeIdentify,
			logger: spyLogger().logger,
			timers,
		})
		q.start()
		return { port, p, timers, state, results, q }
	}

	it("a skipped unclaimed capture rejoins the queue on the retry timer once identify ended", async () => {
		const s = parked()
		s.port.add(id(100))
		await flush()
		expect(s.p.requests).toHaveLength(0)
		expect(s.q.size()).toBe(1)
		s.state.activeIdentify = false
		s.timers.fireAll()
		await flush()
		const got = {
			requests: s.p.requests.length,
			held: s.port.holderOf(id(100)),
			size: s.q.size(),
			results: s.results.length,
		}
		await s.q.stop()
		expect(got).toEqual({ requests: 1, held: undefined, size: 0, results: 1 })
	})

	it("recheck() (identify job ended) replays it at once; while still skipped it waits without spinning", async () => {
		const s = parked()
		s.port.add(id(101))
		await flush()
		// One retry timer at most, re-armed only when it fires.
		expect(s.timers.q.size).toBe(1)
		s.timers.fireAll()
		await flush()
		expect(s.timers.q.size).toBe(1)
		expect(s.p.requests).toHaveLength(0)
		s.state.activeIdentify = false
		s.q.recheck()
		await flush()
		expect(s.results.map(r => r.captureId)).toEqual([id(101)])
		expect(s.timers.q.size).toBe(0)
		await s.q.stop()
	})

	it("a parked capture identify claimed, or one that is gone, leaves the queue", async () => {
		const s = parked()
		s.port.add(id(102))
		s.port.add(id(103))
		await flush()
		s.port.claim(id(102), "j_ident")
		s.port.discard(id(103), "orphan-ttl")
		s.state.activeIdentify = false
		s.q.recheck()
		await flush()
		expect(s.p.requests).toHaveLength(0)
		expect(s.q.size()).toBe(0)
		await s.q.stop()
	})

	it("stop discards parked captures without a result", async () => {
		const s = parked()
		s.port.add(id(104))
		await flush()
		await s.q.stop()
		expect(s.port.discarded).toEqual([[id(104), "shutdown"]])
		expect(s.timers.q.size).toBe(0)
	})
})

const analogTrial = (): IqReplayTrial => ({
	protocol: "analog-fm",
	kind: "analog",
	analogMode: "nfm",
	known: false,
	mode: {
		decoderType: "dsd-fme",
		protocol: "analog-fm",
		covers: ["analog-fm"],
		options: { analogTrial: "nfm" },
		holdMs: 0,
	},
})

function heardStats(): NonNullable<AnalogTrialResult["stats"]> {
	return {
		mode: "nfm",
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
}

/** Internally consistent AM `heard`. The trial above asked for NFM. */
function amHeard(): AnalogTrialResult {
	return {
		outcome: "heard",
		mode: "am",
		voice: true,
		tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
		stats: {
			mode: "am",
			frames: [
				{
					carrierDb: 0,
					hfNoiseDb: -40,
					audioDb: -12,
					syllabic: 0.5,
					cluster: 0.1,
				},
			],
			gapSamples: 0,
			floorDb: -80,
		},
	}
}

function analogAnswer(outcome: AnalogTrialOutcome): AnalogTrialResult {
	return {
		outcome,
		mode: "nfm",
		voice: outcome === "heard" || outcome === "decoded",
		tones: {
			ctcssHz: outcome === "decoded" ? 88.5 : null,
			dcs: null,
			audioSeconds: 1,
		},
		stats: outcome === "heard" ? heardStats() : null,
	}
}

function runWithAnalog(opts: {
	trials?: readonly IqReplayTrial[]
	analog?: AnalogTrialRunner
	reserveCores?: (cores: number) => (() => void) | null
	script?: Script
	planInput?: (capture: IqCaptureView) => IqReplayPlanInput
}) {
	const port = new FakePort()
	const p = makeProbes(opts.script ?? (() => miss))
	const results: IqReplayResult[] = []
	const q = createIqReplayQueue({
		port,
		probes: p.probes,
		planner: () =>
			opts.trials ?? [analogTrial(), trial("pocsag"), trial("dmr")],
		sink: r => results.push(r),
		planInput:
			opts.planInput ??
			(capture => ({
				capture,
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			})),
		logger: spyLogger().logger,
		timers: new Timers(),
		...(opts.analog ? { analog: opts.analog } : {}),
		...(opts.reserveCores ? { reserveCores: opts.reserveCores } : {}),
	})
	q.start()
	return { q, port, p, results }
}

describe("IqReplayQueue analog trial", () => {
	it("analog heard → digital trials not-needed, one result, one discard", async () => {
		const release = viRelease()
		const { port, p, results } = runWithAnalog({
			analog: { run: () => Promise.resolve(analogAnswer("heard")) },
			reserveCores: cores => {
				expect(cores).toBe(ANALOG_TRIAL_CORES)
				return release.fn
			},
		})
		port.add(id(1))
		await flush()
		expect(p.requests).toEqual([])
		expect(results).toHaveLength(1)
		expect(results[0]?.decoded).toBeNull()
		expect(results[0]?.analog?.outcome).toBe("heard")
		expect(results[0]?.trials.map(t => [t.protocol, t.outcome])).toEqual([
			["analog-fm", "heard"],
			["pocsag", "not-needed"],
			["dmr", "not-needed"],
		])
		expect(results[0]?.trials[0]).toMatchObject({
			decoder: "analog-demod",
			mode: "nfm",
		})
		expect(port.discarded).toEqual([[id(1), "result"]])
		expect(release.calls).toBe(1)
	})

	it("request nfm, consistent am heard → cancelled, digital trials run, nothing positive", async () => {
		const release = viRelease()
		const { port, p, results } = runWithAnalog({
			analog: { run: () => Promise.resolve(amHeard()) },
			reserveCores: () => release.fn,
		})
		port.add(id(1))
		await flush()
		expect(results).toHaveLength(1)
		expect(results[0]?.analog).toBeUndefined()
		expect(results[0]?.decoded).toBeNull()
		expect(results[0]?.trials.map(t => [t.protocol, t.outcome])).toEqual([
			["analog-fm", "cancelled"],
			["pocsag", "no-sync"],
			["dmr", "no-sync"],
		])
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(port.discarded).toEqual([[id(1), "result"]])
		expect(release.calls).toBe(1)
	})

	it("Analog data-like → digital trials run", async () => {
		const { port, p, results } = runWithAnalog({
			analog: { run: () => Promise.resolve(analogAnswer("data-like")) },
		})
		port.add(id(1))
		await flush()
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(results[0]?.analog?.outcome).toBe("data-like")
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"data-like",
			"no-sync",
			"no-sync",
		])
		expect(port.discarded).toEqual([[id(1), "result"]])
	})

	it("Analog carrier-only → digital run", async () => {
		const { port, p, results } = runWithAnalog({
			analog: { run: () => Promise.resolve(analogAnswer("carrier-only")) },
		})
		port.add(id(1))
		await flush()
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"carrier-only",
			"no-sync",
			"no-sync",
		])
		expect(port.discarded).toEqual([[id(1), "result"]])
	})

	it("No analog dep → unsupported", async () => {
		const { port, p, results } = runWithAnalog({})
		port.add(id(1))
		await flush()
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(results[0]?.analog).toBeUndefined()
		expect(results[0]?.trials[0]).toMatchObject({
			outcome: "unsupported",
			decoder: "analog-demod",
		})
		expect(port.discarded).toEqual([[id(1), "result"]])
	})

	it("Budget refused → skipped-budget", async () => {
		let ran = false
		const reserved: number[] = []
		const { port, p, results } = runWithAnalog({
			analog: {
				run: () => {
					ran = true
					return Promise.resolve(analogAnswer("heard"))
				},
			},
			reserveCores: cores => {
				reserved.push(cores)
				return null
			},
		})
		port.add(id(1))
		await flush()
		expect(reserved).toEqual([ANALOG_TRIAL_CORES])
		expect(ran).toBe(false)
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"skipped-budget",
			"no-sync",
			"no-sync",
		])
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(results[0]?.analog).toBeUndefined()
		expect(port.discarded).toEqual([[id(1), "result"]])
	})

	it("analog runner rejection → cancelled, digital trials continue, release once", async () => {
		let rejectRun!: (err: unknown) => void
		const release = viRelease()
		const { port, p, results } = runWithAnalog({
			analog: {
				run: () =>
					new Promise((_resolve, reject) => {
						rejectRun = reject
					}),
			},
			reserveCores: () => release.fn,
		})
		port.add(id(1))
		await flush()
		expect(results).toHaveLength(0)
		rejectRun(new Error("runner failed"))
		await flush()
		expect(results).toHaveLength(1)
		expect(results[0]?.analog).toBeUndefined()
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"cancelled",
			"no-sync",
			"no-sync",
		])
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(port.discarded).toEqual([[id(1), "result"]])
		expect(release.calls).toBe(1)
	})

	it("Abort mid-analog: stop() aborts the signal; one release, one shutdown discard, no result", async () => {
		// stop() during a pending probe discards as shutdown and delivers no result.
		// Analog follows that policy.
		let signal!: AbortSignal
		const release = viRelease()
		const { q, port, p, results } = runWithAnalog({
			analog: {
				run: (_id, _mode, s) =>
					new Promise((_resolve, reject) => {
						signal = s
						s.addEventListener("abort", () => {
							reject(new Error("aborted"))
						})
					}),
			},
			reserveCores: () => release.fn,
		})
		port.add(id(1))
		await flush()
		expect(results).toHaveLength(0)
		expect(signal.aborted).toBe(false)
		await q.stop()
		await flush()
		expect(signal.aborted).toBe(true)
		expect(results).toHaveLength(0)
		expect(p.requests).toEqual([])
		expect(port.discarded).toEqual([[id(1), "shutdown"]])
		expect(release.calls).toBe(1)
	})

	it.each([
		{
			name: "bare {outcome: heard}",
			value: { outcome: "heard" },
		},
		{
			name: "heard plus error cancelled",
			value: { ...analogAnswer("heard"), error: "cancelled" as const },
		},
		{
			name: "non-object",
			value: 42,
		},
		{
			name: "decoded without a qualified tone or DCS",
			value: {
				...analogAnswer("data-like"),
				outcome: "decoded" as const,
				voice: true,
			},
		},
		{
			name: "heard without stats",
			value: { ...analogAnswer("heard"), stats: null },
		},
		{
			name: "decoded CTCSS with audioSeconds 0",
			value: {
				...analogAnswer("decoded"),
				tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 0 },
			},
		},
		{
			name: "heard with voice false and frames []",
			value: {
				...analogAnswer("heard"),
				voice: false,
				stats: { ...heardStats(), frames: [] },
			},
		},
	])(
		"analog runner $name fails closed: cancelled, digital trials continue, analog not positive",
		async ({ value }) => {
			const release = viRelease()
			const { port, p, results } = runWithAnalog({
				analog: {
					run: () => Promise.resolve(value as AnalogTrialResult),
				},
				reserveCores: () => release.fn,
			})
			port.add(id(1))
			await flush()
			expect(results).toHaveLength(1)
			expect(results[0]?.analog).toBeUndefined()
			expect(results[0]?.trials.map(t => t.outcome)).toEqual([
				"cancelled",
				"no-sync",
				"no-sync",
			])
			expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
			expect(port.discarded).toEqual([[id(1), "result"]])
			expect(release.calls).toBe(1)
		},
	)

	it("analog runner throwing getter fails closed: release once, one result", async () => {
		const release = viRelease()
		const bad: object = {}
		Object.defineProperty(bad, "outcome", {
			enumerable: true,
			get() {
				throw new Error("analog getter")
			},
		})
		const { port, p, results } = runWithAnalog({
			analog: { run: () => Promise.resolve(bad as AnalogTrialResult) },
			reserveCores: () => release.fn,
		})
		port.add(id(1))
		await flush()
		expect(results).toHaveLength(1)
		expect(results[0]?.analog).toBeUndefined()
		expect(results[0]?.trials.map(t => t.outcome)).toEqual([
			"cancelled",
			"no-sync",
			"no-sync",
		])
		expect(p.requests.map(r => r.protocol)).toEqual(["pocsag", "dmr"])
		expect(port.discarded).toEqual([[id(1), "result"]])
		expect(release.calls).toBe(1)
	})

	it("R 6.3: a capture of a transmission live audio already identified still runs its own analog trial; data-like runs digital, heard ends not-needed; the live entry is not a substitute", async () => {
		const evidence = liveDecodedAnalog()
		// The queue never reads ObservationEvidenceSink: the deps type has no evidence port.
		const queueReadsEvidence: "evidence" extends keyof IqReplayQueueDeps
			? true
			: false = false
		expect(queueReadsEvidence).toBe(false)
		let consulted = 0
		const seen: AnalogTrialOutcome[] = []
		const run = async (outcome: AnalogTrialOutcome) => {
			const { port, p, results } = runWithAnalog({
				trials: [analogTrial(), trial("pocsag")],
				analog: {
					run: () => {
						seen.push(outcome)
						return Promise.resolve(analogAnswer(outcome))
					},
				},
				planInput: capture => {
					// Where the caller composes the plan: the seeded live decode is visible
					// and is not a substitute for this capture's analog trial.
					expect(evidence.sink.recordAnalog).toEqual(expect.any(Function))
					expect(
						evidence.entries.some(
							e => e.transport === "live" && e.outcome === "decoded",
						),
					).toBe(true)
					consulted++
					return {
						capture,
						track: null,
						knownProtocol: null,
						priors: {},
						narrowRaster: false,
					}
				},
			})
			port.add(id(1))
			await flush()
			return { p, results }
		}
		const dataLike = await run("data-like")
		expect(dataLike.p.requests.map(r => r.protocol)).toEqual(["pocsag"])
		expect(dataLike.results[0]?.analog?.tones.ctcssHz).toBeNull()
		expect(dataLike.results[0]?.trials.map(t => t.outcome)).toEqual([
			"data-like",
			"no-sync",
		])
		const heard = await run("heard")
		expect(heard.p.requests).toEqual([])
		expect(heard.results[0]?.trials.map(t => t.outcome)).toEqual([
			"heard",
			"not-needed",
		])
		expect(heard.results[0]?.analog?.tones.ctcssHz).toBeNull()
		expect(seen).toEqual(["data-like", "heard"])
		expect(consulted).toBe(2)
		expect(evidence.calls).toEqual(evidence.seeded)
		expect(evidence.entries[0]?.tone.ctcssHz).toBe(88.5)
		expect(evidence.entries[0]?.transport).toBe("live")
	})
})

function viRelease(): { fn: () => void; calls: number } {
	const box = { calls: 0, fn: () => {} }
	box.fn = () => {
		box.calls++
	}
	return box
}

function liveDecodedAnalog(): {
	entries: ProofAnalogInput[]
	seeded: { recordAnalog: number; recordTrial: number }
	calls: { recordAnalog: number; recordTrial: number }
	sink: ObservationEvidenceSink
} {
	const entries: ProofAnalogInput[] = []
	const calls = { recordAnalog: 0, recordTrial: 0 }
	const sink: ObservationEvidenceSink = {
		nextTrialOrder: () => 1,
		recordTrial: () => {
			calls.recordTrial++
			return true
		},
		recordAnalog: (_id, entry) => {
			calls.recordAnalog++
			entries.push(entry)
			return true
		},
		recordUnavailable: () => true,
	}
	sink.recordAnalog("o", {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at: 1,
	})
	return {
		entries,
		seeded: {
			recordAnalog: calls.recordAnalog,
			recordTrial: calls.recordTrial,
		},
		calls,
		sink,
	}
}
