import { EventEmitter } from "node:events"
import pino from "pino"
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import {
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
	ConfirmMemory,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import {
	createInterpreterState,
	type InterpreterState,
	type SharedConfirm,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	interpretMultimon,
	POCSAG_BODY_MIN_CHARS,
	POCSAG_FIRST_HEARD_MAX,
	POCSAG_LOW_QUIET_MS,
	POCSAG_NUMERIC_MIN_RATIO,
	POCSAG_ZERO_WORD_ADDRESSES,
} from "../../../../src/core/scanner/probes/confirm/multimon.js"
import {
	CapcodeWindows,
	MULTIMON_HOLD_MS,
	probeModesFor,
	type ProbePoolDeps,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
import {
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

/**
 * POCSAG's gate against false decodes. The output shapes are multimon-ng's own, and every body and
 * address below is synthetic. Bodies named "chance" have the shape random bits gave after a chance
 * sync word: short, numeric or nearly unprintable.
 */

const T0 = 1_000_000
const REAL_ADDRESS = 1234567

function pocsag(
	at: number,
	address = REAL_ADDRESS,
	fn = 0,
	messageType = "unknown",
	message = "",
) {
	return {
		type: "message",
		timestamp: new Date(at),
		data: {
			protocol: "POCSAG1200",
			address,
			function: fn,
			messageType,
			message,
		},
	}
}

const alpha = (message: string, address = REAL_ADDRESS) =>
	pocsag(T0, address, 3, "alpha", message)
const numeric = (message: string, address = REAL_ADDRESS) =>
	pocsag(T0, address, 0, "numeric", message)

/** A live probe's state: pairs through the shared memory on one discovery. */
function rig(requirePair = false) {
	const clock = { now: T0 }
	const memory = new ConfirmMemory(() => clock.now)
	const shared: SharedConfirm = { memory, scope: () => "d:disc-1" }
	const state = (): InterpreterState =>
		createInterpreterState({
			epoch: 1,
			origin: requirePair ? "ambient" : "probe",
			shared,
			...(requirePair ? { requirePair: true } : {}),
		})
	return { clock, state }
}

type Output = Parameters<typeof interpretMultimon>[0]

const identified = (s: InterpreterState, out: Output) =>
	interpretMultimon(out, s).some(e => e.identity !== undefined)

/** One decode on a discovery that has heard nothing else. */
const alone = (out: Output) => identified(rig().state(), out)

describe("a POCSAG body on one decode", () => {
	it("identifies a real page at once, alpha or numeric", () => {
		expect(alone(alpha("CALL OFFICE 0800"))).toBe(true)
		// multimon-ng prints the padding of a body that does not fill its last word
		expect(alone(alpha("CALL OFFICE 0800<NUL>"))).toBe(true)
		expect(alone(alpha("CALL NOW<NUL><NUL>"))).toBe(true)
		expect(alone(numeric("555-0142"))).toBe(true)
		expect(alone(numeric("0123 456 789"))).toBe(true)
	})

	it("states the length bound at it and past it", () => {
		const at = "X".repeat(POCSAG_BODY_MIN_CHARS)
		const under = "X".repeat(POCSAG_BODY_MIN_CHARS - 1)
		expect(alone(alpha(at))).toBe(true)
		expect(alone(alpha(under))).toBe(false)
		const digitsAt = "1".repeat(POCSAG_BODY_MIN_CHARS)
		const digitsUnder = "1".repeat(POCSAG_BODY_MIN_CHARS - 1)
		expect(alone(numeric(digitsAt))).toBe(true)
		expect(alone(numeric(digitsUnder))).toBe(false)
		// Padding fills nothing: 7 characters and a pad are still 7.
		expect(alone(alpha(`${under}<NUL>`))).toBe(false)
	})

	it("states the numeric share at it and past it", () => {
		// 10 symbols: 9 of them numeric is exactly the share, 8 is under it
		expect(POCSAG_NUMERIC_MIN_RATIO).toBe(0.9)
		expect(alone(numeric("123456789U"))).toBe(true)
		expect(alone(numeric("12345678U["))).toBe(false)
	})

	it("refuses what chance prints: short bodies, BCD symbols, a stuck slicer's symbol", () => {
		for (const chance of [
			"pNN<c", // five printable alpha characters, two random words
			"Q<ETB>",
			"<DEL><DEL><DEL><DEL><DEL><DEL><DEL><DEL><DEL>",
			"W[/<<DC1>",
		])
			expect(alone(alpha(chance))).toBe(false)
		for (const chance of [
			"1 .48", // five BCD symbols, one random word
			"0 552[8571[[",
			"((((((((((((((",
			"]]]]]]]]",
		])
			expect(alone(numeric(chance))).toBe(false)
	})

	it("needs a known message type and function (malformed: no identity)", () => {
		expect(alone(pocsag(T0, REAL_ADDRESS, 3, "skyper", "CALL OFFICE"))).toBe(
			false,
		)
		expect(alone(pocsag(T0, REAL_ADDRESS, 7, "alpha", "CALL OFFICE"))).toBe(
			false,
		)
		expect(alone(pocsag(T0, REAL_ADDRESS, 3, "alpha", "CALL OFFICE"))).toBe(
			true,
		)
	})

	it("a short body still counts as a repeat of its address", () => {
		const { clock, state } = rig()
		expect(
			identified(state(), pocsag(T0, REAL_ADDRESS, 0, "alpha", "OK")),
		).toBe(false)
		clock.now += 60_000
		expect(
			identified(state(), pocsag(T0, REAL_ADDRESS, 0, "alpha", "OK")),
		).toBe(true)
	})

	it("an ambient decoder keeps needing a second decode, its older and stricter rule", () => {
		const { clock, state } = rig(true)
		expect(identified(state(), alpha("CALL OFFICE 0800"))).toBe(false)
		clock.now += 60_000
		expect(identified(state(), alpha("CALL OFFICE 0800"))).toBe(true)
	})

	it("FLEX keeps its own bar", () => {
		const flex = (message: string) => ({
			type: "message",
			timestamp: new Date(T0),
			data: {
				protocol: "FLEX",
				mode: "1600/2/A",
				frequency: "0.000",
				capcode: "001234567",
				messageType: "NUM",
				message,
			},
		})
		expect(alone(flex("1234"))).toBe(true)
		expect(alone(flex("123"))).toBe(false)
	})
})

describe("a repeated POCSAG address", () => {
	it("a tone-only beacon about every 60 s identifies on its second decode", () => {
		const { clock, state } = rig()
		expect(identified(state(), pocsag(clock.now))).toBe(false)
		clock.now += 60_000
		expect(identified(state(), pocsag(clock.now))).toBe(true)
	})

	it("states the window at it and past it, and one decode heard twice counts once", () => {
		const at = rig()
		expect(identified(at.state(), pocsag(at.clock.now))).toBe(false)
		at.clock.now += CONFIRM_WINDOW_MS
		expect(identified(at.state(), pocsag(at.clock.now))).toBe(true)

		const past = rig()
		expect(identified(past.state(), pocsag(past.clock.now))).toBe(false)
		past.clock.now += CONFIRM_WINDOW_MS + 1
		expect(identified(past.state(), pocsag(past.clock.now))).toBe(false)

		const close = rig()
		expect(identified(close.state(), pocsag(close.clock.now))).toBe(false)
		close.clock.now += CONFIRM_MIN_SEPARATION_MS - 1
		expect(identified(close.state(), pocsag(close.clock.now))).toBe(false)
		close.clock.now += 1
		expect(identified(close.state(), pocsag(close.clock.now))).toBe(true)
	})

	it("two different addresses never pair", () => {
		const { clock, state } = rig()
		expect(identified(state(), pocsag(clock.now, 572450))).toBe(false)
		clock.now += 60_000
		expect(identified(state(), pocsag(clock.now, 982785))).toBe(false)
	})

	it("the all-zero word's addresses do not pair inside a run, on any path, and the bound ends at 8", () => {
		for (const requirePair of [false, true]) {
			const { clock, state } = rig(requirePair)
			const s = state()
			// One chance sync, then a slicer held for 20 s: a decode every 200 ms, every frame's address.
			for (let i = 0; i < 100; i++) {
				const address = i % 8
				expect(identified(s, pocsag(clock.now, address))).toBe(false)
				clock.now += 200
			}
		}
		expect(POCSAG_ZERO_WORD_ADDRESSES).toBe(8)
		const { clock, state } = rig()
		// The first address past them is an ordinary one.
		expect(
			identified(state(), pocsag(clock.now, POCSAG_ZERO_WORD_ADDRESSES)),
		).toBe(false)
		clock.now += 60_000
		expect(
			identified(state(), pocsag(clock.now, POCSAG_ZERO_WORD_ADDRESSES)),
		).toBe(true)
	})

	it("only function 0 comes from the all-zero word; a real body there still identifies", () => {
		const { clock, state } = rig()
		expect(identified(state(), pocsag(clock.now, 3, 2))).toBe(false)
		clock.now += 60_000
		expect(identified(state(), pocsag(clock.now, 3, 2))).toBe(true)
		const { state: other } = rig()
		expect(identified(other(), alpha("CALL OFFICE 0800", 3))).toBe(true)
		expect(identified(other(), numeric("555-0142", 3))).toBe(true)
	})

	it("a decoder without a shared memory holds the same rule, 2 s apart at the least", () => {
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		expect(identified(s, pocsag(T0, 0))).toBe(false)
		expect(identified(s, pocsag(T0, 0))).toBe(false)
		expect(identified(s, pocsag(T0))).toBe(false)
		expect(identified(s, pocsag(T0))).toBe(false)
		expect(identified(s, pocsag(T0 + CONFIRM_MIN_SEPARATION_MS - 1))).toBe(
			false,
		)
		// A close decode keeps the earlier time, so a real repeat still measures from it.
		expect(identified(s, pocsag(T0 + CONFIRM_MIN_SEPARATION_MS))).toBe(true)
		// Accepted: every later decode is evidence again.
		expect(identified(s, pocsag(T0 + CONFIRM_MIN_SEPARATION_MS))).toBe(true)
	})

	it("a decode with no valid time never pairs without a shared memory", () => {
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		expect(identified(s, pocsag(T0))).toBe(false)
		expect(identified(s, pocsag(Number.NaN))).toBe(false)
		expect(identified(s, pocsag(Number.NaN, 3))).toBe(false)
	})

	it("states the bound on remembered first decodes at it and past it", () => {
		const fill = (count: number) => {
			const s = createInterpreterState({ epoch: 1, origin: "probe" })
			for (let i = 0; i < count; i++)
				expect(identified(s, pocsag(T0, 100_000 + i))).toBe(false)
			return s
		}
		const later = T0 + CONFIRM_MIN_SEPARATION_MS
		expect(POCSAG_FIRST_HEARD_MAX).toBe(256)
		expect(
			identified(fill(POCSAG_FIRST_HEARD_MAX), pocsag(later, 100_000)),
		).toBe(true)
		// One more and the oldest is forgotten: its next decode only begins a pair.
		expect(
			identified(fill(POCSAG_FIRST_HEARD_MAX + 1), pocsag(later, 100_000)),
		).toBe(false)
	})

	it("the 2 s minimum on that path is POCSAG's: FLEX still pairs as before", () => {
		const flex = () => ({
			type: "message",
			timestamp: new Date(T0),
			data: {
				protocol: "FLEX",
				capcode: "001234567",
				messageType: "NUM",
				message: "1",
			},
		})
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		expect(identified(s, flex())).toBe(false)
		expect(identified(s, flex())).toBe(true)
	})

	// Feature: pocsag-gate, Property 1: no false decode identifies alone
	// Validates: a false decode must not identify; a real page identifies at once
	it("no single chance-shaped decode identifies; any address, function and short body", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 ** 21 - 1 }),
				fc.integer({ min: 0, max: 3 }),
				fc.constantFrom("alpha", "numeric", "unknown"),
				fc.string({ maxLength: POCSAG_BODY_MIN_CHARS - 1 }),
				(address, fn, type, body) => {
					const { state } = rig()
					expect(identified(state(), pocsag(T0, address, fn, type, body))).toBe(
						false,
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("a low address at function 0 pairs across transmissions only", () => {
	const SECOND = 1_000
	const FIVE_MIN = 300_000
	const LOW = 3

	/** One decoder on one discovery, through the real per-capcode windows. */
	function decoderRig(
		requirePair = false,
		shared = true,
		holdMs = MULTIMON_HOLD_MS,
	) {
		const clock = { now: T0 }
		const memory = new ConfirmMemory(() => clock.now)
		const confirm: SharedConfirm = { memory, scope: () => "d:disc-1" }
		const windows = new CapcodeWindows(holdMs, () =>
			createInterpreterState({
				epoch: 1,
				origin: requirePair ? "ambient" : "probe",
				...(shared ? { shared: confirm } : {}),
				...(requirePair ? { requirePair: true } : {}),
			}),
		)
		const decode = (address = LOW) =>
			windows
				.interpret(pocsag(clock.now, address), clock.now)
				.some(e => e.identity !== undefined)
		return { clock, decode }
	}

	// With no shared memory a pair forms inside one capcode window only, so that path holds its window
	// open for 10 min: the longest span below is 5 min, and only the rule under test decides.
	const paths = [
		{
			name: "probe",
			requirePair: false,
			shared: true,
			holdMs: MULTIMON_HOLD_MS,
		},
		{
			name: "configured decoder",
			requirePair: true,
			shared: true,
			holdMs: MULTIMON_HOLD_MS,
		},
		{
			name: "replay, no shared memory",
			requirePair: false,
			shared: false,
			holdMs: 600_000,
		},
	]

	it.each(paths)(
		"$name: a run of decodes every second for 5 min never identifies",
		({ requirePair, shared, holdMs }) => {
			const { clock, decode } = decoderRig(requirePair, shared, holdMs)
			for (let t = 0; t <= FIVE_MIN; t += SECOND) {
				expect(decode()).toBe(false)
				clock.now += SECOND
			}
		},
	)

	it.each(paths)(
		"$name: a run over all 8 addresses never identifies, however long the windows renew",
		({ requirePair, shared, holdMs }) => {
			const { clock, decode } = decoderRig(requirePair, shared, holdMs)
			for (let t = 0; t <= FIVE_MIN; t += 125) {
				expect(decode((t / 125) % POCSAG_ZERO_WORD_ADDRESSES)).toBe(false)
				clock.now += 125
			}
		},
	)

	it.each(paths)(
		"$name: a beacon every 60 s identifies on its second decode",
		({ requirePair, shared, holdMs }) => {
			const { clock, decode } = decoderRig(requirePair, shared, holdMs)
			expect(decode()).toBe(false)
			clock.now += 60_000
			expect(decode()).toBe(true)
		},
	)

	it("a beacon pairs across two short probes on one discovery", () => {
		const { clock, state } = rig()
		expect(identified(state(), pocsag(clock.now, LOW))).toBe(false)
		clock.now += 60_000
		expect(identified(state(), pocsag(clock.now, LOW))).toBe(true)
	})

	it("states the quiet gap at it and just under it", () => {
		expect(POCSAG_LOW_QUIET_MS).toBe(30_000)
		const at = decoderRig()
		expect(at.decode()).toBe(false)
		at.clock.now += POCSAG_LOW_QUIET_MS
		expect(at.decode()).toBe(true)

		const under = decoderRig()
		expect(under.decode()).toBe(false)
		under.clock.now += POCSAG_LOW_QUIET_MS - 1
		expect(under.decode()).toBe(false)
		// That decode voided the first, and counted for nothing itself.
		under.clock.now += POCSAG_LOW_QUIET_MS
		expect(under.decode()).toBe(false)
		under.clock.now += POCSAG_LOW_QUIET_MS
		expect(under.decode()).toBe(true)
	})

	it.each(paths)(
		"$name: a decode 30 s after a run only begins a pair",
		({ requirePair, shared, holdMs }) => {
			const { clock, decode } = decoderRig(requirePair, shared, holdMs)
			// Short enough that the run's first decode is still inside the 5 min pairing window.
			for (let t = 0; t < 20; t++) {
				expect(decode()).toBe(false)
				clock.now += SECOND
			}
			clock.now += POCSAG_LOW_QUIET_MS - SECOND
			expect(decode()).toBe(false)
			clock.now += POCSAG_LOW_QUIET_MS
			expect(decode()).toBe(true)
		},
	)

	it("two runs with a quiet gap between them never pair", () => {
		const { clock, decode } = decoderRig()
		for (let run = 0; run < 3; run++) {
			for (let t = 0; t < 10; t++) {
				expect(decode()).toBe(false)
				clock.now += SECOND
			}
			clock.now += POCSAG_LOW_QUIET_MS
		}
	})

	it("any address of the family refreshes the gap for all of them", () => {
		const { clock, decode } = decoderRig()
		expect(decode(LOW)).toBe(false)
		clock.now += POCSAG_LOW_QUIET_MS - 1
		expect(decode(LOW + 1)).toBe(false)
		clock.now += 1
		expect(decode(LOW)).toBe(false)
	})

	it("a clock that steps back is no quiet gap", () => {
		const { clock, decode } = decoderRig()
		expect(decode()).toBe(false)
		clock.now -= 60_000
		expect(decode()).toBe(false)
	})

	it("an address past the family, or another function, is not held to the gap", () => {
		const past = decoderRig()
		expect(past.decode(POCSAG_ZERO_WORD_ADDRESSES)).toBe(false)
		past.clock.now += CONFIRM_MIN_SEPARATION_MS
		expect(past.decode(POCSAG_ZERO_WORD_ADDRESSES)).toBe(true)

		const { clock, state } = rig()
		const s = state()
		expect(identified(s, pocsag(clock.now, LOW, 2))).toBe(false)
		clock.now += CONFIRM_MIN_SEPARATION_MS
		expect(identified(s, pocsag(clock.now, LOW, 2))).toBe(true)
	})
})

describe("a configured decoder, through the ambient path", () => {
	const HZ = 153_350_000

	function ambientRig() {
		const clock = { now: T0 }
		const decoders = new EventEmitter()
		const status = {
			id: "pager-cfg",
			type: "multimon-ng",
			sourceId: "rtl",
			owner: "config",
			running: true,
			health: "running",
		}
		Object.assign(decoders, {
			getAllStatus: () => [status],
			getStatus: () => status,
			getDecoder: () => undefined,
		})
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			now: () => clock.now,
			tuningTrustOf: () => "commanded",
			targetOf: () => ({
				sourceId: "rtl",
				hz: HZ,
				targetsHz: [HZ],
				external: false,
			}),
			centreOf: () => HZ - 50_000,
			epochOf: () => 1,
			logger: pino({ level: "silent" }),
			confirm: {
				memory: new ConfirmMemory(() => clock.now),
				scopeOf: () => "d:disc-1",
			},
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const emit = (out: Output) =>
			decoders.emit("decoder:output", "pager-cfg", out)
		const identities = () => got.filter(e => e.ev.identity !== undefined).length
		return { ambient, clock, emit, identities }
	}

	it("identical pages 60 s apart do not pair; different text and tone-only do", () => {
		const r = ambientRig()
		const page = (message: string) =>
			pocsag(r.clock.now, REAL_ADDRESS, 3, "alpha", message)
		try {
			r.emit(page("CALL OFFICE 0800"))
			r.clock.now += 60_000
			r.emit(page("CALL OFFICE 0800"))
			expect(r.identities()).toBe(0)
			r.clock.now += 60_000
			r.emit(page("CALL HOME 0900"))
			expect(r.identities()).toBe(1)
		} finally {
			r.ambient.stop()
		}

		const tone = ambientRig()
		try {
			tone.emit(pocsag(tone.clock.now))
			tone.clock.now += 60_000
			tone.emit(pocsag(tone.clock.now))
			expect(tone.identities()).toBe(1)
		} finally {
			tone.ambient.stop()
		}
	})

	it("a low address: a 5 min run never identifies and a 60 s beacon does", () => {
		const run = ambientRig()
		try {
			for (let t = 0; t <= 300; t++) {
				run.emit(pocsag(run.clock.now, 3))
				run.clock.now += 1_000
			}
			expect(run.identities()).toBe(0)
		} finally {
			run.ambient.stop()
		}

		const beacon = ambientRig()
		try {
			beacon.emit(pocsag(beacon.clock.now, 3))
			expect(beacon.identities()).toBe(0)
			beacon.clock.now += 60_000
			beacon.emit(pocsag(beacon.clock.now, 3))
			expect(beacon.identities()).toBe(1)
		} finally {
			beacon.ambient.stop()
		}
	})
})

describe("the channel's spectral class", () => {
	/**
	 * A live probe of class `cls` on one discovery, two probes 60 s apart, through the real pool. An
	 * `analog-fm` probe plans no pager mode of its own, so the modes are given; a configured decoder
	 * on that channel reads the same interpreter.
	 */
	async function beaconOn(cls: ScannerClass): Promise<number> {
		const h = poolHarness()
		const memory = new ConfirmMemory(() => h.clock.now)
		;(h.pool as unknown as { deps: ProbePoolDeps }).deps.confirm = {
			memory,
			scopeOf: () => "d:disc-1",
		}
		for (let k = 0; k < 2; k++) {
			const res = h.pool.request(
				probeRequest({
					cls,
					protocols: ["pocsag"],
					modes: probeModesFor("fsk2-wide", []),
					holdMs: 60_000,
					trackId: `t${k}`,
				}),
			)
			if (!("started" in res)) throw new Error("not started")
			await flushAsync()
			const decoderId = h.pool
				.status()
				.find(s => s.probeId === res.started)!.decoderId
			h.decoders.emitOutput(decoderId, pocsag(h.clock.now))
			await h.pool.release(res.started)
			await flushAsync()
			if (k === 0) h.clock.now += 60_000
		}
		return h.evidence.filter(e => e.ev.identity !== undefined).length
	}

	it("a beacon about every 60 s identifies on a channel not read as analog-fm", async () => {
		expect(await beaconOn("fsk2-wide")).toBe(1)
	})

	it("the same beacon identifies on a channel read as analog-fm: the rule reads no class", async () => {
		// A class can be wrong and a shorter window would not end false repeats
		// (`POCSAG_ZERO_WORD_ADDRESSES`), so this beacon is not lost to one.
		expect(await beaconOn("analog-fm")).toBe(1)
	})

	it("and on a channel whose class is unknown", async () => {
		expect(await beaconOn("unknown")).toBe(1)
	})
})

describe("POCSAG pairing with no shared memory", () => {
	const state = () => createInterpreterState({ epoch: 1, origin: "probe" })

	it("pairs a repeat exactly at the window's end", () => {
		const s = state()
		expect(interpretMultimon(pocsag(T0), s)).toEqual([])
		expect(interpretMultimon(pocsag(T0 + CONFIRM_WINDOW_MS), s)).toHaveLength(1)
	})

	it("does not pair a repeat past the window, and that repeat starts a new pair", () => {
		const s = state()
		const late = T0 + CONFIRM_WINDOW_MS + 1
		expect(interpretMultimon(pocsag(T0), s)).toEqual([])
		expect(interpretMultimon(pocsag(late), s)).toEqual([])
		expect(
			interpretMultimon(pocsag(late + CONFIRM_MIN_SEPARATION_MS), s),
		).toHaveLength(1)
	})
})
