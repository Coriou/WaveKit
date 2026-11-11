import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	RtlTcpFrameAssembler,
	TUNING_LEDGER_RING,
	TuningLedger,
	type LedgerConnection,
	type TuningWriterTag,
} from "../../../src/core/tuning-ledger.js"
import {
	IN_FLIGHT_BOUND_BYTES,
	settleBytes,
	settleMs,
} from "../../../src/core/spectrum/network-settle.js"

const OP: TuningWriterTag = { writer: "operator" }
const RELAY: TuningWriterTag = { writer: "relay" }
/** 1 Msps U8 IQ (2 bytes) with 0 ms configured settle and no in-flight bound: settle 0 bytes. */
const RATE = 1_000_000

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

/** A ledger whose settle is exactly `settle` bytes (configured 0 ms, in-flight `settle`). */
function ledgerWith(settle = 0) {
	return new TuningLedger({
		settleLink: () => ({ configuredSettleMs: 0, inFlightBytes: settle }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
}

/** Writes and flushes at once (the socket callback runs immediately). */
function flush(conn: LedgerConnection, payload: Buffer, tag?: TuningWriterTag) {
	conn.write(payload, tag)(null)
}

function started(ledger: TuningLedger, id = "rtl") {
	const conn = ledger.connection(id)
	const session = conn.start()!
	return { conn, session }
}

describe("network settle", () => {
	it("is the larger of the configured settle and the in-flight bound", () => {
		// 1000 ms at 2.4 Msps × 2 B = 4.8 MB, above 512 KiB.
		expect(settleBytes(2_400_000, 2, { configuredSettleMs: 1000 })).toBe(
			4_800_000,
		)
		// 0 ms: the in-flight bound alone.
		expect(settleBytes(2_400_000, 2, { configuredSettleMs: 0 })).toBe(
			IN_FLIGHT_BOUND_BYTES,
		)
		// At 250 ksps the bound (524 288 B) beats 1000 ms (500 000 B): 1.048576 s.
		expect(settleMs(250_000, 2, { configuredSettleMs: 1000 })).toBeCloseTo(
			1048.576,
		)
		expect(settleBytes(0, 2, { configuredSettleMs: 1000 })).toBe(Infinity)
		expect(settleBytes(Number.NaN, 2, { configuredSettleMs: 1000 })).toBe(
			Infinity,
		)
	})
})

describe("RtlTcpFrameAssembler", () => {
	it("parses frames across writes and drops the writer of a mixed frame", () => {
		const a = new RtlTcpFrameAssembler()
		const two = Buffer.concat([frame(1, 100), frame(2, 200)])
		expect(a.push(two.subarray(0, 7), OP)).toEqual([
			{ field: "frequency", value: 100, tag: OP },
		])
		expect(a.push(two.subarray(7), OP)).toEqual([
			{ field: "sampleRate", value: 200, tag: OP },
		])
		const f = frame(1, 300)
		expect(a.push(f.subarray(0, 2), OP)).toEqual([])
		expect(a.push(f.subarray(2), RELAY)).toEqual([
			{ field: "frequency", value: 300, tag: undefined },
		])
	})
})

describe("TuningLedger", () => {
	it("numbers sessions per source from 1 and ends the old one on a new connection", () => {
		const ledger = ledgerWith()
		const a = started(ledger)
		expect(a.session.session).toBe(1)
		expect(started(ledger, "other").session.session).toBe(1)
		a.conn.close()
		const b = started(ledger)
		expect(b.session.session).toBe(2)
		expect(a.session.ended).toBe(true)
	})

	it("proves a block past the settle of both receipts, labelled by the writer", () => {
		const ledger = ledgerWith(100)
		const { conn, session } = started(ledger)
		flush(conn, frame(1, 446_000_000), OP)
		flush(conn, frame(2, RATE), RELAY)
		session.pos = 1000
		expect(ledger.trustAt("rtl", 1, 99, 200).trust).toBe("unverified")
		expect(ledger.trustAt("rtl", 1, 99, 200).reason).toBe("settling")
		const v = ledger.trustAt("rtl", 1, 100, 200)
		expect(v).toMatchObject({
			trust: "relay",
			frequency: 446_000_000,
			sampleRate: RATE,
		})
		expect(v.receipts.frequency).toBe(1)
		expect(v.receipts.sampleRate).toBe(2)
		expect(ledger.trustNow("rtl").trust).toBe("relay")
		expect(ledger.fieldState("rtl").frequency).toMatchObject({
			state: "proven",
			writer: "operator",
			value: 446_000_000,
		})
	})

	it("records a frame only at its flush, at the position of that moment", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		const done = conn.write(Buffer.concat([frame(1, 1), frame(2, RATE)]), OP)
		session.pos = 640
		expect(ledger.receipts("rtl")).toEqual([])
		done(null)
		expect(ledger.receipts("rtl").map(r => r.pos)).toEqual([640, 640])
		// Flushed after its session ended: no receipt.
		const late = conn.write(frame(1, 2), OP)
		conn.close()
		late(null)
		expect(ledger.receipts("rtl")).toEqual([])
	})

	it("records frames flushed before the first payload at position 0, and none for a closed connection", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		const session = conn.start()!
		expect(ledger.receipts("rtl").map(r => [r.field, r.pos])).toEqual([
			["frequency", 0],
			["sampleRate", 0],
		])
		session.pos = 10
		expect(ledger.trustAt("rtl", 1, 0, 10).trust).toBe("commanded")
		const other = ledger.connection("x")
		flush(other, frame(1, 5), OP)
		other.close()
		expect(other.start()).toBeNull()
	})

	it("fails closed on malformed and unknown input", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 100
		expect(ledger.trustAt("rtl", 1, 0, 100).trust).toBe("commanded")
		const bad: [unknown, unknown, unknown, unknown, string][] = [
			["nope", 1, 0, 10, "unknown-source"],
			["rtl", 2, 0, 10, "unknown-session"],
			["rtl", 0, 0, 10, "unknown-session"],
			["rtl", 1.5, 0, 10, "bad-input"],
			["rtl", 1, -1, 10, "bad-input"],
			["rtl", 1, 20, 10, "bad-input"],
			["rtl", 1, Number.NaN, 10, "bad-input"],
			["rtl", 1, 0, 101, "beyond-known"],
			[42, 1, 0, 10, "bad-input"],
		]
		for (const [id, s, a, b, reason] of bad) {
			const v = ledger.trustAt(
				id as string,
				s as number,
				a as number,
				b as number,
			)
			expect(v.trust).toBe("unverified")
			expect(v.reason).toBe(reason)
		}
		conn.close()
		expect(ledger.trustAt("rtl", 1, 0, 10).reason).toBe("session-ended")
	})

	it("reads unverified without a writer, for an invalid value, and when a lookup throws", () => {
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: 0, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => {
				throw new Error("boom")
			},
		})
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 10
		expect(ledger.trustAt("rtl", 1, 0, 10).reason).toBe("lookup-failed")
		expect(ledger.trustNow("rtl").reason).toBe("lookup-failed")

		const plain = ledgerWith()
		const s2 = started(plain)
		flush(s2.conn, frame(1, 5))
		flush(s2.conn, frame(2, RATE), OP)
		s2.session.pos = 10
		expect(plain.trustAt("rtl", 1, 0, 10).reason).toBe("no-writer")
		flush(s2.conn, frame(1, 0), OP)
		s2.session.pos = 20
		expect(plain.trustAt("rtl", 1, 10, 20).reason).toBe("invalid-value")
	})

	it("gain receipts never gate, and a doubt unproves only from its position", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 100
		flush(conn, frame(4, 300))
		session.pos = 200
		expect(ledger.trustAt("rtl", 1, 0, 200).trust).toBe("commanded")
		ledger.raiseDoubt("rtl", "sampleRate", "rate-truth-mismatch")
		session.pos = 300
		expect(ledger.trustAt("rtl", 1, 0, 200).trust).toBe("commanded")
		const v = ledger.trustAt("rtl", 1, 0, 201)
		expect(v).toMatchObject({
			trust: "unverified",
			reason: "doubt",
			doubtReason: "rate-truth-mismatch",
		})
		expect(ledger.fieldState("rtl").sampleRate.state).toBe("unverified")
		expect(ledger.fieldState("rtl").frequency.state).toBe("proven")
		// A new receipt after the doubt proves again.
		flush(conn, frame(2, RATE), OP)
		session.pos = 400
		expect(ledger.trustAt("rtl", 1, 300, 400).trust).toBe("commanded")
	})

	it("keeps 64 receipts per session: at the bound a block still reads, past it older-than-ring", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 10
		// 62 gain frames: exactly TUNING_LEDGER_RING receipts, the two tuning ones still held.
		for (let i = 0; i < TUNING_LEDGER_RING - 2; i++)
			flush(conn, frame(4, i), OP)
		session.pos = 20
		expect(ledger.receipts("rtl")).toHaveLength(TUNING_LEDGER_RING)
		expect(ledger.trustAt("rtl", 1, 0, 10).trust).toBe("commanded")
		// One more evicts the frequency receipt.
		flush(conn, frame(4, 99), OP)
		expect(ledger.receipts("rtl")).toHaveLength(TUNING_LEDGER_RING)
		expect(ledger.trustAt("rtl", 1, 0, 10).reason).toBe("older-than-ring")
	})

	it("an evicted doubt keeps unproving every receipt it may follow", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		for (let i = 0; i <= TUNING_LEDGER_RING; i++) {
			session.pos = 10 + i
			ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
		}
		expect(ledger.doubts("rtl")).toHaveLength(TUNING_LEDGER_RING)
		session.pos = 200
		expect(ledger.trustAt("rtl", 1, 0, 5).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 0, 200).reason).toBe("doubt")
	})

	// Feature: tuning-trust-ledger, Property 1: trust only with proof in the same session
	// Validates: Requirements 1.1
	it("never trusts before B(R), across a later receipt, in another session, or past a doubt", () => {
		const op = fc.oneof(
			fc.record({
				k: fc.constant("advance" as const),
				n: fc.integer({ min: 0, max: 400 }),
			}),
			fc.record({
				k: fc.constant("write" as const),
				field: fc.constantFrom(1 as const, 2 as const, 4 as const, 5 as const),
				value: fc.integer({ min: 1, max: 4 }),
				relay: fc.boolean(),
			}),
			fc.record({
				k: fc.constant("doubt" as const),
				field: fc.constantFrom(
					"frequency" as const,
					"sampleRate" as const,
					"both" as const,
				),
				// Evidence this far behind the live position (0: at it).
				back: fc.integer({ min: 0, max: 600 }),
			}),
			fc.record({ k: fc.constant("reconnect" as const) }),
		)
		fc.assert(
			fc.property(
				fc.array(op, { maxLength: 60 }),
				fc.integer({ min: 0, max: 300 }),
				fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 20 }),
				(ops, settle, queries) => {
					const ledger = ledgerWith(settle)
					// Model: per session, writes and doubts in order with their positions; a doubt
					// stamps how many writes preceded it (`after`): it unproves writes 1..after.
					type W = { field: number; value: number; pos: number; relay: boolean }
					let conn = ledger.connection("rtl")
					let session = conn.start()!
					let writes: W[] = []
					let doubts: { field: string; pos: number; after: number }[] = []
					const sessions: { id: number; end: number }[] = []
					for (const o of ops) {
						if (o.k === "advance") {
							session.pos += o.n
						} else if (o.k === "write") {
							if (writes.length >= TUNING_LEDGER_RING - 1) continue
							flush(
								conn,
								frame(o.field, o.field === 2 ? RATE * o.value : o.value),
								o.relay ? RELAY : OP,
							)
							writes.push({
								field: o.field,
								value: o.field === 2 ? RATE * o.value : o.value,
								pos: session.pos,
								relay: o.relay,
							})
						} else if (o.k === "doubt") {
							if (doubts.length >= TUNING_LEDGER_RING - 1) continue
							const at = Math.max(0, session.pos - o.back)
							ledger.raiseDoubt(
								"rtl",
								o.field,
								"test",
								o.back === 0 ? undefined : at,
							)
							doubts.push({ field: o.field, pos: at, after: writes.length })
						} else {
							sessions.push({ id: session.session, end: session.pos })
							conn.close()
							conn = ledger.connection("rtl")
							session = conn.start()!
							writes = []
							doubts = []
						}
					}
					// Old sessions never read trusted.
					for (const old of sessions)
						expect(ledger.trustAt("rtl", old.id, 0, old.end).trust).toBe(
							"unverified",
						)
					const known = session.pos
					for (const [x, y] of queries) {
						const a = known === 0 ? 0 : x % (known + 1)
						const b = known === 0 ? 0 : a + (y % (known - a + 1))
						const v = ledger.trustAt("rtl", session.session, a, b)
						if (v.trust === "unverified") continue
						for (const field of [1, 2]) {
							const before = writes.filter(w => w.field === field && w.pos < b)
							const last = before.at(-1)
							// Trusted only with a receipt, at or past its boundary.
							expect(last).toBeDefined()
							expect(a).toBeGreaterThanOrEqual(last!.pos + settle)
							// A ppm frame (0x05) flushed after the receipt pushes the boundary.
							const index = writes.indexOf(last!)
							for (const w of writes.slice(index + 1))
								if (w.field === 5 && w.pos < b)
									expect(a).toBeGreaterThanOrEqual(w.pos + settle)
							// The value is the last receipt's: never across a later receipt.
							expect(field === 1 ? v.frequency : v.sampleRate).toBe(last!.value)
							// No doubt on the field raised after the receipt lies before b.
							const name = field === 1 ? "frequency" : "sampleRate"
							expect(
								doubts.some(
									d =>
										(d.field === name || d.field === "both") &&
										d.after > index &&
										d.pos < b,
								),
							).toBe(false)
						}
						const relay = [1, 2].some(
							f => writes.filter(w => w.field === f && w.pos < b).at(-1)!.relay,
						)
						expect(v.trust).toBe(relay ? "relay" : "commanded")
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: tuning-trust-ledger, Property 2: ring overflow reads unverified
	// Validates: Requirements 1.1
	it("reads unverified once the proving receipt left the ring", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 40 }), extra => {
				const ledger = ledgerWith()
				const { conn, session } = started(ledger)
				flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
				session.pos = 10
				const gains = TUNING_LEDGER_RING - 2 + extra
				for (let i = 0; i < gains; i++) flush(conn, frame(4, i), OP)
				session.pos = 20
				const v = ledger.trustAt("rtl", 1, 0, 10)
				if (extra === 0) expect(v.trust).toBe("commanded")
				else expect(v.reason).toBe("older-than-ring")
			}),
			{ numRuns: 100 },
		)
		// Ring overflow across a rate change: an evicted high rate still sets the settle of the
		// receipts written while it may be in effect (session running maximum).
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 40 }),
				fc.integer({ min: 0, max: 4_000_000 }),
				(extra, offset) => {
					const ledger = new TuningLedger({
						settleLink: () => ({ configuredSettleMs: 1000, inFlightBytes: 0 }),
						frameBytes: () => 2,
						capsRate: () => 250_000,
					})
					const { conn, session } = started(ledger)
					flush(conn, Buffer.concat([frame(1, 5), frame(2, 2_400_000)]), OP)
					session.pos = 10_000_000
					for (let i = 0; i < TUNING_LEDGER_RING - 2 + extra; i++)
						flush(conn, frame(4, i), OP)
					flush(conn, Buffer.concat([frame(1, 6), frame(2, 250_000)]), OP)
					session.pos = 20_000_000
					// 2.4 Msps × 2 B × 1 s = 4.8 MB after the frequency receipt at 10 MB.
					const a = 10_000_000 + offset
					expect(ledger.trustAt("rtl", 1, a, a + 100_000).trust).toBe(
						"unverified",
					)
					expect(ledger.trustAt("rtl", 1, 14_800_000, 14_900_000).trust).toBe(
						"commanded",
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("keeps the settle rate across ring eviction (caps 250k, a 2.4 Msps receipt evicted)", () => {
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: 1000, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => 250_000,
		})
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, 2_400_000)]), OP)
		session.pos = 10_000_000
		for (let i = 0; i < 62; i++) flush(conn, frame(4, i), OP)
		flush(conn, frame(1, 6), OP)
		flush(conn, frame(2, 250_000), OP)
		session.pos = 11_100_000
		// Both 2.4 Msps receipts left the ring; 250 ksps alone would settle in 500 kB.
		expect(ledger.receipts("rtl").some(r => r.value === 2_400_000)).toBe(false)
		expect(ledger.trustAt("rtl", 1, 11_000_000, 11_100_000)).toMatchObject({
			trust: "unverified",
			reason: "settling",
		})
	})

	it("limits the settle rate to rates that can be in effect from the receipt on", () => {
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: 1000, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => 2_400_000,
		})
		const { conn, session } = started(ledger)
		// The first rate receipt settles at the caps rate it replaces (2.4 Msps: 4.8 MB).
		flush(conn, frame(2, 250_000), OP)
		session.pos = 5_000_000
		// Caps is no longer in effect for a receipt after a rate receipt: 250 ksps, 500 kB.
		flush(conn, frame(1, 5), OP)
		session.pos = 6_000_000
		expect(ledger.trustAt("rtl", 1, 5_500_000, 5_600_000).trust).toBe(
			"commanded",
		)
		expect(ledger.trustAt("rtl", 1, 5_499_999, 5_600_000).reason).toBe(
			"settling",
		)
		// A later higher rate before the block's end raises the settle (1 Msps: 2 MB).
		flush(conn, frame(2, 1_000_000), OP)
		session.pos = 9_000_000
		expect(ledger.trustAt("rtl", 1, 7_999_999, 8_100_000).reason).toBe(
			"settling",
		)
		expect(ledger.trustAt("rtl", 1, 8_000_000, 8_100_000).trust).toBe(
			"commanded",
		)
	})

	it("a doubt unproves only the receipts raised before it, whatever their position", () => {
		const ledger = ledgerWith(100)
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 1000
		ledger.raiseDoubt("rtl", "both", "untracked-retune")
		// The same values written again at the same position: they follow the doubt.
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 100_000
		expect(ledger.trustAt("rtl", 1, 1100, 2000).trust).toBe("commanded")
		expect(ledger.trustAt("rtl", 1, 1100, 2000).receipts).toEqual({
			frequency: 3,
			sampleRate: 4,
		})
		// The same holds once the doubt left the ring.
		const evicted = ledgerWith(100)
		const e = started(evicted)
		flush(e.conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		e.session.pos = 1000
		for (let i = 0; i <= TUNING_LEDGER_RING; i++)
			evicted.raiseDoubt("rtl", "both", "untracked-retune")
		flush(e.conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		e.session.pos = 100_000
		expect(evicted.doubts("rtl")).toHaveLength(TUNING_LEDGER_RING)
		expect(evicted.trustAt("rtl", 1, 1100, 2000).trust).toBe("commanded")
		expect(evicted.trustAt("rtl", 1, 1000, 1001).trust).toBe("unverified")
	})

	it("raises a doubt at its evidence position, clamped to the session, in position order", () => {
		const ledger = ledgerWith()
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 10_000
		ledger.raiseDoubt("rtl", "frequency", "late", 4000)
		ledger.raiseDoubt("rtl", "frequency", "early", 2000)
		ledger.raiseDoubt("rtl", "sampleRate", "future", 50_000)
		ledger.raiseDoubt("rtl", "sampleRate", "negative", -5)
		expect(ledger.doubts("rtl").map(d => [d.reason, d.pos])).toEqual([
			["negative", 0],
			["early", 2000],
			["late", 4000],
			["future", 10_000],
		])
		// A block before the earliest frequency doubt still reads (rate doubted from 0).
		expect(ledger.trustAt("rtl", 1, 0, 2000).reason).toBe("doubt")
		const only = ledgerWith()
		const o = started(only)
		flush(o.conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		o.session.pos = 10_000
		only.raiseDoubt("rtl", "frequency", "late", 4000)
		only.raiseDoubt("rtl", "frequency", "early", 2000)
		expect(only.trustAt("rtl", 1, 0, 2000).trust).toBe("commanded")
		// The earlier doubt is found even though a later one was raised first (no ordered break).
		expect(only.trustAt("rtl", 1, 0, 2001)).toMatchObject({
			reason: "doubt",
			doubtReason: "early",
		})
		only.raiseDoubt("rtl", "frequency", "bad", Number.NaN)
		expect(only.doubts("rtl")[0]).toMatchObject({ reason: "bad", pos: 0 })
	})

	it("reports frames written and not receipted as queued, also before the session", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		expect(ledger.fieldState("rtl").frequency).toMatchObject({
			reason: "no-session",
			queued: null,
		})
		// Flushed before the first payload: queued until the session receipts it.
		flush(conn, frame(1, 7), OP)
		expect(ledger.fieldState("rtl").frequency.queued).toEqual({
			value: 7,
			writer: "operator",
		})
		const session = conn.start()!
		expect(ledger.fieldState("rtl").frequency.queued).toBeNull()
		// Behind backpressure: queued until the write callback.
		const a = conn.write(frame(1, 8), OP)
		const b = conn.write(frame(1, 9), RELAY)
		const g = conn.write(frame(4, 120), OP)
		expect(ledger.fieldState("rtl").frequency.queued).toEqual({
			value: 9,
			writer: "relay",
		})
		expect(ledger.fieldState("rtl").gain.queued).toEqual({
			value: 120,
			writer: "operator",
		})
		a(null)
		expect(ledger.fieldState("rtl").frequency.queued).toEqual({
			value: 9,
			writer: "relay",
		})
		b(new Error("reset"))
		g(null)
		expect(ledger.fieldState("rtl").frequency.queued).toBeNull()
		expect(ledger.fieldState("rtl").gain.queued).toBeNull()
		session.pos = 10
		conn.write(frame(2, RATE), OP)
		conn.close()
		expect(ledger.fieldState("rtl").sampleRate).toMatchObject({
			reason: "session-ended",
			queued: null,
		})
		expect(ledger.fieldState("nope").frequency.reason).toBe("unknown-source")
	})

	it("hands each write its receipt at flush, or null", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		const got: (number | null)[] = []
		const note = (r: { seq: number } | null) => got.push(r?.seq ?? null)
		// Before the session: delivered when the session starts.
		conn.write(Buffer.concat([frame(1, 5), frame(2, RATE)]), OP, note)(null)
		expect(got).toEqual([])
		const session = conn.start()!
		expect(got).toEqual([2])
		session.pos = 100
		const later = conn.write(frame(1, 6), OP, note)
		expect(got).toEqual([2])
		later(null)
		expect(got).toEqual([2, 3])
		conn.write(frame(1, 7), OP, note)(new Error("reset"))
		conn.write(frame(1, 7).subarray(0, 3), OP, note)(null)
		const ended = conn.write(frame(1, 8), OP, note)
		conn.close()
		ended(null)
		expect(got).toEqual([2, 3, null, null, null])
		// A connection closed before its first payload answers its pending writes with null.
		const other = ledger.connection("x")
		other.write(frame(1, 5), OP, note)(null)
		other.close()
		expect(got.at(-1)).toBeNull()
		expect(got).toHaveLength(6)
		// A throwing callback never breaks the ledger.
		const c3 = ledger.connection("y")
		c3.start()
		c3.write(frame(1, 5), OP, () => {
			throw new Error("caller")
		})(null)
		expect(ledger.receipts("y")).toHaveLength(1)
	})

	it("lowers a boundary to a marker only, never below the receipt nor above its settle", () => {
		const ledger = ledgerWith(1000)
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(2, RATE), frame(1, 5)]), OP)
		session.pos = 500
		flush(conn, frame(1, 6), OP)
		session.pos = 5000
		const freq = ledger.receipts("rtl").at(-1)!
		expect(freq).toMatchObject({ seq: 3, pos: 500 })
		expect(ledger.trustAt("rtl", 1, 1400, 1500).reason).toBe("settling")
		// Raising is impossible: a later position keeps the settle boundary (1500).
		expect(ledger.lowerBoundary("rtl", 1, 3, 4000)).toBe(true)
		expect(ledger.trustAt("rtl", 1, 1500, 1600).trust).toBe("commanded")
		// Below the receipt clamps to its position; the rate receipt keeps its own boundary.
		expect(ledger.lowerBoundary("rtl", 1, 3, 100)).toBe(true)
		expect(ledger.trustAt("rtl", 1, 499, 600).reason).toBe("settling")
		expect(ledger.lowerBoundary("rtl", 1, 1, 0)).toBe(true)
		expect(ledger.trustAt("rtl", 1, 499, 600).reason).toBe("settling")
		expect(ledger.trustAt("rtl", 1, 500, 600).trust).toBe("commanded")
		// Unknown seq, session or position: nothing changes.
		expect(ledger.lowerBoundary("rtl", 1, 99, 0)).toBe(false)
		expect(ledger.lowerBoundary("rtl", 2, 3, 0)).toBe(false)
		expect(ledger.lowerBoundary("rtl", 1, 3, Number.NaN)).toBe(false)
		expect(ledger.lowerBoundary("nope", 1, 3, 0)).toBe(false)
	})

	it("centre-moving frames push the frequency boundary; ppm and crystals the rate's too", () => {
		for (const [cmd, rateToo] of [
			[0x05, true],
			[0x09, false],
			[0x0a, false],
			[0x0b, true],
			[0x0c, true],
		] as const) {
			const ledger = ledgerWith(100)
			const { conn, session } = started(ledger)
			flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
			session.pos = 1000
			flush(conn, frame(cmd, 1), OP)
			session.pos = 5000
			// Pushed to the frame's position + settle (1100), not left at 0 + 100.
			expect(ledger.trustAt("rtl", 1, 1099, 1200).reason).toBe("settling")
			expect(ledger.trustAt("rtl", 1, 1100, 1200).trust).toBe("commanded")
			// Blocks ending before the frame flushed are not moved.
			expect(ledger.trustAt("rtl", 1, 100, 1000).trust).toBe("commanded")
			// Per field at the live edge: frequency re-written after the frame (its own settle),
			// the rate only pushed by ppm and the crystals.
			const per = ledgerWith(100)
			const p = started(per)
			flush(p.conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
			p.session.pos = 1000
			flush(p.conn, frame(cmd, 1), OP)
			p.session.pos = 1050
			expect(per.fieldState("rtl").frequency.state).toBe("settling")
			expect(per.fieldState("rtl").sampleRate.state).toBe(
				rateToo ? "settling" : "proven",
			)
		}
	})

	it("reads the settle link live on every read", () => {
		let settleMsNow = 1000
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: settleMsNow, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => RATE,
		})
		const { conn, session } = started(ledger)
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		session.pos = 3_000_000
		// 1 Msps × 2 B × 1 s = 2 MB.
		expect(ledger.trustAt("rtl", 1, 1_000_000, 1_100_000).reason).toBe(
			"settling",
		)
		settleMsNow = 300
		expect(ledger.trustAt("rtl", 1, 1_000_000, 1_100_000).trust).toBe(
			"commanded",
		)
	})

	it("counts frames evicted from the pre-session queue as older than the ring", () => {
		const ledger = ledgerWith()
		const conn = ledger.connection("rtl")
		flush(conn, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		for (let i = 0; i < TUNING_LEDGER_RING - 2; i++)
			flush(conn, frame(4, i), OP)
		// At the bound both tuning frames are still pending.
		const kept = ledgerWith()
		const k = kept.connection("rtl")
		flush(k, Buffer.concat([frame(1, 5), frame(2, RATE)]), OP)
		for (let i = 0; i < TUNING_LEDGER_RING - 2; i++) flush(k, frame(4, i), OP)
		const ks = k.start()!
		ks.pos = 10
		expect(kept.trustAt("rtl", 1, 0, 10).trust).toBe("commanded")
		// One past it evicts the frequency frame.
		flush(conn, frame(4, 99), OP)
		const session = conn.start()!
		session.pos = 10
		expect(ledger.receipts("rtl")).toHaveLength(TUNING_LEDGER_RING)
		expect(ledger.trustAt("rtl", 1, 0, 10).reason).toBe("older-than-ring")
	})
})
