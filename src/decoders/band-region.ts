/**
 * Band plan region (band defaults spec §4): the configured code, else a guess
 * from the time zone, then the locale, else EU. Pure and total: unusable
 * signals are skipped, never errors.
 *
 * Region codes name band plans, not polities: `EU` is CEPT / IARU Region 1
 * (includes the UK, Switzerland, Norway; Africa via time zone).
 */

import type {
	BandRegion,
	BandRegionSource,
	DecoderBandRegion,
} from "@wavekit/api-types"

export type {
	BandRegion,
	BandRegionSource,
	DecoderBandRegion,
} from "@wavekit/api-types"

export const BAND_REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]

// Compile-time check that the list covers the API union.
type MissingRegion = Exclude<BandRegion, (typeof BAND_REGIONS)[number]>
const regionsComplete: MissingRegion extends never ? true : never = true
void regionsComplete

export const BAND_REGION_SOURCES = [
	"configured",
	"decoder",
	"guessed:tz",
	"guessed:intl-timezone",
	"guessed:locale-env",
	"guessed:intl-locale",
	"default",
] as const satisfies readonly BandRegionSource[]

export interface BandRegionInput {
	/** config.region, which WAVEKIT_REGION feeds */
	configured?: BandRegion | undefined
	env: Readonly<Record<string, string | undefined>>
	/** Intl.DateTimeFormat().resolvedOptions().timeZone */
	intlTimeZone?: string | undefined
	/** Intl.DateTimeFormat().resolvedOptions().locale */
	intlLocale?: string | undefined
}

const CANADIAN_ZONES = new Set([
	"America/Toronto",
	"America/Vancouver",
	"America/Edmonton",
	"America/Winnipeg",
	"America/Halifax",
	"America/St_Johns",
	"America/Regina",
	"America/Moncton",
	"America/Whitehorse",
	"America/Yellowknife",
	"America/Iqaluit",
])

/** CEPT member territories (ISO 3166 alpha-2), mapped to the EU band plan. */
const CEPT_TERRITORIES = new Set([
	"AL",
	"AD",
	"AT",
	"AZ",
	"BA",
	"BE",
	"BG",
	"CH",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GB",
	"GE",
	"GR",
	"HR",
	"HU",
	"IE",
	"IS",
	"IT",
	"LI",
	"LT",
	"LU",
	"LV",
	"MC",
	"MD",
	"ME",
	"MK",
	"MT",
	"NL",
	"NO",
	"PL",
	"PT",
	"RO",
	"RS",
	"SE",
	"SI",
	"SK",
	"SM",
	"TR",
	"UA",
	"VA",
])

const SELF_MAPPED: ReadonlySet<string> = new Set([
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
])

/** Band region for an IANA time zone; undefined when unusable or unmapped. */
export function regionFromTimeZone(zone: string): BandRegion | undefined {
	const tz = zone.trim()
	if (tz === "") return undefined
	if (CANADIAN_ZONES.has(tz) || tz.startsWith("Canada/")) return "CA"
	if (tz.startsWith("Europe/") || tz.startsWith("Africa/")) return "EU"
	if (tz === "Pacific/Auckland" || tz === "Pacific/Chatham" || tz === "NZ")
		return "NZ"
	if (
		tz.startsWith("America/") ||
		tz.startsWith("US/") ||
		tz === "Pacific/Honolulu"
	)
		return "US"
	if (tz.startsWith("Australia/")) return "AU"
	if (tz === "Asia/Tokyo" || tz === "Japan") return "JP"
	if (tz === "Asia/Shanghai" || tz === "Asia/Urumqi" || tz === "PRC")
		return "CN"
	return undefined
}

/**
 * Band region for a POSIX (`en_GB.UTF-8`) or BCP 47 (`en-GB`) locale;
 * undefined for `C`, `POSIX`, no territory, or an unmapped one.
 */
export function regionFromLocale(locale: string): BandRegion | undefined {
	const base = locale.trim().split(/[.@]/)[0] ?? ""
	const parts = base.split(/[_-]/)
	if (parts.length < 2) return undefined
	for (const part of parts.slice(1)) {
		if (!/^[A-Za-z]{2}$/.test(part)) continue
		const territory = part.toUpperCase()
		if (SELF_MAPPED.has(territory)) return territory as BandRegion
		if (CEPT_TERRITORIES.has(territory)) return "EU"
		return undefined
	}
	return undefined
}

const POSIX_LOCALES = new Set(["", "C", "POSIX"])

/**
 * ICU reports `en-US` when the locale variables are unset or `C`/`POSIX`
 * (the Docker default): that is a fallback, not a signal about location.
 */
function isIcuFallbackLocale(
	env: Readonly<Record<string, string | undefined>>,
	locale: string,
): boolean {
	if (locale.trim() !== "en-US") return false
	return ["LC_ALL", "LC_CTYPE", "LANG"].every(key => {
		const value = env[key]
		if (value === undefined) return true
		const base = value.trim().split(/[.@]/)[0] ?? ""
		return POSIX_LOCALES.has(base.toUpperCase())
	})
}

export function resolveBandRegion(input: BandRegionInput): DecoderBandRegion {
	if (input.configured !== undefined)
		return { code: input.configured, source: "configured" }
	const tz = input.env["TZ"]
	const fromTz = typeof tz === "string" ? regionFromTimeZone(tz) : undefined
	if (fromTz) return { code: fromTz, source: "guessed:tz" }
	const fromIntlZone =
		typeof input.intlTimeZone === "string"
			? regionFromTimeZone(input.intlTimeZone)
			: undefined
	if (fromIntlZone)
		return { code: fromIntlZone, source: "guessed:intl-timezone" }
	for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) {
		const value = input.env[key]
		const fromLocale =
			typeof value === "string" ? regionFromLocale(value) : undefined
		if (fromLocale) return { code: fromLocale, source: "guessed:locale-env" }
	}
	const fromIntlLocale =
		typeof input.intlLocale === "string" &&
		!isIcuFallbackLocale(input.env, input.intlLocale)
			? regionFromLocale(input.intlLocale)
			: undefined
	if (fromIntlLocale)
		return { code: fromIntlLocale, source: "guessed:intl-locale" }
	return { code: "EU", source: "default" }
}

/** Reads the process signals (TZ, LC_*, LANG, Intl) once; for src/index.ts. */
export function resolveProcessBandRegion(
	configured: BandRegion | undefined,
): DecoderBandRegion {
	let intlTimeZone: string | undefined
	let intlLocale: string | undefined
	try {
		const resolved = Intl.DateTimeFormat().resolvedOptions()
		intlTimeZone = resolved.timeZone
		intlLocale = resolved.locale
	} catch {
		// Intl unavailable: fall through to env and the default.
	}
	return resolveBandRegion({
		configured,
		env: process.env,
		intlTimeZone,
		intlLocale,
	})
}
