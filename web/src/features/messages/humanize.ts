// Readable fields from any decoded JSON (Decode board, "JSON fallback for unknown rtl_433 models"): rtl_433 alone has
// hundreds of models, so units come from the key suffix (`temperature_C` → "Temperature" in °C), flags read as words
// and nested objects one level deep (`weather.temperature`). Pure.
import type { DecodeField, JsonValue } from "@wavekit/api-types"

/** rtl_433 key suffixes and the unit they carry, longest first where one ends another. */
const SUFFIX_UNITS: readonly (readonly [string, string])[] = [
	["_km_h", "km/h"],
	["_m_s", "m/s"],
	["_kWh", "kWh"],
	["_kPa", "kPa"],
	["_hPa", "hPa"],
	["_inHg", "inHg"],
	["_PSI", "psi"],
	["_psi", "psi"],
	["_bar", "bar"],
	["_mph", "mph"],
	["_kph", "km/h"],
	["_mm_h", "mm/h"],
	["_in_h", "in/h"],
	["_mm", "mm"],
	["_in", "in"],
	["_dBm", "dBm"],
	["_dB", "dB"],
	["_lux", "lx"],
	["_ppm", "ppm"],
	["_pct", "%"],
	["_deg", "°"],
	["_kHz", "kHz"],
	["_MHz", "MHz"],
	["_Hz", "Hz"],
	["_mV", "mV"],
	["_V", "V"],
	["_mA", "mA"],
	["_A", "A"],
	["_kW", "kW"],
	["_W", "W"],
	["_m3", "m³"],
	["_L", "L"],
	["_ms", "ms"],
	["_s", "s"],
	["_C", "°C"],
	["_F", "°F"],
	["_K", "K"],
	["_m", "m"],
	["_ft", "ft"],
]

/** camelCase unit suffixes (`speedKmh`, `temperatureC`, `windDirDeg`). */
const CAMEL_UNIT =
	/([a-z0-9])(Kmh|Kph|Mph|Kn|Kts|Knots|Deg|Hz|KHz|Khz|MHz|Mhz|Dbm|DBm|Db|DB|Ft|Hpa|HPa|Kpa|KPa|Pct|Mm|Mv|MV|C|F)$/
const CAMEL_UNITS: Readonly<Record<string, string>> = {
	kmh: "km/h",
	kph: "km/h",
	mph: "mph",
	kn: "kn",
	kts: "kn",
	knots: "kn",
	deg: "°",
	hz: "Hz",
	khz: "kHz",
	mhz: "MHz",
	dbm: "dBm",
	db: "dB",
	ft: "ft",
	hpa: "hPa",
	kpa: "kPa",
	pct: "%",
	mm: "mm",
	mv: "mV",
	c: "°C",
	f: "°F",
}

/** Keys whose unit is implied by the name alone. */
const NAME_UNITS: Readonly<Record<string, string>> = {
	course: "°",
	heading: "°",
	track: "°",
	cog: "°",
	hdg: "°",
	sog: "kn",
	windDir: "°",
	wind_dir: "°",
	humidity: "%",
	moisture: "%",
	battery_pct: "%",
	snr: "dB",
	rssi: "dBm",
	noise: "dB",
}

/** Readable names for the common keys of decoders and rtl_433. */
const NAMES: Readonly<Record<string, string>> = {
	battery_ok: "Battery",
	wind_avg: "Wind",
	wind_max: "Gusts",
	wind_dir: "Wind from",
	rain: "Rain",
	uv: "UV index",
	uvi: "UV index",
	co2: "CO₂",
	pm2_5: "PM2.5",
	pm10: "PM10",
	sog: "Speed",
	cog: "Course",
	hdg: "Heading",
	snr: "SNR",
	rssi: "RSSI",
	rxSnr: "SNR",
	rxRssi: "RSSI",
	msgType: "Message type",
	navStatus: "Status",
	hopsAway: "Hops",
	portnum: "Port",
	rain1h: "Rain 1 h",
	rain24h: "Rain 24 h",
	windDir: "Wind from",
	windSpeed: "Wind",
	gust: "Gusts",
	lat: "Latitude",
	lon: "Longitude",
	icao: "ICAO",
	mmsi: "MMSI",
	tg: "Talkgroup",
	ctcssHz: "CTCSS",
	dcs: "DCS",
	dtmf: "DTMF",
	id: "ID",
}

/** rtl_433 bookkeeping and identity keys: the title and subtitle already say them, or they mean nothing to a reader. */
const SKIP = new Set([
	"time",
	"model",
	"id",
	"channel",
	"mic",
	"protocol",
	"subtype",
	"mod",
	"freq",
	"freq1",
	"freq2",
	"rssi_dB",
	"snr_dB",
	"noise_dB",
])

/** Words that stay upper case in a label ("Rssi" reads wrong). */
const ACRONYMS = new Set([
	"id",
	"uv",
	"co2",
	"pm",
	"snr",
	"rssi",
	"icao",
	"mmsi",
	"ais",
	"crc",
	"tpms",
	"gps",
	"cpdlc",
	"dtmf",
	"ctcss",
	"dcs",
	"nac",
	"tg",
	"ppm",
	"rf",
])

