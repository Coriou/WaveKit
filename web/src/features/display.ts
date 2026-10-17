// Units and time (Settings › Display, DESIGN.md "Settings"): core's operator preferences `units` and `timeFormat`,
// synced to every signed-in device. Without operator data (open mode, a legacy core) the choice is kept on this
// device instead. Formatters read the current choice; components that print them call useDisplay() so they render
// again when it changes.
import { useSyncExternalStore } from "react"

import { browserStorage, type KeyValueStorage } from "../shell/theme.ts"

export const UNITS = ["metric", "nautical", "imperial"] as const
export type Units = (typeof UNITS)[number]
export const TIME_FORMATS = ["local-24h", "local-12h", "utc"] as const
export type TimeFormat = (typeof TIME_FORMATS)[number]

export interface DisplayPrefs {
	readonly units: Units
	readonly timeFormat: TimeFormat
}

/** Core's defaults (src/operator-data/domain.ts PREFERENCE_DEFAULTS). */
export const DEFAULT_DISPLAY: DisplayPrefs = {
	units: "nautical",
	timeFormat: "local-24h",
}
export const DISPLAY_STORAGE_KEY = "wavekit.web.display"

const pick = <T extends string>(
	list: readonly T[],
	v: unknown,
	fallback: T,
): T =>
	typeof v === "string" && (list as readonly string[]).includes(v)
		? (v as T)
		: fallback

export function parseDisplayPrefs(raw: string | null): DisplayPrefs {
	if (!raw) return DEFAULT_DISPLAY
	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return DEFAULT_DISPLAY
	}
	if (typeof data !== "object" || data === null) return DEFAULT_DISPLAY
	const o = data as Record<string, unknown>
	return {
		units: pick(UNITS, o["units"], DEFAULT_DISPLAY.units),
		timeFormat: pick(TIME_FORMATS, o["timeFormat"], DEFAULT_DISPLAY.timeFormat),
	}
}

export class DisplayStore {
	#local: DisplayPrefs
	#core: DisplayPrefs | null = null
	#state: DisplayPrefs
	readonly #storage: KeyValueStorage | null
	readonly #listeners = new Set<() => void>()

	constructor(storage: KeyValueStorage | null) {
		this.#storage = storage
		let raw: string | null = null
		try {
			raw = storage?.getItem(DISPLAY_STORAGE_KEY) ?? null
		} catch {
			raw = null
		}
		this.#local = parseDisplayPrefs(raw)
		this.#state = this.#local
	}

	readonly getState = (): DisplayPrefs => this.#state

	/** This device's own choice (shown in Settings while core has no preferences). */
	readonly getLocal = (): DisplayPrefs => this.#local

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	/** True while core's preferences decide (operator data on this core). */
	get synced(): boolean {
		return this.#core !== null
	}

	/** Core's effective values, or null when this core has no operator data (the device's choice applies). */
	setCore(values: DisplayPrefs | null): void {
		this.#core = values
			? { units: values.units, timeFormat: values.timeFormat }
			: null
		this.#update()
	}

