import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	AERO_VHF_MAX_HZ,
	AERO_VHF_MIN_HZ,
	anchorHzOf,
	canAnchor,
	decodeAnchorKey,
} from "../../../../src/core/scanner/store/decode-anchor.js"
import {
	ANCHOR_HELD_MAX,
	CHANNEL_ANCHOR_FRESH_MS,
	CHANNEL_OWNER_REACH_HZ,
	CHANNEL_PROTOCOL_HOLD_MS,
	DiscoveryStore,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { evidenceLevelOf } from "../../../../src/core/scanner/proof.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import type {
	DecodeEvidence,
	Discovery,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"

// Synthetic channels inside the VHF aeronautical band; not taken from any capture.
const CH_A = 130_000_000
const CH_B = 130_050_000
const T0 = Date.UTC(2026, 9, 31)
const DAY = 86_400_000
/** Inside spectrum()'s observation pairing window (it ends at T0 - 9 000; the window 2 000 ms on). */
const PAIRED_AT = T0 - 8_000

const acars = (value = "TEST01", at = T0): DecodeEvidence => ({
	protocol: "acars",
	origin: "ambient",
	crcClean: true,
	epoch: 1,
	at,
	identity: { kind: "acars-reg", value },
	metadata: {},
})
const vdl2 = (value = "ABC001", at = T0): DecodeEvidence => ({
	protocol: "vdl2",
	origin: "ambient",
	crcClean: true,
	epoch: 1,
	at,
	identity: { kind: "vdl2-addr", value },
	metadata: {},
})

function store(now: () => number = () => T0) {
	let n = 0
	return new DiscoveryStore({
		maxDiscoveries: 10,
		now,
		newId: () => `anchor${n++}`,
	})
}

/** A closed spectrum observation's discovery centred `offsetHz` from CH_A (epoch 1, trusted). */
function spectrum(s: DiscoveryStore, id: string, offsetHz: number): string {
	const created = s.ingest(
		makeObs({
			id,
			centreHz: CH_A + offsetHz,
			startedAt: T0 - 10_000,
			blocks: 2,
			obwHz: 9_000,
			sourceId: "rtl",
		}),
	)
	if (created.discoveryId === null) throw new Error("spectrum did not surface")
	return created.discoveryId
}

/** The store's own proof view of a discovery (its label before the read paths publish it). */
function viewOf(s: DiscoveryStore, id: string): unknown {
	const raw = s.snapshot().discoveries.find(d => d.id === id)!
	return (
		s as unknown as { discoveryView(d: Discovery): unknown }
	).discoveryView(raw)
}

/** Records of `sourceId` within the 4 000 Hz reach of CH_A that claim it: an anchor, or decoded. */
function decodedAt(s: DiscoveryStore, sourceId = "rtl"): string[] {
	return s
		.snapshot()
		.discoveries.filter(
			d =>
				d.sourceIds.includes(sourceId) &&
				Math.abs(d.frequencyHz - CH_A) < CHANNEL_OWNER_REACH_HZ &&
				(d.anchor === "decode" || s.get(d.id)!.confidence === "decoded"),
		)
		.map(d => d.id)
		.sort()
}

describe("channel anchors (ACARS, VDL2)", () => {
	it.each([
		["acars", acars()],
		["vdl2", vdl2()],
	] as const)(
		"a confirmed %s decode opens a decoded discovery at its channel whose proof cites the identity",
		(protocol, ev) => {
			const s = store()
			try {
				const res = s.anchorDecode("rtl", CH_A, ev, "commanded")
				expect(res.change).toBe("created")
				const d = s.get(res.discoveryId!)!
				expect(d).toMatchObject({
					anchor: "decode",
					frequencyHz: CH_A,
					protocol,
					family: "packet",
					confidence: "decoded",
					bandwidthHz: 0,
					proof: {
						kind: "decoded",
						protocol,
						transport: "ambient",
						identity: ev.identity,
					},
				})
				expect(d.proof!.summary).toContain(ev.identity!.value)
				expect(evidenceLevelOf(d)).toBe("proven")
				// The proof follows the latest checked identity on the channel.
				const next =
					protocol === "acars"
						? acars("TEST02", T0 + 1)
						: vdl2("ABC002", T0 + 1)
				expect(s.anchorDecode("rtl", CH_A, next, "commanded").discoveryId).toBe(
					d.id,
				)
				// Staged until published (the stop flush here).
				s.stopAnchorExpiry()
				expect(s.get(d.id)!.proof!.identity).toEqual(next.identity)
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

	it("an anchor holds an observation it took: its ingests stay transient until the anchor goes", () => {
		const s = store()
		try {
			const anchorId = s.anchorDecode(
				"rtl",
				CH_A,
				acars(),
				"commanded",
			).discoveryId!
			const obs = (open: boolean) =>
				makeObs({
					id: "o_held",
					centreHz: CH_A + 1_500,
					startedAt: T0 - 10_000,
					blocks: 2,
					obwHz: 9_000,
					sourceId: "rtl",
					open,
				})
			// Only a channel anchor of the observation's source holds it.
			expect(s.holdForAnchor("other", "o_held", anchorId)).toBe(false)
			expect(s.holdForAnchor("rtl", "o_held", "d_missing")).toBe(false)
			expect(s.holdForAnchor("rtl", "o_held", anchorId)).toBe(true)
			expect(s.ingest(obs(true))).toEqual({
				discoveryId: null,
				change: "transient",
			})
			expect(s.ingest(obs(false)).change).toBe("transient")
			expect(s.snapshot().discoveries.map(d => d.id)).toEqual([anchorId])
			// A spectrum discovery holds nothing; once the anchor is gone, ingests run as before.
			const spectrumId = spectrum(s, "o_spec", 50_000)
			expect(s.holdForAnchor("rtl", "o_next", spectrumId)).toBe(false)
			expect(s.holdForAnchor("rtl", "o_spec", anchorId)).toBe(false)
			expect(s.holdForAnchor("rtl", "o_held", anchorId)).toBe(true)
			expect(s.delete(anchorId)).toBe(true)
			expect(s.ingest(obs(false)).discoveryId).not.toBeNull()
		} finally {
			s.stopAnchorExpiry()
		}
	})

	describe("anchor holds release and bound", () => {
		/** An observation-only track near CH_A that would surface on its own (2 blocks, passed). */
		const near = (id: string, open: boolean, spur = false) =>
			makeObs({
				id,
				centreHz: CH_A + 1_500,
				startedAt: T0 - 10_000,
				blocks: 2,
				obwHz: 9_000,
				sourceId: "rtl",
				open,
				spur,
			})
		const fill = (s: DiscoveryStore, anchorId: string, count: number) => {
			for (let i = 0; i < count; i++)
				expect(s.holdForAnchor("rtl", `o_${i}`, anchorId)).toBe(true)
		}

		it("a flagged close releases the hold, as an ordinary close does", () => {
			const s = store()
			try {
				const anchorId = s.anchorDecode(
					"rtl",
					CH_A,
					acars(),
					"commanded",
				).discoveryId!
				expect(s.holdForAnchor("rtl", "o_flag", anchorId)).toBe(true)
				expect(s.holdForAnchor("rtl", "o_plain", anchorId)).toBe(true)
				expect(s.anchorHeldCount()).toBe(2)
				// An open flagged ingest keeps the hold; its close releases it.
				expect(s.ingest(near("o_flag", true, true)).change).toBe("transient")
				expect(s.anchorHeldCount()).toBe(2)
				expect(s.ingest(near("o_flag", false, true)).change).toBe("transient")
				expect(s.anchorHeldCount()).toBe(1)
				expect(s.ingest(near("o_plain", false)).change).toBe("transient")
				expect(s.anchorHeldCount()).toBe(0)
				expect(s.snapshot().discoveries.map(d => d.id)).toEqual([anchorId])
			} finally {
				s.stopAnchorExpiry()
			}
		})

		it("deleting or pruning an anchor releases its holds and no other anchor's", () => {
			let at = T0
			const s = store(() => at)
			try {
				const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId!
				const b = s.anchorDecode("rtl", CH_B, acars(), "commanded").discoveryId!
				expect(s.holdForAnchor("rtl", "o_a1", a)).toBe(true)
				expect(s.holdForAnchor("rtl", "o_a2", a)).toBe(true)
				expect(s.holdForAnchor("rtl", "o_b", b)).toBe(true)
				// Re-holding moves the observation to the other anchor; it is counted once.
				expect(s.holdForAnchor("rtl", "o_a2", b)).toBe(true)
				expect(s.anchorHeldCount()).toBe(3)
				expect(s.delete(a)).toBe(true)
				expect(s.anchorHeldCount()).toBe(2)
				at = T0 + 2 * 86_400_000
				expect(s.pruneInactive(1)).toContain(b)
				expect(s.anchorHeldCount()).toBe(0)
			} finally {
				s.stopAnchorExpiry()
			}
		})

		// Bound: ANCHOR_HELD_MAX = 4096 = 8 sources x 512 open tracks; at it a new hold is refused.
		it("holds exactly ANCHOR_HELD_MAX (4096) live holds and refuses the 4097th without forgetting one", () => {
			expect(ANCHOR_HELD_MAX).toBe(4096)
			const s = store()
			try {
				const anchorId = s.anchorDecode(
					"rtl",
					CH_A,
					acars(),
					"commanded",
				).discoveryId!
				fill(s, anchorId, ANCHOR_HELD_MAX)
				expect(s.anchorHeldCount()).toBe(4096)
				// The 4097th is refused; re-holding one already held still succeeds.
				expect(s.holdForAnchor("rtl", "o_4096", anchorId)).toBe(false)
				expect(s.holdForAnchor("rtl", "o_4095", anchorId)).toBe(true)
				expect(s.anchorHeldCount()).toBe(4096)
				// The oldest live hold was not forgotten: its close opens no duplicate discovery.
				expect(s.ingest(near("o_0", false)).change).toBe("transient")
				expect(s.snapshot().discoveries.map(d => d.id)).toEqual([anchorId])
				// The close freed a slot.
				expect(s.holdForAnchor("rtl", "o_4096", anchorId)).toBe(true)
				expect(s.anchorHeldCount()).toBe(4096)
			} finally {
				s.stopAnchorExpiry()
			}
		})

		it("at the bound drops only holds of observations no longer open; a throwing port keeps all", () => {
			let open: (id: string) => boolean = id => id !== "o_7"
			let n = 0
			const s = new DiscoveryStore({
				maxDiscoveries: 10,
				now: () => T0,
				newId: () => `anchor${n++}`,
				observationOpen: id => open(id),
			})
			try {
				const anchorId = s.anchorDecode(
					"rtl",
					CH_A,
					acars(),
					"commanded",
				).discoveryId!
				// Under the bound the port is not read.
				const port = vi.fn((id: string) => id !== "o_7")
				open = port
				fill(s, anchorId, ANCHOR_HELD_MAX - 1)
				expect(port).not.toHaveBeenCalled()
				fill(s, anchorId, ANCHOR_HELD_MAX)
				expect(s.anchorHeldCount()).toBe(4096)
				expect(s.holdForAnchor("rtl", "o_4096", anchorId)).toBe(true)
				expect(port).toHaveBeenCalledTimes(4096)
				expect(s.anchorHeldCount()).toBe(4096)
				// o_7 (closed) went; o_8 (open) is still held.
				expect(s.ingest(near("o_8", false)).change).toBe("transient")
				expect(s.anchorHeldCount()).toBe(4095)
				expect(s.holdForAnchor("rtl", "o_8", anchorId)).toBe(true)
				// Fail closed: a throwing port answers "open", so the new hold is refused.
				open = () => {
					throw new Error("port down")
				}
				expect(s.holdForAnchor("rtl", "o_4097", anchorId)).toBe(false)
				expect(s.anchorHeldCount()).toBe(4096)
			} finally {
				s.stopAnchorExpiry()
			}
		})
	})

	it("keeps one anchor per source and channel; the other protocol is refused there", () => {
		const s = store()
		try {
			const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId
			const b = s.anchorDecode("rtl", CH_B, acars(), "commanded").discoveryId
			// M2: the ACARS anchor owns CH_A for both protocols: a VDL2 decode there opens nothing.
			const v = s.anchorDecode("rtl", CH_A, vdl2(), "commanded")
			expect(v).toEqual({ discoveryId: null, change: "transient" })
			const vb = s.anchorDecode("rtl", CH_B, vdl2(), "commanded").discoveryId
			expect(vb).toBe(null)
			const other = s.anchorDecode(
				"other",
				CH_A,
				acars(),
				"commanded",
			).discoveryId
			const again = s.anchorDecode(
				"rtl",
				CH_A,
				acars("TEST02"),
				"commanded",
			).discoveryId
			expect(new Set([a, b, other]).size).toBe(3)
			expect(again).toBe(a)
			expect(s.snapshot().discoveries).toHaveLength(3)
			expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(a)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("keys an MHz-to-Hz product with float error to the same channel", () => {
		const s = store()
		try {
			// 130.7 × 1e6 is 130 699 999.99999999 in binary floating point.
			const mhz = 130.7 * 1_000_000
			expect(Number.isInteger(mhz)).toBe(false)
			const a = s.anchorDecode("rtl", mhz, acars(), "commanded")
			const b = s.anchorDecode("rtl", 130_700_000, acars("TEST02"), "commanded")
			expect(b.discoveryId).toBe(a.discoveryId)
			expect(s.get(a.discoveryId!)!.frequencyHz).toBe(130_700_000)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("refuses unclean, unconfirmed, malformed, untrusted or non-ambient decodes", () => {
		const { identity: _identity, ...unconfirmed } = acars()
		const refused: [DecodeEvidence, string | undefined][] = [
			[{ ...acars(), crcClean: false }, "commanded"],
			[unconfirmed, "commanded"],
			[{ ...acars(), origin: "probe" }, "commanded"],
			[{ ...acars(), at: Number.NaN }, "commanded"],
			[acars(), "unverified"],
			[acars(), undefined],
			[acars("-------"), "commanded"],
			[acars("X"), "commanded"],
			[
				{ ...acars(), identity: { kind: "vdl2-addr", value: "TEST01" } },
				"commanded",
			],
			[vdl2("abc001"), "commanded"],
			[vdl2("ABC0012"), "commanded"],
			[{ ...vdl2(), protocol: "ais" }, "commanded"],
		]
		for (const [ev, trust] of refused) {
			expect(canAnchor(ev, CH_A, trust as never)).toBe(false)
			const s = store()
			expect(s.anchorDecode("rtl", CH_A, ev, trust as never).discoveryId).toBe(
				null,
			)
			expect(s.snapshot().discoveries).toHaveLength(0)
		}
		expect(canAnchor(acars(), CH_A, "relay")).toBe(true)
	})

	it("anchors only inside the VHF aeronautical band (at and just past each bound)", () => {
		for (const ev of [acars(), vdl2()]) {
			expect(canAnchor(ev, AERO_VHF_MIN_HZ, "commanded")).toBe(true)
			expect(canAnchor(ev, AERO_VHF_MAX_HZ, "commanded")).toBe(true)
			// Rounding to whole Hz: 0.4 Hz outside still keys the bound, 1 Hz outside does not.
			expect(canAnchor(ev, AERO_VHF_MAX_HZ + 0.4, "commanded")).toBe(true)
			expect(canAnchor(ev, AERO_VHF_MIN_HZ - 1, "commanded")).toBe(false)
			expect(canAnchor(ev, AERO_VHF_MAX_HZ + 1, "commanded")).toBe(false)
			for (const hz of [Number.NaN, Number.POSITIVE_INFINITY, 0, -CH_A])
				expect(canAnchor(ev, hz, "commanded")).toBe(false)
		}
	})

	it("keeps the ADS-B anchor at 1090 MHz and never anchors other protocols", () => {
		expect(anchorHzOf("adsb", 1_090_000_500)).toBe(1_090_000_000)
		expect(anchorHzOf("adsb", CH_A)).toBeUndefined()
		for (const protocol of ["ais", "dmr", "pocsag", "unknown"] as const)
			expect(anchorHzOf(protocol, CH_A)).toBeUndefined()
	})

	// Feature: acars-vdl2-ambient-anchor, Property 1: channel keying
	// Validates: decodes of one channel share one anchor and pairing key; distinct channels never do
	it("keys every report of one channel alike and distinct channels apart (property)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<ScannerProtocol>("acars", "vdl2"),
				fc.integer({ min: AERO_VHF_MIN_HZ, max: AERO_VHF_MAX_HZ }),
				fc.double({ min: -0.49, max: 0.49, noNaN: true }),
				fc.double({ min: -0.49, max: 0.49, noNaN: true }),
				fc.integer({ min: 1, max: 100_000 }),
				(protocol, channel, e1, e2, gap) => {
					const a = anchorHzOf(protocol, channel + e1)
					const b = anchorHzOf(protocol, channel + e2)
					expect(a).toBe(channel)
					expect(b).toBe(channel)
					expect(decodeAnchorKey("rtl", protocol, a!)).toBe(
						decodeAnchorKey("rtl", protocol, b!),
					)
					const other = anchorHzOf(protocol, channel + gap)
					if (other !== undefined) {
						expect(other).not.toBe(channel)
						expect(decodeAnchorKey("rtl", protocol, other)).not.toBe(
							decodeAnchorKey("rtl", protocol, a!),
						)
					}
					const peer: ScannerProtocol = protocol === "acars" ? "vdl2" : "acars"
					expect(decodeAnchorKey("rtl", peer, a!)).not.toBe(
						decodeAnchorKey("rtl", protocol, a!),
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("channel decode at a stored spectrum discovery", () => {
	const anchors = (s: DiscoveryStore) =>
		s.snapshot().discoveries.filter(d => d.anchor === "decode")

	// Reach CHANNEL_OWNER_REACH_HZ = ambientReachHz(protocol, 0) = 1 500 + 2 500 = 4 000 Hz,
	// exclusive as point placement. spectrum()'s observation ends at T0 - 9 000: a decode at
	// T0 - 8 000 pairs with it (the 2 000 ms pairing window), so its evidence persists there.
	it.each([0, 3_999, -3_999])(
		"proves the one discovery %i Hz from the channel instead of opening an anchor",
		offset => {
			for (const ev of [
				acars("TEST01", PAIRED_AT),
				vdl2("ABC001", PAIRED_AT),
			]) {
				const s = store()
				try {
					const id = spectrum(s, "o1", offset)
					const res = s.anchorDecode("rtl", CH_A, ev, "commanded")
					expect(res.discoveryId).toBe(id)
					expect(anchors(s)).toHaveLength(0)
					expect(s.snapshot().discoveries).toHaveLength(1)
					const d = s.get(id)!
					expect(d).toMatchObject({
						protocol: ev.protocol,
						confidence: "decoded",
						identity: ev.identity,
						proof: { kind: "decoded", protocol: ev.protocol },
					})
					expect(evidenceLevelOf(d)).toBe("proven")
					// The observation carries the checked decode the proof cites.
					expect(s.snapshot().observations[0]!.decode).toEqual([ev])
				} finally {
					s.stopAnchorExpiry()
				}
			}
		},
	)

	it.each([4_000, -4_000, 4_001])(
		"anchors beside a discovery %i Hz away (outside the reach)",
		offset => {
			const s = store()
			try {
				const id = spectrum(s, "o1", offset)
				const res = s.anchorDecode("rtl", CH_A, acars(), "commanded")
				expect(res.change).toBe("created")
				expect(res.discoveryId).not.toBe(id)
				expect(anchors(s)).toHaveLength(1)
				expect(s.get(id)!.confidence).not.toBe("decoded")
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

	// channelRoute: with none decoded yet, the nearest record to the channel owns it, ties to the
	// oldest (firstSeenAt, then id); no anchor opens beside them.
	it.each([
		["the nearest", -1_000, 2_000, T0 - 10_000, T0 - 10_000, "near"],
		["the nearest", 2_000, -1_000, T0 - 10_000, T0 - 10_000, "far"],
		[
			"the oldest of two as near",
			-2_000,
			2_000,
			T0 - 10_000,
			T0 - 11_000,
			"far",
		],
		[
			"the first id of two as near and as old",
			2_000,
			-2_000,
			T0 - 10_000,
			T0 - 10_000,
			"near",
		],
	] as const)(
		"two discoveries in reach, none decoded: %s owns the channel (%i, %i Hz)",
		(_name, firstHz, secondHz, firstAt, secondAt, owner) => {
			const s = store()
			try {
				const open = (id: string, offsetHz: number, startedAt: number) =>
					s.ingest(
						makeObs({
							id,
							centreHz: CH_A + offsetHz,
							startedAt,
							blocks: 2,
							obwHz: 9_000,
							sourceId: "rtl",
						}),
					).discoveryId!
				const first = open("o1", firstHz, firstAt)
				const second = open("o2", secondHz, secondAt)
				expect(first).not.toBe(second)
				const want = owner === "near" ? first : second
				const res = s.anchorDecode("rtl", CH_A, acars(), "commanded")
				expect(res.discoveryId).toBe(want)
				expect(anchors(s)).toHaveLength(0)
				expect(decodedAt(s)).toEqual([want])
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

	it("never proves through untrusted or unclean evidence", () => {
		for (const [ev, trust] of [
			[acars("TEST01", PAIRED_AT), "unverified"],
			[{ ...acars("TEST01", PAIRED_AT), crcClean: false }, "commanded"],
		] as const) {
			const s = store()
			try {
				const id = spectrum(s, "o1", 0)
				expect(s.anchorDecode("rtl", CH_A, ev, trust).discoveryId).toBe(null)
				expect(s.get(id)!.confidence).not.toBe("decoded")
				expect(
					s.snapshot().observations.find(o => o.id === "o1")!.decode ?? [],
				).toEqual([])
				expect(anchors(s)).toHaveLength(0)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	// The pairing window is AMBIENT_PAIR_MS (2 000 ms) each side of the observation's span
	// [T0 - 10 000, T0 - 9 000], inclusive: at and just past each edge.
	it.each([
		["2 000 ms after its end", T0 - 7_000, true],
		["2 001 ms after its end", T0 - 6_999, false],
		["2 000 ms before its start", T0 - 12_000, true],
		["2 001 ms before its start", T0 - 12_001, false],
	])(
		"a decode %s (at %i) pairs with the owner's observation: %s",
		(_name, at, pairs) => {
			const s = store()
			try {
				const id = spectrum(s, "o1", 0)
				const ev = acars("TEST01", at)
				expect(s.anchorDecode("rtl", CH_A, ev, "commanded").discoveryId).toBe(
					id,
				)
				expect(s.snapshot().observations[0]!.decode ?? []).toEqual(
					pairs ? [ev] : [],
				)
				// Either way the one owner is proven by the decode, and no anchor opens.
				const d = s.get(id)!
				expect(d).toMatchObject({
					protocol: "acars",
					confidence: "decoded",
					proof: { kind: "decoded", protocol: "acars", identity: ev.identity },
				})
				expect(anchors(s)).toHaveLength(0)
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

	it("M1a: another epoch's spectrum discovery takes the decode: one decoded record, no anchor", () => {
		for (const ev of [acars(), vdl2()]) {
			const s = store()
			try {
				// A retune or restart since: the discovery's observation is epoch 1, the decode epoch 2.
				const id = spectrum(s, "o1", 1_500)
				const res = s.anchorDecode(
					"rtl",
					CH_A,
					{ ...ev, epoch: 2 },
					"commanded",
				)
				expect(res.discoveryId).toBe(id)
				expect(anchors(s)).toHaveLength(0)
				expect(decodedAt(s)).toEqual([id])
				const d = s.get(id)!
				expect(d).toMatchObject({
					protocol: ev.protocol,
					confidence: "decoded",
					evidenceLevel: "proven",
					lastSeenAt: new Date(ev.at).toISOString(),
					proof: {
						kind: "decoded",
						protocol: ev.protocol,
						transport: "ambient",
						identity: ev.identity,
						observationId: "o1",
					},
				})
				expect(d.proof!.summary).toContain(ev.identity!.value)
				// The old epoch's observation never collects the new epoch's decode.
				expect(s.snapshot().observations[0]!.decode ?? []).toEqual([])
				// The channel proof follows the latest checked identity, with no co-channel twin.
				const next = {
					...ev,
					epoch: 2,
					at: T0 + 1,
					identity: {
						...ev.identity!,
						value: ev.protocol === "acars" ? "TEST02" : "ABC002",
					},
				}
				expect(s.anchorDecode("rtl", CH_A, next, "commanded").discoveryId).toBe(
					id,
				)
				expect(s.get(id)!.proof!.identity).toEqual(next.identity)
				// An older decode never replaces it.
				expect(
					s.anchorDecode("rtl", CH_A, { ...ev, epoch: 2 }, "commanded"),
				).toEqual({ discoveryId: id, change: "transient" })
				expect(s.get(id)!.proof!.identity).toEqual(next.identity)
				expect(decodedAt(s)).toEqual([id])
				expect(s.snapshot().discoveries).toHaveLength(1)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("m1: a restored observation whose epoch number a new run reuses never collects the new run's decode", () => {
		const original = store()
		const restored = store(() => T0 + DAY)
		try {
			const id = spectrum(original, "o1", 0)
			restored.restore(original.snapshot())
			// Epochs restart at 1 per run: the decode a day later is epoch 1 too.
			const ev = acars("TEST01", T0 + DAY)
			expect(
				restored.anchorDecode("rtl", CH_A, ev, "commanded").discoveryId,
			).toBe(id)
			expect(restored.snapshot().observations[0]!.decode ?? []).toEqual([])
			expect(restored.get(id)).toMatchObject({
				confidence: "decoded",
				evidenceLevel: "proven",
				proof: { identity: ev.identity },
			})
			expect(anchors(restored)).toHaveLength(0)
		} finally {
			original.stopAnchorExpiry()
			restored.stopAnchorExpiry()
		}
	})

	it("a restored channel-proven owner is unproven until a fresh decode, which it takes again", () => {
		const original = store()
		const restored = store()
		try {
			const id = spectrum(original, "o1", 0)
			original.anchorDecode("rtl", CH_A, { ...acars(), epoch: 2 }, "commanded")
			expect(evidenceLevelOf(original.get(id)!)).toBe("proven")
			restored.restore(original.snapshot())
			const d = restored.get(id)!
			expect(d.proof).toBeUndefined()
			expect(d.evidenceLevel).toBe("weak")
			expect(d.confidence).not.toBe("decoded")
			// Nothing of the channel proof was stored: the record keeps its spectrum label.
			expect(
				restored.snapshot().discoveries.find(x => x.id === id)!.confidence,
			).not.toBe("decoded")
			const fresh = { ...acars("TEST02", T0 + 1), epoch: 1 }
			expect(
				restored.anchorDecode("rtl", CH_A, fresh, "commanded").discoveryId,
			).toBe(id)
			expect(restored.get(id)!.proof!.identity).toEqual(fresh.identity)
			expect(anchors(restored)).toHaveLength(0)
			expect(decodedAt(restored)).toEqual([id])
		} finally {
			original.stopAnchorExpiry()
			restored.stopAnchorExpiry()
		}
	})

	it("an owner proven by its observation takes another identity's decode without a co-channel twin", () => {
		const s = store()
		try {
			const id = spectrum(s, "o1", 0)
			s.anchorDecode("rtl", CH_A, acars("TEST01", PAIRED_AT), "commanded")
			const other = acars("TEST02", PAIRED_AT + 1)
			expect(s.anchorDecode("rtl", CH_A, other, "commanded").discoveryId).toBe(
				id,
			)
			expect(s.snapshot().discoveries).toHaveLength(1)
			expect(decodedAt(s)).toEqual([id])
			// M1: the proof cites the latest checked identity on the channel, as an anchor's does.
			expect(s.get(id)!.proof!.identity!.value).toBe("TEST02")
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("M1b: an anchor owns its channel: a spectrum observation in its reach opens nothing, the anchor takes every decode", () => {
		for (const ev of [acars(), vdl2()]) {
			const s = store()
			try {
				const anchorId = s.anchorDecode(
					"rtl",
					CH_A,
					ev,
					"commanded",
				).discoveryId!
				// 3 999 Hz is in reach (exclusive 4 000), closed and open alike.
				for (const [id, offset, open] of [
					["o1", 0, false],
					["o2", 3_999, true],
					["o3", -3_999, false],
				] as const) {
					const res = s.ingest(
						makeObs({
							id,
							centreHz: CH_A + offset,
							startedAt: T0 - 10_000,
							blocks: 2,
							obwHz: 9_000,
							sourceId: "rtl",
							open,
						}),
					)
					expect(res).toEqual({ discoveryId: null, change: "transient" })
				}
				expect(s.snapshot().discoveries.map(d => d.id)).toEqual([anchorId])
				const next = { ...ev, at: T0 + 1 }
				expect(s.anchorDecode("rtl", CH_A, next, "commanded").discoveryId).toBe(
					anchorId,
				)
				expect(decodedAt(s)).toEqual([anchorId])
				// At the reach (4 000 Hz) and for another source a spectrum record still opens.
				const outside = s.ingest(
					makeObs({
						id: "o4",
						centreHz: CH_A + 4_000,
						startedAt: T0 - 10_000,
						blocks: 2,
						obwHz: 9_000,
						sourceId: "rtl",
					}),
				)
				expect(outside.discoveryId).not.toBe(null)
				const otherSource = s.ingest(
					makeObs({
						id: "o5",
						centreHz: CH_A,
						startedAt: T0 - 10_000,
						blocks: 2,
						obwHz: 9_000,
						sourceId: "other",
					}),
				)
				expect(otherSource.discoveryId).not.toBe(null)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("M1b: a stale anchor with two spectrum records opened beside it keeps the channel when one is left", () => {
		let now = T0
		const s = store(() => now)
		try {
			const anchorId = s.anchorDecode(
				"rtl",
				CH_A,
				acars(),
				"commanded",
			).discoveryId!
			// Past CHANNEL_ANCHOR_FRESH_MS the anchor lets spectrum records open in its reach.
			now = T0 + CHANNEL_ANCHOR_FRESH_MS + 1
			const open = (id: string, offsetHz: number) =>
				s.ingest(
					makeObs({
						id,
						centreHz: CH_A + offsetHz,
						startedAt: now - 1_000,
						blocks: 2,
						obwHz: 9_000,
						sourceId: "rtl",
					}),
				).discoveryId!
			const a = open("o1", -2_000)
			const b = open("o2", 2_000)
			expect(new Set([anchorId, a, b]).size).toBe(3)
			// One record leaves; the anchor still holds the channel and takes the next decode.
			s.delete(b)
			const res = s.anchorDecode("rtl", CH_A, acars("TEST02", now), "commanded")
			expect(res.discoveryId).toBe(anchorId)
			expect(s.get(a)!.confidence).not.toBe("decoded")
			expect(decodedAt(s)).toEqual([anchorId])
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("another source's discovery or a discovery decoded as another protocol never takes the decode", () => {
		const s = store()
		try {
			const other = s.ingest(
				makeObs({
					id: "o1",
					centreHz: CH_A,
					startedAt: T0 - 10_000,
					blocks: 2,
					sourceId: "other",
				}),
			).discoveryId!
			s.anchorDecode("rtl", CH_A, acars(), "commanded")
			expect(s.get(other)!.confidence).not.toBe("decoded")
			expect(anchors(s)).toHaveLength(1)
			const t = store()
			try {
				const id = spectrum(t, "o2", 0)
				t.anchorDecode("rtl", CH_A, vdl2(), "commanded")
				expect(t.get(id)!.protocol).toBe("vdl2")
				// M2: the record decoded as VDL2 owns the channel: the ACARS decode is refused, no anchor.
				const res = t.anchorDecode("rtl", CH_A, acars(), "commanded")
				expect(res).toEqual({ discoveryId: null, change: "transient" })
				expect(t.get(id)!.protocol).toBe("vdl2")
				expect(anchors(t)).toHaveLength(0)
			} finally {
				t.stopAnchorExpiry()
			}
		} finally {
			s.stopAnchorExpiry()
		}
	})
})

describe("channel ownership across protocols and anchor freshness", () => {
	const anchors = (s: DiscoveryStore) =>
		s.snapshot().discoveries.filter(d => d.anchor === "decode")
	const open = (s: DiscoveryStore, id: string, at: number) =>
		s.ingest(
			makeObs({
				id,
				centreHz: CH_A + 1_000,
				startedAt: at,
				blocks: 2,
				obwHz: 9_000,
				sourceId: "rtl",
			}),
		)

	it("M1: a spectrum owner decoded by one aircraft takes another's through applyEvidence, no co-channel twin", () => {
		for (const [first, second] of [
			[acars("TEST01", PAIRED_AT), acars("TEST02", PAIRED_AT + 1)],
			[vdl2("ABC001", PAIRED_AT), vdl2("ABC002", PAIRED_AT + 1)],
		] as const) {
			const s = store()
			try {
				const id = spectrum(s, "o1", 0)
				s.appendObservationEvidence("o1", first)
				s.applyEvidenceResult(id, first)
				expect(s.get(id)!.proof!.identity).toEqual(first.identity)
				// The live placement path: the observation, then the record.
				s.appendObservationEvidence("o1", second)
				expect(s.applyEvidenceResult(id, second).accepted).toBe(true)
				expect(s.snapshot().discoveries.map(d => d.id)).toEqual([id])
				expect(decodedAt(s)).toEqual([id])
				expect(s.get(id)!.proof!.identity).toEqual(second.identity)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("M1: other protocols keep their per-identity split", () => {
		const s = store()
		try {
			const id = spectrum(s, "o1", 0)
			const pocsag = (value: string, at: number): DecodeEvidence => ({
				protocol: "pocsag",
				origin: "ambient",
				crcClean: true,
				epoch: 1,
				at,
				identity: { kind: "pocsag-capcode", value },
				metadata: {},
			})
			s.applyEvidenceResult(id, pocsag("1234567", PAIRED_AT))
			s.applyEvidenceResult(id, pocsag("7654321", PAIRED_AT + 1))
			expect(s.snapshot().discoveries).toHaveLength(2)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("M2: the other protocol is refused at an anchor and a decoded spectrum owner, logged once per owner", () => {
		const warn = vi.fn()
		const logger = { child: () => logger, warn } as unknown as Logger
		let n = 0
		const s = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: () => `own${n++}`,
			logger,
		})
		try {
			const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId!
			for (const value of ["ABC001", "ABC002"])
				expect(
					s.anchorDecode("rtl", CH_A + 1, vdl2(value, T0 + 1), "commanded"),
				).toEqual({ discoveryId: null, change: "transient" })
			expect(anchors(s).map(d => d.id)).toEqual([a])
			expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(a)
			expect(warn).toHaveBeenCalledTimes(1)
			// Only the two protocols are logged, never a decoded value or frequency.
			expect(warn.mock.calls[0]![0]).toEqual({
				protocol: "vdl2",
				ownerProtocol: "acars",
			})
			// A spectrum owner decoded as VDL2 on CH_B's reach refuses ACARS through every path.
			const owner = s.ingest(
				makeObs({
					id: "o2",
					centreHz: CH_B,
					startedAt: PAIRED_AT - 1_000,
					blocks: 2,
					obwHz: 9_000,
					sourceId: "rtl",
				}),
			).discoveryId!
			const v = vdl2("ABC001", PAIRED_AT)
			s.appendObservationEvidence("o2", v)
			s.applyEvidenceResult(owner, v)
			expect(s.get(owner)).toMatchObject({
				protocol: "vdl2",
				confidence: "decoded",
			})
			const ac = acars("TEST05", PAIRED_AT + 1)
			expect(s.appendObservationEvidence("o2", ac)).toBe(false)
			expect(s.applyEvidenceResult(owner, ac)).toEqual({
				change: null,
				accepted: false,
			})
			expect(s.anchorDecode("rtl", CH_B, ac, "commanded").discoveryId).toBe(
				null,
			)
			expect(s.snapshot().discoveries).toHaveLength(2)
			expect(s.get(owner)!.protocol).toBe("vdl2")
			expect(warn).toHaveBeenCalledTimes(2)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("M2: a restored (unproven) anchor of the other protocol is retaken: still one record, re-keyed", () => {
		const original = store()
		const restored = store()
		const again = store()
		try {
			const id = original.anchorDecode(
				"rtl",
				CH_A,
				acars(),
				"commanded",
			).discoveryId!
			original.stopAnchorExpiry()
			restored.restore(original.snapshot())
			const res = restored.anchorDecode(
				"rtl",
				CH_A,
				vdl2("ABC001", T0 + 1),
				"commanded",
			)
			expect(res.discoveryId).toBe(id)
			restored.stopAnchorExpiry()
			expect(restored.snapshot().discoveries.map(d => d.id)).toEqual([id])
			expect(restored.get(id)).toMatchObject({
				anchor: "decode",
				protocol: "vdl2",
				confidence: "decoded",
				proof: { protocol: "vdl2", identity: vdl2().identity },
			})
			expect(restored.decodeAnchorFor("rtl", CH_A)?.id).toBe(id)
			// Now proven as VDL2: ACARS is refused; the re-key survives a restore.
			expect(
				restored.anchorDecode("rtl", CH_A, acars("TEST01", T0 + 2), "commanded")
					.discoveryId,
			).toBe(null)
			again.restore(restored.snapshot())
			expect(
				again.anchorDecode("rtl", CH_A, vdl2("ABC002", T0 + 3), "commanded")
					.discoveryId,
			).toBe(id)
			expect(again.snapshot().discoveries).toHaveLength(1)
			// A decode older than the restored anchor's last never re-keys it.
			const older = store()
			try {
				older.restore(original.snapshot())
				expect(
					older.anchorDecode("rtl", CH_A, vdl2("ABC001", T0 - 1), "commanded"),
				).toEqual({ discoveryId: id, change: "transient" })
				expect(older.snapshot().discoveries[0]!.protocol).toBe("acars")
				expect(older.decodeAnchorFor("rtl", CH_A)?.id).toBe(id)
			} finally {
				older.stopAnchorExpiry()
			}
		} finally {
			original.stopAnchorExpiry()
			restored.stopAnchorExpiry()
			again.stopAnchorExpiry()
		}
	})

	// CHANNEL_ANCHOR_FRESH_MS = ANCHOR_AIRCRAFT_WINDOW_MS = 60 000 ms, inclusive.
	it("M4: a proven anchor suppresses a spectrum observation for 60 000 ms after its last decode, not 60 001", () => {
		expect(CHANNEL_ANCHOR_FRESH_MS).toBe(60_000)
		for (const [after, suppressed] of [
			[0, true],
			[60_000, true],
			[60_001, false],
		] as const) {
			let now = T0
			const s = store(() => now)
			try {
				s.anchorDecode("rtl", CH_A, acars(), "commanded")
				now = T0 + after
				const res = open(s, "o1", now - 1_000)
				if (suppressed)
					expect(res).toEqual({ discoveryId: null, change: "transient" })
				else expect(res.discoveryId).not.toBe(null)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("M4: a restored (unproven) anchor never suppresses an independent signal", () => {
		const original = store()
		const restored = store()
		try {
			original.anchorDecode("rtl", CH_A, acars(), "commanded")
			original.stopAnchorExpiry()
			restored.restore(original.snapshot())
			expect(open(restored, "o1", T0 - 1_000).discoveryId).not.toBe(null)
		} finally {
			original.stopAnchorExpiry()
			restored.stopAnchorExpiry()
		}
	})

	it("M4: once the stale anchor is proven again it keeps the channel: one decoded record", () => {
		for (const ev of [acars(), vdl2()]) {
			let now = T0
			const s = store(() => now)
			try {
				const anchorId = s.anchorDecode(
					"rtl",
					CH_A,
					ev,
					"commanded",
				).discoveryId!
				now = T0 + 60_001
				const spectrumId = open(s, "o1", now - 1_000).discoveryId!
				expect(spectrumId).not.toBe(null)
				// The next confirmed decode re-proves the anchor, not the spectrum record.
				const next = { ...ev, at: now }
				expect(s.anchorDecode("rtl", CH_A, next, "commanded").discoveryId).toBe(
					anchorId,
				)
				// A placement on the spectrum record is the anchor's too: refused there.
				s.appendObservationEvidence("o1", next)
				expect(s.applyEvidenceResult(spectrumId, next).accepted).toBe(false)
				s.stopAnchorExpiry()
				expect(decodedAt(s)).toEqual([anchorId])
				// A further spectrum observation lands on the spectrum record, never decoding it.
				open(s, "o2", now)
				expect(decodedAt(s)).toEqual([anchorId])
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})
})

describe("one owner per channel", () => {
	type Step =
		| { k: "open"; offset: number; open: boolean }
		| { k: "close" }
		| { k: "retune" }
		| { k: "restart" }
		| { k: "decode"; n: number }
	const step: fc.Arbitrary<Step> = fc.oneof(
		fc.record({
			k: fc.constant("open" as const),
			offset: fc.integer({ min: -3_999, max: 3_999 }),
			open: fc.boolean(),
		}),
		fc.constant({ k: "close" as const }),
		fc.constant({ k: "retune" as const }),
		fc.constant({ k: "restart" as const }),
		fc.record({
			k: fc.constant("decode" as const),
			n: fc.integer({ min: 1, max: 3 }),
		}),
	)

	// Feature: ACARS and VDL2 channel identity, Property 2: one owner per channel
	// Validates: M1 (one decoded record at a channel across spectrum opens and closes, retunes,
	// restarts and confirmed decodes), m1 (a reused epoch number never pairs an old observation)
	it("any interleaving at one channel ends with exactly one decoded record there (property)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<ScannerProtocol>("acars", "vdl2"),
				fc.array(fc.tuple(step, fc.integer({ min: 0, max: 5_000 })), {
					maxLength: 24,
				}),
				fc.integer({ min: 1, max: 3 }),
				(protocol, steps, last) => {
					let now = T0
					let seq = 0
					const make = () =>
						new DiscoveryStore({
							maxDiscoveries: 100,
							now: () => now,
							newId: () => `p${seq++}`,
						})
					let s = make()
					let epoch = 1
					let opened: ReturnType<typeof makeObs>[] = []
					let obs = 0
					const decode = (n: number): DecodeEvidence =>
						protocol === "acars"
							? { ...acars(`TEST0${n}`, now), epoch }
							: { ...vdl2(`ABC00${n}`, now), epoch }
					const claims = () => decodedAt(s).length
					try {
						for (const [st, dt] of steps) {
							now += dt
							if (st.k === "open") {
								const o = makeObs({
									id: `o${obs++}`,
									centreHz: CH_A + st.offset,
									startedAt: now,
									blocks: 2,
									obwHz: 9_000,
									sourceId: "rtl",
									open: st.open,
								})
								o.track.epoch = epoch
								s.ingest(o)
								if (st.open) opened.push(o)
							} else if (st.k === "close") {
								const o = opened.shift()
								if (o) s.ingest({ ...o, endedAt: now, endReason: "quiet" })
							} else if (st.k === "retune") {
								for (const o of opened)
									s.ingest({ ...o, endedAt: now, endReason: "retune" })
								opened = []
								epoch += 1
							} else if (st.k === "restart") {
								// Open tracks die with the run; the next run numbers epochs from 1 again.
								s.stopAnchorExpiry()
								const next = make()
								next.restore(s.snapshot())
								s = next
								opened = []
								epoch = 1
								now += DAY
							} else s.anchorDecode("rtl", CH_A, decode(st.n), "commanded")
							expect(claims()).toBeLessThanOrEqual(1)
						}
						now += 1
						const final = decode(last)
						const res = s.anchorDecode("rtl", CH_A, final, "commanded")
						s.stopAnchorExpiry()
						const owners = decodedAt(s)
						expect(owners).toHaveLength(1)
						expect(res.discoveryId).toBe(owners[0])
						const owner = s.get(owners[0]!)!
						expect(owner.confidence).toBe("decoded")
						expect(owner.evidenceLevel).toBe("proven")
						expect(owner.proof).toMatchObject({ kind: "decoded", protocol })
					} finally {
						s.stopAnchorExpiry()
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("one decoded owner per channel across records", () => {
	const anchors = (s: DiscoveryStore) =>
		s.snapshot().discoveries.filter(d => d.anchor === "decode")
	/** A replayed or live decode placed on a record's own observation: the observation, then the record. */
	const place = (
		s: DiscoveryStore,
		observationId: string,
		discoveryId: string,
		ev: DecodeEvidence,
	) => {
		const collected = s.appendObservationEvidence(observationId, ev)
		const applied = s.applyEvidenceResult(discoveryId, ev)
		return { collected, applied }
	}
	const observed = (s: DiscoveryStore, id: string) =>
		s.snapshot().observations.find(o => o.id === id)!.decode ?? []

	it("F1: a second record in reach never becomes a decoded owner, whatever the aircraft: the owner takes it", () => {
		for (const [first, second] of [
			[acars("TEST01", PAIRED_AT), acars("TEST02", PAIRED_AT + 1)],
			[vdl2("ABC001", PAIRED_AT), vdl2("ABC002", PAIRED_AT + 1)],
		] as const) {
			const s = store()
			try {
				const a = spectrum(s, "o1", -2_000)
				const b = spectrum(s, "o2", 2_000)
				expect(place(s, "o1", a, first).collected).toBe(true)
				expect(decodedAt(s)).toEqual([a])
				// Another aircraft on the other record's observation: the channel's owner takes it.
				expect(place(s, "o2", b, second).collected).toBe(false)
				expect(decodedAt(s)).toEqual([a])
				expect(observed(s, "o2")).toEqual([])
				expect(s.get(b)!.confidence).not.toBe("decoded")
				expect(s.get(a)!.proof).toMatchObject({
					kind: "decoded",
					protocol: first.protocol,
					identity: second.identity,
				})
				// The anchor path routes to the same owner.
				const third = { ...second, at: PAIRED_AT + 2 }
				expect(
					s.anchorDecode("rtl", CH_A, third, "commanded").discoveryId,
				).toBe(a)
				expect(anchors(s)).toHaveLength(0)
				expect(decodedAt(s)).toEqual([a])
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("F1: the other protocol on the other record within the hold is refused, not a second owner", () => {
		for (const [first, second] of [
			[acars("TEST01", PAIRED_AT), vdl2("ABC001", PAIRED_AT + 1)],
			[vdl2("ABC001", PAIRED_AT), acars("TEST01", PAIRED_AT + 1)],
		] as const) {
			const s = store()
			try {
				const a = spectrum(s, "o1", -2_000)
				const b = spectrum(s, "o2", 2_000)
				place(s, "o1", a, first)
				expect(place(s, "o2", b, second)).toEqual({
					collected: false,
					applied: { change: null, accepted: false },
				})
				expect(decodedAt(s)).toEqual([a])
				expect(s.get(a)!.proof).toMatchObject({
					protocol: first.protocol,
					identity: first.identity,
				})
				expect(observed(s, "o2")).toEqual([])
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("F1: with none decoded, a decode placed on a farther record goes to the nearest", () => {
		const s = store()
		try {
			const near = spectrum(s, "o1", -1_000)
			const far = spectrum(s, "o2", 2_000)
			const ev = acars("TEST01", PAIRED_AT)
			expect(place(s, "o2", far, ev).collected).toBe(false)
			expect(decodedAt(s)).toEqual([near])
			expect(s.get(near)!.proof).toMatchObject({ identity: ev.identity })
			// Later decodes on either record keep that one owner.
			place(s, "o1", near, acars("TEST02", PAIRED_AT + 1))
			place(s, "o2", far, acars("TEST03", PAIRED_AT + 2))
			expect(decodedAt(s)).toEqual([near])
			expect(s.get(near)!.proof!.identity!.value).toBe("TEST03")
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("F1: a record in an anchor's reach never collects a channel decode on its observation", () => {
		let now = T0
		const s = store(() => now)
		try {
			const anchorId = s.anchorDecode(
				"rtl",
				CH_A,
				acars(),
				"commanded",
			).discoveryId!
			now = T0 + CHANNEL_ANCHOR_FRESH_MS + 1
			const id = s.ingest(
				makeObs({
					id: "o1",
					centreHz: CH_A + 1_000,
					startedAt: now - 1_000,
					blocks: 2,
					obwHz: 9_000,
					sourceId: "rtl",
				}),
			).discoveryId!
			expect(place(s, "o1", id, acars("TEST02", now - 500)).collected).toBe(
				false,
			)
			expect(observed(s, "o1")).toEqual([])
			s.stopAnchorExpiry()
			expect(decodedAt(s)).toEqual([anchorId])
		} finally {
			s.stopAnchorExpiry()
		}
	})

	// CHANNEL_PROTOCOL_HOLD_MS = CHANNEL_ANCHOR_FRESH_MS = 60 000 ms from the owner's last decode
	// to the new decode, inclusive: refused at 60 000 ms, taken over at 60 001 ms.
	it("F2: an anchor refuses the other protocol 60 000 ms after its last decode and is re-keyed 60 001 ms after", () => {
		expect(CHANNEL_PROTOCOL_HOLD_MS).toBe(60_000)
		for (const [first, other] of [
			[acars("TEST01", T0), vdl2("ABC001")],
			[vdl2("ABC001", T0), acars("TEST01")],
		] as const) {
			let now = T0
			const s = store(() => now)
			try {
				const id = s.anchorDecode("rtl", CH_A, first, "commanded").discoveryId!
				now = T0 + 60_000
				expect(
					s.anchorDecode("rtl", CH_A, { ...other, at: now }, "commanded"),
				).toEqual({ discoveryId: null, change: "transient" })
				now = T0 + 60_001
				const res = s.anchorDecode(
					"rtl",
					CH_A,
					{ ...other, at: now },
					"commanded",
				)
				expect(res.discoveryId).toBe(id)
				s.stopAnchorExpiry()
				expect(s.snapshot().discoveries.map(d => d.id)).toEqual([id])
				expect(s.get(id)).toMatchObject({
					anchor: "decode",
					protocol: other.protocol,
					confidence: "decoded",
					proof: { protocol: other.protocol, identity: other.identity },
				})
				expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(id)
				// Now fresh as the other protocol: the first is refused in turn.
				expect(
					s.anchorDecode("rtl", CH_A, { ...first, at: now + 1 }, "commanded")
						.discoveryId,
				).toBe(null)
			} finally {
				s.stopAnchorExpiry()
			}
		}
	})

	it("F2: a spectrum owner refuses the other protocol 60 000 ms after its last decode and is re-proven 60 001 ms after", () => {
		for (const path of ["placed", "anchor"] as const)
			for (const [first, other] of [
				[acars("TEST01", PAIRED_AT), vdl2("ABC001")],
				[vdl2("ABC001", PAIRED_AT), acars("TEST01")],
			] as const) {
				const s = store()
				try {
					const id = spectrum(s, "o1", 0)
					place(s, "o1", id, first)
					expect(s.get(id)).toMatchObject({
						protocol: first.protocol,
						confidence: "decoded",
					})
					const send = (at: number) =>
						path === "placed"
							? place(s, "o1", id, { ...other, at }).applied.accepted
							: s.anchorDecode("rtl", CH_A, { ...other, at }, "commanded")
									.discoveryId === id
					expect(send(PAIRED_AT + 60_000)).toBe(false)
					expect(s.get(id)!.protocol).toBe(first.protocol)
					expect(send(PAIRED_AT + 60_001)).toBe(true)
					expect(s.snapshot().discoveries.map(d => d.id)).toEqual([id])
					expect(anchors(s)).toHaveLength(0)
					expect(decodedAt(s)).toEqual([id])
					expect(s.get(id)).toMatchObject({
						protocol: other.protocol,
						confidence: "decoded",
						proof: {
							kind: "decoded",
							protocol: other.protocol,
							identity: other.identity,
						},
					})
					// Fresh as the other protocol now: the first protocol is refused in turn.
					expect(
						s.applyEvidenceResult(id, { ...first, at: PAIRED_AT + 60_002 })
							.accepted,
					).toBe(false)
					expect(s.get(id)!.protocol).toBe(other.protocol)
				} finally {
					s.stopAnchorExpiry()
				}
			}
	})
})

describe("channel anchor publication and restore", () => {
	it("stages a new identity and publishes it with a revision and change event", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const s = store(() => Date.now())
		const events: ReturnType<DiscoveryStore["get"]>[] = []
		s.on("change", (id: string) => events.push(s.get(id)))
		try {
			const id = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId!
			const created = s.get(id)!
			expect(created.proof!.identity).toEqual(acars().identity)
			expect(events).toHaveLength(1)
			vi.advanceTimersByTime(1000)
			s.anchorDecode("rtl", CH_A, acars("TEST02", Date.now()), "commanded")
			// Not visible before publication: same identity, same revision, no event.
			expect(s.get(id)).toEqual(created)
			expect(events).toHaveLength(1)
			vi.advanceTimersByTime(3999)
			expect(s.get(id)).toEqual(created)
			vi.advanceTimersByTime(1)
			expect(events).toHaveLength(2)
			const published = s.get(id)!
			expect(published).toEqual(events.at(-1))
			expect(published.proof!.identity).toEqual({
				kind: "acars-reg",
				value: "TEST02",
			})
			expect(published.revision).toBeGreaterThan(created.revision ?? 0)
			// An identity change alone (same count, same 10 s bucket) still publishes.
			vi.advanceTimersByTime(1000)
			s.anchorDecode("rtl", CH_A, acars("TEST01", Date.now()), "commanded")
			expect(s.get(id)!.proof!.identity!.value).toBe("TEST02")
			vi.advanceTimersByTime(5000)
			expect(events).toHaveLength(3)
			expect(s.get(id)!.proof!.identity!.value).toBe("TEST01")
			expect(s.get(id)!.aircraftCount).toBe(2)
		} finally {
			s.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	it("withholds decoded/proven from a restored anchor until a fresh confirmed decode", () => {
		for (const ev of [acars(), vdl2()]) {
			const original = store()
			const restored = store()
			try {
				const id = original.anchorDecode(
					"rtl",
					CH_A,
					ev,
					"commanded",
				).discoveryId!
				expect(evidenceLevelOf(original.get(id)!)).toBe("proven")
				restored.restore(original.snapshot())
				const d = restored.get(id)!
				expect(d.anchor).toBe("decode")
				expect(d.proof).toBeUndefined()
				expect(evidenceLevelOf(d)).toBe("weak")
				// m3: unproven everywhere. The API view publishes it as any weak record; the store's
				// own label keeps the protocol it was last seen as, never at decoded without a proof.
				expect(d).toMatchObject({ protocol: "unknown", evidenceLevel: "weak" })
				expect(d.confidence).not.toBe("decoded")
				expect(restored.identityOf(id)!.confidence).not.toBe("decoded")
				expect(viewOf(restored, id)).toEqual({
					proof: null,
					evidence: "weak",
					label: {
						protocol: ev.protocol,
						family: "packet",
						confidence: "candidate",
					},
				})
				expect(restored.decodeAnchorFor("rtl", CH_A)?.proof).toBeUndefined()
				const next = { ...ev, at: T0 + 1 }
				expect(
					restored.anchorDecode("rtl", CH_A, next, "commanded").discoveryId,
				).toBe(id)
				restored.stopAnchorExpiry()
				expect(restored.get(id)!.proof!.identity).toEqual(ev.identity)
				expect(evidenceLevelOf(restored.get(id)!)).toBe("proven")
			} finally {
				original.stopAnchorExpiry()
				restored.stopAnchorExpiry()
			}
		}
	})

	it("names the one channel anchor at a point target; the other protocol never opens a second", () => {
		const s = store()
		try {
			const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId
			expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(a)
			expect(s.decodeAnchorFor("rtl", CH_A + 0.4)?.id).toBe(a)
			expect(s.decodeAnchorFor("rtl", CH_B)).toBeUndefined()
			expect(s.decodeAnchorFor("other", CH_A)).toBeUndefined()
			expect(s.anchorDecode("rtl", CH_A, vdl2(), "commanded").discoveryId).toBe(
				null,
			)
			expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(a)
		} finally {
			s.stopAnchorExpiry()
		}
	})
})