/** "temperature_C" → "temperature", unit "°C". */
function splitUnit(key: string): { base: string; unit: string | undefined } {
	const named = NAME_UNITS[key]
	if (named) return { base: key, unit: named }
	const camel = CAMEL_UNIT.exec(key)
	if (camel?.[1] && camel[2]) {
		const base = key.slice(0, -camel[2].length)
		const unit = CAMEL_UNITS[camel[2].toLowerCase()]
		// a lone C or F is a temperature only on a temperature key
		if (unit && (camel[2].length > 1 || /temp/i.test(base)))
			return { base, unit }
	}
	for (const [suffix, unit] of SUFFIX_UNITS) {
		if (key.length > suffix.length && key.endsWith(suffix))
			return { base: key.slice(0, -suffix.length), unit }
	}
	return { base: key, unit: undefined }
}

/** "wind_avg" / "windAvg" / "wind-avg" → "Wind avg"; acronyms stay upper case. */
export function labelOf(key: string): string {
	const exact = NAMES[key]
	if (exact) return exact
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s_\-.]+/)
		.filter(w => w.length > 0)
		.map(w =>
			ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase(),
		)
	if (words.length === 0) return key
	const [first, ...rest] = words
	const head = first ?? ""
	return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(" ")
}

/** A canonical form for comparing keys from the core and from the JSON ("temperature_C" = "temperatureC"). */
export function keyId(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

type JsonObject = { readonly [k: string]: JsonValue }

function isObject(v: JsonValue | undefined): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

function scalarOf(v: JsonValue): DecodeField["value"] | undefined {
	if (v === null) return undefined
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined
	if (typeof v === "string") return v.trim().length > 0 ? v : undefined
	if (typeof v === "boolean") return v
	// arrays of scalars read as a list ("WIDE1-1, WIDE2-1"); anything deeper stays in the JSON
	if (Array.isArray(v)) {
		const parts = v.filter(
			(x): x is string | number =>
				typeof x === "string" || typeof x === "number",
		)
		return parts.length === v.length && parts.length > 0 && parts.length <= 8
			? parts.join(", ")
			: undefined
	}
	return undefined
}

function fieldOf(
	key: string,
	path: string,
	raw: JsonValue,
): DecodeField | null {
	const value = scalarOf(raw)
	if (value === undefined) return null
	if (key === "battery_ok")
		return {
			key: path,
			label: "Battery",
			value:
				value === 1 || value === true
					? "OK"
					: value === 0 || value === false
						? "Low"
						: value,
		}
	const { base, unit } = splitUnit(key)
	const label = labelOf(NAMES[key] ? key : base)
	const rounded =
		typeof value === "number" && !Number.isInteger(value)
			? Math.round(value * 100) / 100
			: value
	return unit && typeof rounded === "number"
		? { key: path, label, value: rounded, unit }
		: { key: path, label, value: rounded }
}

/**
 * Every readable scalar of a decoded object, in its own order, with nested objects flattened one level
 * (`weather.temperature` → "Temperature"). Bookkeeping keys (`time`, `model`, `mic`…) and positions are left out.
 */
export function humanize(
	data: JsonValue | undefined,
	limit = 24,
): DecodeField[] {
	if (!isObject(data)) return []
	const out: DecodeField[] = []
	const walk = (obj: JsonObject, prefix: string, depth: number) => {
		for (const [k, v] of Object.entries(obj)) {
			if (out.length >= limit) return
			if (depth === 0 && SKIP.has(k)) continue
			if (k === "lat" || k === "lon" || k === "latitude" || k === "longitude")
				continue
			if (isObject(v)) {
				if (depth === 0) walk(v, `${prefix}${k}.`, 1)
				continue
			}
			const f = fieldOf(k, prefix + k, v)
			if (f) out.push(f)
		}
	}
	walk(data, "", 0)
	return out
}

/**
 * The core's fields first (its labels and units win), then what the JSON adds that the core left out.
 * `extra` is false for decoders the core already presents in full (aircraft, ships): their JSON is long and noisy.
 */
export function mergeFields(
	core: readonly DecodeField[],
	data: JsonValue | undefined,
	extra: boolean,
	limit = 12,
): DecodeField[] {
	const out = [...core]
	if (!extra) return out.slice(0, limit)
	const seen = new Set(core.map(f => keyId(f.key.split(".").pop() ?? f.key)))
	const labels = new Set(core.map(f => f.label.toLowerCase()))
	for (const f of humanize(data)) {
		if (out.length >= limit) break
		const id = keyId(f.key.split(".").pop() ?? f.key)
		const base = keyId(splitUnit(f.key.split(".").pop() ?? f.key).base)
		if (seen.has(id) || seen.has(base) || labels.has(f.label.toLowerCase()))
			continue
		seen.add(id)
		labels.add(f.label.toLowerCase())
		out.push(f)
	}
	return out
}
