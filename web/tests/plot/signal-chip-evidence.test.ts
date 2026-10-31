import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { Discovery, ScannerProof } from "@wavekit/api-types"

import {
	PROVEN_LIVE_HOLD_MS,
	discoveryIndex,
	identifiedAt,
	identifiesChip,
	tagState,
	unidentifiedLabel,
} from "../../src/plot/discovery-tags.ts"
import {
	ADOPT_WIDTH_RATIO,
	adoptable,
	BURST_HOLD_MS,
	EMPTY_LABEL_GATE,
	HOLD_MS,
	PROVEN_CHIP_HOLD_MS,
	WEAK_FOR_MS,
	gatedSignals,
	stepLabelGate,
	type LabelGateContext,
	type LabelGateState,
} from "../../src/plot/label-gate.ts"
import type { Track } from "../../src/plot/maths.ts"
import {
	chipIdentity,
	clusterSignals,
	provenLiveAt,
	weakChip,
	weakDiscoveryAt,
} from "../../src/plot/signal-chips.ts"

// ── The gate: a chip on a proven, live discovery holds between bursts ──────────────────────────────

const FLOOR = -70
const MHZ = 161.3125

function track(snrDb: number, burst = true): Track {
	const hz = MHZ * 1e6
	return {
		startHz: hz - 5000,
		endHz: hz + 5000,
		flags: { burst, iqImage: false, edge: false },
		peakDb: FLOOR + snrDb,
	}
}

function ctx(provenLive?: LabelGateContext["provenLive"]): LabelGateContext {
	// named, as a decoded discovery names it in Plot.tsx
	const c: LabelGateContext = {
		mode: "clear",
		tunedHz: null,
		isNamed: () => true,
	}
	if (provenLive) c.provenLive = provenLive
	return c
}

function step(
	s: LabelGateState,
	tracks: Track[],
	now: number,
	c: LabelGateContext,
): LabelGateState {
	return stepLabelGate(
		s,
		{
			sourceId: "rtl",
			tracks,
			floorDbfs: FLOOR,
			binHz: 250,
			epoch: 1,
			startHz: 0,
			binCount: 8_000_000,
		},
		now,
		c,
	)
}

const shown = (s: LabelGateState) =>
	gatedSignals(s).filter(g => !g.leaving).length
const leaving = (s: LabelGateState) =>
	gatedSignals(s).filter(g => g.leaving).length

/** One burst seen at t = 0 (the chip shows at once: named, 20 dB over the floor). */
function afterBurst(c: LabelGateContext): LabelGateState {
	const s = step(EMPTY_LABEL_GATE, [track(20)], 0, c)
	expect(shown(s)).toBe(1)
	return s
}

/** A burst the core tracks as `trackId` (each burst of a control channel gets a new one). */
function idTrack(n: number, snrDb = 20, offHz = 0): Track {
	const t = track(snrDb)
	return {
		...t,
		startHz: t.startHz + offHz,
		endHz: t.endHz + offHz,
		trackId: `t${n}`,
	}
}

