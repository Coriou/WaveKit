import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { Discovery, ScannerProof } from "@wavekit/api-types"

import {
	PROVEN_LIVE_HOLD_MS,
	identifiedAt,
	identifiesChip,
	tagState,
	unidentifiedLabel,
} from "../../src/plot/discovery-tags.ts"
import {
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
	clusterSignals,
	provenLiveAt,
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

	it("re-attaches only within the position tolerance: a burst past it is another signal", () => {
		const c = ctx(() => true)
		let s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		// tolerance max(2 bins, 1 kHz) = 1 kHz beyond the 10 kHz-wide chip's edges
		s = step(s, [idTrack(2, 20, 11_000)], 14_000, c)
		expect(s.followed).toHaveLength(1)
		s = step(EMPTY_LABEL_GATE, [idTrack(1)], 0, c)
		s = step(s, [idTrack(2, 20, 11_001)], 14_000, c)
		expect(s.followed).toHaveLength(2)
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
		// Feature: wg18-tg signal chips, Property 1: unknown input is never proven
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

	it("keeps a decoded discovery naming its chip, proven only when its tag is", () => {
		const weak = disc("w", { evidenceLevel: "weak" })
		expect(identifiesChip(weak)).toBe(true)
		expect(tagState(weak)).not.toBe("proven")
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
