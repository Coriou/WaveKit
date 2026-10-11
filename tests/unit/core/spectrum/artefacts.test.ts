import { describe, expect, it } from "vitest"
import { artefactOf } from "../../../../src/core/spectrum/artefacts.js"
import type { ArtefactMasks } from "../../../../src/core/spectrum/artefacts.js"

const C = 446_100_000

function masks(over: Partial<ArtefactMasks> = {}): ArtefactMasks {
	return {
		sourceId: "s1",
		epoch: 4,
		centreHz: C,
		binHz: 1000,
		usable: { startHz: C - 102_500, endHz: C + 102_500 },
		dcGuardHz: 2000,
		spurs: [
			{ startHz: C - 60_500, endHz: C - 57_500, origin: "comb" },
			{ startHz: C + 30_500, endHz: C + 32_500, origin: "provisional" },
		],
		images: [{ centreHz: C - 40_000, obwHz: 9000, partnerHz: C + 40_000 }],
		rfi: { active: false, periodMs: null, blankedFrames: 0 },
		activity: [{ startHz: C + 35_500, endHz: C + 44_500 }],
		...over,
	}
}

describe("artefactOf", () => {
	it("names the DC guard, spur lines and IQ images, and nothing elsewhere", () => {
		const m = masks()
		expect(artefactOf(C, 4, m)).toBe("dc")
		expect(artefactOf(C + 1900, 4, m)).toBe("dc")
		expect(artefactOf(C - 59_000, 4, m)).toBe("spur")
		expect(artefactOf(C + 31_500, 4, m)).toBe("spur")
		expect(artefactOf(C - 37_000, 4, m)).toBe("image")
		expect(artefactOf(C + 40_000, 4, m)).toBeNull() // the image's partner is the real emission
		expect(artefactOf(C + 10_000, 4, m)).toBeNull()
	})

	it("answers nothing for another epoch's masks", () => {
		expect(artefactOf(C, 5, masks())).toBeNull()
	})

	it("does not call an emission that straddles the DC guard or a spur line an artefact", () => {
		const straddling = masks({
			activity: [
				{ startHz: C - 6500, endHz: C - 2500 }, // a 13 kHz emission split by the DC mask
				{ startHz: C + 2500, endHz: C + 6500 },
				{ startHz: C + 27_500, endHz: C + 36_500 }, // one segment over the provisional line
			],
		})
		expect(artefactOf(C, 4, straddling)).toBeNull()
		expect(artefactOf(C + 31_500, 4, straddling)).toBeNull()
		expect(artefactOf(C - 59_000, 4, straddling)).toBe("spur")
		expect(
			artefactOf(
				C,
				4,
				masks({ activity: [{ startHz: C + 2500, endHz: C + 6500 }] }),
			),
		).toBe("dc") // one side only
	})

	it("calls a quiet target rfi only while periodic RFI is active, inside the usable span", () => {
		const rfi = masks({
			rfi: { active: true, periodMs: 100, blankedFrames: 60 },
		})
		expect(artefactOf(C + 10_000, 4, rfi)).toBe("rfi")
		expect(artefactOf(C + 40_000, 4, rfi)).toBeNull() // activity at the target: an emission
		expect(artefactOf(C + 46_000, 4, rfi)).toBeNull() // within 2 kHz of activity
		expect(artefactOf(C + 150_000, 4, rfi)).toBeNull() // outside the usable span
		expect(artefactOf(C - 59_000, 4, rfi)).toBe("spur") // masks are named before rfi
	})
})
