// The rows of the Settings drawer, built from what the app knows (a snapshot of its stores) and the writes it can
// make (actions). Only settings that work in this app and this core are rows; the rest of the canvas registry
// waits on CORE-GAPS ("Settings store in core", "One settings schema"). Pure given the snapshot and the actions.
import type {
	AccessDeviceDto,
	DecoderInfo,
	DecoderSettingsUpdate,
	DecoderSettingsView,
	DecoderTypeInfo,
	ExtendedSourceStatus,
	LiveAudioStatus,
	PreferenceKey,
	Preferences,
	StationIdentity,
	StationProvenance,
	StationUpdate,
	StorageReport,
	TunerState,
} from "@wavekit/api-types"
import { SPECTRUM_BINS_CAP_CEILING } from "@wavekit/api-types"

import type {
	ControlStatus,
	ReceiverCaps,
	ReceiverSetting,
	ReceiverSettingKey,
	SettingWriteResult,
	SpectrumLimitsState,
	TunerRelayView,
} from "../../data/index.ts"
import type { CardAnchorId } from "../../shell/layout.ts"
import type {
	Averaging,
	Density,
	DevicePrefs,
	DiscoveryTagMode,
	MapLabels,
	MapTiles,
	Motion,
	SpectrumRange,
} from "../../shell/device-prefs.ts"
import type { SignalLabelsMode } from "../../plot/label-gate.ts"
import { FFT_SIZES, MAP_TRAILS, fftBins } from "../../shell/device-prefs.ts"
import type { DisplayPrefs, TimeFormat, Units } from "../display.ts"
import { DEFAULT_DISPLAY } from "../display.ts"
import type { ThemePrefs } from "../../shell/theme.ts"
import { formatDb, formatRate, formatStep } from "../format.ts"
import type { LiveAudioConfigPatch } from "../../data/live-audio-store.ts"
import {
	controlAvailability,
	controlErrorText,
	rateLabel,
	rateWarning,
	receiverLock,
	sampleRateOptions,
	type ReceiverControlId,
} from "../receiver/controls.ts"
import {
	gainAt,
	gainDb,
	gainSteps,
	nearestGainIndex,
} from "../receiver/gain.ts"
import { sourceTitle } from "../receiver/summary.ts"
import { STEPS } from "../tuner/prefs.ts"
import { decoderRows } from "./decoder-rows.ts"
import { devicesCount, devicesSummary } from "./devices.ts"
import {
	optionText,
	type SettingOption,
	type SettingRow,
	type SettingValue,
	type TextWidget,
} from "./model.ts"

export interface SettingsSnapshot {
	/** A protected core without a session: everything shows, nothing changes. */
	readonly readOnly: boolean
	readonly theme: ThemePrefs
	/** Density and motion (this browser only). */
	readonly device: DevicePrefs
	readonly stepHz: number | null
	/** The anchor the tuned card wants (this browser only). */
	readonly cardAt: CardAnchorId
	readonly volume: number
	readonly tuner: TunerState | undefined
	readonly source: ExtendedSourceStatus | undefined
	readonly caps: ReceiverCaps | null
	readonly controls: Readonly<
		Partial<Record<ReceiverSettingKey, ControlStatus>>
	>
	readonly relay: TunerRelayView | null
	readonly live: LiveAudioStatus | null
	readonly station: StationIdentity | null
	readonly preferences: Preferences | null
	readonly preferenceDefaults: Preferences | null
	/** Units and time kept by this browser, used while core has no preferences. */
	readonly display: DisplayPrefs
	readonly savedCount: number
	/** Bands you edited or added in Settings › Band plans; null until the stack loads. */
	readonly bandplanEdits: number | null
	/** The core's spectrum limits (GET /api/spectrum): FFT sizes above `binsMax` cannot be picked. */
	readonly spectrumLimits: Pick<SpectrumLimitsState, "binsMax" | "binsCap">
	readonly decoders: readonly DecoderInfo[]
	readonly decoderTypes: Readonly<Record<string, DecoderTypeInfo>>
	readonly decoderViews: Readonly<Record<string, DecoderSettingsView>>
	/** False: this core keeps no decoder settings (legacy access mode). */
	readonly decoderSettings: boolean
	readonly version: string | null
	readonly accessMode: "legacy" | "protected" | null
	/** Remembered devices (protected core, this browser paired); null until loaded or without a session. */
	readonly devices: readonly AccessDeviceDto[] | null
	readonly storage: StorageReport | null
	readonly exportUrl: string
}

export interface SettingsActions {
	setTheme(patch: Partial<ThemePrefs>): void
	setDevice(patch: Partial<DevicePrefs>): void
	setDisplay(patch: Partial<DisplayPrefs>): void
	setStep(hz: number | null): void
	setCardAt(id: CardAnchorId): void
	setVolume(volume: number): void
	receiver(setting: ReceiverSetting): Promise<SettingWriteResult>
	manualGain(tenthsDb: number): Promise<SettingWriteResult>
	audio(patch: LiveAudioConfigPatch): Promise<SettingWriteResult>
	station(patch: StationUpdate): Promise<SettingWriteResult>
	preference(
		key: PreferenceKey,
		value: Preferences[PreferenceKey],
	): Promise<SettingWriteResult>
	decoder(id: string, patch: DecoderSettingsUpdate): Promise<SettingWriteResult>
	openTuner(): void
	openShortcuts(): void
	openBandPlans(): void
	openDevices(): void
	/** The browser's position as a Location value; absent where the browser has no geolocation. */
	locate?: () => Promise<{ value: string } | { error: string }>
}

const OK: SettingWriteResult = { ok: true }
/** A write kept by this browser: applied at once, never fails. */
const local = (fn: () => void): Promise<SettingWriteResult> => {
	fn()
	return Promise.resolve(OK)
}
const opts = (list: readonly (readonly [string, string])[]): SettingOption[] =>
	list.map(([value, label]) => ({ value, label }))

/** Each keyword, plus each pair of neighbours ("dark mode"). */
export function words(text: string): string[] {
	const w = text ? text.split(" ") : []
	return w.concat(w.slice(1).map((x, i) => `${w[i]} ${x}`))
}

