import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import * as f from "../../../cli/source/ui/format.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("formatters (spec §8)", () => {
	it("format the spec's examples", () => {
		expect(f.formatRate(f.kibToBytes(3994))).toBe("4.1 MB/s")
		expect(f.formatBytes(1_940_000_000, 2)).toBe("1.94 GB")
		expect(f.formatBytes(545_500_000)).toBe("545.5 MB")
		expect(f.formatBytes(0)).toBe("0 B")
		expect(f.formatMSps(2_048_000)).toBe("2.048 MS/s")
		expect(f.formatSps(2_048_000)).toBe("2 048 000 S/s")
		expect(f.formatHz(445_970_700)).toBe("445 970 700 Hz")
		expect(f.formatMHz(445_970_700)).toBe("445.971 MHz")
		expect(f.formatMHzBare(445_970_700, 4)).toBe("445.9707")
		expect(f.formatWindow(444_946_700, 446_994_700)).toBe("444.947–446.995 MHz")
		expect(f.formatHalfSpan(2_048_000)).toBe("±1.024")
		expect(f.formatPercent(0.3449)).toBe("34%")
		expect(f.formatCount(3357)).toBe("3 357")
		expect(f.formatCount(42)).toBe("42")
		expect(f.formatEventRate(2 / 60)).toBe("2/min")
		expect(f.formatEventRate(1.2)).toBe("1.2/s")
		expect(f.formatEventRate(0.001)).toBe("<1/min")
		expect(f.formatDb(207)).toBe("20.7 dB")
		expect(f.formatDeltaHz(29_300)).toBe("+29.3 kHz")
		expect(f.formatDeltaHz(-1_500_000)).toBe("−1.500 MHz")
		expect(f.formatClock(Date.parse("2026-10-08T18:07:52Z"))).toBe("18:07:52")
		expect(f.formatClockShort(Date.parse("2026-10-08T18:07:52Z"))).toBe("18:07")
		expect(f.formatClockMs(Date.parse("2026-10-08T18:12:10.412Z"))).toBe(
			"18:12:10.412",
		)
	})
	it("formats ages in buckets", () => {
		expect(f.formatAge(-5000)).toBe("<1s")
		expect(f.formatAge(400)).toBe("<1s")
		expect(f.formatAge(9_000)).toBe("9s")
		// R79 (M11): seconds below a minute, then minute precision, never zero-padded.
		expect(f.formatAge(59_999)).toBe("59s")
		expect(f.formatAge(160_000)).toBe("2m")
		expect(f.formatAge(124_000)).toBe("2m")
		expect(f.formatAge(720_000)).toBe("12m")
		expect(f.formatAge(3_780_000)).toBe("1h 3m")
		expect(f.formatAge(7_200_000)).toBe("2h")
		expect(f.formatAge(7_800_000)).toBe("2h 10m")
		expect(f.formatAge(3 * 86_400_000)).toBe("3d")
		expect(f.formatDuration(52)).toBe("52s")
		expect(f.formatSampleAge(4)).toBe("4 ms")
		expect(f.formatSampleAge(1200)).toBe("1.2s")
		expect(f.formatSampleAge(23_000)).toBe("23s")
	})
	it("never rounds a nonzero or non-total ratio to 0% or 100% (R21, T4)", () => {
		expect(f.formatPercent(0)).toBe("0%")
		expect(f.formatPercent(0.004)).toBe("<1%")
		expect(f.formatPercent(0.005)).toBe("1%")
		expect(f.formatPercent(0.996)).toBe(">99%")
		expect(f.formatPercent(1)).toBe("100%")
		expect(f.formatEventRate(-0.5)).toBe("?")
	})
	it("never rounds up into the next bucket's number", () => {
		expect(f.formatSampleAge(999.6)).toBe("999 ms")
		expect(f.formatSampleAge(9_990)).toBe("9.9s")
		expect(f.formatEventRate(59.6 / 60)).toBe("1.0/s")
		expect(f.formatBytes(999.7)).toBe("1.0 KB")
		expect(f.formatBytes(999_960)).toBe("1.0 MB")
		expect(f.formatDeltaHz(999_990)).toBe("+1.000 MHz")
		expect(f.formatCount(999.6)).toBe("1 000")
	})

	const unknowns = [null, undefined, Number.NaN]
	const fns: Array<[string, (n: number | null | undefined) => string]> = [
		["bytes", n => f.formatBytes(n)],
		["rate", n => f.formatRate(n)],
		["spaced", n => f.formatSpaced(n)],
		["count", n => f.formatCount(n)],
		["hz", n => f.formatHz(n)],
		["sps", n => f.formatSps(n)],
		["msps", n => f.formatMSps(n)],
		["mhz", n => f.formatMHz(n)],
		["half", n => f.formatHalfSpan(n)],
		["percent", n => f.formatPercent(n)],
		["age", n => f.formatAge(n)],
		["duration", n => f.formatDuration(n)],
		["sampleAge", n => f.formatSampleAge(n)],
		["eventRate", n => f.formatEventRate(n)],
		["db", n => f.formatDb(n)],
		["delta", n => f.formatDeltaHz(n)],
		["clock", n => f.formatClock(n)],
	]

	// Feature: cli-dashboard-overhaul, Property 6: unknown is never zero
	// Validates: spec T5
	it("P6: null/undefined/NaN format as ? and never as a number", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...fns),
				fc.constantFrom(...unknowns),
				([, fn], v) => {
					const out = fn(v)
					expect(out).toBe("?")
					expect(/\d/.test(out)).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})

	const parseAge = (s: string): number => {
		if (s === "<1s") return 0
		let m = /^(\d+)s$/.exec(s)
		if (m) return Number(m[1])
		m = /^(\d+)m (\d+)s$/.exec(s)
		if (m) return Number(m[1]) * 60 + Number(m[2])
		m = /^(\d+)m$/.exec(s)
		if (m) return Number(m[1]) * 60
		m = /^(\d+)h (\d+)m$/.exec(s)
		if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60
		m = /^(\d+)h$/.exec(s)
		if (m) return Number(m[1]) * 3600
		m = /^(\d+)d$/.exec(s)
		if (m) return Number(m[1]) * 86400
		throw new Error(`unparseable age ${s}`)
	}

	// Feature: cli-dashboard-overhaul, Property 8: ages
	// Validates: spec §8
	it("P8: formatAge is never negative/NaN and is non-decreasing in age", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -1e9, max: 1e10 }),
				fc.integer({ min: 0, max: 1e9 }),
				(a, d) => {
					const x = f.formatAge(a)
					const y = f.formatAge(a + d)
					expect(x.includes("-") || x.includes("NaN")).toBe(false)
					expect(parseAge(x)).toBeLessThanOrEqual(parseAge(y))
				},
			),
			{ numRuns: 100 },
		)
	})
})
