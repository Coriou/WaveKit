/**
 * The tuning ledger on a placed connection (hub intake): receipts at the intake's
 * exact placements, parked until forwardData reaches them (B2: queued frames settle reads past
 * their write position), doubts ordered by position as well as by seq (B3), and a measured
 * in-flight figure that only ever raises the settle (m2).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	TUNING_LEDGER_RING,
	TuningLedger,
	type DoubtField,
	type LedgerConnection,
	type LedgerSession,
	type TuningReceipt,
	type TuningWriterTag,
	type WritePlacement,
} from "../../../src/core/tuning-ledger.js"
import { IN_FLIGHT_BOUND_BYTES } from "../../../src/core/spectrum/network-settle.js"

const OP: TuningWriterTag = { writer: "operator" }
const RATE = 1_000_000

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

function ledgerWith(settle = 0, configuredSettleMs = 0) {
	return new TuningLedger({
		settleLink: () => ({ configuredSettleMs, inFlightBytes: settle }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
}

/** forwardData's ledger part: advance the position, release what it reached. */
function advance(conn: LedgerConnection, session: LedgerSession, n: number) {
	session.pos += n
	if (session.pos >= conn.parkedUntil) conn.releaseParked()
}

function placedSession(ledger: TuningLedger) {
	const conn = ledger.connection("rtl", { placed: true })
	const session = conn.start()!
	return { conn, session }
}

/** A receipt at exactly `pos` for frequency `value` and rate RATE. */
function provenAt(
	ledger: TuningLedger,
	conn: LedgerConnection,
	session: LedgerSession,
	pos: number,
) {
	conn.write(frame(0x02, RATE), OP)(null, { pos })
	conn.write(frame(0x01, 100_000_000), OP)(null, { pos })
	expect(ledger.receipts("rtl").at(-1)?.pos).toBe(pos)
	void session
}