	/** This device's choice, used while core's preferences are not available. */
	setLocal(patch: Partial<DisplayPrefs>): void {
		const next = { ...this.#local, ...patch }
		if (
			next.units === this.#local.units &&
			next.timeFormat === this.#local.timeFormat
		)
			return
		this.#local = next
		try {
			this.#storage?.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(next))
		} catch {
			// private mode or quota: the choice holds for this page only
		}
		this.#update()
	}

	#update(): void {
		const next = this.#core ?? this.#local
		if (
			next.units === this.#state.units &&
			next.timeFormat === this.#state.timeFormat
		)
			return
		this.#state = next
		for (const l of [...this.#listeners]) l()
	}
}

export const displayStore = new DisplayStore(browserStorage())

/** The units and time format in force now. */
export const current = (): DisplayPrefs => displayStore.getState()

/** The current units and time format; the component renders again when they change. */
export function useDisplay(): DisplayPrefs {
	return useSyncExternalStore(
		displayStore.subscribe,
		displayStore.getState,
		displayStore.getState,
	)
}

// ---- time

type When = number | string | Date

function msOf(t: When): number {
	return t instanceof Date
		? t.getTime()
		: typeof t === "number"
			? t
			: Date.parse(t)
}

const pad = (n: number) => String(n).padStart(2, "0")

/** "14:05" (24 h), "2:05 pm" (12 h), "14:05Z" (UTC); with seconds "14:05:09". Empty for an invalid time. */
export function clockText(
	t: When,
	opts: { seconds?: boolean } = {},
	p: DisplayPrefs = current(),
): string {
	const ms = msOf(t)
	if (!Number.isFinite(ms)) return ""
	const d = new Date(ms)
	const utc = p.timeFormat === "utc"
	const h = utc ? d.getUTCHours() : d.getHours()
	const m = utc ? d.getUTCMinutes() : d.getMinutes()
	const s = utc ? d.getUTCSeconds() : d.getSeconds()
	const tail = opts.seconds === true ? `:${pad(s)}` : ""
	if (p.timeFormat === "local-12h")
		return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)}${tail} ${h < 12 ? "am" : "pm"}`
	return `${pad(h)}:${pad(m)}${tail}${utc ? "Z" : ""}`
}

/** The hour of day (0–23) on the clock the user reads: UTC hours in UTC. */
export function hourOf(t: When, p: DisplayPrefs = current()): number {
	const d = new Date(msOf(t))
	return p.timeFormat === "utc" ? d.getUTCHours() : d.getHours()
}

/** An hour mark for axes and tooltips: "14:00", "2 pm", "14:00Z". */
export function hourText(hour: number, p: DisplayPrefs = current()): string {
	const h = ((hour % 24) + 24) % 24
	if (p.timeFormat === "local-12h")
		return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`
	return `${pad(h)}:00${p.timeFormat === "utc" ? "Z" : ""}`
}

/** A date in en-GB words ("8 Oct"), on the UTC calendar in UTC. */
export function dateText(
	t: When,
	opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
	p: DisplayPrefs = current(),
): string {
	const ms = msOf(t)
	if (!Number.isFinite(ms)) return ""
	return new Date(ms).toLocaleDateString("en-GB", {
		...opts,
		...(p.timeFormat === "utc" ? { timeZone: "UTC" } : {}),
	})
}

