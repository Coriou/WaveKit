import { describe, expect, it } from "vitest"
import {
	AIS_CHANNEL_A_HZ,
	AIS_CHANNEL_B_HZ,
	ADSB_CARRIER_HZ,
	MAX_PROVENANCE_HZ,
	RTL433_FREQ_MAX_HZ,
	RTL433_FREQ_MAX_OFFSET_HZ,
	RTL433_FREQ_MIN_HZ,
	resolveProvenance,
	validHz,
} from "../../../../../src/core/activity/provenance/resolve.js"
import type { ActivityDecoderBinding } from "../../../../../src/core/activity/types.js"
import type {
	DecoderOutput,
	DecoderOutputType,
} from "../../../../../src/decoders/types.js"

function out(type: DecoderOutputType, data: unknown): DecoderOutput {
	return { timestamp: new Date(0), decoder: "d", type, data }
}

function bind(
	targets: readonly number[],
	sourceId: string | null = "rtl-0",
	tuningTrust: ActivityDecoderBinding["tuningTrust"] = "unverified",
): ActivityDecoderBinding {
	return { sourceId, targetFrequenciesHz: targets, tuningTrust }
}

const chan = (hz: number, tuningTrust = "unverified") => ({
	hz,
	basis: "channel",
	tuningTrust,
})