describe("placed connection: receipts at the intake's placements", () => {
	it("records at the placement at once when reached, parks it otherwise, and settles reads past a queued frame (B2)", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 1000)
		expect(ledger.trustAt("rtl", 1, 0, 1000).trust).toBe("commanded")
		const got: (TuningReceipt | null)[] = []
		const done = conn.write(frame(0x01, 200_000_000), OP, r => got.push(r))
		// Written at 1000, not placed yet: a read ending past 1000 settles; one ending at it is proven.
		advance(conn, session, 1000)
		expect(ledger.trustAt("rtl", 1, 0, 1000).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 500, 1001)).toMatchObject({
			trust: "unverified",
			reason: "settling",
		})
		expect(ledger.fieldState("rtl").frequency.state).toBe("settling")
		// Placed beyond the live position: parked; still settling, no receipt handed back.
		done(null, { pos: 2600 })
		expect(got).toEqual([])
		expect(conn.parkedUntil).toBe(2600)
		expect(ledger.trustAt("rtl", 1, 1500, 2000).reason).toBe("settling")
		advance(conn, session, 599)
		expect(got).toEqual([])
		advance(conn, session, 1)
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({ pos: 2600, value: 200_000_000 })
		expect(conn.parkedUntil).toBe(Number.POSITIVE_INFINITY)
		advance(conn, session, 400)
		expect(ledger.trustAt("rtl", 1, 0, 2600)).toMatchObject({
			trust: "commanded",
			frequency: 100_000_000,
		})
		expect(ledger.trustAt("rtl", 1, 2600, 3000)).toMatchObject({
			trust: "commanded",
			frequency: 200_000_000,
		})
	})

	it("a queued centre mover (ppm) settles frequency reads past its write position too", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 1000)
		conn.write(frame(0x05, 3), OP)
		advance(conn, session, 500)
		expect(ledger.trustAt("rtl", 1, 0, 1001).reason).toBe("settling")
		expect(ledger.trustAt("rtl", 1, 0, 1000).trust).toBe("commanded")
	})

	it("an unplaced connection (today's socket path) keeps reads proven while a frame waits in the socket", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		const session = conn.start()!
		conn.write(frame(0x02, RATE), OP)(null)
		conn.write(frame(0x01, 100_000_000), OP)(null)
		session.pos += 1000
		conn.write(frame(0x01, 200_000_000), OP)
		session.pos += 1000
		expect(ledger.trustAt("rtl", 1, 0, 2000)).toMatchObject({
			trust: "commanded",
			frequency: 100_000_000,
		})
	})

	it("M1: a null placement unqueues with a null receipt and no doubt; a write error doubts; close hands parked receipts null", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 100)
		const changes: string[] = []
		ledger.subscribe((_id, change) => changes.push(change.kind))
		const got: (TuningReceipt | null)[] = []
		conn.write(frame(0x01, 7), OP, r => got.push(r))(null, { pos: null })
		expect(got).toEqual([null])
		// The bytes never reached the receiver: nothing to doubt, nothing for the controller to redo.
		expect(ledger.doubts("rtl")).toEqual([])
		expect(changes).toEqual([])
		expect(ledger.fieldState("rtl").frequency.queued).toBeNull()
		expect(ledger.trustAt("rtl", 1, 0, 100).trust).toBe("commanded")
		got.length = 0
		conn.write(frame(0x01, 9), OP, r => got.push(r))(new Error("EPIPE"))
		expect(got).toEqual([null])
		expect(ledger.doubts("rtl").map(d => d.reason)).toEqual(["write-failed"])
		got.length = 0
		conn.write(frame(0x01, 8), OP, r => got.push(r))(null, { pos: 5000 })
		conn.close()
		expect(got).toEqual([null])
	})

	it("M-A: a mismatch placement doubts both fields from the write position, with a null receipt", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 1000)
		const got: (TuningReceipt | null)[] = []
		const done = conn.write(frame(0x01, 7), OP, r => got.push(r))
		advance(conn, session, 500)
		done(null, { pos: null, mismatch: true })
		expect(got).toEqual([null])
		expect(ledger.fieldState("rtl").frequency.queued).toBeNull()
		expect(ledger.doubts("rtl")).toMatchObject([
			{ field: "both", pos: 1000, reason: "placement-mismatch" },
		])
		expect(ledger.trustAt("rtl", 1, 0, 1000).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 0, 1001)).toMatchObject({
			trust: "unverified",
			doubtReason: "placement-mismatch",
		})
	})

	it("m-1: a placement below the newest receipt records there and doubts from its own position (never hidden)", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 2000)
		conn.write(frame(0x01, 200_000_000), OP)(null, { pos: 1500 })
		expect(ledger.doubts("rtl")).toEqual([])
		const got: (TuningReceipt | null)[] = []
		conn.write(frame(0x01, 300_000_000), OP, r => got.push(r))(null, {
			pos: 1200,
		})
		expect(got[0]?.pos).toBe(1500)
		expect(ledger.doubts("rtl")).toMatchObject([
			{ field: "both", pos: 1200, reason: "placement-out-of-order" },
		])
		expect(ledger.trustAt("rtl", 1, 0, 1200).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 1500, 2000)).toMatchObject({
			trust: "unverified",
			doubtReason: "placement-out-of-order",
		})
	})

	it("pre-session placements: at 0 record at the session start, beyond it park", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl", { placed: true })
		const got: (TuningReceipt | null)[] = []
		conn.write(frame(0x02, RATE), OP, r => got.push(r))(null, { pos: 0 })
		conn.write(frame(0x01, 5), OP, r => got.push(r))(null, { pos: 40 })
		expect(got).toEqual([])
		const session = conn.start()!
		expect(got.map(r => r?.pos)).toEqual([0])
		advance(conn, session, 40)
		expect(got.map(r => r?.pos)).toEqual([0, 40])
	})

	it("past TUNING_LEDGER_RING parked frames the oldest records early at its exact position, positions monotone", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		const got: (TuningReceipt | null)[] = []
		for (let i = 0; i < TUNING_LEDGER_RING + 3; i++)
			conn.write(frame(0x04, i), OP, r => got.push(r))(null, {
				pos: 100 + i * 2,
			})
		expect(got.map(r => r?.pos)).toEqual([100, 102, 104])
		advance(conn, session, 100 + (TUNING_LEDGER_RING + 2) * 2)
		const positions = got.map(r => r!.pos)
		expect(positions).toHaveLength(TUNING_LEDGER_RING + 3)
		expect(positions).toEqual([...positions].sort((a, b) => a - b))
		expect(positions.at(-1)).toBe(100 + (TUNING_LEDGER_RING + 2) * 2)
	})
})

