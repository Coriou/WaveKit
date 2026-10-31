import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	AERO_VHF_MAX_HZ,
	AERO_VHF_MIN_HZ,
	anchorHzOf,
	canAnchor,
	decodeAnchorKey,
} from "../../../../src/core/scanner/store/decode-anchor.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { evidenceLevelOf } from "../../../../src/core/scanner/proof.js"
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

function store() {
	let n = 0
	return new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => T0,
		newId: () => `anchor${n++}`,
	})
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
				expect(s.get(d.id)!.proof!.identity).toEqual(next.identity)
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

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