/** Midnight that starts `t`'s day on the clock the user reads. */
export function startOfDay(t: When, p: DisplayPrefs = current()): number {
	const d = new Date(msOf(t))
	return p.timeFormat === "utc"
		? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
		: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function sameDay(
	a: When,
	b: When,
	p: DisplayPrefs = current(),
): boolean {
	return startOfDay(a, p) === startOfDay(b, p)
}

export function yearOf(t: When, p: DisplayPrefs = current()): number {
	const d = new Date(msOf(t))
	return p.timeFormat === "utc" ? d.getUTCFullYear() : d.getFullYear()
}

// ---- units

const KM_PER_NM = 1.852
const KM_PER_MI = 1.609344
const M_PER_FT = 0.3048

/** Digit groups with a thin space, as elsewhere ("36 000"). */
const grouped = (n: number) =>
	Math.round(n).toLocaleString("en-GB").replace(/,/g, " ")

const tenth = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

/** A speed given in knots: "12 kn", "22 km/h", "14 mph". `digits: 1` keeps one decimal (vessels). */
export function speedText(
	kn: number,
	opts: { digits?: 0 | 1 } = {},
	p: DisplayPrefs = current(),
): string {
	const [v, unit] =
		p.units === "metric"
			? [kn * KM_PER_NM, "km/h"]
			: p.units === "imperial"
				? [(kn * KM_PER_NM) / KM_PER_MI, "mph"]
				: [kn, "kn"]
	return `${opts.digits === 1 ? tenth(v) : String(Math.round(v))} ${unit}`
}

/** The unit speedText() uses, for labels. */
export function speedUnit(p: DisplayPrefs = current()): string {
	return p.units === "metric" ? "km/h" : p.units === "imperial" ? "mph" : "kn"
}

/** A distance given in km: "12.4 km" (metres under 1 km), "6.7 nm", "7.7 mi"; one decimal under 10. */
export function distanceText(km: number, p: DisplayPrefs = current()): string {
	if (p.units === "metric" && km < 1) return `${Math.round(km * 1000)} m`
	const [v, unit] =
		p.units === "metric"
			? [km, "km"]
			: p.units === "imperial"
				? [km / KM_PER_MI, "mi"]
				: [km / KM_PER_NM, "nm"]
	return `${v < 10 ? tenth(v) : String(Math.round(v))} ${unit}`
}

/** A distance unit's length in km. */
export function unitKm(p: DisplayPrefs = current()): number {
	return p.units === "metric"
		? 1
		: p.units === "imperial"
			? KM_PER_MI
			: KM_PER_NM
}

/** The unit distanceText() uses at 1 or more. */
export function distanceUnit(p: DisplayPrefs = current()): string {
	return p.units === "metric" ? "km" : p.units === "imperial" ? "mi" : "nm"
}

/** An altitude or height given in feet: "36 000 ft", or "10 970 m" in metric. */
export function altitudeText(ft: number, p: DisplayPrefs = current()): string {
	return p.units === "metric"
		? `${grouped(Math.round((ft * M_PER_FT) / 10) * 10)} m`
		: `${grouped(ft)} ft`
}

/** Aircraft altitude as the Map labels it: FL from 10 000 ft (in every unit, as aviation does), else rounded. */
export function flightLevelText(
	ft: number,
	p: DisplayPrefs = current(),
): string {
	if (ft >= 10_000) return `FL${String(Math.round(ft / 100)).padStart(3, "0")}`
	if (p.units === "metric")
		return `${grouped(Math.round((ft * M_PER_FT) / 50) * 50)} m`
	return `${grouped(Math.round(ft / 100) * 100)} ft`
}

/** A climb or descent rate given in ft/min: "1 200 ft/min", or "6.1 m/s" in metric. */
export function climbText(ftMin: number, p: DisplayPrefs = current()): string {
	return p.units === "metric"
		? `${tenth((ftMin * M_PER_FT) / 60)} m/s`
		: `${grouped(ftMin)} ft/min`
}

/** A temperature given in °C: "18.4 °C", or "65.1 °F" in imperial. */
export function temperatureText(
	c: number,
	p: DisplayPrefs = current(),
): string {
	return p.units === "imperial"
		? `${tenth((c * 9) / 5 + 32)} °F`
		: `${tenth(c)} °C`
}

type Kind = "speed" | "distance" | "altitude" | "temperature"

/** Units decoders send, in their kind and as a factor to the base (knots, km, feet; °C is special-cased). */
const MEASURES: Readonly<Record<string, readonly [Kind, number]>> = {
	kn: ["speed", 1],
	"km/h": ["speed", 1 / KM_PER_NM],
	mph: ["speed", KM_PER_MI / KM_PER_NM],
	km: ["distance", 1],
	nm: ["distance", KM_PER_NM],
	mi: ["distance", KM_PER_MI],
	ft: ["altitude", 1],
	"°C": ["temperature", 1],
	"°F": ["temperature", 1],
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * A decoded measurement in the chosen units ("452 kn" → 837 km/h in metric). Null when the unit is not one the
 * setting changes (metres stay metres: a decoder's "m" can be a height or a distance), or already matches.
 */
export function convertMeasure(
	value: number,
	unit: string,
	p: DisplayPrefs = current(),
): { value: number; unit: string } | null {
	const m = MEASURES[unit]
	if (!m || !Number.isFinite(value)) return null
	const [kind, factor] = m
	let out: { value: number; unit: string }
	switch (kind) {
		case "speed": {
			const kn = value * factor
			const to = speedUnit(p)
			out = {
				unit: to,
				value:
					to === "kn"
						? kn
						: to === "km/h"
							? kn * KM_PER_NM
							: (kn * KM_PER_NM) / KM_PER_MI,
			}
			break
		}
		case "distance": {
			const km = value * factor
			out = { unit: distanceUnit(p), value: km / unitKm(p) }
			break
		}
		case "altitude":
			out =
				p.units === "metric"
					? { unit: "m", value: value * M_PER_FT }
					: { unit: "ft", value }
			break
		case "temperature": {
			const c = unit === "°F" ? ((value - 32) * 5) / 9 : value
			out =
				p.units === "imperial"
					? { unit: "°F", value: (c * 9) / 5 + 32 }
					: { unit: "°C", value: c }
			break
		}
	}
	if (out.unit === unit) return null
	return {
		unit: out.unit,
		value: kind === "altitude" ? Math.round(out.value) : round1(out.value),
	}
}