describe("B3: doubts by position as well as by seq", () => {
	it("a placement recorded after a doubt at an earlier position does not re-prove past the doubt", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 1000)
		const done = conn.write(frame(0x01, 200_000_000), OP)
		advance(conn, session, 2000)
		// The doubt (e.g. an untracked retune) at 2500 is raised while the command is in flight.
		ledger.raiseDoubt("rtl", "frequency", "untracked-retune", 2500)
		done(null, { pos: 2000 })
		expect(ledger.receipts("rtl").at(-1)?.pos).toBe(2000)
		expect(ledger.trustAt("rtl", 1, 2000, 2500)).toMatchObject({
			trust: "commanded",
			frequency: 200_000_000,
		})
		expect(ledger.trustAt("rtl", 1, 2000, 2501)).toMatchObject({
			trust: "unverified",
			reason: "doubt",
			doubtReason: "untracked-retune",
		})
		// A receipt placed past the doubt re-proves as before.
		conn.write(frame(0x01, 300_000_000), OP)(null, { pos: 2800 })
		expect(ledger.trustAt("rtl", 1, 2800, 3000)).toMatchObject({
			trust: "commanded",
			frequency: 300_000_000,
		})
	})

	it("evicted doubts keep their highest position: a later receipt at a lower position stays doubted", () => {
		const ledger = ledgerWith()
		const { conn, session } = placedSession(ledger)
		provenAt(ledger, conn, session, 0)
		advance(conn, session, 1000)
		const done = conn.write(frame(0x01, 200_000_000), OP)
		advance(conn, session, 5000)
		ledger.raiseDoubt("rtl", "frequency", "untracked-retune", 4000)
		for (let i = 0; i < TUNING_LEDGER_RING; i++)
			ledger.raiseDoubt("rtl", "sampleRate", "filler", 5900)
		expect(
			ledger.doubts("rtl").some(d => d.reason === "untracked-retune"),
		).toBe(false)
		done(null, { pos: 2000 })
		expect(ledger.trustAt("rtl", 1, 2000, 3000).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 2000, 4001)).toMatchObject({
			trust: "unverified",
			doubtReason: "older-than-ring",
		})
	})

	it("socket mode is unchanged: a receipt after the doubt re-proves (its position is never below the doubt's)", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		const session = conn.start()!
		conn.write(frame(0x02, RATE), OP)(null)
		conn.write(frame(0x01, 100_000_000), OP)(null)
		session.pos += 1000
		ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
		conn.write(frame(0x01, 200_000_000), OP)(null)
		session.pos += 1000
		expect(ledger.trustAt("rtl", 1, 1000, 2000)).toMatchObject({
			trust: "commanded",
			frequency: 200_000_000,
		})
	})
})