function fftRow(
	d: DevicePrefs,
	limits: SettingsSnapshot["spectrumLimits"],
	a: SettingsActions,
): SettingRow {
	const served = fftBins(d.fftSize, limits.binsMax)
	return {
		id: "dp.fft",
		group: "display",
		label: "FFT size",
		help:
			served < d.fftSize
				? `Using ${served}: this WaveKit sends up to ${served} bins`
				: "Larger shows finer detail and reacts more slowly",
		keys: words("fft size resolution bins detail spectrum waterfall"),
		device: true,
		widget: {
			kind: "select",
			options: FFT_SIZES.map(n => ({
				value: String(n),
				label: String(n),
				...optional("disabled", fftSizeBlocked(n, limits)),
			})),
		},
		value: String(d.fftSize),
		text: String(d.fftSize),
		def: { value: "8192", text: "8192" },
		write: v => {
			const n = Number(v)
			const size = FFT_SIZES.find(x => x === n)
			return local(() => {
				if (size !== undefined) a.setDevice({ fftSize: size })
			})
		},
	}
}

// ---- station

/** ISO 3166 codes the core accepts for `station.country` (src/config.ts stationCountries). */
const COUNTRY_CODES =
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
		" ",
	)

let countryNames: Intl.DisplayNames | null | undefined
function countryName(code: string): string {
	if (countryNames === undefined) {
		try {
			countryNames = new Intl.DisplayNames(["en"], { type: "region" })
		} catch {
			countryNames = null
		}
	}
	return countryNames?.of(code) ?? code
}

let countryOptions: SettingOption[] | null = null
function countries(): SettingOption[] {
	countryOptions ??= [
		{ value: "", label: "Not set" },
		...COUNTRY_CODES.map(c => ({ value: c, label: countryName(c) })).sort(
			(a, b) => a.label.localeCompare(b.label),
		),
	]
	return countryOptions
}

const PROVENANCE_LOCK: Partial<Record<StationProvenance, string>> = {
	env: "Set in the environment · change it there",
	yaml: "Set in the YAML configuration · change it there",
}

const ENV_NAMES: Record<string, string> = {
	name: "WAVEKIT_STATION_NAME",
	callsign: "WAVEKIT_CALLSIGN",
	country: "WAVEKIT_COUNTRY",
}

/** Lock note of a station field pinned by env or YAML (core precedence env > yaml > ui > default). */
function stationLock(
	field: string,
	provenance: StationProvenance,
): string | undefined {
	if (provenance === "env" && ENV_NAMES[field])
		return `Set by ${ENV_NAMES[field]} · change it in the environment`
	return PROVENANCE_LOCK[provenance]
}

const CALLSIGN = /^[A-Z0-9]{3,7}(-[0-9]{1,2})?$/i

const textWidget = (
	placeholder: string,
	parse: TextWidget["parse"],
	inputMode: "text" | "decimal" = "text",
): TextWidget => ({
	kind: "text",
	placeholder,
	inputMode,
	parse,
	format: v => (v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v)),
})

/** "48.727, -3.985" (or with N/S/E/W): both or neither. */
export function parseLocation(
	text: string,
): { value: SettingValue } | { error: string } {
	const t = text.trim()
	if (!t) return { value: null }
	const parts = t.split(/[,;\s]+/).filter(Boolean)
	if (parts.length !== 2)
		return { error: "Type latitude and longitude, like 48.727, -3.985" }
	const num = (s: string, pos: string, neg: string) => {
		const m = /^(-?\d+(?:[.,]\d+)?)°?([A-Za-z])?$/.exec(s)
		if (!m) return Number.NaN
		const v = Number((m[1] ?? "").replace(",", "."))
		const h = m[2]?.toUpperCase()
		if (h === undefined) return v
		if (h === pos) return v
		if (h === neg) return -v
		return Number.NaN
	}
	const lat = num(parts[0] ?? "", "N", "S")
	const lon = num(parts[1] ?? "", "E", "W")
	if (!Number.isFinite(lat) || lat < -90 || lat > 90)
		return { error: "Latitude goes from −90 to 90" }
	if (!Number.isFinite(lon) || lon < -180 || lon > 180)
		return { error: "Longitude goes from −180 to 180" }
	return { value: `${lat}, ${lon}` }
}

export function formatLocation(lat: number | null, lon: number | null): string {
	if (lat === null || lon === null) return "Not set"
	const ns = `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? "S" : "N"}`
	const ew = `${Math.abs(lon).toFixed(3)}° ${lon < 0 ? "W" : "E"}`
	return `${ns}, ${ew}`
}

const bandplanText = (n: number | null) =>
	n === null ? "Open" : n === 0 ? "No edits" : `${n} edit${n === 1 ? "" : "s"}`

function stationRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const st = s.station
	if (!st) return []
	const writable = st.writable === true && !s.readOnly
	const notWritable = s.readOnly
		? "Read-only access: sign in on this WaveKit to change it"
		: st.writable === true
			? undefined
			: "This WaveKit keeps the station read-only (open access mode) · set it in the YAML"
	const field = <K extends keyof StationUpdate>(
		key: K,
		toPatch: (v: SettingValue) => StationUpdate[K],
	) =>
		writable
			? (v: SettingValue) => a.station({ [key]: toPatch(v) } as StationUpdate)
			: undefined
	const lockOf = (k: string, p: StationProvenance) =>
		stationLock(k, p) ?? (writable ? undefined : notWritable)
	const lat = st.lat.value
	const lon = st.lon.value
	const locLock =
		stationLock("lat", st.lat.provenance) ??
		stationLock("lon", st.lon.provenance)
	const rows: SettingRow[] = [
		{
			id: "station.name",
			group: "station",
			label: "Station name",
			help: "Shown on your other devices",
			keys: words("title name"),
			widget: textWidget("WaveKit", t => ({ value: t.trim() || null })),
			value: st.name.value,
			text: st.name.value ?? "Not set",
			def: { value: null, text: "Not set" },
			...optional("lock", lockOf("name", st.name.provenance)),
			...optional(
				"write",
				field("name", v => (v === null ? null : String(v))),
			),
		},
		{
			id: "station.location",
			group: "station",
			label: "Location",
			help: "Latitude, longitude. Used by ADS-B and the map, never shared.",
			keys: words("position latitude longitude coordinates gps qth lat lon"),
			widget: {
				...textWidget("48.727, -3.985", parseLocation, "decimal"),
				...optional(
					"fill",
					a.locate && writable && !locLock
						? {
								label: "Use my location",
								busyLabel: "Locating…",
								run: a.locate,
							}
						: undefined,
				),
			},
			value: lat === null || lon === null ? null : `${lat}, ${lon}`,
			text: formatLocation(lat, lon),
			def: { value: null, text: "Not set" },
			effect: {
				kind: "restart",
				text: "Restarts ADS-B (readsb takes the position at start)",
				short: "restarts ADS-B",
			},
			...optional("lock", locLock ?? (writable ? undefined : notWritable)),
			...optional(
				"write",
				writable
					? (v: SettingValue) => {
							if (v === null) return a.station({ lat: null, lon: null })
							const [la, lo] = String(v).split(",").map(Number)
							return a.station({ lat: la ?? null, lon: lo ?? null })
						}
					: undefined,
			),
		},
		{
			id: "station.country",
			group: "station",
			label: "Country",
			help: `Picks the band plan and legal limits · region ${st.region}`,
			keys: words("region nation band plan legal limits locale"),
			widget: { kind: "select", options: countries() },
			value: st.country.value ?? "",
			text: st.country.value ? countryName(st.country.value) : "Not set",
			def: { value: "", text: "Not set" },
			...optional("lock", lockOf("country", st.country.provenance)),
			...optional(
				"write",
				field("country", v => (v ? String(v) : null)),
			),
		},
		{
			id: "station.bandplans",
			group: "station",
			label: "Band plans",
			help: "Band and channel names for the spectrum, Tuner, scans and ⌘K",
			keys: words(
				"band plan bandplan bands channels frequency allocations import sdr++ sdrpp gqrx sdr# sdrsharp csv xml",
			),
			widget: {
				kind: "link",
				text: bandplanText(s.bandplanEdits),
				action: a.openBandPlans,
			},
			value: s.bandplanEdits,
			text: bandplanText(s.bandplanEdits),
		},
		{
			id: "station.callsign",
			group: "station",
			label: "Callsign",
			help: "For APRS and the map",
			keys: words("call sign ham amateur licence license"),
			widget: textWidget("Optional", t => {
				const v = t.trim().toUpperCase()
				if (!v) return { value: null }
				return CALLSIGN.test(v)
					? { value: v }
					: { error: "Use letters and digits only, like F4ABC or F4ABC-9" }
			}),
			value: st.callsign.value,
			text: st.callsign.value ?? "Not set",
			def: { value: null, text: "Not set" },
			...optional("lock", lockOf("callsign", st.callsign.provenance)),
			...optional(
				"write",
				field("callsign", v => (v === null ? null : String(v))),
			),
		},
		{
			id: "station.saved",
			group: "station",
			label: "Saved frequencies",
			help: "Managed in the Tuner, shared by every device",
			keys: words("bookmarks memories favourites favorites channels"),
			widget: {
				kind: "link",
				text: `${s.savedCount} saved`,
				action: a.openTuner,
			},
			value: s.savedCount,
			text: `${s.savedCount} saved`,
		},
		{
			id: "station.altitude",
			group: "station",
			label: "Altitude",
			help: "Antenna height above sea level, for ADS-B range",
			keys: words("height elevation altitude metres meters"),
			more: true,
			widget: { kind: "stepper", min: -500, max: 9000, step: 1, unit: " m" },
			value: st.altM.value,
			text: st.altM.value === null ? "Not set" : `${st.altM.value} m`,
			def: { value: null, text: "Not set" },
			...optional("lock", lockOf("altM", st.altM.provenance)),
			...optional(
				"write",
				field("altM", v => (v === null ? null : Number(v))),
			),
		},
	]
	return rows
}

/** `{ [key]: value }` only when the value is defined (exactOptionalPropertyTypes). */
function optional<K extends string, V>(
	key: K,
	value: V | undefined,
): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

// ---- receiver

const RX_KEYS: Record<ReceiverControlId, ReceiverSettingKey> = {
	gain: "gain",
	agcMode: "agcMode",
	sampleRate: "sampleRate",
	ppm: "ppm",
	biasTee: "biasTee",
	directSampling: "directSampling",
	offsetTuning: "offsetTuning",
}

function receiverRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const tuner = s.tuner
	const source = s.source
	const rows: SettingRow[] = [
		{
			id: "rx.source",
			group: "receiver",
			label: "Source",
			help: source
				? [
						source.url ?? source.type,
						source.connected ? "streaming" : "not connected",
					]
						.filter(Boolean)
						.join(" · ")
				: "No source yet",
			keys: words("dongle rtl_tcp sdr++ host input"),
			widget: { kind: "read" },
			value: source?.id ?? null,
			text: source ? sourceTitle(source, tuner) : "None",
			lock: "Set in the YAML configuration (sources)",
		},
	]
	if (!tuner) return rows
	const lock = receiverLock({
		tuner,
		source,
		readOnly: s.readOnly,
		relay: s.relay,
	})
	const ctl = (id: ReceiverControlId) => {
		const avail = controlAvailability(id, s.caps)
		const status = s.controls[RX_KEYS[id]]
		const disabled = lock.locked
			? (lock.reason ?? "The receiver is not yours to change right now")
			: avail.enabled
				? undefined
				: (avail.reason ?? "Not available")
		return {
			...optional("disabled", disabled),
			...optional(
				"error",
				status?.error ? controlErrorText(status.error) : undefined,
			),
			...(status?.pending ? { busy: true } : {}),
		}
	}
	const shown = <T>(key: ReceiverSettingKey, core: T): T => {
		const st = s.controls[key]
		return st?.pending && st.target !== null ? (st.target as T) : core
	}
	const write =
		(make: (v: SettingValue) => ReceiverSetting) => (v: SettingValue) =>
			a.receiver(make(v))

	const rate = shown("sampleRate", tuner.sampleRate)
	const rates = sampleRateOptions(s.caps, tuner.sampleRate)
	rows.push({
		id: "rx.rate",
		group: "receiver",
		label: "Sample rate",
		help: "Wider shows more spectrum and uses more CPU",
		keys: words("span bandwidth sdr ms/s msps"),
		widget:
			rates.length > 5
				? {
						kind: "select",
						options: rates.map(hz => ({
							value: String(hz),
							label: formatRate(hz),
						})),
					}
				: {
						kind: "seg",
						options: rates.map(hz => ({
							value: String(hz),
							label: rateLabel(hz),
						})),
					},
		value: String(rate),
		text: formatRate(rate),
		effect: {
			kind: "restart",
			text: "Restarts the stream: decoders pause for a moment",
			short: "restarts the stream",
		},
		warn: v => rateWarning(Number(v)),
		...ctl("sampleRate"),
		write: write(v => ({ key: "sampleRate", value: Number(v) })),
	})

	const steps = gainSteps(s.caps)
	const auto = shown("gainMode", tuner.gainMode) === "agc"
	const gain = shown("gain", tuner.gain)
	const gainOptions: SettingOption[] = [
		{ value: "auto", label: "Auto (tuner AGC)" },
		...steps.valuesTenthsDb
			.slice()
			.reverse()
			.map(v => ({ value: String(v), label: gainDb(v) })),
	]
	// the select lists the tuner's table: show the nearest step when the core reports a value between two
	const gainValue = auto
		? "auto"
		: String(gainAt(steps, nearestGainIndex(steps, gain)))
	rows.push({
		id: "rx.gain",
		group: "receiver",
		label: "Gain",
		help: "Also on the Receiver island",
		keys: words("rf gain lna amplification auto"),
		widget: { kind: "select", options: gainOptions },
		value: gainValue,
		text: auto ? "Auto" : gainDb(gain),
		...ctl("gain"),
		write: v =>
			v === "auto"
				? a.receiver({ key: "gainMode", value: "agc" })
				: a.manualGain(Number(v)),
	})

	const ppm = shown("ppm", tuner.ppm)
	rows.push({
		id: "rx.ppm",
		group: "receiver",
		label: "Frequency correction",
		help: "Crystal error. Tune a known signal and adjust until it centres.",
		keys: words("ppm crystal offset calibration xtal drift"),
		widget: { kind: "stepper", min: -200, max: 200, step: 1, unit: " ppm" },
		value: ppm,
		text: `${ppm} ppm`,
		def: { value: 0, text: "0 ppm" },
		...ctl("ppm"),
		write: write(v => ({ key: "ppm", value: Number(v) })),
	})

	const bias = shown("biasTee", tuner.biasTee)
	rows.push({
		id: "rx.biasT",
		group: "receiver",
		label: "Bias‑T",
		help: "Powers an LNA through the antenna port",
		keys: words("lna power bias tee antenna"),
		widget: { kind: "switch" },
		value: bias,
		text: bias ? "On" : "Off",
		def: { value: false, text: "Off" },
		effect: {
			kind: "hardware",
			text: "Sends 4.5 V up the antenna cable. Only with an LNA that needs it.",
			short: "turns on antenna power",
		},
		...ctl("biasTee"),
		write: write(v => ({ key: "biasTee", value: v === true })),
	})

	const direct = shown("directSampling", tuner.directSampling)
	rows.push({
		id: "rx.direct",
		group: "receiver",
		label: "Direct sampling",
		help: "For HF below 24 MHz",
		keys: words("hf shortwave direct sampling i q"),
		more: true,
		widget: {
			kind: "seg",
			options: opts([
				["off", "Off"],
				["i", "I"],
				["q", "Q"],
			]),
		},
		value: direct,
		text: optionText(
			opts([
				["off", "Off"],
				["i", "I branch"],
				["q", "Q branch"],
			]),
			direct,
		),
		def: { value: "off", text: "Off" },
		effect: {
			kind: "hardware",
			text: "Switches the dongle input",
			short: "switches the dongle input",
		},
		...ctl("directSampling"),
		write: write(v => ({
			key: "directSampling",
			value: v === "i" || v === "q" ? v : "off",
		})),
	})

	const offset = shown("offsetTuning", tuner.offsetTuning)
	rows.push({
		id: "rx.offset",
		group: "receiver",
		label: "Offset tuning",
		help: "Moves the DC spike out of the band (E4000)",
		keys: words("e4000 dc spike offset"),
		more: true,
		widget: { kind: "switch" },
		value: offset,
		text: offset ? "On" : "Off",
		def: { value: false, text: "Off" },
		effect: {
			kind: "hardware",
			text: "Retunes the dongle",
			short: "retunes the dongle",
		},
		...ctl("offsetTuning"),
		write: write(v => ({ key: "offsetTuning", value: v === true })),
	})

	const agc = shown("agcMode", tuner.agcMode)
	rows.push({
		id: "rx.rtlAgc",
		group: "receiver",
		label: "RTL AGC",
		help: "Digital gain inside the RTL2832",
		keys: words("digital gain agc rtl2832"),
		more: true,
		widget: { kind: "switch" },
		value: agc,
		text: agc ? "On" : "Off",
		def: { value: false, text: "Off" },
		...ctl("agcMode"),
		write: write(v => ({ key: "agcMode", value: v === true })),
	})

	if (s.relay)
		rows.push({
			id: "rx.relay",
			group: "receiver",
			label: "Share with SDR++",
			help:
				s.relay.clientsConnected > 0
					? "An rtl_tcp relay · a client is connected"
					: "An rtl_tcp relay · no client",
			keys: words("relay rtl_tcp sdr++ sdrpp share"),
			more: true,
			widget: { kind: "read" },
			value: s.relay.enabled,
			text: s.relay.enabled ? "On" : "Off",
			lock: "Set in the YAML configuration (tunerRelay)",
		})
	return rows
}

// ---- audio

const NR = opts([
	["off", "Off"],
	["voice", "Voice"],
	["narrow-band", "Narrow band"],
	["noaa-apt", "NOAA APT"],
])

function audioRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const rows: SettingRow[] = []
	const st = s.live
	const disabled = s.readOnly
		? "Read-only access: sign in on this WaveKit to change it"
		: undefined
	if (st) {
		const c = st.config
		const mode = c.squelchMode ?? "manual"
		const sq =
			mode === "manual" && c.squelch >= 0
				? "off"
				: mode === "manual"
					? "level"
					: mode
		const noiseFits = c.modulation === "nfm" || c.modulation === "wfm"
		const sqOpts: SettingOption[] = [
			{ value: "auto", label: "Auto" },
			{
				value: "noise",
				label: "Noise",
				...(noiseFits ? {} : { disabled: "FM only (NFM, WFM)" }),
			},
			{ value: "level", label: "Level" },
			{ value: "off", label: "Off" },
		]
		const w =
			(patch: (v: SettingValue) => LiveAudioConfigPatch) => (v: SettingValue) =>
				a.audio(patch(v))
		rows.push({
			id: "au.squelch",
			group: "audio",
			label: "Squelch",
			help: "Auto keeps it above the noise floor; Noise (FM) opens when a carrier quiets the noise",
			keys: words("threshold sql noise squelch gate"),
			widget: { kind: "seg", options: sqOpts },
			value: sq,
			text: optionText(sqOpts, sq),
			...optional("disabled", disabled),
			write: w(v =>
				v === "auto"
					? { squelchMode: "auto" }
					: v === "noise"
						? { squelchMode: "noise" }
						: v === "off"
							? { squelchMode: "manual", squelch: 0 }
							: {
									squelchMode: "manual",
									squelch: c.squelch < 0 ? c.squelch : -60,
								},
			),
		})
		if (sq === "level")
			rows.push({
				id: "au.threshold",
				group: "audio",
				label: "Squelch level",
				help: "Opens above this channel power. Or drag the line in Listen.",
				keys: words("squelch threshold level dbfs"),
				widget: {
					kind: "stepper",
					min: -120,
					max: -1,
					step: 1,
					unit: " dBFS",
				},
				value: c.squelch,
				text: `${formatDb(c.squelch, 0)} dBFS`,
				...optional("disabled", disabled),
				write: w(v => ({ squelchMode: "manual", squelch: Number(v) })),
			})
		const margin = c.autoMarginDb ?? 6
		rows.push({
			id: "au.margin",
			group: "audio",
			label: "Auto squelch margin",
			help: "How far above the noise floor Auto opens",
			keys: words("squelch sql threshold auto margin"),
			widget: { kind: "stepper", min: 0, max: 40, step: 1, unit: " dB" },
			value: margin,
			text: `${margin} dB`,
			def: { value: 6, text: "6 dB" },
			...optional("disabled", disabled),
			write: w(v => ({ autoMarginDb: Number(v) })),
		})
		const agcDefault = ["am", "cw", "dsb", "usb", "lsb"].includes(c.modulation)
			? "fast"
			: "off"
		const agc = c.agc ?? agcDefault
		const agcOpts = opts([
			["off", "Off"],
			["slow", "Slow"],
			["fast", "Fast"],
		])
		rows.push({
			id: "au.agc",
			group: "audio",
			label: "Level control",
			help: "Evens out loud and quiet stations",
			keys: words("agc automatic gain loudness level"),
			widget: { kind: "seg", options: agcOpts },
			value: agc,
			text: optionText(agcOpts, agc),
			def: { value: agcDefault, text: optionText(agcOpts, agcDefault) },
			...optional("disabled", disabled),
			write: w(v => ({ agc: v === "slow" || v === "fast" ? v : "off" })),
		})
		const de = c.deEmphasis ? String(c.deEmphasisTau) : "off"
		const deOpts = opts([
			["off", "Off"],
			["50", "50 µs"],
			["75", "75 µs"],
		])
		rows.push({
			id: "au.deemph",
			group: "audio",
			label: "De-emphasis",
			help: "For FM broadcast: 50 µs in Europe, 75 µs in the Americas",
			keys: words("deemphasis de-emphasis fm broadcast tau"),
			widget: { kind: "seg", options: deOpts },
			value: de,
			text: optionText(deOpts, de),
			def: { value: "off", text: "Off" },
			...optional("disabled", disabled),
			write: w(v =>
				v === "50" || v === "75"
					? { deEmphasis: true, deEmphasisTau: v === "50" ? 50 : 75 }
					: { deEmphasis: false },
			),
		})
		rows.push({
			id: "au.nr",
			group: "audio",
			label: "Noise reduction",
			help: "Softens hiss between words",
			keys: words("noise reduction hiss nr denoise"),
			more: true,
			widget: { kind: "select", options: NR },
			value: c.noiseReduction,
			text: optionText(NR, c.noiseReduction),
			def: { value: "off", text: "Off" },
			...optional("disabled", disabled),
			write: w(v => ({
				noiseReduction: NR.some(o => o.value === v)
					? (v as LiveAudioStatus["config"]["noiseReduction"])
					: "off",
			})),
		})
		rows.push({
			id: "au.hp",
			group: "audio",
			label: "Cut low rumble",
			help: "High-pass filter; 0 is off",
			keys: words("high pass highpass rumble hum filter"),
			more: true,
			widget: { kind: "stepper", min: 0, max: 5000, step: 50, unit: " Hz" },
			value: c.highPass,
			text: c.highPass ? `${c.highPass} Hz` : "Off",
			def: { value: 0, text: "Off" },
			...optional("disabled", disabled),
			write: w(v => ({ highPass: Number(v) })),
		})
		rows.push({
			id: "au.lp",
			group: "audio",
			label: "Cut high hiss",
			help: "Low-pass filter; 0 is off",
			keys: words("low pass lowpass hiss treble filter"),
			more: true,
			widget: { kind: "stepper", min: 0, max: 20000, step: 100, unit: " Hz" },
			value: c.lowPass,
			text: c.lowPass ? `${c.lowPass} Hz` : "Off",
			def: { value: 0, text: "Off" },
			...optional("disabled", disabled),
			write: w(v => ({ lowPass: Number(v) })),
		})
		rows.push({
			id: "au.format",
			group: "audio",
			label: "Stream format",
			help: "Sent to the browser and the app",
			keys: words("pcm sample rate format bits"),
			more: true,
			widget: { kind: "read" },
			value: c.audioFormat,
			text: `${formatRate(st.effectiveSampleRate).replace("MS/s", "MHz")} · ${c.audioFormat === "s16le" ? "16-bit" : "32-bit float"}`,
		})
	}
	rows.push({
		id: "au.volume",
		group: "audio",
		label: "Volume",
		help: "Also in Listen",
		keys: words("loudness volume level"),
		device: true,
		widget: {
			kind: "slider",
			min: 0,
			max: 1,
			step: 0.01,
			format: v => `${Math.round(v * 100)} %`,
		},
		value: s.volume,
		text: `${Math.round(s.volume * 100)} %`,
		write: v => {
			a.setVolume(Number(v))
			return Promise.resolve(OK)
		},
	})
	return rows
}

// ---- storage

