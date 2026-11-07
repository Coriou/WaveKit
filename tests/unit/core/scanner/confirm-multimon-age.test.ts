import { describe, expect, it } from "vitest"
import {
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
	ConfirmMemory,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import {
	createInterpreterState,
	type SharedConfirm,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	interpretMultimon,
	PocsagLowRun,
	POCSAG_LOW_QUIET_MS,
	POCSAG_ZERO_WORD_ADDRESSES,
} from "../../../../src/core/scanner/probes/confirm/multimon.js"

/**
 * An accepted pager capcode names a decode on its own only while its last counted decode is at most
 * CONFIRM_WINDOW_MS old, and the all-zero word's addresses keep their quiet-gap rule after
 * acceptance. Every address and body below is synthetic.
 */

const T0 = 1_000_000
const SECOND = 1_000
const DAY = 86_400_000
const REAL_ADDRESS = 1234567

function pocsag(at: number, address: number, fn = 0) {
	return {
		type: "message",
		timestamp: new Date(at),
		data: {
			protocol: "POCSAG1200",
			address,
			function: fn,
			messageType: "unknown",
			message: "",
		},
	}
}

function flex(at: number) {
	return {
		type: "message",
		timestamp: new Date(at),
		data: {
			protocol: "FLEX",
			capcode: "001234567",
			messageType: "NUM",
			message: "1",
		},
	}
}

/**
 * One discovery's shared memory; each `probe()` is one short probe: its own state and its own
 * all-zero-word run, as `CapcodeWindows` gives each probe.
 */
function discovery() {
	const clock = { now: T0 }
	const memory = new ConfirmMemory(() => clock.now)
	const shared: SharedConfirm = { memory, scope: () => "d:disc-1" }
	const probe = () => {
		const state = createInterpreterState({ epoch: 1, origin: "probe", shared })
		const run = new PocsagLowRun()
		return (out: ReturnType<typeof pocsag> | ReturnType<typeof flex>) =>
			interpretMultimon(out, state, run).some(e => e.identity !== undefined)
	}
	return { clock, probe }
}

describe("an accepted pager capcode ages", () => {
	it("a stuck slicer never identifies, also across two runs 45 s apart and for 10 min after", () => {
		const { clock, probe } = discovery()
		const run1 = probe()
		const got1: boolean[] = []
		for (let i = 0; i < 5; i++) {
			got1.push(run1(pocsag(clock.now, 2)))
			clock.now += SECOND
		}
		expect(got1).toEqual([false, false, false, false, false])
		// A new chance sync 45 s after run 1 began (41 s after its last decode). Each run's first decode
		// follows at least POCSAG_LOW_QUIET_MS of quiet as far as its own probe heard, and the two are
		// 45 s apart, inside 2 s to 5 min: exactly what a beacon every 45 s looks like, so they pair.
		// That is the known limit of a run's memory ending with its probe. The rest of run 2 is the
		// stuck run and, accepted or not, never counts.
		clock.now = T0 + 45 * SECOND
		const run2 = probe()
		expect(run2(pocsag(clock.now, 2))).toBe(true)
		for (let t = 1; t <= 600; t++) {
			clock.now = T0 + 45 * SECOND + t * SECOND
			expect(run2(pocsag(clock.now, t % POCSAG_ZERO_WORD_ADDRESSES))).toBe(
				false,
			)
		}
	})

	it("a 30-day-old acceptance does not identify a decode alone, nor the stuck run after it", () => {
		const { clock, probe } = discovery()
		expect(probe()(pocsag(clock.now, 2))).toBe(false)
		clock.now += 45 * SECOND
		expect(probe()(pocsag(clock.now, 2))).toBe(true)
		clock.now += 30 * DAY
		const late = probe()
		expect(late(pocsag(clock.now, 2))).toBe(false)
		for (let t = 1; t <= 10; t++) {
			clock.now += SECOND
			expect(late(pocsag(clock.now, 2))).toBe(false)
		}
	})

	it("after a 30-day-old acceptance a fresh beacon pair identifies again", () => {
		const { clock, probe } = discovery()
		expect(probe()(pocsag(clock.now, 3))).toBe(false)
		clock.now += 60 * SECOND
		expect(probe()(pocsag(clock.now, 3))).toBe(true)
		clock.now += 30 * DAY
		expect(probe()(pocsag(clock.now, 3))).toBe(false)
		clock.now += 60 * SECOND
		expect(probe()(pocsag(clock.now, 3))).toBe(true)
		// and the beacon keeps it fresh: each counted decode restarts the age
		for (let k = 0; k < 10; k++) {
			clock.now += 60 * SECOND
			expect(probe()(pocsag(clock.now, 3))).toBe(true)
		}
	})

	it("states the age bound at it and past it: 5 min counts, 5 min + 1 ms needs a pair", () => {
		const at = discovery()
		expect(at.probe()(pocsag(at.clock.now, REAL_ADDRESS))).toBe(false)
		at.clock.now += 60 * SECOND
		expect(at.probe()(pocsag(at.clock.now, REAL_ADDRESS))).toBe(true)
		at.clock.now += CONFIRM_WINDOW_MS
		expect(at.probe()(pocsag(at.clock.now, REAL_ADDRESS))).toBe(true)

		const past = discovery()
		expect(past.probe()(pocsag(past.clock.now, REAL_ADDRESS))).toBe(false)
		past.clock.now += 60 * SECOND
		expect(past.probe()(pocsag(past.clock.now, REAL_ADDRESS))).toBe(true)
		past.clock.now += CONFIRM_WINDOW_MS + 1
		expect(past.probe()(pocsag(past.clock.now, REAL_ADDRESS))).toBe(false)
		// that decode begins a new pair, measured as any other: 2 s later it completes
		past.clock.now += CONFIRM_MIN_SEPARATION_MS
		expect(past.probe()(pocsag(past.clock.now, REAL_ADDRESS))).toBe(true)
	})

	it("an accepted zero-word address counts after the quiet gap and not inside it", () => {
		const { clock, probe } = discovery()
		const p = probe()
		expect(p(pocsag(clock.now, 5))).toBe(false)
		clock.now += 60 * SECOND
		expect(p(pocsag(clock.now, 5))).toBe(true)
		clock.now += POCSAG_LOW_QUIET_MS - 1
		expect(p(pocsag(clock.now, 5))).toBe(false)
		clock.now += POCSAG_LOW_QUIET_MS
		expect(p(pocsag(clock.now, 5))).toBe(true)
	})

	it("FLEX ages the same way", () => {
		const { clock, probe } = discovery()
		expect(probe()(flex(clock.now))).toBe(false)
		clock.now += 60 * SECOND
		expect(probe()(flex(clock.now))).toBe(true)
		clock.now += 30 * DAY
		expect(probe()(flex(clock.now))).toBe(false)
		clock.now += 60 * SECOND
		expect(probe()(flex(clock.now))).toBe(true)
	})

	it("a decoder with no shared memory keeps its own acceptance for its life", () => {
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		const hit = (at: number) =>
			interpretMultimon(pocsag(at, REAL_ADDRESS), s).some(
				e => e.identity !== undefined,
			)
		expect(hit(T0)).toBe(false)
		expect(hit(T0 + 60 * SECOND)).toBe(true)
		expect(hit(T0 + 30 * DAY)).toBe(true)
	})
})