describe("m2: a measured in-flight figure only raises the settle", () => {
	it("uses the receipt's in-flight bytes when larger, the link estimate when smaller", () => {
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: 0 }),
			frameBytes: () => 2,
			capsRate: () => RATE,
		})
		const { conn, session } = placedSession(ledger)
		const big = IN_FLIGHT_BOUND_BYTES + 10_000
		conn.write(frame(0x02, RATE), OP)(null, { pos: 0, inFlightBytes: big })
		conn.write(frame(0x01, 100_000_000), OP)(null, {
			pos: 0,
			inFlightBytes: big,
		})
		advance(conn, session, big + 10)
		expect(ledger.trustAt("rtl", 1, big - 1, big + 10).reason).toBe("settling")
		expect(ledger.trustAt("rtl", 1, big, big + 10).trust).toBe("commanded")
		conn.write(frame(0x01, 200_000_000), OP)(null, {
			pos: big + 10,
			inFlightBytes: 5,
		})
		const at = big + 10
		advance(conn, session, IN_FLIGHT_BOUND_BYTES + 10)
		expect(
			ledger.trustAt(
				"rtl",
				1,
				at + IN_FLIGHT_BOUND_BYTES - 1,
				at + IN_FLIGHT_BOUND_BYTES,
			).reason,
		).toBe("settling")
		expect(
			ledger.trustAt(
				"rtl",
				1,
				at + IN_FLIGHT_BOUND_BYTES,
				at + IN_FLIGHT_BOUND_BYTES + 1,
			).frequency,
		).toBe(200_000_000)
	})
})

interface PlaceOp {
	kind: "place"
	delta: number
	/** Placed inside what Node already forwarded (a fraction of it), not beyond it. */
	within: number | null
	outcome: "placed" | "null" | "err"
}

type Op =
	| { kind: "write"; field: 1 | 2 | 4 | 5; value: number }
	| PlaceOp
	| { kind: "advance"; bytes: number }
	| { kind: "doubt"; back: number }
	| { kind: "read"; a: number; b: number }

/** Fields whose unreceipted frame may already move a frequency or rate read (B2 oracle). */
const MOVES_A_READ = new Set([1, 2, 5])