describe("resolveProvenance table", () => {
	it("acars uses the payload frequency in Hz, rounded", () => {
		expect(
			resolveProvenance(
				out("acars", { frequency: 131_550_000.4 }),
				bind([131_725_000, 131_550_000]),
			),
		).toEqual({ sourceId: "rtl-0", frequency: chan(131_550_000) })
	})

	it("vdl2 with frequency 0 falls back to a single target", () => {
		expect(
			resolveProvenance(out("vdl2", { frequency: 0 }), bind([136_975_000])),
		).toEqual({ sourceId: "rtl-0", frequency: chan(136_975_000) })
		expect(
			resolveProvenance(
				out("vdl2", { frequency: 0 }),
				bind([136_975_000, 136_650_000]),
			),
		).toEqual({ sourceId: "rtl-0", frequency: null })
	})

	it("meshtastic uses the payload frequency and the binding trust", () => {
		expect(
			resolveProvenance(
				out("meshtastic", { frequency: 869_525_000 }),
				bind([], "lora", "commanded"),
			),
		).toEqual({ sourceId: "lora", frequency: chan(869_525_000, "commanded") })
	})

	it("AIS channel spellings map to the carriers", () => {
		for (const c of ["A", "a", "1", "87B", 1])
			expect(
				resolveProvenance(out("ship", { channel: c }), null).frequency?.hz,
			).toBe(AIS_CHANNEL_A_HZ)
		for (const c of ["B", "b", "2", "88B", 2])
			expect(
				resolveProvenance(out("ship", { channel: c }), null).frequency?.hz,
			).toBe(AIS_CHANNEL_B_HZ)
		expect(
			resolveProvenance(out("ship", { channel: "C" }), bind([162_000_000])),
		).toEqual({ sourceId: "rtl-0", frequency: chan(162_000_000) })
		expect(
			resolveProvenance(out("ship", { mmsi: 1 }), bind([1, 2])).frequency,
		).toBeNull()
	})

	it("other outputs ignore payload frequency and use a single target", () => {
		// multimon-ng's string frequency is never used (unit unverified).
		expect(
			resolveProvenance(out("message", { frequency: "446.006" }), null),
		).toEqual({ sourceId: null, frequency: null })
		expect(
			resolveProvenance(out("aircraft", { frequency: 1_090_000_000 }), null),
		).toEqual({ sourceId: null, frequency: null })
		expect(
			resolveProvenance(out("aircraft", {}), bind([1_090_000_000], null)),
		).toEqual({ sourceId: null, frequency: chan(1_090_000_000) })
		expect(
			resolveProvenance(out("aprs", {}), bind([144_800_000, 144_390_000])),
		).toEqual({ sourceId: "rtl-0", frequency: null })
	})

	it("no binding: payload frequency with null source and unverified trust", () => {
		expect(
			resolveProvenance(out("acars", { frequency: 131_550_000 }), null),
		).toEqual({ sourceId: null, frequency: chan(131_550_000) })
	})

	it("hz bounds (0, 10^12] after rounding", () => {
		expect(validHz(MAX_PROVENANCE_HZ)).toBe(MAX_PROVENANCE_HZ)
		expect(validHz(MAX_PROVENANCE_HZ + 1)).toBeUndefined()
		expect(validHz(0.5)).toBe(1)
		expect(validHz(0.49)).toBeUndefined()
		for (const v of [0, -1, Number.NaN, Infinity, -Infinity, "5", null, 1n])
			expect(validHz(v)).toBeUndefined()
	})

	it("non-object payloads and hostile bindings resolve without the payload", () => {
		expect(resolveProvenance(out("acars", null), null)).toEqual({
			sourceId: null,
			frequency: null,
		})
		const hostile = {
			sourceId: 7,
			targetFrequenciesHz: "x",
			tuningTrust: "bogus",
		} as unknown as ActivityDecoderBinding
		expect(resolveProvenance(out("acars", { frequency: 5 }), hostile)).toEqual({
			sourceId: null,
			frequency: chan(5),
		})
	})

	describe("WG16 SC 3b: readsb and rtl_433 frequencies", () => {
		it("a bound readsb is the 1090 MHz carrier, whatever its targets", () => {
			expect(ADSB_CARRIER_HZ).toBe(1_090_000_000)
			expect(
				resolveProvenance(
					out("aircraft", { icao: "x" }),
					bind([], "rtl", "relay"),
				),
			).toEqual({ sourceId: "rtl", frequency: chan(1_090_000_000, "relay") })
			expect(
				resolveProvenance(
					out("aircraft", {}),
					bind([1_089_000_000, 1_091_000_000]),
				),
			).toEqual({ sourceId: "rtl-0", frequency: chan(1_090_000_000) })
			// an unbound reception stays unknown
			expect(resolveProvenance(out("aircraft", {}), null)).toEqual({
				sourceId: null,
				frequency: null,
			})
		})

		it("rtl_433 uses its freq (MHz) inside the plausible range, bounds included", () => {
			const sig = (freq: unknown) => out("signal", { model: "m", freq })
			expect(resolveProvenance(sig(868.3), bind([]))).toEqual({
				sourceId: "rtl-0",
				frequency: chan(868_300_000),
			})
			expect(resolveProvenance(sig(RTL433_FREQ_MIN_HZ / 1e6), null)).toEqual({
				sourceId: null,
				frequency: chan(24_000_000),
			})
			expect(resolveProvenance(sig(RTL433_FREQ_MAX_HZ / 1e6), null)).toEqual({
				sourceId: null,
				frequency: chan(1_766_000_000),
			})
			for (const bad of [
				23.999999,
				1766.000001,
				Number.NaN,
				Infinity,
				-433.92,
				"433.92",
				null,
				undefined,
			])
				expect(resolveProvenance(sig(bad), null)).toEqual({
					sourceId: null,
					frequency: null,
				})
		})

		it("rtl_433's freq is used within 1.6 MHz of the single target, else the target", () => {
			expect(RTL433_FREQ_MAX_OFFSET_HZ).toBe(1_600_000)
			const target = 868_000_000
			const sig = (hz: number) => out("signal", { freq: hz / 1e6 })
			expect(
				resolveProvenance(sig(target + 1_600_000), bind([target])),
			).toEqual({
				sourceId: "rtl-0",
				frequency: chan(869_600_000),
			})
			expect(
				resolveProvenance(sig(target - 1_600_001), bind([target])),
			).toEqual({
				sourceId: "rtl-0",
				frequency: chan(target),
			})
		})
	})
})
