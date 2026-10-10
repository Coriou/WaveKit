import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import type { TunerStateField } from "@wavekit/api-types"
import {
	TunerArbiter,
	type ArbiterDeps,
	type Lease,
	type LeaseLostReason,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import type { PersistedLease } from "../../../../src/core/scanner/store/persistence.js"
import type { NormalisedJobSpec } from "../../../../src/core/scanner/types.js"
import {
	ArbiterFakeTuner,
	FakeClock,
} from "../../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })

class Sources extends EventEmitter {
	isRtlTcpSource(id: string): boolean {
		return id === "rtl"
	}
}

function harness(
	unknown: TunerStateField[] = [],
	extra: Partial<ArbiterDeps> = {},
) {
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl", unknown)
	const sources = new Sources()
	const clock = new FakeClock()
	const persisted: { sourceId: string; lease: PersistedLease | null }[] = []
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: sources as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: (sourceId, lease) => {
			persisted.push({ sourceId, lease })
			return Promise.resolve()
		},
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		// Ruling R1: every holder may hand over unless a test says otherwise (P5 draws it per acquire).
		canHandOver: () => true,
		logger,
		...extra,
	}
	const arbiter = new TunerArbiter(deps)
	const lost: { jobId: string; reason: LeaseLostReason }[] = []
	arbiter.on("lease-lost", (lease: Lease, reason: LeaseLostReason) =>
		lost.push({ jobId: lease.jobId, reason }),
	)
	return { tuner, sources, clock, persisted, arbiter, lost }
}

interface RetuneOp {
	t: "retune"
	job: "a" | "b" | "c"
	centre: number
	gain: number | null
	interrupt: "none" | "rest" | "relay" | "fail"
}

type Op =
	| { t: "acquire"; job: "a" | "b" | "c"; priority: number; handOver: boolean }
	| RetuneOp
	| { t: "rest" }
	| { t: "relay"; external: boolean }
	| { t: "replay" }
	| { t: "disconnect" }
	| { t: "payload" }
	| { t: "release"; job: "a" | "b" | "c"; restore: boolean }

const job = fc.constantFrom<"a" | "b" | "c">("a", "b", "c")
const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		t: fc.constant("acquire" as const),
		job,
		priority: fc.integer({ min: 0, max: 100 }),
		// Ruling R1: whether the holder could hand over (false = it is starting).
		handOver: fc.boolean(),
	}),
	fc.record({
		t: fc.constant("retune" as const),
		job,
		centre: fc.integer({ min: 400, max: 470 }).map(m => m * 1_000_000 + 37_500),
		gain: fc.option(fc.integer({ min: 0, max: 496 }), { nil: null }),
		interrupt: fc.constantFrom<"none" | "rest" | "relay" | "fail">(
			"none",
			"none",
			"rest",
			"relay",
			"fail",
		),
	}),
	fc.record({ t: fc.constant("rest" as const) }),
	fc.record({ t: fc.constant("relay" as const), external: fc.boolean() }),
	fc.record({ t: fc.constant("replay" as const) }),
	fc.record({ t: fc.constant("disconnect" as const) }),
	fc.record({ t: fc.constant("payload" as const) }),
	fc.record({ t: fc.constant("release" as const), job, restore: fc.boolean() }),
)
const unknownArb = fc.subarray<TunerStateField>([
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"agcMode",
])

