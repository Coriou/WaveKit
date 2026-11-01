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
	DiscoveryStore,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { evidenceLevelOf } from "../../../../src/core/scanner/proof.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import type {
	DecodeEvidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"

// Synthetic channels inside the VHF aeronautical band; not taken from any capture.
const CH_A = 130_000_000
const CH_B = 130_025_000
const T0 = Date.UTC(2026, 9, 31)

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

	it("keeps one anchor per source, protocol and channel", () => {
		const s = store()
		try {
			const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId
			const b = s.anchorDecode("rtl", CH_B, acars(), "commanded").discoveryId
			const v = s.anchorDecode("rtl", CH_A, vdl2(), "commanded").discoveryId
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
			expect(new Set([a, b, v, other]).size).toBe(4)
			expect(again).toBe(a)
			expect(s.snapshot().discoveries).toHaveLength(4)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("keys an MHz-to-Hz product with float error to the same channel", () => {
		const s = store()
		try {
			// 131.825 × 1e6 is 131 824 999.99999999 in binary floating point.
			const mhz = 131.825 * 1_000_000
			expect(Number.isInteger(mhz)).toBe(false)
			const a = s.anchorDecode("rtl", mhz, acars(), "commanded")
			const b = s.anchorDecode("rtl", 131_825_000, acars("TEST02"), "commanded")
			expect(b.discoveryId).toBe(a.discoveryId)
			expect(s.get(a.discoveryId!)!.frequencyHz).toBe(131_825_000)
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

	// Reach ambientReachHz(protocol, 0) = 1 500 + 2 500 = 4 000 Hz, exclusive as point placement.
	it.each([0, 3_999, -3_999])(
		"proves the one discovery %i Hz from the channel instead of opening an anchor",
		offset => {
			for (const ev of [acars(), vdl2()]) {
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

	it("fails closed to the anchor when two discoveries are in reach: neither is proven", () => {
		const s = store()
		try {
			const a = spectrum(s, "o1", -2_000)
			const b = spectrum(s, "o2", 2_000)
			expect(a).not.toBe(b)
			const res = s.anchorDecode("rtl", CH_A, acars(), "commanded")
			expect(res.change).toBe("created")
			expect(anchors(s).map(d => d.id)).toEqual([res.discoveryId])
			for (const id of [a, b]) {
				expect(s.get(id)!.confidence).not.toBe("decoded")
				expect(s.get(id)!.proof).toBeUndefined()
			}
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("never proves through untrusted, unclean or another epoch's evidence", () => {
		for (const [ev, trust, anchored] of [
			[acars(), "unverified", false],
			[{ ...acars(), crcClean: false }, "commanded", false],
			// Another epoch: the observation refuses the evidence, the anchor takes it.
			[{ ...acars(), epoch: 2 }, "commanded", true],
		] as const) {
			const s = store()
			try {
				const id = spectrum(s, "o1", 0)
				s.anchorDecode("rtl", CH_A, ev, trust)
				expect(s.get(id)!.confidence).not.toBe("decoded")
				expect(
					s.snapshot().observations.find(o => o.id === "o1")!.decode ?? [],
				).toEqual([])
				expect(anchors(s)).toHaveLength(anchored ? 1 : 0)
			} finally {
				s.stopAnchorExpiry()
			}
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
				const res = t.anchorDecode("rtl", CH_A, acars(), "commanded")
				expect(res.discoveryId).not.toBe(id)
				expect(t.get(id)!.protocol).toBe("vdl2")
				expect(anchors(t)).toHaveLength(1)
			} finally {
				t.stopAnchorExpiry()
			}
		} finally {
			s.stopAnchorExpiry()
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

	it("names the one channel anchor at a point target, and none for both protocols at once", () => {
		const s = store()
		try {
			const a = s.anchorDecode("rtl", CH_A, acars(), "commanded").discoveryId
			expect(s.decodeAnchorFor("rtl", CH_A)?.id).toBe(a)
			expect(s.decodeAnchorFor("rtl", CH_A + 0.4)?.id).toBe(a)
			expect(s.decodeAnchorFor("rtl", CH_B)).toBeUndefined()
			expect(s.decodeAnchorFor("other", CH_A)).toBeUndefined()
			s.anchorDecode("rtl", CH_A, vdl2(), "commanded")
			expect(s.decodeAnchorFor("rtl", CH_A)).toBeUndefined()
		} finally {
			s.stopAnchorExpiry()
		}
	})
})
