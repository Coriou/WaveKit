import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	captureRateFor,
	isCaptureRate,
	wholeCaptureShapeAt,
} from "../../../../src/core/iq-capture/rates.js"
import { IqCaptureStore } from "../../../../src/core/iq-capture/store.js"
import {
	IQ_CAPTURE_RATES,
	IQ_CAPTURE_TOTAL_MAX_BYTES,
	iqCaptureMaxBytes,
	type IqCaptureRequest,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"

const id = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const req = (over: Partial<IqCaptureRequest> = {}): IqCaptureRequest => ({
	sourceId: "s1",
	observationId: "o1",
	epoch: 1,
	rfHz: 433_920_000,
	tuningTrust: "commanded",
	fromSample: 0,
	reason: "detection",
	...over,
})
const store = (capBytes = IQ_CAPTURE_TOTAL_MAX_BYTES) =>
	new IqCaptureStore({
		capBytes,
		maxCaptureMs: 4000,
		now: () => 1_000_000,
		onRemove: () => undefined,
	})

describe("capture rates", () => {
	it("file bounds per rate: 4 s × rate × 8 B; none for an unsupported rate", () => {
		expect(IQ_CAPTURE_RATES).toEqual([48_000, 96_000, 192_000])
		expect(iqCaptureMaxBytes(48_000)).toBe(1_536_000)
		expect(iqCaptureMaxBytes(96_000)).toBe(3_072_000)
		expect(iqCaptureMaxBytes(192_000)).toBe(6_144_000)
		expect(iqCaptureMaxBytes(250_000)).toBe(0)
		// the 256 MiB total holds 87 full 96 kHz captures and refuses the 88th reservation
		expect(Math.floor(IQ_CAPTURE_TOTAL_MAX_BYTES / 3_072_000)).toBe(87)
		for (const r of [0, 47_999, 96_001, 250_000, Number.NaN, "96000"])
			expect(isCaptureRate(r)).toBe(false)
	})

	it("whole-capture shape at each rate, at and past the minimum transition", () => {
		expect(wholeCaptureShapeAt(47_424, 96_000)).toEqual({
			bandwidthHz: 47_424,
			transitionHz: 24_288,
		})
		expect(wholeCaptureShapeAt(95_800, 96_000)).toEqual({
			bandwidthHz: 95_800,
			transitionHz: 100,
		})
		expect(wholeCaptureShapeAt(95_801, 96_000)).toEqual({
			bandwidthHz: 95_800,
			transitionHz: 100,
		})
		expect(wholeCaptureShapeAt(47_424, 250_000)).toBeNull()
		expect(wholeCaptureShapeAt(0, 96_000)).toBeNull()
	})

	it("ISM listed (prior ≥ 1) or an OOK burst gets 96 kHz; a prior of 0 or below 1 does not", () => {
		const burst = trackOf({ blocks: 4 })
		const long = trackOf({ blocks: 5, spectralShape: "flat" })
		expect(captureRateFor({ priors: { ism: 1 }, track: null })).toBe(96_000)
		expect(captureRateFor({ priors: { ism: 0.99 }, track: null })).toBe(48_000)
		expect(captureRateFor({ priors: {}, track: burst })).toBe(96_000)
		expect(captureRateFor({ priors: {}, track: long })).toBe(48_000)
		expect(captureRateFor({ priors: { ism: 0 }, track: burst })).toBe(48_000)
		expect(captureRateFor({ priors: { dmr: 3 }, track: null })).toBe(48_000)
		expect(captureRateFor({ priors: { ism: Number.NaN }, track: null })).toBe(
			48_000,
		)
	})

	// Feature: capture-rates, Property 1: a capture rate is always a supported rate
	it("property: any priors and track give a supported rate", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.constantFrom("ism", "dmr", "pocsag", "analog-fm"),
					fc.oneof(fc.double(), fc.constant(0), fc.constant(1)),
				),
				fc.option(fc.integer({ min: 1, max: 40 })),
				(priors, blocks) => {
					const rate = captureRateFor({
						priors,
						track: blocks === null ? null : trackOf({ blocks }),
					})
					return isCaptureRate(rate)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("IqCaptureStore at 96 kHz", () => {
	it("reserves the 96 kHz bound and refuses 'full' at the cap", () => {
		const s = store(3_072_000 * 2)
		expect(s.reservationBytes(96_000)).toBe(3_072_000)
		expect(s.admit(req({ rateHz: 96_000 }), id(1), 1)).toEqual({
			captureId: id(1),
		})
		expect(s.admit(req({ rateHz: 96_000 }), id(2), 1)).toEqual({
			captureId: id(2),
		})
		// finished at full length (the concurrency bound is not what refuses the third)
		for (const n of [1, 2]) {
			expect(s.captured(id(n), 384_000, 0)).toBe(true)
			s.ready(id(n))
		}
		// exactly at the cap: a third is refused even at 48 kHz
		expect(s.heldBytes()).toBe(6_144_000)
		expect(s.admit(req(), id(3), 1)).toEqual({ refused: "full" })
	})

	it("sample bounds follow the rate: 9 600 at least, 384 000 at most", () => {
		const s = store()
		s.admit(req({ rateHz: 96_000 }), id(1), 1)
		expect(s.captured(id(1), 9_599, 0)).toBe(false)
		s.admit(req({ rateHz: 96_000 }), id(2), 1)
		expect(s.captured(id(2), 384_001, 0)).toBe(false)
		s.admit(req({ rateHz: 96_000 }), id(3), 1)
		expect(s.captured(id(3), 384_000, 0)).toBe(true)
		const view = s.ready(id(3))
		expect(view).toMatchObject({ durationMs: 4000, rateHz: 96_000 })
		s.admit(req({ rateHz: 96_000 }), id(4), 1)
		expect(s.captured(id(4), 9_600, 0)).toBe(true)
		// a 48 kHz view carries no rate (unchanged shape)
		s.admit(req(), id(5), 1)
		expect(s.captured(id(5), 48_000, 0)).toBe(true)
		expect(s.ready(id(5))).not.toHaveProperty("rateHz")
	})
})