describe("signal chips: a proven chip across bursts with new track ids", () => {
	it("keeps exactly one chip over many bursts, each with its own track id", () => {
		const c = ctx(() => true)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		const id = gatedSignals(s)[0]?.id
		expect(id).toBeDefined()
		for (let n = 2; n <= 40; n++) {
			const t = (n - 1) * 14_000
			// the burst is gone, then the next one comes 14 s later under a new id, jittering a little
			s = step(s, [], t - 13_000, c)
			s = step(s, [idTrack(n, 20, (n % 3) * 400)], t, c)
			expect(gatedSignals(s).map(g => [g.id, g.leaving])).toEqual([[id, false]])
		}
		// what the chip row draws: one chip, no "+1"
		const g = gatedSignals(s)[0]!
		const info = {
			hz: g.hz,
			widthHz: g.widthHz,
			label: "DMR · CC 7",
			sub: "",
			known: true,
			peakDb: g.peakDb,
			burst: true,
		}
		const out = clusterSignals(
			gatedSignals(s).map(x => ({ ...info, hz: x.hz })),
			{ startHz: HZ - 1e6, endHz: HZ + 1e6 },
			1000,
		)
		expect(out.map(x => x.label)).toEqual(["DMR · CC 7"])
	})

	it("adopts the new track id: the old one never claims the chip again", () => {
		const c = ctx(() => true)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		s = step(s, [idTrack(2)], 14_000, c)
		// the old id at the same place is now another emission beside the chip
		s = step(s, [idTrack(2), idTrack(1)], 14_100, c)
		expect(s.followed.map(f => f.key)).toEqual(
			expect.arrayContaining(["rtl/t2", "rtl/t1"]),
		)
		expect(s.followed.filter(f => f.key === "rtl/t2")).toHaveLength(1)
	})

	it("keeps two emissions apart when both track ids are in the same frame", () => {
		const c = ctx(() => true)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		s = step(s, [idTrack(1), idTrack(2, 18)], 100, c)
		expect(s.followed).toHaveLength(2)
	})

	it("re-attaches only within max(tol, width / 4) of the chip's centre: a burst past it is another signal", () => {
		const c = ctx(() => true)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		// tol = max(2 bins of 250 Hz, 1 kHz) = 1 kHz; the 10 kHz-wide chip: max(1000, 10000 / 4) = 2500 Hz
		s = step(s, [idTrack(2, 20, 2500)], 14_000, c)
		expect(s.followed).toHaveLength(1)
		s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		s = step(s, [idTrack(2, 20, 2501)], 14_000, c)
		expect(s.followed).toHaveLength(2)
	})

	/** A burst `widthHz` wide centred `offHz` from MHZ, as track id `n`. */
	function wTrack(n: number, widthHz: number, offHz = 0): Track {
		const hz = MHZ * 1e6 + offHz
		return {
			startHz: hz - widthHz / 2,
			endHz: hz + widthHz / 2,
			flags: { burst: true, iqImage: false, edge: false },
			peakDb: FLOOR + 20,
			trackId: `t${n}`,
		}
	}

	it("a 6.25 kHz neighbour never takes a held 12.5 kHz DMR chip", () => {
		const c = ctx(() => true)
		const dmr = step(EMPTY_LABEL_GATE, [wTrack(1, 12_500)], 0, c)
		// one 6.25 kHz channel up: 6250 Hz off, past max(1000, 12500 / 4) = 3125 Hz, and 12500 / 6250 = 2 > 1.5
		const up = step(dmr, [wTrack(2, 6250, 6250)], 14_000, c)
		expect(up.followed).toHaveLength(2)
		expect(up.followed.find(f => f.key === "rtl/t1")?.widthHz).toBe(12_500)
		// on the same centre but half as wide: the width rule alone keeps them apart
		const narrow = step(dmr, [wTrack(2, 6250)], 14_000, c)
		expect(narrow.followed).toHaveLength(2)
		// the DMR channel's own next burst still adopts the chip
		const same = step(dmr, [wTrack(2, 12_000, 400)], 14_000, c)
		expect(same.followed.map(f => f.key)).toEqual(["rtl/t2"])
	})

	it("adopts at the width ratio bound, not past it", () => {
		expect(ADOPT_WIDTH_RATIO).toBe(1.5)
		const c = ctx(() => true)
		const chip = step(EMPTY_LABEL_GATE, [wTrack(1, 9000)], 0, c)
		// 9000 / 6000 = 1.5: the same emission
		expect(step(chip, [wTrack(2, 6000)], 14_000, c).followed).toHaveLength(1)
		// 9000 / 5999 > 1.5: another one
		expect(step(chip, [wTrack(2, 5999)], 14_000, c).followed).toHaveLength(2)
		// and wider: 13500 / 9000 = 1.5 adopts, 13501 does not
		expect(step(chip, [wTrack(2, 13_500)], 14_000, c).followed).toHaveLength(1)
		expect(step(chip, [wTrack(2, 13_501)], 14_000, c).followed).toHaveLength(2)
	})

	it("adoptable follows the centre and width rule exactly (property)", () => {
		// Feature: spectrum tag evidence, signal chips, Property 3: held proven chip adoption bound
		// Validates: label-gate adoption by centre within max(tol, width / 4) and width ratio at most 1.5
		fc.assert(
			fc.property(
				fc.integer({ min: 1000, max: 30_000 }),
				fc.integer({ min: 1, max: 40_000 }),
				fc.integer({ min: -20_000, max: 20_000 }),
				fc.integer({ min: 0, max: 4000 }),
				(chipW, trackW, off, tol) => {
					const f = { hz: 1e8, widthHz: chipW }
					const t = {
						startHz: 1e8 + off - trackW / 2,
						endHz: 1e8 + off + trackW / 2,
					}
					const want =
						Math.abs(off) <= Math.max(tol, chipW / 4) &&
						Math.max(chipW, trackW) <= 1.5 * Math.min(chipW, trackW)
					expect(adoptable(f, t, tol)).toBe(want)
				},
			),
			{ numRuns: 300 },
		)
		// no width (a malformed track) never adopts
		expect(
			adoptable({ hz: 1e8, widthHz: 9000 }, { startHz: 1e8, endHz: 1e8 }, 1000),
		).toBe(false)
	})

	it("never re-attaches a chip that is not proven", () => {
		const c = ctx(() => false)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		s = step(s, [idTrack(2)], 1000, c)
		expect(s.followed.map(f => f.key).sort()).toEqual(["rtl/t1", "rtl/t2"])
	})
})

