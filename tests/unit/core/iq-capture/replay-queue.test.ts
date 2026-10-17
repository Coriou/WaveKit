import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	createIqReplayQueue,
	IQ_REPLAY_DEFER_RETRY_MS,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayProbeAnswer,
	type IqReplayProbeRequest,
	type IqReplayProbes,
	type IqReplayQueuePort,
	type IqReplayQueueTimers,
} from "../../../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { ProbeMode } from "../../../../src/core/scanner/probes/probe-pool.js"
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
	add(id: string): IqCaptureView {
		const view: IqCaptureView = {
			captureId: id,
			sourceId: "s",
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