const MB = 1024 * 1024
export function formatBytes(n: number): string {
	if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(1)} GB`
	if (n >= MB) return `${Math.round(n / MB)} MB`
	if (n >= 1024) return `${Math.round(n / 1024)} kB`
	return `${n} B`
}

function storageRows(s: SettingsSnapshot): SettingRow[] {
	const r = s.storage
	if (!r) return []
	const rows: SettingRow[] = []
	const act = r.areas.find(x => x.id === "activity")
	const ret = act?.retention
	if (ret) {
		const days = Math.round(ret.maxAgeMs / 86_400_000)
		const parts = [
			`${days} day${days === 1 ? "" : "s"}`,
			`${ret.maxRows.toLocaleString("en")} messages`,
			formatBytes(ret.maxDbBytes),
		]
		rows.push({
			id: "st.activity",
			group: "storage",
			label: "Keep Activity for",
			help: "The oldest messages go first when any limit is reached",
			keys: words("retention history messages expire days database"),
			widget: { kind: "read" },
			value: days,
			text: parts.join(" · "),
			lock: "Set in the YAML configuration (activity.retention)",
		})
	}
	return rows
}

// ---- display

const THEME_OPTS = opts([
	["dark", "Dark"],
	["light", "Light"],
])
const GROUND_OPTS = opts([
	["ink", "Ink"],
	["graphite", "Graphite"],
	["black", "True black"],
])
const ACCENT_OPTS = opts([
	["phosphor", "Phosphor"],
	["ice", "Ice"],
	["violet", "Violet"],
	["coral", "Coral"],
	["mono", "Mono"],
])
// the canvas's three named places; any other anchor is one you dragged the card to
const CARD_OPTS = opts([
	["al", "Above Listen"],
	["br", "Bottom right"],
	["tr", "Top right"],
])
const CARD_OTHER = "Where you left it"
const DENSITY_OPTS = opts([
	["comfy", "Comfortable"],
	["compact", "Compact"],
])
const MOTION_OPTS = opts([
	["system", "Follow system"],
	["reduce", "Reduce"],
])

const UNITS_OPTS = opts([
	["metric", "Metric"],
	["nautical", "Nautical"],
	["imperial", "Imperial"],
])
const TIME_OPTS = opts([
	["local-24h", "24 h"],
	["local-12h", "12 h"],
	["utc", "UTC"],
])
const RANGE_OPTS = opts([
	["auto", "Auto"],
	["fixed", "Fixed"],
])
const SIGNAL_LABEL_OPTS = opts([
	["named", "Named"],
	["clear", "Clear"],
	["all", "All"],
])
const SIGNAL_LABEL_HELP: Readonly<Record<SignalLabelsMode, string>> = {
	named: "Only the tuned signal and named channels",
	clear: "Named signals, and unknown ones that stand clear of the noise",
	all: "Every signal WaveKit finds, even faint ones",
}
const DISCOVERY_TAG_OPTS = opts([
	["all", "All"],
	["decoded", "Decoded only"],
	["off", "Off"],
])
const DISCOVERY_TAG_HELP: Readonly<Record<DiscoveryTagMode, string>> = {
	all: "What the scanner found, under the saved-frequency tags",
	decoded: "Only what the scanner decoded",
	off: "The spectrum shows no discoveries",
}
const AVERAGING_OPTS = opts([
	["off", "Off"],
	["low", "Low"],
	["high", "High"],
])
/** No core sends more bins than this yet (WG8 SPECTRUM_BINS_CAP_CEILING). */
const FFT_CEILING = SPECTRUM_BINS_CAP_CEILING

/** Why an FFT size above what this core serves cannot be picked; undefined when it can. */
export function fftSizeBlocked(
	size: number,
	limits: Pick<SpectrumLimitsState, "binsMax" | "binsCap">,
): string | undefined {
	const max = limits.binsMax
	if (max !== null && size <= max) return undefined
	if (size > FFT_CEILING)
		return `No WaveKit sends more than ${FFT_CEILING} bins yet`
	if (max === null) return "This WaveKit did not report its spectrum limits"
	const cap = limits.binsCap
	if (cap && size > cap.cap)
		return cap.source === "measured"
			? `This host measured its limit at ${cap.cap} bins`
			: `This host is capped at ${cap.cap} bins`
	return `Raise scanner.ws.spectrumSummaryBins to ${size} to use it`
}

const WATERFALL_OPTS = opts([
	["match", "Match accent"],
	["amber", "Amber"],
	["mono", "Mono"],
	["classic", "Classic"],
])

/** Units and Time: core's preferences when it has them (every device), else this browser's. */
function unitTimeRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const p = s.preferences
	const v = p ?? s.display
	const def = p ? (s.preferenceDefaults ?? DEFAULT_DISPLAY) : DEFAULT_DISPLAY
	const lock =
		p && s.readOnly
			? { disabled: "Read-only access: sign in on this WaveKit to change it" }
			: {}
	return [
		{
			id: "dp.units",
			group: "display",
			label: "Units",
			help: "Nautical: knots, nautical miles, feet for altitude",
			keys: words("km miles knots feet metres meters speed distance altitude"),
			...(p ? {} : { device: true }),
			widget: { kind: "seg", options: UNITS_OPTS },
			value: v.units,
			text: optionText(UNITS_OPTS, v.units),
			def: { value: def.units, text: optionText(UNITS_OPTS, def.units) },
			...lock,
			write: x =>
				p
					? a.preference("units", x as Units)
					: local(() => a.setDisplay({ units: x as Units })),
		},
		{
			id: "dp.time",
			group: "display",
			label: "Time",
			keys: words("clock timezone zulu utc gmt 12 hour 24 hour am pm"),
			...(p ? {} : { device: true }),
			widget: { kind: "seg", options: TIME_OPTS },
			value: v.timeFormat,
			text: optionText(TIME_OPTS, v.timeFormat),
			def: {
				value: def.timeFormat,
				text: optionText(TIME_OPTS, def.timeFormat),
			},
			...lock,
			write: x =>
				p
					? a.preference("timeFormat", x as TimeFormat)
					: local(() => a.setDisplay({ timeFormat: x as TimeFormat })),
		},
	]
}

function displayRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const rows: SettingRow[] = []
	const p = s.preferences
	if (p) rows.push(...unitTimeRows(s, a))
	if (p) {
		rows.push({
			id: "dp.tags",
			group: "display",
			label: "Tags for saved frequencies",
			help: "Their names on the spectrum",
			keys: words("saved frequency labels names tags spectrum"),
			widget: { kind: "switch" },
			value: p.showSavedFrequencyLabels,
			text: p.showSavedFrequencyLabels ? "On" : "Off",
			def: {
				value: s.preferenceDefaults?.showSavedFrequencyLabels ?? true,
				text:
					(s.preferenceDefaults?.showSavedFrequencyLabels ?? true)
						? "On"
						: "Off",
			},
			...(s.readOnly
				? { disabled: "Read-only access: sign in on this WaveKit to change it" }
				: {}),
			write: v => a.preference("showSavedFrequencyLabels", v === true),
		})
	}
	rows.push({
		id: "dp.keys",
		group: "display",
		label: "Keyboard shortcuts",
		keys: words("keymap hotkeys keys shortcuts"),
		widget: { kind: "link", text: "Show all", action: a.openShortcuts },
		value: null,
		text: "Show all",
	})
	if (!p) rows.push(...unitTimeRows(s, a))
	const t = s.theme
	rows.push(
		{
			id: "dev.theme",
			group: "display",
			label: "Theme",
			keys: words(
				"appearance dark mode light mode night day colour scheme color",
			),
			device: true,
			widget: { kind: "seg", options: THEME_OPTS },
			value: t.theme,
			text: optionText(THEME_OPTS, t.theme),
			def: { value: "dark", text: "Dark" },
			write: v => local(() => a.setTheme({ theme: v as ThemePrefs["theme"] })),
		},
		{
			id: "dev.ground",
			group: "display",
			label: "Dark ground",
			help: "Used when the theme is dark",
			keys: words(
				"theme dark background ink graphite grey gray black true black oled amoled night",
			),
			device: true,
			widget: { kind: "seg", options: GROUND_OPTS },
			value: t.ground,
			text: optionText(GROUND_OPTS, t.ground),
			def: { value: "black", text: "True black" },
			write: v =>
				local(() => a.setTheme({ ground: v as ThemePrefs["ground"] })),
		},
		{
			id: "dev.accent",
			group: "display",
			label: "Accent",
			help: "Selection and the tuned signal",
			keys: words(
				"colour color highlight tint theme phosphor ice violet coral mono",
			),
			device: true,
			widget: { kind: "seg", options: ACCENT_OPTS },
			value: t.accent,
			text: optionText(ACCENT_OPTS, t.accent),
			def: { value: "mono", text: "Mono" },
			write: v =>
				local(() => a.setTheme({ accent: v as ThemePrefs["accent"] })),
		},
		{
			id: "dev.waterfall",
			group: "display",
			label: "Waterfall colours",
			help: "Match accent builds the waterfall from the ground and the accent",
			keys: words(
				"palette colors colours heat spectrum theme ramp classic amber mono sdr++",
			),
			device: true,
			widget: { kind: "ramp", options: WATERFALL_OPTS },
			value: t.waterfall,
			text: optionText(WATERFALL_OPTS, t.waterfall),
			def: { value: "match", text: "Match accent" },
			write: v =>
				local(() => a.setTheme({ waterfall: v as ThemePrefs["waterfall"] })),
		},
	)
	const d = s.device
	const fixed = d.spectrumRange === "fixed" ? d.fixedLevels : null
	rows.push(
		{
			id: "dp.range",
			group: "display",
			label: "Spectrum range",
			help: fixed
				? `Holds ${formatDb(fixed.minDb, 0)} to ${formatDb(fixed.maxDb, 0)} dBFS, where Auto stood when you picked Fixed`
				: "Auto follows the noise floor",
			keys: words("db scale min max range levels floor fixed auto spectrum"),
			device: true,
			widget: { kind: "seg", options: RANGE_OPTS },
			value: d.spectrumRange,
			text: optionText(RANGE_OPTS, d.spectrumRange),
			def: { value: "auto", text: "Auto" },
			write: v =>
				local(() => a.setDevice({ spectrumRange: v as SpectrumRange })),
		},
		{
			id: "dp.avg",
			group: "display",
			label: "Averaging",
			help: "Smooths the spectrum line",
			keys: words("averaging smoothing smooth average trace line spectrum"),
			device: true,
			widget: { kind: "seg", options: AVERAGING_OPTS },
			value: d.averaging,
			text: optionText(AVERAGING_OPTS, d.averaging),
			def: { value: "low", text: "Low" },
			write: v => local(() => a.setDevice({ averaging: v as Averaging })),
		},
		fftRow(d, s.spectrumLimits, a),
		{
			id: "dp.labels",
			group: "display",
			label: "Signal labels",
			help: SIGNAL_LABEL_HELP[d.signalLabels],
			keys: words("signal labels tags chips names spectrum noise clutter"),
			device: true,
			widget: { kind: "seg", options: SIGNAL_LABEL_OPTS },
			value: d.signalLabels,
			text: optionText(SIGNAL_LABEL_OPTS, d.signalLabels),
			def: { value: "clear", text: "Clear" },
			write: v =>
				local(() => a.setDevice({ signalLabels: v as SignalLabelsMode })),
		},
		{
			id: "dp.disc",
			group: "display",
			label: "Discoveries on the spectrum",
			help: DISCOVERY_TAG_HELP[d.discoveryTags],
			keys: words(
				"discoveries scanner found tags auto band map spectrum decoded clutter",
			),
			device: true,
			widget: { kind: "seg", options: DISCOVERY_TAG_OPTS },
			value: d.discoveryTags,
			text: optionText(DISCOVERY_TAG_OPTS, d.discoveryTags),
			def: { value: "all", text: "All" },
			write: v =>
				local(() => a.setDevice({ discoveryTags: v as DiscoveryTagMode })),
		},
	)
	rows.push({
		id: "dev.density",
		group: "display",
		label: "Density",
		help: "Compact fits more rows in lists and drawers",
		keys: words("density compact comfortable spacing rows dense tight"),
		device: true,
		widget: { kind: "seg", options: DENSITY_OPTS },
		value: d.density,
		text: optionText(DENSITY_OPTS, d.density),
		def: { value: "comfy", text: "Comfortable" },
		write: v => local(() => a.setDevice({ density: v as Density })),
	})
	const cardOpts = CARD_OPTS.some(o => o.value === s.cardAt)
		? CARD_OPTS
		: [...CARD_OPTS, { value: s.cardAt, label: CARD_OTHER }]
	rows.push({
		id: "dev.card",
		group: "display",
		label: "Tuned card position",
		help: "Or drag the card by its icon",
		keys: words("tuned card float move anchor above listen corner place"),
		device: true,
		widget: { kind: "select", options: cardOpts },
		value: s.cardAt,
		text: optionText(cardOpts, s.cardAt),
		def: { value: "al", text: "Above Listen" },
		write: v => local(() => a.setCardAt(v as CardAnchorId)),
	})
	rows.push({
		id: "dev.motion",
		group: "display",
		label: "Motion",
		help: "Reduce turns off slides and glides",
		keys: words("animation reduce motion transitions slides accessibility"),
		device: true,
		widget: { kind: "seg", options: MOTION_OPTS },
		value: d.motion,
		text: optionText(MOTION_OPTS, d.motion),
		def: { value: "system", text: "Follow system" },
		write: v => local(() => a.setDevice({ motion: v as Motion })),
	})
	const stepOpts: SettingOption[] = [
		{ value: "plan", label: "Band plan" },
		...STEPS.map(hz => ({ value: String(hz), label: formatStep(hz) })),
	]
	const step = s.stepHz === null ? "plan" : String(s.stepHz)
	rows.push({
		id: "tn.step",
		group: "display",
		label: "Tuning step",
		help: "The wheel and arrow keys tune by it. Band plan follows the band you are in.",
		keys: words("step channel spacing wheel arrows"),
		device: true,
		widget: { kind: "select", options: stepOpts },
		value: step,
		text: optionText(stepOpts, step),
		def: { value: "plan", text: "Band plan" },
		write: v => {
			a.setStep(v === "plan" ? null : Number(v))
			return Promise.resolve(OK)
		},
	})
	return rows
}

// ---- map (this browser: the core keeps no map settings yet)

const TILE_OPTS = opts([
	["online", "Online tiles"],
	["blank", "Blank"],
])
const TRAIL_OPTS = opts([
	["5", "5 min"],
	["15", "15 min"],
	["60", "1 hour"],
])
const LABEL_OPTS = opts([
	["few", "Few"],
	["normal", "Normal"],
	["many", "Many"],
])

function mapRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const d = s.device
	return [
		{
			id: "map.online",
			group: "map",
			label: "Beyond the offline map",
			help:
				d.mapTiles === "online"
					? "Online tiles come from OpenFreeMap, which then sees the area you look at"
					: "No tiles are fetched: aircraft, vessels and stations on a plain ground",
			keys: words("tiles openfreemap offline online blank basemap privacy"),
			device: true,
			widget: { kind: "seg", options: TILE_OPTS },
			value: d.mapTiles,
			text: optionText(TILE_OPTS, d.mapTiles),
			def: { value: "online", text: "Online tiles" },
			write: v => local(() => a.setDevice({ mapTiles: v as MapTiles })),
		},
		{
			id: "map.trails",
			group: "map",
			label: "Trail length",
			help: "Aircraft trails are a fifth of it: they cover more ground",
			keys: words("trail trails history track tail path length"),
			device: true,
			widget: { kind: "select", options: TRAIL_OPTS },
			value: String(d.mapTrail),
			text: optionText(TRAIL_OPTS, String(d.mapTrail)),
			def: { value: "15", text: "15 min" },
			write: v => {
				const min = MAP_TRAILS.find(m => String(m) === v)
				return local(() => {
					if (min !== undefined) a.setDevice({ mapTrail: min })
				})
			},
		},
		{
			id: "map.labels",
			group: "map",
			label: "Labels",
			help: "Many names aircraft and vessels sooner as you zoom in",
			keys: words("labels names callsigns text clutter"),
			device: true,
			widget: { kind: "seg", options: LABEL_OPTS },
			value: d.mapLabels,
			text: optionText(LABEL_OPTS, d.mapLabels),
			def: { value: "normal", text: "Normal" },
			write: v => local(() => a.setDevice({ mapLabels: v as MapLabels })),
		},
	]
}

// ---- system

function systemRows(s: SettingsSnapshot, a: SettingsActions): SettingRow[] {
	const rows: SettingRow[] = []
	if (s.version !== null)
		rows.push({
			id: "sys.version",
			group: "system",
			label: "Version",
			keys: words("version update upgrade release"),
			widget: { kind: "read" },
			value: s.version,
			text: `WaveKit ${s.version}`,
		})
	if (s.accessMode !== null)
		rows.push({
			id: "sys.access",
			group: "system",
			label: "Access",
			help:
				s.accessMode === "protected"
					? "Devices sign in to change things"
					: "Anyone on the network can listen and change things",
			keys: words("access sign in login security protected open devices"),
			widget: { kind: "read" },
			value: s.accessMode,
			text: s.accessMode === "protected" ? "Protected" : "Open",
			lock: "Set at deploy (access.mode)",
		})
	if (s.accessMode === "protected") {
		const keys = words(
			"devices signed in sign out log out logout paired browsers phones tablets revoke lost",
		)
		rows.push(
			s.readOnly
				? {
						id: "sys.devices",
						group: "system",
						label: "Signed-in devices",
						help: "Pair this browser to see them and sign them out",
						keys,
						widget: { kind: "read" },
						value: null,
						text: "Not paired",
					}
				: {
						id: "sys.devices",
						group: "system",
						label: "Signed-in devices",
						help: s.devices
							? devicesSummary(s.devices)
							: "Browsers and apps paired with this WaveKit",
						keys,
						widget: {
							kind: "link",
							text: s.devices ? devicesCount(s.devices.length) : "Show",
							action: a.openDevices,
						},
						value: s.devices?.length ?? null,
						text: s.devices ? devicesCount(s.devices.length) : "Show",
					},
		)
	}
	rows.push({
		id: "sys.config",
		group: "system",
		label: "Configuration",
		help: "The running configuration as one YAML file, secrets left out",
		keys: words("backup export yaml config download"),
		widget: {
			kind: "buttons",
			buttons: [
				{ label: "Export", action: () => undefined, href: s.exportUrl },
			],
		},
		value: null,
		text: "Export",
	})
	return rows
}

/** Every row the drawer shows, in group order (decoder page rows carry `page`). */
export function buildRows(
	s: SettingsSnapshot,
	a: SettingsActions,
): SettingRow[] {
	return [
		...stationRows(s, a),
		...receiverRows(s, a),
		...audioRows(s, a),
		...decoderRows(s, a),
		...storageRows(s),
		...mapRows(s, a),
		...displayRows(s, a),
		...systemRows(s, a),
	]
}
