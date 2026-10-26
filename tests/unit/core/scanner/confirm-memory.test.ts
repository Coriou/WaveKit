import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
	type AmbientPairContext,
} from "../../../../src/core/scanner/probes/ambient.js"
import {
	CONFIRM_MAX_ENTRIES,
	CONFIRM_MAX_PART_CHARS,
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
	ConfirmMemory,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import {
	createInterpreterState,
	DoubleMatch,
	type SharedConfirm,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	CapcodeWindows,
	type ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { probeRequest } from "../../../mocks/scanner/probe-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"

function memory(start = 1_000_000) {
	const clock = { now: start }
	return { clock, mem: new ConfirmMemory(() => clock.now) }
}

/** A single-decode POCSAG page the plausibility rule refuses (function 0, messageType unknown). */
const page = (at: number, address = 8) => ({
	type: "message",
	timestamp: new Date(at),
	data: {
		protocol: "POCSAG1200",
		address,
		function: 0,
		messageType: "unknown",
		message: "",
	},
})

const sharedIn = (mem: ConfirmMemory, scope: string | null): SharedConfirm => ({
	memory: mem,
	scope: () => scope,
})

/** One short probe: a fresh multimon state (as the pool builds per probe) sharing `shared`. */
function probe(shared: SharedConfirm, probeId: string): CapcodeWindows {
	return new CapcodeWindows(4000, () =>
		createInterpreterState({
			epoch: 1,
			origin: "probe",
			probeId,
			decoderId: `scan-${probeId}`,
			shared,
		}),
	)
}

const identities = (evs: DecodeEvidence[]) =>
	evs.filter(e => e.identity !== undefined)

describe("ConfirmMemory", () => {
	it("pairs at the window bound and not 1 ms past it", () => {
		const { clock, mem } = memory()
		expect(mem.pair("d:1", "pocsag:cap", "8")).toBe(false)
		clock.now += CONFIRM_WINDOW_MS
		expect(mem.pair("d:1", "pocsag:cap", "8")).toBe(true)
		clock.now += CONFIRM_WINDOW_MS + 1
		expect(mem.pair("d:1", "pocsag:cap", "8")).toBe(false)
		// that fresh occurrence opened a new window
		clock.now += CONFIRM_MIN_SEPARATION_MS
		expect(mem.pair("d:1", "pocsag:cap", "8")).toBe(true)
	})

	it("never pairs occurrences closer than the minimum separation (one transmission, two decoders)", () => {
		const { clock, mem } = memory()
		expect(mem.pair("d:1", "k", "v")).toBe(false)
		clock.now += CONFIRM_MIN_SEPARATION_MS - 1
		expect(mem.pair("d:1", "k", "v")).toBe(false)
		// the close occurrence did not move the earlier time: 2 000 ms after the first pairs
		clock.now += 1
		expect(mem.pair("d:1", "k", "v")).toBe(true)
	})

	it("keeps scopes, keys and values apart", () => {
		const { clock, mem } = memory()
		mem.pair("d:1", "pocsag:cap", "8")
		clock.now += 60_000
		expect(mem.pair("d:2", "pocsag:cap", "8")).toBe(false)
		expect(mem.pair("d:1", "flex:cap", "8")).toBe(false)
		expect(mem.pair("d:1", "pocsag:cap", "9")).toBe(false)
		expect(mem.pair("d:1", "pocsag:cap", "8")).toBe(true)
	})

	it("holds at most CONFIRM_MAX_ENTRIES entries, evicting the least recently recorded", () => {
		const { clock, mem } = memory()
		for (let i = 0; i < CONFIRM_MAX_ENTRIES; i++) mem.pair("d:1", "k", `v${i}`)
		expect(mem.size).toBe(CONFIRM_MAX_ENTRIES)
		mem.pair("d:1", "k", "extra")
		expect(mem.size).toBe(CONFIRM_MAX_ENTRIES)
		clock.now += 60_000
		// v0 was evicted, v1 is still there
		expect(mem.pair("d:1", "k", "v0")).toBe(false)
		expect(mem.pair("d:1", "k", "v2")).toBe(true)
	})

	it("expires entries past the window", () => {
		const { clock, mem } = memory()
		mem.pair("d:1", "k", "a")
		mem.pair("d:1", "k", "b")
		clock.now += CONFIRM_WINDOW_MS + 1
		mem.pair("d:1", "k", "c")
		expect(mem.size).toBe(1)
	})

	it("refuses malformed parts and a bad clock (the safe answer)", () => {
		const { clock, mem } = memory()
		const long = "x".repeat(CONFIRM_MAX_PART_CHARS + 1)
		const atBound = "x".repeat(CONFIRM_MAX_PART_CHARS)
		for (const [s, k, v] of [
			["", "k", "v"],
			["d:1", "", "v"],
			["d:1", "k", ""],
			[long, "k", "v"],
			["d:1", "k", long],
		] as const) {
			mem.pair(s, k, v)
			clock.now += 60_000
			expect(mem.pair(s, k, v)).toBe(false)
		}
		mem.pair("d:1", "k", atBound)
		clock.now += 60_000
		expect(mem.pair("d:1", "k", atBound)).toBe(true)
		const bad = new ConfirmMemory(() => Number.NaN)
		expect(bad.pair("d:1", "k", "v")).toBe(false)
		expect(bad.size).toBe(0)
		const throwing = new ConfirmMemory(() => {
			throw new Error("clock")
		})
		expect(throwing.pair("d:1", "k", "v")).toBe(false)
	})

	it("pairs only within [separation, window] of the last recorded occurrence (property)", () => {
		// Feature: decode-attachment, Property 1: confirm pairing window
		// Validates: Requirements 3a
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 2 * CONFIRM_WINDOW_MS }), {
					minLength: 1,
					maxLength: 12,
				}),
				gaps => {
					const { clock, mem } = memory()
					let last: number | null = null
					for (const gap of gaps) {
						clock.now += gap
						const got = mem.pair("d:1", "k", "v")
						const age = last === null ? null : clock.now - last
						const expected =
							age !== null &&
							age >= CONFIRM_MIN_SEPARATION_MS &&
							age <= CONFIRM_WINDOW_MS
						expect(got).toBe(expected)
						if (age === null || age >= CONFIRM_MIN_SEPARATION_MS)
							last = clock.now
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("DoubleMatch with a shared pairing", () => {
	it("with a scope, repeats inside one instance obey the separation and window bounds", () => {
		// Review regression: local seen >= 2 bypassed the shared bounds.
		const { clock, mem } = memory()
		const m = new DoubleMatch(sharedIn(mem, "d:1"))
		expect(m.accept("k", "v", true)).toBe(false)
		clock.now += 100
		expect(m.accept("k", "v", true)).toBe(false)
		clock.now += CONFIRM_WINDOW_MS + 1
		expect(m.accept("k", "w", true)).toBe(false)
		const n = new DoubleMatch(sharedIn(mem, "d:2"))
		expect(n.accept("k", "v", true)).toBe(false)
		clock.now += CONFIRM_WINDOW_MS + 1
		expect(n.accept("k", "v", true)).toBe(false)
		// every local occurrence records in the shared memory: a second instance pairs with it
		clock.now += CONFIRM_MIN_SEPARATION_MS
		expect(new DoubleMatch(sharedIn(mem, "d:2")).accept("k", "v", true)).toBe(
			true,
		)
		expect(n.isAccepted("k", "v")).toBe(true)
		expect(n.accept("k", "v", true)).toBe(false)
	})

	it("acceptance is per scope, the accepted shortcut included", () => {
		const { clock, mem } = memory()
		const scope = { now: "d:a" as string | null }
		const m = new DoubleMatch({ memory: mem, scope: () => scope.now })
		m.accept("ais:mmsi", "x", true)
		clock.now += 60_000
		expect(m.accept("ais:mmsi", "x", true)).toBe(true)
		expect(m.isAccepted("ais:mmsi", "x")).toBe(true)
		scope.now = "d:b"
		expect(m.isAccepted("ais:mmsi", "x")).toBe(false)
		expect(m.accept("ais:mmsi", "x", true)).toBe(false)
		m.markAccepted("p:call", "c")
		scope.now = "d:a"
		expect(m.isAccepted("p:call", "c")).toBe(false)
	})

	it("without a scope (or a throwing one), the instance pairs alone as before", () => {
		const { mem } = memory()
		const m = new DoubleMatch(sharedIn(mem, null))
		expect(m.accept("k", "v", true)).toBe(false)
		expect(m.accept("k", "v", true)).toBe(true)
		expect(mem.size).toBe(0)
		const t = new DoubleMatch({
			memory: mem,
			scope: () => {
				throw new Error("scope")
			},
		})
		expect(t.accept("k", "v", true)).toBe(false)
		expect(t.accept("k", "v", true)).toBe(true)
	})

	it("keeps dsd-fme link identities per scope", () => {
		const { mem } = memory()
		const scope = { now: "d:a" }
		const state = createInterpreterState({
			epoch: 1,
			origin: "ambient",
			shared: { memory: mem, scope: () => scope.now },
		})
		state.accepted.set("dmr:id", "1")
		expect(state.accepted.get("dmr:id")).toBe("1")
		scope.now = "d:b"
		expect(state.accepted.has("dmr:id")).toBe(false)
		expect(state.accepted.get("dmr:id")).toBeUndefined()
	})

	it("two short probes, one decode of a capcode each, 60 s apart: the second confirms", () => {
		const { clock, mem } = memory()
		const pair = sharedIn(mem, "d:disc-1")
		expect(
			identities(probe(pair, "p1").interpret(page(clock.now), clock.now)),
		).toEqual([])
		clock.now += 60_000
		const evs = probe(pair, "p2").interpret(page(clock.now), clock.now)
		expect(identities(evs)).toEqual([
			expect.objectContaining({
				protocol: "pocsag",
				probeId: "p2",
				identity: { kind: "pocsag-capcode", value: "8" },
			}),
		])
	})

	it("without a shared pairing, the same two probes never confirm (the R4 defect)", () => {
		const a = new CapcodeWindows(4000, () =>
			createInterpreterState({ epoch: 1, origin: "probe" }),
		)
		const b = new CapcodeWindows(4000, () =>
			createInterpreterState({ epoch: 1, origin: "probe" }),
		)
		expect(identities(a.interpret(page(0), 0))).toEqual([])
		expect(identities(b.interpret(page(60_000), 60_000))).toEqual([])
	})

	it("probes on different discoveries never pair, nor does one decode heard by two probes at once", () => {
		const { clock, mem } = memory()
		probe(sharedIn(mem, "d:a"), "p1").interpret(page(clock.now), clock.now)
		clock.now += 60_000
		expect(
			identities(
				probe(sharedIn(mem, "d:b"), "p2").interpret(page(clock.now), clock.now),
			),
		).toEqual([])
		clock.now += 500
		expect(
			identities(
				probe(sharedIn(mem, "d:b"), "p3").interpret(page(clock.now), clock.now),
			),
		).toEqual([])
	})
})

describe("AmbientEvidence with the shared pairing", () => {
	it("an ambient multimon decode pairs with a probe's earlier decode on the same discovery", () => {
		const { clock, mem } = memory()
		const decoders = new EventEmitter() as EventEmitter &
			Record<string, unknown>
		decoders["getAllStatus"] = () => [
			{
				id: "pager-cfg",
				type: "multimon-ng",
				sourceId: "rtl",
				owner: "config",
			},
		]
		decoders["getDecoder"] = () => undefined
		const contexts: AmbientPairContext[] = []
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id =>
				id === "pager-cfg"
					? {
							sourceId: "rtl",
							hz: 153_350_000,
							targetsHz: [153_350_000],
							external: false,
						}
					: null,
			epochOf: () => 3,
			logger: pino({ level: "silent" }),
			now: () => clock.now,
			confirm: {
				memory: mem,
				scopeOf: ctx => {
					contexts.push(ctx)
					return "d:disc-1"
				},
			},
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		try {
			probe(sharedIn(mem, "d:disc-1"), "p1").interpret(
				page(clock.now),
				clock.now,
			)
			clock.now += 60_000
			decoders.emit("decoder:output", "pager-cfg", page(clock.now))
			expect(got).toHaveLength(1)
			expect(got[0]?.ev.identity).toEqual({
				kind: "pocsag-capcode",
				value: "8",
			})
			// The scope was asked where the decode lies, at its own time.
			expect(contexts.length).toBeGreaterThan(0)
			for (const c of contexts)
				expect(c).toEqual({ sourceId: "rtl", hz: 153_350_000, at: clock.now })
		} finally {
			ambient.stop()
		}
	})
})

describe("ScannerService probe pairing wiring", () => {
	it("pairs live probes of one observation 60 s apart, never a replay or another observation", () => {
		vi.useFakeTimers({ now: 5_000_000, toFake: ["Date"] })
		try {
			const h = serviceHarness()
			const internals = h.service as unknown as {
				probeConfirmScope(req: ProbeRequest): string | null
				confirmMemory: ConfirmMemory
			}
			const pair = (req: ProbeRequest, key: string, value: string) => {
				const scope = internals.probeConfirmScope(req)
				return scope !== null && internals.confirmMemory.pair(scope, key, value)
			}
			const live = probeRequest({ observationId: "obs-1" })
			expect(pair(live, "pocsag:cap", "8")).toBe(false)
			vi.setSystemTime(5_060_000)
			expect(
				pair(
					probeRequest({ observationId: "obs-1", replay: { captureId: "c" } }),
					"pocsag:cap",
					"8",
				),
			).toBe(false)
			expect(
				pair(probeRequest({ observationId: "obs-2" }), "pocsag:cap", "8"),
			).toBe(false)
			expect(pair(live, "pocsag:cap", "8")).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("AmbientEvidence shared acceptance is scoped per discovery (review regressions)", () => {
	const AIS_A = 161_975_000
	const AIS_B = 162_025_000
	function aisRig() {
		const { clock, mem } = memory(0)
		const decoders = new EventEmitter() as EventEmitter &
			Record<string, unknown>
		const status = (id: string) => ({
			id,
			type: "ais-catcher",
			sourceId: "rtl",
			owner: "config",
			running: true,
			health: "running",
			suspended: false,
		})
		decoders["getAllStatus"] = () => [status("ais1"), status("ais2")]
		decoders["getStatus"] = (id: string) => status(id)
		decoders["getDecoder"] = () => undefined
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: () => ({
				sourceId: "rtl",
				hz: AIS_A,
				targetsHz: [AIS_A, AIS_B],
				external: false,
			}),
			epochOf: () => 1,
			logger: pino({ level: "silent" }),
			now: () => clock.now,
			tuningTrustOf: () => "commanded",
			confirm: {
				memory: mem,
				// a distinct discovery on each channel
				scopeOf: ctx =>
					ctx.hz === AIS_A ? "d:A" : ctx.hz === AIS_B ? "d:B" : null,
			},
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const hear = (id: string, channel: "A" | "B") =>
			decoders.emit("decoder:output", id, {
				type: "ship",
				data: { mmsi: "244123456", channel },
				timestamp: new Date(clock.now),
			})
		const named = () => got.filter(e => e.ev.identity !== undefined)
		return { clock, ambient, hear, named, got }
	}

	it("an MMSI confirmed on channel A is not identity evidence on channel B", () => {
		const r = aisRig()
		try {
			r.hear("ais1", "A")
			r.clock.now += 60_000
			r.hear("ais2", "A")
			expect(r.named().map(e => e.hz)).toEqual([AIS_A])
			r.hear("ais2", "B")
			expect(r.named().map(e => e.hz)).toEqual([AIS_A])
			expect(r.got.at(-1)?.hz).toBe(AIS_B)
		} finally {
			r.ambient.stop()
		}
	})

	it("one persistent decoder never pairs 100 ms or 300 001 ms apart", () => {
		const r = aisRig()
		try {
			r.hear("ais1", "A")
			r.clock.now += 100
			r.hear("ais1", "A")
			expect(r.named()).toEqual([])
			r.clock.now += CONFIRM_WINDOW_MS + 1
			r.hear("ais1", "A")
			expect(r.named()).toEqual([])
			r.clock.now += 60_000
			r.hear("ais1", "A")
			expect(r.named()).toHaveLength(1)
		} finally {
			r.ambient.stop()
		}
	})
})