describe("signal chips: proven hold", () => {
	it("shares the tag's hold, not a copy of the number", () => {
		expect(PROVEN_CHIP_HOLD_MS).toBe(PROVEN_LIVE_HOLD_MS)
	})

	it("holds a proven, live chip unseen up to the hold, and lets it go just past it", () => {
		const c = ctx(() => true)
		let s = afterBurst(c)
		// well past the burst hold: a non-proven chip would have gone
		s = step(s, [], BURST_HOLD_MS + 1, c)
		expect(shown(s)).toBe(1)
		s = step(s, [], PROVEN_CHIP_HOLD_MS, c)
		expect(shown(s)).toBe(1)
		s = step(s, [], PROVEN_CHIP_HOLD_MS + 1, c)
		expect(shown(s)).toBe(0)
		expect(leaving(s)).toBe(1)
	})

	it("keeps the same chip when the next burst comes inside the hold", () => {
		const c = ctx(() => true)
		let s = afterBurst(c)
		const id = gatedSignals(s)[0]?.id
		s = step(s, [], PROVEN_CHIP_HOLD_MS - 1, c)
		s = step(s, [track(20)], PROVEN_CHIP_HOLD_MS, c)
		expect(gatedSignals(s).map(g => [g.id, g.leaving])).toEqual([[id, false]])
	})

	it("never drops a proven chip as weak between bursts", () => {
		const c = ctx(() => true)
		let s = afterBurst(c)
		for (let t = 100; t <= 3 * WEAK_FOR_MS; t += 100)
			s = step(s, [track(2)], t, c)
		expect(shown(s)).toBe(1)
	})

	it("keeps the burst hold for a chip whose discovery is not proven or not live", () => {
		for (const c of [ctx(), ctx(() => false)]) {
			let s = afterBurst(c)
			s = step(s, [], BURST_HOLD_MS, c)
			expect(shown(s)).toBe(1)
			s = step(s, [], BURST_HOLD_MS + 1, c)
			expect(shown(s)).toBe(0)
		}
		// a steady (non-burst) signal: HOLD_MS, as before
		const c = ctx(() => false)
		let s = step(EMPTY_LABEL_GATE, [track(20, false)], 0, c)
		s = step(s, [], HOLD_MS, c)
		expect(shown(s)).toBe(1)
		s = step(s, [], HOLD_MS + 1, c)
		expect(shown(s)).toBe(0)
	})

	it("still drops a non-proven chip once weak for a while", () => {
		const c = ctx(() => false)
		let s = afterBurst(c)
		for (let t = 100; t <= 100 + WEAK_FOR_MS; t += 100)
			s = step(s, [track(2)], t, c)
		expect(shown(s)).toBe(0)
	})

	it("ends the hold as soon as the discovery stops being live", () => {
		let live = true
		const c = ctx(() => live)
		let s = afterBurst(c)
		s = step(s, [], BURST_HOLD_MS + 1000, c)
		expect(shown(s)).toBe(1)
		live = false
		s = step(s, [], BURST_HOLD_MS + 1100, c)
		expect(shown(s)).toBe(0)
	})

	it("treats a lookup that throws or answers garbage as not proven", () => {
		const throwing = ctx(() => {
			throw new Error("broken lookup")
		})
		let s = afterBurst(throwing)
		s = step(s, [], BURST_HOLD_MS + 1, throwing)
		expect(shown(s)).toBe(0)
		const garbage = ctx(() => "yes" as unknown as boolean)
		s = afterBurst(garbage)
		s = step(s, [], BURST_HOLD_MS + 1, garbage)
		expect(shown(s)).toBe(0)
	})
})

