// tests/unit/core/scanner/tuner-arbiter-noop.property.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import { noopHarness } from "./tuner-arbiter-noop-harness.js"

type JobId = "a" | "b"
interface RetuneOp {
	t: "retune"
	job: JobId
	centre: number
	gain: number | null
	rate: number | null
}
type Op =
	| { t: "acquire"; job: JobId; priority: number }
	| RetuneOp
	/** The same job re-sends its last written target (a parked or re-sent hop). */
	| { t: "repeat"; job: JobId }
	/** The engine's label of the current epoch: never decides a skip. */
	| { t: "trust"; commanded: boolean }
	| { t: "started"; started: boolean }
	/** An untracked epoch: the engine doubts both fields. */
	| { t: "external-epoch" }
	| { t: "reconnect" }
	| { t: "distrust" }
	/** A doubt on the rate (a rate-truth mismatch). */
	| { t: "rate-doubt" }
	| { t: "control-mode" }
	| { t: "release"; job: JobId }

const job = fc.constantFrom<JobId>("a", "b")
const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		t: fc.constant("acquire" as const),
		job,
		priority: fc.integer({ min: 0, max: 100 }),
	}),
	{
		arbitrary: fc.record({
			t: fc.constant("retune" as const),
			job,
			centre: fc.constantFrom(446_500_000, 447_000_000),
			gain: fc.constantFrom<number | null>(null, 300, 400),
			rate: fc.constantFrom<number | null>(null, 2_048_000),
		}),
		weight: 6,
	},
	{
		arbitrary: fc.record({ t: fc.constant("repeat" as const), job }),
		weight: 4,
	},
	fc.record({ t: fc.constant("trust" as const), commanded: fc.boolean() }),
	fc.record({ t: fc.constant("started" as const), started: fc.boolean() }),
	fc.record({ t: fc.constant("external-epoch" as const) }),
	fc.record({ t: fc.constant("reconnect" as const) }),
	fc.record({ t: fc.constant("distrust" as const) }),
	fc.record({ t: fc.constant("rate-doubt" as const) }),
	fc.record({ t: fc.constant("control-mode" as const) }),
	fc.record({ t: fc.constant("release" as const), job }),
)

interface Accepted {
	centre: number
	gain: number | null
	rate: number | null
}

describe("TunerArbiter same-centre no-op property", () => {
	// Feature: scanner-redesign, Property 4: Same-centre retune writes nothing
	// Validates: Requirements 1.2
	it("writes nothing iff holder, target equals the last accepted, epoch started and the ledger still proves the hop's own receipt; else today's writes", async () => {
		let skips = 0
		let written = 0
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 40 }),
				async ops => {
					const h = noopHarness()
					const leases = new Map<JobId, Lease>()
					// The model: the last accepted retune of each lease, cleared on any trust break.
					const accepted = new Map<Lease, Accepted>()
					// The ledger's live proof is the last written hop's receipts (no doubt, no session since).
					let ledgerProves = false
					const lastTarget = new Map<
						Lease,
						{ centre: number; gain: number | null; rate: number | null }
					>()
					const flush = () => new Promise(resolve => setImmediate(resolve))
					for (const raw of ops) {
						let op = raw
						if (op.t === "repeat") {
							const lease = leases.get(op.job)
							const last = lease ? lastTarget.get(lease) : undefined
							if (!last) continue
							op = { t: "retune", job: op.job, ...last }
						}
						switch (op.t) {
							case "acquire": {
								const before = h.arbiter.holder("rtl")
								const r = h.arbiter.acquire(op.job, "rtl", op.priority)
								if (r.ok) {
									leases.set(op.job, r.lease)
									// a handover or a new lease starts unverified
									if (before !== r.lease) accepted.clear()
								}
								break
							}
							case "retune": {
								const lease = leases.get(op.job)
								if (!lease) break
								const held = h.arbiter.holder("rtl") === lease
								const last = accepted.get(lease)
								const now = h.clock.currentEpoch()
								const skip =
									held &&
									last !== undefined &&
									last.centre === op.centre &&
									last.gain === op.gain &&
									last.rate === op.rate &&
									now.startSample !== null &&
									ledgerProves
								lastTarget.set(lease, {
									centre: op.centre,
									gain: op.gain,
									rate: op.rate,
								})
								const sent = h.tuner.sent.length
								const submitted = h.clock.submitted.length
								const target = {
									centreHz: op.centre,
									gainTenthsDb: op.gain,
									sampleRateHz: op.rate,
								}
								const pending = await h.arbiter
									.retune(lease, target)
									.catch(() => null)
								const writes = h.tuner.sent.slice(sent).map(c => c.name)
								if (!held) {
									expect(pending).toBeNull()
									expect(writes).toEqual([])
									break
								}
								if (skip) {
									skips++
									expect(writes).toEqual([])
									expect(h.clock.submitted.length).toBe(submitted)
									expect(pending?.epoch).toBe(now.epoch)
								} else {
									// today's path: a new epoch and the frequency write
									written++
									expect(pending).not.toBeNull()
									expect(writes).toContain("set-frequency")
									expect(h.clock.submitted.length).toBe(submitted + 1)
									accepted.set(lease, {
										centre: op.centre,
										gain: op.gain,
										rate: op.rate,
									})
									ledgerProves = true
								}
								break
							}
							case "trust":
								h.clock.trust = op.commanded ? "commanded" : "unverified"
								break
							case "started":
								h.clock.startSample = op.started ? 0 : null
								break
							case "external-epoch":
								h.clock.external()
								ledgerProves = false
								break
							case "reconnect":
								h.ledger.reconnect()
								h.sources.emit("disconnected", "rtl")
								h.ledger.start()
								h.sources.emit("payload-started", "rtl")
								await flush()
								accepted.clear()
								ledgerProves = false
								break
							case "distrust":
								h.arbiter.distrust("rtl")
								accepted.clear()
								break
							case "rate-doubt":
								h.ledger.ledger.raiseDoubt(
									"rtl",
									"sampleRate",
									"rate-truth-mismatch",
								)
								ledgerProves = false
								break
							case "control-mode":
								h.tuner.emit("control-mode-changed", "rtl", "internal")
								accepted.clear()
								break
							case "release": {
								const lease = leases.get(op.job)
								if (!lease) break
								await h.arbiter.release(lease, { restore: false })
								leases.delete(op.job)
								accepted.delete(lease)
								break
							}
						}
					}
				},
			),
			{
				numRuns: 100,
				// A sequence that must skip, so the skip branch runs on every seed.
				examples: [
					[
						[
							{ t: "acquire", job: "a", priority: 50 },
							{
								t: "retune",
								job: "a",
								centre: 446_500_000,
								gain: 300,
								rate: 2_048_000,
							},
							{ t: "trust", commanded: false },
							{ t: "started", started: true },
							{ t: "repeat", job: "a" },
						],
					],
				],
			},
		)
		// both branches ran
		expect(skips).toBeGreaterThan(0)
		expect(written).toBeGreaterThan(0)
	})
})