describe("P3: receipts follow the hub's placements", () => {
	it("records every receipt at exactly its placement, in seq order, monotone, never before it is reached, and trusts no read a brute-force model refuses", () => {
		// Feature: rx-starvation, Property 4: receipts follow the hub's placements
		// Validates: hub intake exact receipts, queued commands, doubts by position
		let commandedReads = 0
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.record({
							kind: fc.constant("write" as const),
							field: fc.constantFrom(
								1 as const,
								2 as const,
								4 as const,
								5 as const,
							),
							value: fc.integer({ min: 1, max: 4_000_000 }),
						}),
						fc.record({
							kind: fc.constant("place" as const),
							delta: fc.integer({ min: 0, max: 3000 }),
							within: fc.option(fc.integer({ min: 0, max: 1000 }), {
								nil: null,
							}),
							outcome: fc.constantFrom(
								"placed" as const,
								"placed" as const,
								"null" as const,
								"err" as const,
							),
						}),
						fc.record({
							kind: fc.constant("advance" as const),
							bytes: fc.integer({ min: 0, max: 2000 }),
						}),
						fc.record({
							kind: fc.constant("doubt" as const),
							back: fc.integer({ min: 0, max: 3000 }),
						}),
						fc.record({
							kind: fc.constant("read" as const),
							a: fc.integer({ min: 0, max: 10_000 }),
							b: fc.integer({ min: 0, max: 10_000 }),
						}),
					),
					{ maxLength: 60 },
				),
				fc.boolean(),
				fc.boolean(),
				(ops: Op[], closeAtEnd, provenFirst) => {
					const ledger = ledgerWith(0)
					const conn = ledger.connection("rtl", { placed: true })
					let session: LedgerSession | null = null
					const recorded: TuningReceipt[] = []
					ledger.subscribe((_id, change) => {
						if (change.kind !== "receipt") return
						// Never before its position is reached (no overflow: < 64 parked here).
						expect(change.receipt.pos).toBeLessThanOrEqual(session?.pos ?? 0)
						recorded.push(change.receipt)
					})
					const waiting: {
						done: (err?: Error | null, p?: WritePlacement) => void
						index: number
					}[] = []
					const results: (TuningReceipt | null | "pending")[] = []
					// The brute-force model: each write's field and write position, every doubt.
					const writes: { field: number; writePos: number }[] = []
					const doubts: {
						field: "frequency" | "both"
						pos: number
						/** Receipts recorded before the doubt was raised. */
						after: number
					}[] = []
					const expectedPos = new Map<number, number | null>()
					let lastPlaced = 0
					// Oracle: a `commanded` read is one the model can justify.
					const checkRead = (posA: number, posB: number) => {
						if (session === null) return
						const verdict = ledger.trustAt("rtl", session.session, posA, posB)
						if (verdict.trust !== "commanded") return
						commandedReads += 1
						// B2: no frame of a moving field is unreceipted from before posB.
						results.forEach((result, index) => {
							const write = writes[index]!
							if (result === "pending" && MOVES_A_READ.has(write.field))
								expect(write.writePos).toBeGreaterThanOrEqual(posB)
						})
						// B3: no doubt below posB stands over the proving receipt: one above the
						// receipt's position, or one raised after it was recorded.
						const proving = [
							["frequency", verdict.receipts?.frequency],
							["sampleRate", verdict.receipts?.sampleRate],
						] as const
						for (const [field, seq] of proving) {
							const index = recorded.findIndex(r => r.seq === seq)
							expect(index).toBeGreaterThanOrEqual(0)
							const receipt = recorded[index]!
							expect(receipt.pos).toBeLessThan(posB)
							for (const d of doubts) {
								if (d.field !== "both" && d.field !== field) continue
								if (d.pos >= posB) continue
								expect(d.pos > receipt.pos || d.after > index).toBe(false)
							}
						}
					}
					if (provenFirst) {
						// Both fields proven at 0 first, so reads can be trusted (the oracle has work).
						session = conn.start()
						for (const [field, value] of [
							[2, RATE],
							[1, 100_000_000],
						] as const) {
							const index = results.length
							results.push("pending")
							writes.push({ field, writePos: 0 })
							expectedPos.set(index, 0)
							conn.write(frame(field, value), OP, r => {
								results[index] = r
							})(null, { pos: 0 })
						}
					}
					for (const op of ops) {
						if (op.kind === "write") {
							if (waiting.length >= 40) continue
							const index = results.length
							results.push("pending")
							writes.push({ field: op.field, writePos: session?.pos ?? 0 })
							const done = conn.write(frame(op.field, op.value), OP, r => {
								results[index] = r
							})
							waiting.push({ done, index })
						} else if (op.kind === "place") {
							const next = waiting.shift()
							if (!next) continue
							if (op.outcome === "null") {
								expectedPos.set(next.index, null)
								next.done(null, { pos: null })
							} else if (op.outcome === "err") {
								expectedPos.set(next.index, null)
								if (session !== null)
									doubts.push({
										field: "both",
										pos: session.pos,
										after: recorded.length,
									})
								next.done(new Error("write failed"))
							} else {
								const reached = session?.pos ?? 0
								lastPlaced =
									op.within !== null && reached > lastPlaced
										? lastPlaced +
											Math.round(((reached - lastPlaced) * op.within) / 1000)
										: lastPlaced + op.delta
								expectedPos.set(next.index, lastPlaced)
								next.done(null, { pos: lastPlaced })
							}
						} else if (op.kind === "advance") {
							if (op.bytes === 0) continue
							session ??= conn.start()
							advance(conn, session!, op.bytes)
						} else if (op.kind === "read") {
							if (session === null) continue
							const posB = Math.round((op.b / 10_000) * session.pos)
							checkRead(Math.round((op.a / 10_000) * posB), posB)
							checkRead(0, session.pos)
						} else if (session) {
							const pos = Math.max(0, session.pos - op.back)
							doubts.push({
								field: "frequency",
								pos,
								after: recorded.length,
							})
							ledger.raiseDoubt("rtl", "frequency", "untracked-retune", pos)
						}
					}
					if (session !== null && !closeAtEnd)
						for (let b = 0; b <= session.pos; b += 97) checkRead(0, b)
					if (closeAtEnd) conn.close()
					// Seq order, monotone positions.
					for (let i = 1; i < recorded.length; i++) {
						expect(recorded[i]!.seq).toBeGreaterThan(recorded[i - 1]!.seq)
						expect(recorded[i]!.pos).toBeGreaterThanOrEqual(
							recorded[i - 1]!.pos,
						)
					}
					for (const [index, pos] of expectedPos) {
						const result = results[index]
						if (pos === null) expect(result).toBeNull()
						else if (result === "pending") {
							// Parked: only while its position is not reached and the session is open.
							expect(closeAtEnd).toBe(false)
							if (session !== null) expect(pos).toBeGreaterThan(session.pos)
						} else if (result === null) {
							// Null only when closed, or placed before any session (pending path).
							expect(closeAtEnd || session === null).toBe(true)
						} else {
							// Exactly at its placement (pre-session placements at 0 record at 0).
							expect(result?.pos).toBe(pos)
						}
					}
				},
			),
			{
				numRuns: 500,
				// B3's narrow window (a doubt, then a placement below it), kept as a seed case.
				examples: [
					[
						[
							{ kind: "advance", bytes: 1 },
							{ kind: "doubt", back: 0 },
							{ kind: "advance", bytes: 1 },
							{ kind: "write", field: 1, value: 1 },
							{ kind: "place", delta: 0, within: null, outcome: "placed" },
							{ kind: "read", a: 0, b: 0 },
						],
						false,
						true,
					],
				],
			},
		)
		// The oracle is not vacuous: some reads were trusted.
		expect(commandedReads).toBeGreaterThan(0)
	})
})