// ── The lookups: proven and live, or weak ─────────────────────────────────────────────────────────

type Over = { [K in keyof Discovery]?: Discovery[K] | undefined }

const NOW = Date.parse("2026-10-30T08:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const NONE: ReadonlySet<string> = new Set()

const proof = (over: Partial<ScannerProof> = {}): ScannerProof => ({
	kind: "decoded",
	protocol: "dmr",
	transport: "live",
	at: ago(60_000),
	observationId: "o1",
	identity: { kind: "dmr-cc", value: "7" },
	tried: ["dmr"],
	unavailable: [],
	encrypted: false,
	summary: "DMR decoded (CC7)",
	...over,
})

/** A synthesised DMR control channel, proven by its colour code, heard a minute ago. */
function disc(id: string, over: Over = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	const d = {
		id,
		frequencyHz: MHZ * 1e6,
		frequencyKey: `r:${MHZ * 1e6}`,
		measuredOffsetHz: 0,
		bandwidthHz: 9000,
		protocol: "dmr",
		family: "digital-voice",
		class: "tdma-ms",
		confidence: "decoded",
		identity: { kind: "dmr-cc", value: "7" },
		encrypted: false,
		coChannel: [],
		firstSeenAt: ago(86_400_000),
		lastSeenAt: ago(60_000),
		observationCount: 64,
		airtimeMs: 38_000,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["rx"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: true, iq: false },
		proof: proof(),
		evidenceLevel: "proven",
		...over,
	} as Discovery
	for (const k of Object.keys(over) as (keyof Discovery)[])
		if (over[k] === undefined) delete d[k]
	return d
}

/** An unidentified 4FSK signal: heard, nothing named it. */
const heard = (over: Over = {}) =>
	disc("heard", {
		protocol: "unknown",
		family: "unknown",
		class: "fsk4-12k5",
		confidence: "activity",
		identity: undefined,
		proof: undefined,
		evidenceLevel: "weak",
		...over,
	})

const HZ = MHZ * 1e6

describe("signal chips: provenLiveAt", () => {
	it("finds a proven discovery heard within its hold (at the bound too)", () => {
		expect(provenLiveAt([disc("a")], HZ, 10_000, NONE, NOW)?.id).toBe("a")
		const atBound = disc("a", { lastSeenAt: ago(PROVEN_LIVE_HOLD_MS) })
		expect(provenLiveAt([atBound], HZ, 10_000, NONE, NOW)?.id).toBe("a")
	})

	it("is null once the proven discovery is past its hold, unless it is active now", () => {
		const past = disc("a", { lastSeenAt: ago(PROVEN_LIVE_HOLD_MS + 1) })
		expect(provenLiveAt([past], HZ, 10_000, NONE, NOW)).toBeNull()
		expect(provenLiveAt([past], HZ, 10_000, new Set(["a"]), NOW)?.id).toBe("a")
	})

	it("is null for a weak, decoded-without-proof, ignored or distant discovery", () => {
		const items = [
			disc("weak", { evidenceLevel: "weak" }),
			disc("carrier", { proof: proof({ kind: "carrier-only" }) }),
			disc("ignored", { operator: { lockout: true } } as Over),
			disc("far", { frequencyHz: HZ + 6000 }),
		]
		expect(provenLiveAt(items, HZ, 10_000, NONE, NOW)).toBeNull()
		expect(provenLiveAt([heard()], HZ, 10_000, NONE, NOW)).toBeNull()
	})

	it("is null for a malformed frequency or last-heard time", () => {
		expect(
			provenLiveAt([disc("a", { lastSeenAt: "garbage" })], HZ, 1e4, NONE, NOW),
		).toBeNull()
		expect(
			provenLiveAt(
				[disc("a", { frequencyHz: Number.NaN })],
				HZ,
				1e4,
				NONE,
				NOW,
			),
		).toBeNull()
		expect(provenLiveAt([disc("a")], Number.NaN, 1e4, NONE, NOW)).toBeNull()
	})

	it("never answers proven for a discovery that is not proven (property)", () => {
		// Feature: spectrum tag evidence, signal chips, Property 1: unknown input is never proven
		// Validates: brief item 1 (non-proven chips keep the current behaviour)
		fc.assert(
			fc.property(
				fc.constantFrom<Discovery["evidenceLevel"] | undefined>(
					"weak",
					undefined,
				),
				fc.constantFrom<Discovery["confidence"]>(
					"activity",
					"candidate",
					"classified",
				),
				fc.integer({ min: -5000, max: 5000 }),
				fc.integer({ min: 0, max: 2 * PROVEN_LIVE_HOLD_MS }),
				(evidenceLevel, confidence, off, age) => {
					const d = disc("a", {
						evidenceLevel,
						confidence,
						frequencyHz: HZ + off,
						lastSeenAt: ago(age),
					})
					return provenLiveAt([d], HZ, 10_000, new Set(["a"]), NOW) === null
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("signal chips: weakDiscoveryAt", () => {
	it("labels a chip near an unidentified discovery by what was measured", () => {
		const d = weakDiscoveryAt([heard()], HZ + 2000, 10_000)
		expect(d?.id).toBe("heard")
		expect(d && unidentifiedLabel(d)).toBe("Unidentified · 4FSK ~9 kHz")
	})

	it("takes a likely discovery too, but never a proven or ignored one", () => {
		const likely = disc("likely", {
			confidence: "classified",
			evidenceLevel: "weak",
			proof: undefined,
		})
		expect(weakDiscoveryAt([likely], HZ, 10_000)?.id).toBe("likely")
		expect(weakDiscoveryAt([disc("proven")], HZ, 10_000)).toBeNull()
		expect(
			weakDiscoveryAt(
				[heard({ operator: { lockout: true } } as Over)],
				HZ,
				10_000,
			),
		).toBeNull()
	})

	it("looks within max(3 kHz, half the width): at the bound, not past it", () => {
		expect(weakDiscoveryAt([heard()], HZ + 3000, 1000)?.id).toBe("heard")
		expect(weakDiscoveryAt([heard()], HZ + 3001, 1000)).toBeNull()
		expect(weakDiscoveryAt([heard()], HZ + 10_000, 20_000)?.id).toBe("heard")
		expect(weakDiscoveryAt([heard()], HZ + 10_001, 20_000)).toBeNull()
	})

	it("picks the closest one", () => {
		const a = heard({ id: "a", frequencyHz: HZ - 2500 })
		const b = heard({ id: "b", frequencyHz: HZ + 1000 })
		expect(weakDiscoveryAt([a, b], HZ, 10_000)?.id).toBe("b")
		expect(weakDiscoveryAt([b, a], HZ, 10_000)?.id).toBe("b")
		expect(weakDiscoveryAt(discoveryIndex([a, b]), HZ, 10_000)?.id).toBe("b")
	})

	it("a likely discovery's chip uses the tag's name; only a heard one is Unidentified", () => {
		const likely = disc("likely", {
			confidence: "classified",
			evidenceLevel: "weak",
			proof: undefined,
			identity: undefined,
		})
		expect(weakChip(likely)).toEqual({ label: "Likely DMR", state: "likely" })
		expect(weakChip(heard())).toEqual({
			label: "Unidentified · 4FSK ~9 kHz",
			state: "unidentified",
		})
		// a heard decode anchor has no measured RF: plain Unidentified, never "Heard"
		expect(weakChip(heard({ anchor: "decode" })).label).toBe("Unidentified")
	})
})

describe("signal chips: the per-frame frequency index", () => {
	it("answers the lookups exactly as a scan of every discovery does (property)", () => {
		// Feature: spectrum tag evidence, signal chips, Property 4: index lookups equal full scans
		// Validates: discoveryIndex binary search (identifiedAt, provenLiveAt, weakDiscoveryAt) matches the O(D) scan
		const kinds = [
			() => disc("p"),
			() => heard(),
			() =>
				disc("l", {
					confidence: "classified",
					evidenceLevel: "weak",
					proof: undefined,
				}),
			() => disc("ig", { operator: { lockout: true } } as Over),
			() => disc("old", { lastSeenAt: ago(PROVEN_LIVE_HOLD_MS + 1) }),
		]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						kind: fc.integer({ min: 0, max: kinds.length - 1 }),
						// 1 kHz steps keep distances distinct from each other only sometimes: ties are tested too
						off: fc.integer({ min: -40, max: 40 }),
					}),
					{ maxLength: 30 },
				),
				fc.integer({ min: -40_000, max: 40_000 }),
				fc.integer({ min: 0, max: 30_000 }),
				(specs, at, width) => {
					// equal distances either side (and equal frequencies) are generated: the index keeps the
					// scan's source order for ties, so the very same discovery answers
					const items = specs.map((x, i) => ({
						...(kinds[x.kind] as () => Discovery)(),
						id: `d${i}`,
						frequencyHz: HZ + x.off * 1000,
					}))
					const index = discoveryIndex(items)
					const hz = HZ + at
					const pickedId = (d: Discovery | null) => d?.id ?? null
					expect(pickedId(identifiedAt(index, hz, width))).toBe(
						pickedId(identifiedAt(items, hz, width)),
					)
					expect(pickedId(weakDiscoveryAt(index, hz, width))).toBe(
						pickedId(weakDiscoveryAt(items, hz, width)),
					)
					expect(pickedId(provenLiveAt(index, hz, width, NONE, NOW))).toBe(
						pickedId(provenLiveAt(items, hz, width, NONE, NOW)),
					)
				},
			),
			{ numRuns: 300 },
		)
	})

	it("skips non-finite frequencies and finds the bounds exactly", () => {
		const a = heard({ id: "a", frequencyHz: HZ + 3000 })
		const nan = heard({ id: "nan", frequencyHz: Number.NaN })
		const index = discoveryIndex([nan, a])
		expect(index.sorted.map(d => d.id)).toEqual(["a"])
		expect(weakDiscoveryAt(index, HZ, 1000)?.id).toBe("a")
		expect(weakDiscoveryAt(index, HZ - 1, 1000)).toBeNull()
		expect(weakDiscoveryAt(index, HZ + 6000, 1000)?.id).toBe("a")
		expect(weakDiscoveryAt(index, HZ + 6001, 1000)).toBeNull()
		expect(weakDiscoveryAt(discoveryIndex([]), HZ, 1000)).toBeNull()
		expect(weakDiscoveryAt(index, Number.NaN, 1000)).toBeNull()
	})
})

describe("signal chips: which discovery a chip states (Plot.tsx)", () => {
	const tone = (over: Over = {}) =>
		disc("tone", {
			protocol: "analog-fm",
			family: "analog",
			class: "analog-fm",
			identity: undefined,
			proof: proof({ kind: "analog-tone", protocol: "analog-fm" }),
			evidenceLevel: "proven",
			...over,
		})

	it("names the chip with a proven analog proof whose confidence is classified or candidate", () => {
		for (const confidence of ["classified", "candidate"] as const) {
			const d = tone({ confidence })
			expect(tagState(d)).toBe("proven")
			expect(identifiesChip(d)).toBe(true)
			expect(identifiedAt([d], HZ, 10_000)?.id).toBe("tone")
			// the chip states it proven, and the weak lookup (the unidentified style) never takes it
			expect(weakDiscoveryAt([d], HZ, 10_000)).toBeNull()
		}
	})

	it("names a decoded discovery's chip exactly when its tag is proven", () => {
		const proven = disc("p")
		expect(tagState(proven)).toBe("proven")
		expect(identifiesChip(proven)).toBe(true)
		// a core before proofs: decoded with neither an evidence level nor a proof still names it
		const legacy = disc("old", { evidenceLevel: undefined, proof: undefined })
		expect(tagState(legacy)).toBe("proven")
		expect(identifiesChip(legacy)).toBe(true)
		expect(identifiedAt([legacy], HZ, 10_000)?.id).toBe("old")
	})

	it("never names DMR for a decoded DMR whose evidence is weak with a digital-undecoded proof", () => {
		const d = disc("dmr-weak", {
			evidenceLevel: "weak",
			proof: proof({ kind: "digital-undecoded", summary: "4FSK sync, no CC" }),
		})
		expect(d.confidence).toBe("decoded")
		expect(identifiesChip(d)).toBe(false)
		expect(identifiedAt([d], HZ, 10_000)).toBeNull()
		// it takes the unidentified treatment instead
		expect(weakDiscoveryAt([d], HZ, 10_000)?.id).toBe("dmr-weak")
		const id = chipIdentity(
			new Map([[d.id, d]]),
			{ discoveryId: d.id, protocol: "dmr", confidence: "decoded" },
			HZ,
			10_000,
		)
		expect(id).toEqual({ discovery: null, trackDecoded: false })
	})

	it("never names a decoded chip whose evidence contradicts it", () => {
		const items = [
			disc("weak", { evidenceLevel: "weak" }),
			disc("weak-noproof", { evidenceLevel: "weak", proof: undefined }),
			disc("proven-noproof", { proof: undefined }),
			disc("undecoded", {
				proof: proof({ kind: "digital-undecoded" }),
			}),
			disc("carrier", { proof: proof({ kind: "carrier-only" }) }),
			disc("proof-only", { evidenceLevel: undefined }),
			disc("bad-kind", {
				proof: proof({ kind: "guess" as unknown as "decoded" }),
			}),
			disc("bad-level", {
				evidenceLevel: "certain" as unknown as "proven",
			}),
		]
		for (const d of items) {
			expect(d.confidence).toBe("decoded")
			expect(identifiesChip(d)).toBe(false)
			expect(weakDiscoveryAt([d], HZ, 10_000)?.id).toBe(d.id)
		}
		expect(identifiedAt(items, HZ, 10_000)).toBeNull()
	})

	it("names the chip exactly when tagState is proven and not Ignored (property)", () => {
		// Feature: spectrum tag evidence, signal chips, Property 2: chip naming follows tagState
		// Validates: chip naming consistent with tagState (identifiesChip, identifiedAt, weakDiscoveryAt)
		fc.assert(
			fc.property(
				fc.constantFrom<Discovery["confidence"]>(
					"decoded",
					"classified",
					"candidate",
					"activity",
				),
				fc.constantFrom<string | undefined>(
					"proven",
					"weak",
					undefined,
					"certain",
				),
				fc.constantFrom<string | undefined>(
					"decoded",
					"analog-tone",
					"analog-voice",
					"digital-undecoded",
					"carrier-only",
					"guess",
					undefined,
				),
				fc.boolean(),
				(confidence, level, kind, lockout) => {
					const over: Over = {
						confidence,
						evidenceLevel: level as Discovery["evidenceLevel"] | undefined,
						proof:
							kind === undefined
								? undefined
								: proof({ kind: kind as ScannerProof["kind"] }),
					}
					if (lockout)
						over.operator = { lockout: true } as Discovery["operator"]
					const d = disc("x", over)
					const named = identifiesChip(d)
					expect(named).toBe(!lockout && tagState(d) === "proven")
					expect(identifiedAt([d], HZ, 10_000) !== null).toBe(named)
					if (named) expect(weakDiscoveryAt([d], HZ, 10_000)).toBeNull()
				},
			),
			{ numRuns: 200 },
		)
	})

	it("lets the frame track's decoded name the chip only when no linked discovery contradicts it", () => {
		const track = (id: string) =>
			({ discoveryId: id, protocol: "dmr", confidence: "decoded" }) as const
		// no discovery loaded for the link: the track's own decoded names it
		expect(chipIdentity(new Map(), track("gone"), HZ, 10_000)).toEqual({
			discovery: null,
			trackDecoded: true,
		})
		// a stale link to a discovery elsewhere counts as no link
		const far = disc("far", { evidenceLevel: "weak", frequencyHz: HZ + 2e6 })
		expect(
			chipIdentity(new Map([["far", far]]), track("far"), HZ, 10_000),
		).toEqual({ discovery: null, trackDecoded: true })
		// a proven linked discovery names it itself
		const ok = disc("ok")
		expect(
			chipIdentity(new Map([["ok", ok]]), track("ok"), HZ, 10_000).discovery
				?.id,
		).toBe("ok")
		// an Ignored one names nothing
		const ig = disc("ig", { operator: { lockout: true } } as Over)
		expect(
			chipIdentity(new Map([["ig", ig]]), track("ig"), HZ, 10_000),
		).toEqual({ discovery: null, trackDecoded: false })
		// no track claim: nothing
		expect(chipIdentity(new Map(), null, HZ, 10_000)).toEqual({
			discovery: null,
			trackDecoded: false,
		})
	})

	it("never names the chip for weak, non-proving, malformed or ignored evidence", () => {
		const items = [
			tone({ confidence: "classified", evidenceLevel: "weak" }),
			tone({ confidence: "candidate", proof: proof({ kind: "carrier-only" }) }),
			tone({ confidence: "classified", evidenceLevel: undefined }),
			tone({
				confidence: "classified",
				evidenceLevel: "certain" as unknown as "proven",
			}),
			disc("ig", { operator: { lockout: true } } as Over),
			heard(),
		]
		for (const d of items) expect(identifiesChip(d)).toBe(false)
		expect(identifiedAt(items, HZ, 10_000)).toBeNull()
	})
})
