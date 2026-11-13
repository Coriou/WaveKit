/**
 * The one user-facing reason a source's tuning is unproven (TuningUnprovenTracker), on a real
 * TuningLedger: cause by precedence (a block the controller names, else the ledger's doubt, no
 * session or no frame), when it began, and the refusals counted while it stands.
 */
import {
	sourceTuningUnprovenSchema,
	TUNING_UNPROVEN_CAUSES,
} from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { TuningLedger } from "../../../src/core/tuning-ledger.js"
import {
	causeCode,
	TuningUnprovenTracker,
} from "../../../src/core/tuning-ledger-unproven.js"

const RATE = 1_000_000

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

function make() {
	const ledger = new TuningLedger({
		settleLink: () => ({ configuredSettleMs: 0, inFlightBytes: 0 }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
	let clock = 1_700_000_000_000
	const tracker = new TuningUnprovenTracker(ledger, () => clock)
	const tick = (ms: number) => {
		clock += ms
	}
	return { ledger, tracker, tick, at: () => new Date(clock).toISOString() }
}

describe("TuningUnprovenTracker", () => {
	it("says nothing of a source the ledger never saw (a recording or audio source)", () => {
		const { tracker } = make()
		expect(tracker.view("rec")).toBeNull()
		tracker.noteRefusal("rec", "recording")
		expect(tracker.view("rec")).toBeNull()
	})

	it("names no frame, then nothing once proven, then the doubt with its reason; each cause has its own period", () => {
		const { ledger, tracker, tick, at } = make()
		const conn = ledger.connection("rtl")
		const session = conn.start()!
		const began = at()
		const first = tracker.view("rtl")!
		expect(first).toMatchObject({
			code: "tuning-unproven",
			cause: "no-receipt",
			fields: ["frequency", "sampleRate"],
			since: began,
			refusals: { recording: 0, identification: 0 },
		})
		expect(first.message).toMatch(/^Tuning not proven/)
		expect(first.fix.length).toBeGreaterThan(0)
		// Refusals while it stands count; a later read keeps the period.
		tracker.noteRefusal("rtl", "recording")
		tracker.noteRefusal("rtl", "recording")
		tracker.noteRefusal("rtl", "identification")
		tick(5000)
		expect(tracker.view("rtl")).toMatchObject({
			since: began,
			refusals: { recording: 2, identification: 1 },
		})
		// Proven (settle 0): no reason, and refusals are no longer counted.
		conn.write(Buffer.concat([frame(0x02, RATE), frame(0x01, 100_000_000)]), {
			writer: "operator",
		})(null)
		session.pos += 2
		expect(tracker.view("rtl")).toBeNull()
		tracker.noteRefusal("rtl", "recording")
		// A doubt of the centre: a new period, from now, with no refusals carried over.
		tick(1000)
		ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
		const doubt = tracker.view("rtl")!
		expect(doubt).toMatchObject({
			cause: "doubt:untracked-retune",
			fields: ["frequency"],
			since: at(),
			refusals: { recording: 0, identification: 0 },
		})
		expect(causeCode(doubt.cause)).toBe("doubt")
		// The session ends: no connection.
		conn.close()
		expect(tracker.view("rtl")).toMatchObject({ cause: "no-session" })
	})

	it("a block the controller names comes first (plain resume over a missing frame); an unknown block is ignored", () => {
		const { ledger, tracker } = make()
		ledger.connection("rtl").start()
		let block: string | null = "plain-resume"
		tracker.setBlockResolver(() => block)
		tracker.refresh("rtl")
		const view = tracker.view("rtl")!
		expect(view.cause).toBe("plain-resume")
		expect(view.message).toBe(
			"Tuning not proven since a resume without restore: recordings and identification are paused until the tuning is set or restored",
		)
		// Not a cause code: the ledger's own reason (never an echoed string).
		block = "something-else"
		expect(tracker.view("rtl")!.cause).toBe("no-receipt")
		// A resolver that throws: the ledger's reason (fail safe, still unproven).
		tracker.setBlockResolver(() => {
			throw new Error("boom")
		})
		expect(tracker.view("rtl")!.cause).toBe("no-receipt")
	})

	it("a doubt reason outside the fixed-code pattern reads doubt:other; every view fits the response schema's cause pattern", () => {
		const { ledger, tracker } = make()
		const conn = ledger.connection("rtl")
		const session = conn.start()!
		conn.write(Buffer.concat([frame(0x02, RATE), frame(0x01, 100_000_000)]), {
			writer: "operator",
		})(null)
		session.pos += 2
		ledger.raiseDoubt("rtl", "both", "Not A Code!")
		const view = tracker.view("rtl")!
		expect(view.cause).toBe("doubt:other")
		const pattern = new RegExp(
			sourceTuningUnprovenSchema.properties.cause.pattern,
		)
		expect(pattern.test(view.cause)).toBe(true)
		expect(pattern.test("doubt:untracked-retune")).toBe(true)
		for (const cause of TUNING_UNPROVEN_CAUSES)
			expect(pattern.test(cause)).toBe(cause !== "doubt")
		expect(pattern.test("doubt:")).toBe(false)
	})

	it("a standing hold (rate-truth mismatch) reads as a doubt of the rate", () => {
		const { ledger, tracker } = make()
		const conn = ledger.connection("rtl")
		const session = conn.start()!
		conn.write(Buffer.concat([frame(0x02, RATE), frame(0x01, 100_000_000)]), {
			writer: "operator",
		})(null)
		session.pos += 2
		expect(tracker.view("rtl")).toBeNull()
		ledger.setHold("rtl", "sampleRate", "rate-truth-mismatch")
		expect(tracker.view("rtl")).toMatchObject({
			cause: "doubt:rate-truth-mismatch",
			fields: ["sampleRate"],
		})
	})
})