type DoubtKind = "frequency" | "sampleRate" | "both" | "write-error"

interface B3Case {
	field: 1 | 2
	pre: number
	toDoubt: number
	doubtBack: number
	doubtKind: DoubtKind
	before: { field: 1 | 2 | 4 | 5; value: number; frac: number }[]
	after: { field: 1 | 2 | 4 | 5; value: number; delta: number }[]
	relation: "below" | "at" | "above"
	frac: number
	above: number
	tail: number
	reads: { a: number; b: number }[]
}

const b3Case: fc.Arbitrary<B3Case> = fc.record({
	field: fc.constantFrom(1 as const, 2 as const),
	pre: fc.integer({ min: 1, max: 3000 }),
	toDoubt: fc.integer({ min: 0, max: 3000 }),
	doubtBack: fc.integer({ min: 0, max: 3000 }),
	doubtKind: fc.constantFrom<DoubtKind>(
		"frequency",
		"sampleRate",
		"both",
		"write-error",
	),
	before: fc.array(
		fc.record({
			field: fc.constantFrom(1 as const, 2 as const, 4 as const, 5 as const),
			value: fc.integer({ min: 1, max: 4_000_000 }),
			frac: fc.integer({ min: 0, max: 1000 }),
		}),
		{ maxLength: 3 },
	),
	after: fc.array(
		fc.record({
			field: fc.constantFrom(1 as const, 2 as const, 4 as const, 5 as const),
			value: fc.integer({ min: 1, max: 4_000_000 }),
			delta: fc.integer({ min: 0, max: 800 }),
		}),
		{ maxLength: 3 },
	),
	relation: fc.constantFrom("below" as const, "at" as const, "above" as const),
	frac: fc.integer({ min: 0, max: 999 }),
	above: fc.integer({ min: 0, max: 2000 }),
	tail: fc.integer({ min: 1, max: 3000 }),
	reads: fc.array(
		fc.record({
			a: fc.integer({ min: 0, max: 10_000 }),
			b: fc.integer({ min: 0, max: 10_000 }),
		}),
		{ minLength: 1, maxLength: 4 },
	),
})