describe("TunerArbiter lease discipline", () => {
	// Feature: signal-discovery-scanner, Property 5: Lease discipline
	// Validates: spec § 10.3
	it("never commands without the lease, never after a loss, restores only known changed fields", async () => {
		await fc.assert(
			fc.asyncProperty(
				unknownArb,
				fc.array(opArb, { minLength: 1, maxLength: 30 }),
				async (unknown, ops) => {
					let handOver = true
					const h = harness(unknown, { canHandOver: () => handOver })
					const leases = new Map<string, Lease>()
					for (const op of ops) {
						const before = h.tuner.sent.length
						const lostBefore = h.lost.length
						switch (op.t) {
							case "acquire": {
								handOver = op.handOver
								const holderBefore = h.arbiter.holder("rtl")
								const hadHolder = holderBefore !== undefined
								const persistedBefore = h.persisted.length
								const state = h.tuner.getState("rtl")!
								const r = h.arbiter.acquire(op.job, "rtl", op.priority)
								if (state.controlMode === "external") expect(r.ok).toBe(false)
								// R1: a holder that cannot hand over keeps the lease, whatever the priority.
								if (
									holderBefore &&
									holderBefore.jobId !== op.job &&
									!op.handOver
								) {
									expect(r.ok).toBe(false)
								}
								if (!r.ok) {
									if (r.detail === "holder is starting")
										expect(op.handOver).toBe(false)
									expect(h.tuner.sent.length).toBe(before)
									expect(h.lost.length).toBe(lostBefore)
									expect(h.persisted.length).toBe(persistedBefore)
									expect(h.arbiter.holder("rtl")).toBe(holderBefore)
								}
								if (r.ok) {
									leases.set(op.job, r.lease)
									if (!hadHolder)
										for (const f of state.unknownFields ?? [])
											expect(r.lease.snapshot).not.toHaveProperty(f)
								}
								break
							}
							case "retune": {
								const lease = leases.get(op.job)
								if (!lease) break
								const heldAtStart = h.arbiter.holder("rtl") === lease
								if (op.interrupt === "rest")
									h.tuner.afterTestModeOn = () =>
										h.tuner.external("rtl", "set-frequency", 145e6, "rest")
								if (op.interrupt === "relay")
									h.tuner.afterTestModeOn = () =>
										h.tuner.setControl("rtl", "external")
								if (op.interrupt === "fail")
									h.tuner.afterTestModeOn = () => {
										h.tuner.failNext = new Error("socket closed")
									}
								await h.arbiter
									.retune(lease, {
										centreHz: op.centre,
										gainTenthsDb: op.gain,
										sampleRateHz: null,
									})
									.catch(() => undefined)
								h.tuner.afterTestModeOn = null
								const cmds = h.tuner.sent.slice(before)
								if (!heldAtStart) expect(cmds).toEqual([])
								for (const c of cmds.filter(x => x.name === "set-test-mode"))
									expect(c.accept).toBe(false)
								if (h.lost.length > lostBefore) {
									// lost between TEST_MODE 1 and the frequency write: only the marker close may follow
									// (a relay that took control rejects even that; the engine then reports stuckTestMode)
									const external =
										h.tuner.states.get("rtl")!.controlMode === "external"
									expect(cmds.map(c => [c.name, c.value])).toEqual(
										external
											? [["set-test-mode", 1]]
											: [
													["set-test-mode", 1],
													["set-test-mode", 0],
												],
									)
								} else if (
									cmds.some(c => c.name === "set-test-mode" && c.value === 1)
								) {
									expect(cmds.at(-1)).toMatchObject({
										name: "set-test-mode",
										value: 0,
									})
								}
								expect(h.clock.suppressed).toBe(0)
								break
							}
							case "rest":
								h.tuner.external("rtl", "set-gain", 200, "rest")
								break
							case "relay":
								h.tuner.setControl("rtl", op.external ? "external" : "internal")
								break
							case "replay":
								h.tuner.external("rtl", "set-frequency", 446_100_000, "replay")
								expect(h.lost.length).toBe(lostBefore)
								break
							case "disconnect":
								h.sources.emit("disconnected", "rtl")
								break
							case "payload":
								h.sources.emit("payload-started", "rtl")
								break
							case "release": {
								const lease = leases.get(op.job)
								if (!lease) break
								const held = h.arbiter.holder("rtl") === lease
								const snapshot = { ...lease.snapshot }
								const changed = new Set(lease.changedFields)
								const r = await h.arbiter.release(lease, {
									restore: op.restore,
								})
								leases.delete(op.job)
								const cmds = h.tuner.sent.slice(before)
								if (!held) {
									expect(cmds).toEqual([])
									expect(r.restored).toEqual([])
									break
								}
								// § 4.6: every release of a held lease closes test mode first.
								expect(cmds[0]).toMatchObject({
									name: "set-test-mode",
									value: 0,
									origin: "scanner",
									accept: false,
								})
								if (!op.restore) {
									expect(cmds).toHaveLength(1)
									expect(r.restored).toEqual([])
									break
								}
								for (const c of cmds.slice(1)) {
									const field = (
										{
											"set-frequency": "frequency",
											"set-sample-rate": "sampleRate",
											"set-gain-mode": "gainMode",
											"set-gain": "gain",
											"set-agc-mode": "agcMode",
										} as const
									)[c.name as "set-frequency"]
									expect(field).toBeDefined()
									expect(changed.has(field)).toBe(true)
									expect(snapshot[field]).toBeDefined()
								}
								for (const f of r.unrestorable)
									expect(snapshot[f as keyof typeof snapshot]).toBeUndefined()
								break
							}
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("sends marker, frequency and gain in one bracket and posts the epoch first", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		const pending = await h.arbiter.retune(r.lease, {
			centreHz: 446_037_500,
			gainTenthsDb: 400,
			sampleRateHz: null,
		})
		expect(h.tuner.sent.map(c => [c.name, c.value, c.origin])).toEqual([
			["set-test-mode", 1, "scanner"],
			["set-frequency", 446_037_500, "scanner"],
			["set-gain", 400, "scanner"],
			["set-test-mode", 0, "scanner"],
		])
		expect(h.clock.submitted).toEqual([pending])
		expect(pending).toMatchObject({
			expectMarker: true,
			centreHz: 446_037_500,
			gainKey: "m:400",
			tuningTrust: "commanded",
			settleSamples: Math.round(
				(testSettings().sweep.settleMs.network * 2_048_000) / 1000,
			),
		})
		expect([...r.lease.changedFields].sort()).toEqual(["frequency", "gain"])
	})

	it("sends TEST_MODE 0 after a failed frequency write and reports the failure", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		h.tuner.afterTestModeOn = () => {
			h.tuner.failNext = new Error("EPIPE")
		}
		await expect(
			h.arbiter.retune(r.lease, {
				centreHz: 446_037_500,
				gainTenthsDb: null,
				sampleRateHz: null,
			}),
		).rejects.toMatchObject({ code: "SCANNER_TUNER_WRITE" })
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 1],
			["set-test-mode", 0],
		])
	})

	it("treats replay as a reconnect, REST as operator preemption and external control as relay preemption", () => {
		const h = harness()
		const replays: string[] = []
		h.arbiter.on("replay", (id: string) => replays.push(id))
		const a = h.arbiter.acquire("a", "rtl", 50)
		h.tuner.external("rtl", "set-frequency", 446_100_000, "replay")
		expect(h.lost).toEqual([])
		expect(replays).toEqual(["rtl"])
		h.tuner.external("rtl", "set-frequency", 145e6, "rest")
		expect(h.lost).toEqual([{ jobId: "a", reason: "preempted-operator" }])
		expect(a.ok && h.arbiter.holder("rtl")).toBe(undefined)
		const b = h.arbiter.acquire("b", "rtl", 50)
		expect(b.ok).toBe(true)
		h.tuner.setControl("rtl", "external")
		expect(h.lost.at(-1)).toEqual({ jobId: "b", reason: "preempted-relay" })
		expect(h.arbiter.acquire("c", "rtl", 90)).toMatchObject({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
		})
	})

	it("hands the lease and its snapshot to a higher-priority job", () => {
		const h = harness()
		const a = h.arbiter.acquire("a", "rtl", 40)
		if (!a.ok) throw new Error("acquire failed")
		expect(h.arbiter.acquire("b", "rtl", 40)).toMatchObject({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
		})
		const b = h.arbiter.acquire("b", "rtl", 60)
		if (!b.ok) throw new Error("hand-over failed")
		expect(b.lease.snapshot).toEqual(a.lease.snapshot)
		expect(h.lost).toEqual([{ jobId: "a", reason: "preempted-job" }])
		expect(h.arbiter.holder("rtl")).toBe(b.lease)
	})

	it("refuses a hand-over while the holder is starting and allows it once the holder can hand over", () => {
		let starting = true
		const asked: string[] = []
		const h = harness([], {
			canHandOver: jobId => {
				asked.push(jobId)
				return !starting
			},
		})
		const a = h.arbiter.acquire("a", "rtl", 40)
		if (!a.ok) throw new Error("acquire failed")
		const persistedAfterAcquire = h.persisted.length
		// The priority check refuses first: canHandOver is not even asked.
		expect(h.arbiter.acquire("b", "rtl", 40)).toMatchObject({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
		})
		expect(asked).toEqual([])
		expect(h.arbiter.acquire("b", "rtl", 60)).toEqual({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
			detail: "holder is starting",
		})
		expect(asked).toEqual(["a"])
		expect(h.lost).toEqual([])
		expect(h.persisted).toHaveLength(persistedAfterAcquire)
		expect(h.arbiter.holder("rtl")).toBe(a.lease)
		starting = false
		const b = h.arbiter.acquire("b", "rtl", 60)
		if (!b.ok) throw new Error("hand-over failed")
		expect(b.lease.snapshot).toEqual(a.lease.snapshot)
		expect(h.lost).toEqual([{ jobId: "a", reason: "preempted-job" }])
		expect(h.arbiter.holder("rtl")).toBe(b.lease)
	})

	it("still reports REST and relay losses of a starting holder", () => {
		const h = harness([], { canHandOver: () => false })
		const a = h.arbiter.acquire("a", "rtl", 40)
		if (!a.ok) throw new Error("acquire failed")
		h.tuner.external("rtl", "set-gain", 200, "rest")
		expect(h.lost).toEqual([{ jobId: "a", reason: "preempted-operator" }])
		const b = h.arbiter.acquire("b", "rtl", 40)
		if (!b.ok) throw new Error("acquire failed")
		h.tuner.setControl("rtl", "external")
		expect(h.lost.at(-1)).toEqual({ jobId: "b", reason: "preempted-relay" })
		expect(h.arbiter.holder("rtl")).toBe(undefined)
	})

	it("adopts a pending recovery on acquire and leaves the restore to the holder", async () => {
		const h = harness()
		const recovered: {
			id: string
			r: { restored: string[]; unrestorable: string[] }
		}[] = []
		h.arbiter.on(
			"recovered",
			(id: string, r: { restored: string[]; unrestorable: string[] }) =>
				recovered.push({ id, r }),
		)
		const crashed: PersistedLease = {
			sourceId: "rtl",
			jobId: "crashed",
			acquiredAt: 1,
			snapshot: { frequency: 100_000_000, gain: 296 },
			changedFields: ["gain"],
		}
		h.arbiter.recoverPersistedLeases([crashed])
		// Connected, but the recovery's writes fail: the record stays pending.
		h.tuner.failAll = new Error("socket closed")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.tuner.failAll = null
		expect(h.tuner.sent).toEqual([])
		expect(recovered).toEqual([])
		const b = h.arbiter.acquire("b", "rtl", 50)
		if (!b.ok) throw new Error("acquire failed")
		expect(b.lease.snapshot).toEqual(crashed.snapshot)
		expect([...b.lease.changedFields].sort()).toEqual(["frequency", "gain"])
		await new Promise(resolve => setImmediate(resolve))
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		// Only the reconnect marker close: no restore writes under the holder.
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
		])
		// Only the holder's record is persisted (on adoption and after "recovered"), never cleared.
		const holderRecord = {
			sourceId: "rtl",
			lease: {
				sourceId: "rtl",
				jobId: "b",
				acquiredAt: b.lease.acquiredAt,
				snapshot: crashed.snapshot,
				changedFields: ["gain", "frequency"],
			},
		}
		expect(h.persisted).toEqual([holderRecord, holderRecord])
		expect(h.arbiter.holder("rtl")).toBe(b.lease)
		expect(recovered).toEqual([
			{ id: "rtl", r: { restored: [], unrestorable: [] } },
		])
		// The holder's release restores the pre-crash state.
		h.tuner.sent.length = 0
		const res = await h.arbiter.release(b.lease, { restore: true })
		expect(res.restored).toEqual(["frequency", "gain"])
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 100_000_000],
			["set-gain", 296],
		])
		expect(h.persisted.at(-1)).toEqual({ sourceId: "rtl", lease: null })
	})

	it("stops a running recovery when a job adopts its record", async () => {
		const h = harness()
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { frequency: 100_000_000 },
				changedFields: ["frequency"],
			},
		])
		let adopted: ReturnType<typeof h.arbiter.acquire> | null = null
		h.tuner.on("command-sent", (_id: string, name: string) => {
			if (name === "set-test-mode" && adopted === null)
				adopted = h.arbiter.acquire("b", "rtl", 50)
		})
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(adopted).toMatchObject({
			ok: true,
			lease: { jobId: "b", snapshot: { frequency: 100_000_000 } },
		})
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
		])
		expect(h.persisted.map(p => p.lease?.jobId ?? null)).toEqual(["b", "b"])
	})

	it("refuses to adopt a pending recovery before the source connects", async () => {
		const h = harness()
		const recovered: string[] = []
		h.arbiter.on("recovered", (id: string) => recovered.push(id))
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { frequency: 100_000_000, gain: 296 },
				changedFields: ["gain"],
			},
		])
		expect(h.arbiter.acquire("b", "rtl", 50)).toEqual({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
			detail: "recovery pending",
		})
		await new Promise(resolve => setImmediate(resolve))
		expect(recovered).toEqual([])
		expect(h.persisted).toEqual([])
		expect(h.tuner.sent).toEqual([])
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 100_000_000],
			["set-gain", 296],
		])
		expect(recovered).toEqual(["rtl"])
		expect(h.persisted).toEqual([{ sourceId: "rtl", lease: null }])
		const b = h.arbiter.acquire("b", "rtl", 50)
		if (!b.ok) throw new Error("acquire failed")
		expect(b.lease.snapshot.frequency).toBe(100_000_000)
	})

	it("forgets the connection when the source is removed", async () => {
		for (const event of ["removed", "source-removed"]) {
			const h = harness()
			h.arbiter.recoverPersistedLeases([
				{
					sourceId: "rtl",
					jobId: "crashed",
					acquiredAt: 1,
					snapshot: { frequency: 100_000_000 },
					changedFields: [],
				},
			])
			// Connected while writes fail: the record stays pending and is adoptable.
			h.tuner.failAll = new Error("socket closed")
			h.sources.emit("payload-started", "rtl")
			await new Promise(resolve => setImmediate(resolve))
			h.tuner.failAll = null
			h.sources.emit(event, "rtl")
			expect(h.arbiter.acquire("b", "rtl", 50)).toEqual({
				ok: false,
				code: "SCANNER_SOURCE_BUSY",
				detail: "recovery pending",
			})
			// Nor does a return of control retry the recovery on a removed source.
			h.tuner.setControl("rtl", "external")
			h.tuner.setControl("rtl", "internal")
			await new Promise(resolve => setImmediate(resolve))
			expect(h.tuner.sent).toEqual([])
			h.arbiter.dispose()
		}
	})

	it("re-queues the crash record when an adopted lease's release cannot restore it", async () => {
		const h = harness()
		const results: { restored: string[]; unrestorable: string[] }[] = []
		h.arbiter.on(
			"recovered",
			(_id: string, r: { restored: string[]; unrestorable: string[] }) =>
				results.push(r),
		)
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { frequency: 100_000_000, gain: 296 },
				changedFields: ["gain"],
			},
		])
		h.tuner.failAll = new Error("socket closed")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.tuner.failAll = null
		const b = h.arbiter.acquire("b", "rtl", 50)
		if (!b.ok) throw new Error("acquire failed")
		await new Promise(resolve => setImmediate(resolve))
		// The rollback release runs while the source is unreachable: every write fails.
		h.tuner.failAll = new Error("not connected")
		const res = await h.arbiter.release(b.lease, { restore: true })
		expect(res).toEqual({ restored: [], unrestorable: ["frequency", "gain"] })
		expect(h.tuner.sent).toEqual([])
		// The record is persisted again, not cleared.
		expect(h.persisted.at(-1)).toMatchObject({
			sourceId: "rtl",
			lease: { snapshot: { frequency: 100_000_000, gain: 296 } },
		})
		h.tuner.failAll = null
		h.sources.emit("disconnected", "rtl")
		expect(h.arbiter.acquire("c", "rtl", 50)).toMatchObject({
			ok: false,
			detail: "recovery pending",
		})
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 100_000_000],
			["set-gain", 296],
		])
		expect(results).toEqual([
			{ restored: [], unrestorable: [] },
			{ restored: ["frequency", "gain"], unrestorable: [] },
		])
		expect(h.persisted.at(-1)).toEqual({ sourceId: "rtl", lease: null })
	})

	it("re-queues the crash record when an adopted lease is released without restore", async () => {
		const h = harness()
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { frequency: 100_000_000 },
				changedFields: [],
			},
		])
		h.tuner.failAll = new Error("socket closed")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.tuner.failAll = null
		const a = h.arbiter.acquire("a", "rtl", 40)
		if (!a.ok) throw new Error("acquire failed")
		// A hand-over carries the crash record with it.
		const b = h.arbiter.acquire("b", "rtl", 60)
		if (!b.ok) throw new Error("hand-over failed")
		await h.arbiter.release(b.lease, { restore: false })
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
		])
		expect(h.persisted.at(-1)).toMatchObject({
			lease: { jobId: "b", snapshot: { frequency: 100_000_000 } },
		})
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-test-mode", 0],
			["set-frequency", 100_000_000],
		])
		expect(h.persisted.at(-1)).toEqual({ sourceId: "rtl", lease: null })
	})

	it("keeps the holder's persisted lease when a recovered listener drops its copy", async () => {
		// Mirrors Task 35: onPersistLease keeps the record, onRecovered deletes it.
		const store = new Map<string, PersistedLease>()
		const h = harness([], {
			persistLease: (sourceId, lease) => {
				if (lease) store.set(sourceId, lease)
				else store.delete(sourceId)
				return Promise.resolve()
			},
		})
		h.arbiter.on("recovered", (id: string) => store.delete(id))
		const crashed: PersistedLease = {
			sourceId: "rtl",
			jobId: "crashed",
			acquiredAt: 1,
			snapshot: { frequency: 100_000_000, gain: 296 },
			changedFields: ["gain"],
		}
		h.arbiter.recoverPersistedLeases([crashed])
		h.tuner.failAll = new Error("socket closed")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.tuner.failAll = null
		const b = h.arbiter.acquire("b", "rtl", 50)
		if (!b.ok) throw new Error("acquire failed")
		await new Promise(resolve => setImmediate(resolve))
		expect(store.get("rtl")).toEqual({
			sourceId: "rtl",
			jobId: "b",
			acquiredAt: b.lease.acquiredAt,
			snapshot: crashed.snapshot,
			changedFields: ["gain", "frequency"],
		})
	})

	it("refuses to lease a source while its previous lease is still releasing", async () => {
		const h = harness()
		const a = h.arbiter.acquire("a", "rtl", 50)
		if (!a.ok) throw new Error("acquire failed")
		await h.arbiter.retune(a.lease, {
			centreHz: 450_012_500,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		const releasing = h.arbiter.release(a.lease, { restore: true })
		expect(h.arbiter.acquire("b", "rtl", 90)).toEqual({
			ok: false,
			code: "SCANNER_SOURCE_BUSY",
			detail: "releasing",
		})
		await releasing
		const b = h.arbiter.acquire("b", "rtl", 50)
		if (!b.ok) throw new Error("acquire failed")
		// The snapshot is the restored centre, not the released job's last hop.
		expect(b.lease.snapshot.frequency).toBe(446_100_000)
	})

	it("retries a relay-blocked recovery and closes an open marker when control returns", async () => {
		const h = harness()
		const recovered: string[] = []
		h.arbiter.on("recovered", (id: string) => recovered.push(id))
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { frequency: 446_100_000 },
				changedFields: [],
			},
		])
		h.tuner.setControl("rtl", "external")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent).toEqual([])
		h.tuner.setControl("rtl", "internal")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 446_100_000],
		])
		expect(recovered).toEqual(["rtl"])
		expect(h.persisted).toEqual([{ sourceId: "rtl", lease: null }])
		// A relay that takes control mid-bracket rejects TEST_MODE 0: the marker stays open.
		h.tuner.sent.length = 0
		const a = h.arbiter.acquire("a", "rtl", 50)
		if (!a.ok) throw new Error("acquire failed")
		h.tuner.afterTestModeOn = () => h.tuner.setControl("rtl", "external")
		await expect(
			h.arbiter.retune(a.lease, {
				centreHz: 446_037_500,
				gainTenthsDb: null,
				sampleRateHz: null,
			}),
		).rejects.toMatchObject({ code: "SCANNER_LEASE_LOST" })
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 1],
		])
		h.tuner.setControl("rtl", "internal")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value, c.accept])).toEqual([
			["set-test-mode", 1, false],
			["set-test-mode", 0, false],
		])
		// Closed: the next return of control sends nothing.
		h.tuner.setControl("rtl", "external")
		h.tuner.setControl("rtl", "internal")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent).toHaveLength(2)
		expect(recovered).toEqual(["rtl"])
	})

	it("runs a hop that changes the sample rate without markers", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		const pending = await h.arbiter.retune(r.lease, {
			centreHz: 446_037_500,
			gainTenthsDb: null,
			sampleRateHz: 2_400_000,
		})
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-sample-rate", 2_400_000],
			["set-frequency", 446_037_500],
		])
		expect(pending).toMatchObject({
			expectMarker: false,
			sampleRateHz: 2_400_000,
		})
		expect(h.clock.suppressed).toBe(0)
	})

	it("reports unknown changed fields as unrestorable and never writes them", async () => {
		const h = harness(["gain", "gainMode"])
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		expect(r.lease.snapshot).toEqual({
			frequency: 446_100_000,
			sampleRate: 2_048_000,
			agcMode: false,
		})
		await h.arbiter.retune(r.lease, {
			centreHz: 450_012_500,
			gainTenthsDb: 300,
			sampleRateHz: null,
		})
		h.tuner.sent.length = 0
		const res = await h.arbiter.release(r.lease, { restore: true })
		expect(res.restored).toEqual(["frequency"])
		expect(res.unrestorable.sort()).toEqual(["gain", "gainMode"])
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 446_100_000],
		])
		expect(h.persisted.at(-1)).toEqual({ sourceId: "rtl", lease: null })
	})

	it("writes gain mode and gain when the current values are unknown placeholders", async () => {
		const h = harness(["gain", "gainMode"])
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		// The placeholders (manual, 296) equal the target; unknown values still need the writes.
		await h.arbiter.retune(r.lease, {
			centreHz: 450_012_500,
			gainTenthsDb: 296,
			sampleRateHz: null,
		})
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 1],
			["set-frequency", 450_012_500],
			["set-gain-mode", 1],
			["set-gain", 296],
			["set-test-mode", 0],
		])
		expect([...r.lease.changedFields].sort()).toEqual([
			"frequency",
			"gain",
			"gainMode",
		])
	})

	it("persists changed fields before the commands that change them", async () => {
		let sentCount = () => 0
		const seen: { sent: number; changed: string[] }[] = []
		const h = harness([], {
			persistLease: (_sourceId, lease) => {
				seen.push({
					sent: sentCount(),
					changed: [...(lease?.changedFields ?? [])],
				})
				return Promise.resolve()
			},
		})
		sentCount = () => h.tuner.sent.length
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, {
			centreHz: 446_037_500,
			gainTenthsDb: 400,
			sampleRateHz: null,
		})
		// acquire, then the grown set: both before the first command of the hop
		expect(seen).toEqual([
			{ sent: 0, changed: [] },
			{ sent: 0, changed: ["frequency", "gain"] },
		])
		expect(h.tuner.sent).toHaveLength(4)
	})

	it("restores a persisted lease on the first payload-started only", async () => {
		const h = harness()
		const recovered: string[] = []
		h.arbiter.on("recovered", (id: string) => recovered.push(id))
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "a",
				acquiredAt: 1,
				snapshot: { frequency: 446_100_000, gain: 296 },
				changedFields: ["frequency", "gain"],
			},
		])
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value, c.origin])).toEqual([
			["set-test-mode", 0, "scanner"],
			["set-frequency", 446_100_000, "scanner"],
			["set-gain", 296, "scanner"],
		])
		expect(recovered).toEqual(["rtl"])
		expect(h.persisted).toEqual([{ sourceId: "rtl", lease: null }])
	})

	it("retries recovery only after a failed write and always restores the frequency", async () => {
		const h = harness()
		const results: { restored: string[]; unrestorable: string[] }[] = []
		h.arbiter.on(
			"recovered",
			(_id: string, r: { restored: string[]; unrestorable: string[] }) =>
				results.push(r),
		)
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "a",
				acquiredAt: 1,
				snapshot: { frequency: 446_100_000, gain: 296 },
				changedFields: ["gain", "agcMode"],
			},
		])
		h.tuner.setControl("rtl", "external")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(results).toEqual([])
		expect(h.persisted).toEqual([])
		h.tuner.setControl("rtl", "internal")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
			["set-frequency", 446_100_000],
			["set-gain", 296],
		])
		// agcMode has no known snapshot value: reported once, never a reason to retry.
		expect(results).toEqual([
			{ restored: ["frequency", "gain"], unrestorable: ["agcMode"] },
		])
		expect(h.persisted).toEqual([{ sourceId: "rtl", lease: null }])
	})

	it("closes a marker left open by a dropped connection when the source comes back", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		h.tuner.afterTestModeOn = () => {
			h.tuner.failAll = new Error("socket closed")
		}
		await expect(
			h.arbiter.retune(r.lease, {
				centreHz: 446_037_500,
				gainTenthsDb: null,
				sampleRateHz: null,
			}),
		).rejects.toMatchObject({ code: "SCANNER_TUNER_WRITE" })
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 1],
		])
		h.tuner.failAll = null
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(h.tuner.sent.map(c => [c.name, c.value, c.accept])).toEqual([
			["set-test-mode", 1, false],
			["set-test-mode", 0, false],
		])
		expect(h.arbiter.holder("rtl")).toBe(r.lease)
		h.tuner.sent.length = 0
		await h.arbiter.release(r.lease, { restore: false })
		expect(h.tuner.sent.map(c => [c.name, c.value])).toEqual([
			["set-test-mode", 0],
		])
	})

	it("computes impact from actual assignments", () => {
		const h = harness(["agcMode"], {
			impactSources: {
				liveDemod: {
					getStatus: () => ({ running: true, sourceId: "rtl", clientCount: 2 }),
				} as never,
				digitalVoice: {
					getStatus: () => ({
						decoders: [
							{ decoderId: "dmr", clientCount: 3 },
							{ decoderId: "other", clientCount: 5 },
						],
					}),
				} as never,
				decoders: {
					getAllStatus: () =>
						[
							{
								id: "dmr",
								sourceId: "rtl",
								running: true,
								suspended: false,
								owner: "config",
								startMode: "operator",
							},
							{
								id: "pager",
								sourceId: "rtl",
								running: false,
								suspended: true,
								owner: "config",
							},
							{
								id: "other",
								sourceId: "air",
								running: true,
								suspended: false,
								owner: "config",
							},
							{
								id: "scan-x",
								sourceId: "rtl",
								running: true,
								suspended: false,
								owner: "scanner",
							},
						] as never,
				},
			},
			scannerJobsOn: () => ["passive-rtl"],
		})
		const spec = {
			tuner: {
				sampleRateHz: null,
				gainTenthsDb: 300,
				agc: true,
				overload: "flag",
			},
		} as unknown as NormalisedJobSpec
		expect(h.arbiter.impact("rtl", spec)).toEqual({
			liveAudioClients: 2,
			digitalVoiceListeners: 3,
			runningDecoders: ["dmr"],
			pinnedDecoders: ["dmr"],
			scannerJobs: ["passive-rtl"],
			unrestorable: ["agcMode"],
		})
	})

	it("never counts the asking job among the scanner jobs on the source", () => {
		const calls: (string | undefined)[] = []
		const h = harness([], {
			scannerJobsOn: (_sourceId, exceptJobId) => {
				calls.push(exceptJobId)
				return ["passive-rtl", "sweep-a"].filter(id => id !== exceptJobId)
			},
		})
		const spec = {
			tuner: {
				sampleRateHz: null,
				gainTenthsDb: null,
				agc: null,
				overload: "flag",
			},
		} as unknown as NormalisedJobSpec
		expect(h.arbiter.impact("rtl", spec, "sweep-a").scannerJobs).toEqual([
			"passive-rtl",
		])
		expect(h.arbiter.impact("rtl", spec).scannerJobs).toEqual([
			"passive-rtl",
			"sweep-a",
		])
		expect(calls).toEqual(["sweep-a", undefined])
	})
})
