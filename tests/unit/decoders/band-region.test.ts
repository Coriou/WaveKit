/**
 * Band defaults spec §4: band region from config, time zone, then locale.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	BAND_REGIONS,
	BAND_REGION_SOURCES,
	regionFromLocale,
	regionFromTimeZone,
	resolveBandRegion,
} from "../../../src/decoders/band-region.js"

describe("resolveBandRegion", () => {
	it("a configured region always wins", () => {
		expect(
			resolveBandRegion({
				configured: "JP",
				env: { TZ: "Europe/Paris", LANG: "en_US.UTF-8" },
				intlTimeZone: "America/New_York",
			}),
		).toEqual({ code: "JP", source: "configured" })
	})

	it("TZ=Europe/Paris is EU from the TZ variable", () => {
		expect(resolveBandRegion({ env: { TZ: "Europe/Paris" } })).toEqual({
			code: "EU",
			source: "guessed:tz",
		})
	})

	it("Docker defaults (TZ=UTC, LANG=C) fall back to EU", () => {
		// ICU reports en-US for LANG=C: a fallback, not a location signal.
		expect(
			resolveBandRegion({
				env: { TZ: "UTC", LANG: "C" },
				intlTimeZone: "UTC",
				intlLocale: "en-US",
			}),
		).toEqual({ code: "EU", source: "default" })
		expect(
			resolveBandRegion({
				env: {},
				intlTimeZone: "Etc/UTC",
				intlLocale: "en-US",
			}),
		).toEqual({ code: "EU", source: "default" })
		// A real Intl locale still counts.
		expect(
			resolveBandRegion({ env: { LANG: "C" }, intlLocale: "en-AU" }),
		).toEqual({ code: "AU", source: "guessed:intl-locale" })
	})

	it("the time zone outranks an en_US locale", () => {
		expect(
			resolveBandRegion({
				env: { LANG: "en_US.UTF-8" },
				intlTimeZone: "Europe/Berlin",
			}),
		).toEqual({ code: "EU", source: "guessed:intl-timezone" })
	})

	it("maps Canadian, US, Oceanian and Asian zones", () => {
		expect(regionFromTimeZone("America/Toronto")).toBe("CA")
		expect(regionFromTimeZone("Canada/Pacific")).toBe("CA")
		expect(regionFromTimeZone("America/Chicago")).toBe("US")
		expect(regionFromTimeZone("Pacific/Honolulu")).toBe("US")
		expect(regionFromTimeZone("Australia/Sydney")).toBe("AU")
		expect(regionFromTimeZone("Pacific/Auckland")).toBe("NZ")
		expect(regionFromTimeZone("Asia/Tokyo")).toBe("JP")
		expect(regionFromTimeZone("Asia/Shanghai")).toBe("CN")
		expect(regionFromTimeZone("Africa/Lagos")).toBe("EU")
		expect(regionFromTimeZone("Asia/Kolkata")).toBeUndefined()
		expect(regionFromTimeZone("Etc/UTC")).toBeUndefined()
		expect(resolveBandRegion({ env: { TZ: "America/Toronto" } })).toEqual({
			code: "CA",
			source: "guessed:tz",
		})
	})

	it("reads locales in POSIX order and skips unusable ones", () => {
		expect(regionFromLocale("en_GB.UTF-8")).toBe("EU")
		expect(regionFromLocale("de-CH")).toBe("EU")
		expect(regionFromLocale("ja_JP")).toBe("JP")
		expect(regionFromLocale("zh-Hans-CN")).toBe("CN")
		expect(regionFromLocale("C.UTF-8")).toBeUndefined()
		expect(regionFromLocale("POSIX")).toBeUndefined()
		expect(regionFromLocale("pt_BR.UTF-8")).toBeUndefined()
		expect(
			resolveBandRegion({
				env: { LC_ALL: "C", LC_CTYPE: "en_AU.UTF-8", LANG: "en_US.UTF-8" },
			}),
		).toEqual({ code: "AU", source: "guessed:locale-env" })
	})

	it("is total for arbitrary inputs", () => {
		// Feature: decoder-band-defaults, Property 5: Region resolution is total
		// Validates: §4
		const maybe = fc.option(fc.string(), { nil: undefined })
		fc.assert(
			fc.property(
				fc.option(fc.constantFrom(...BAND_REGIONS), { nil: undefined }),
				maybe,
				maybe,
				maybe,
				maybe,
				maybe,
				maybe,
				(configured, TZ, LC_ALL, LC_CTYPE, LANG, intlTimeZone, intlLocale) => {
					const result = resolveBandRegion({
						configured,
						env: { TZ, LC_ALL, LC_CTYPE, LANG },
						intlTimeZone,
						intlLocale,
					})
					expect(BAND_REGIONS).toContain(result.code)
					expect(BAND_REGION_SOURCES).toContain(result.source)
					if (configured !== undefined)
						expect(result).toEqual({ code: configured, source: "configured" })
				},
			),
			{ numRuns: 100 },
		)
	})
})