describe("P3b: a doubt, then a placement around its position, then a read past it", () => {
	it("never trusts a read past a doubt on a receipt recorded before it or placed below it (B3 family)", () => {
		// Feature: rx-starvation, Property 7: a placement at or below a standing doubt never re-proves past it
		// Validates: hub intake doubts by position, settle bound
		let commandedPastDoubt = 0
		fc.assert(
			fc.property(b3Case, c => {
				const ledger = ledgerWith(0)
				const { conn, session } = placedSession(ledger)
				const recorded: TuningReceipt[] = []
				ledger.subscribe((_id, change) => {
					if (change.kind === "receipt") recorded.push(change.receipt)
				})
				provenAt(ledger, conn, session, 0)
				advance(conn, session, c.pre)
				// Writes queued before the command (placed later, in order, before it).
				const earlier = c.before.map(w => ({
					w,
					writePos: session.pos,
					done: conn.write(frame(w.field, w.value), OP),
				}))
				const writePos = session.pos
				const value = c.field === 1 ? 200_000_000 : 2_048_000
				const done = conn.write(frame(c.field, value), OP)
				advance(conn, session, c.toDoubt)
				// The doubt, raised while the command is in flight.
				const doubts: { field: DoubtField; pos: number; after: number }[] = []
				if (c.doubtKind === "write-error") {
					const failed = conn.write(frame(1, 7), OP)
					doubts.push({
						field: "both",
						pos: session.pos,
						after: recorded.length,
					})
					failed(new Error("EPIPE"))
				} else {
					const pos = Math.max(0, session.pos - c.doubtBack)
					doubts.push({ field: c.doubtKind, pos, after: recorded.length })
					ledger.raiseDoubt("rtl", c.doubtKind, "untracked-retune", pos)
				}
				const doubtPos = doubts[0]!.pos
				// The command's placement: below, exactly at or above the doubt's position.
				const lo = Math.min(writePos, Math.max(0, doubtPos - 1))
				const placedAt =
					c.relation === "at" || doubtPos === 0
						? doubtPos
						: c.relation === "above"
							? doubtPos + 1 + c.above
							: lo + Math.floor(((doubtPos - 1 - lo) * c.frac) / 1000)
				// Earlier writes place in order at or below it, then the command.
				let last = 0
				for (const e of earlier) {
					last = Math.max(
						last,
						e.writePos +
							Math.floor(
								(Math.max(0, placedAt - e.writePos) * e.w.frac) / 1000,
							),
					)
					e.done(null, { pos: Math.min(last, placedAt) })
				}
				done(null, { pos: placedAt })
				// Several receipts after it, placed in order past it.
				let next = placedAt
				for (const w of c.after) {
					next += w.delta
					conn.write(frame(w.field, w.value), OP)(null, { pos: next })
				}
				advance(conn, session, Math.max(0, next - session.pos) + c.tail)
				for (const r of c.reads) {
					if (session.pos <= doubtPos) continue
					const posB =
						doubtPos +
						1 +
						Math.floor(((session.pos - doubtPos - 1) * r.b) / 10_000)
					const posA = Math.floor((posB * r.a) / 10_000)
					const verdict = ledger.trustAt("rtl", session.session, posA, posB)
					if (verdict.trust !== "commanded") continue
					commandedPastDoubt += 1
					for (const [name, seq] of [
						["frequency", verdict.receipts?.frequency],
						["sampleRate", verdict.receipts?.sampleRate],
					] as const) {
						const index = recorded.findIndex(x => x.seq === seq)
						expect(index).toBeGreaterThanOrEqual(0)
						const receipt = recorded[index]!
						for (const d of doubts) {
							if (d.field !== "both" && d.field !== name) continue
							if (d.pos >= posB) continue
							// Proven past the doubt only by a receipt recorded after it at or past it.
							expect(index >= d.after && receipt.pos >= d.pos).toBe(true)
						}
					}
				}
			}),
			{ numRuns: 300, seed: 0x52_33_b3 },
		)
		// The oracle is not vacuous: some reads past a doubt were trusted (re-proven).
		expect(commandedPastDoubt).toBeGreaterThan(0)
	})
})
