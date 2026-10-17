// Display › On this device: density, motion, the spectrum's range, averaging, FFT size, signal labels and discovery tags, and the Map's tiles,
// trail length and labels (Settings › Map), persisted in localStorage and applied as data-wk-density /
// data-wk-motion on <html>. Motion "system" resolves through prefers-reduced-motion, so CSS and code only ever
// test data-wk-motion="reduce". Pure apart from the storage, element and media query passed in (tests use fakes).

import { SIGNAL_LABELS, type SignalLabelsMode } from "../plot/label-gate.ts"
import {
	browserStorage,
	type AttributeTarget,
	type KeyValueStorage,
} from "./theme.ts"

export const DENSITIES = ["comfy", "compact"] as const
export type Density = (typeof DENSITIES)[number]

export const MOTIONS = ["system", "reduce"] as const
export type Motion = (typeof MOTIONS)[number]

export const SPECTRUM_RANGES = ["auto", "fixed"] as const
export type SpectrumRange = (typeof SPECTRUM_RANGES)[number]

export const AVERAGINGS = ["off", "low", "high"] as const
export type Averaging = (typeof AVERAGINGS)[number]

/** The trace's exponential average per Averaging step (weight of the newest row; 1 draws it raw). */
export const AVERAGING_ALPHA: Readonly<Record<Averaging, number>> = {
	off: 1,
	low: 0.35,
	high: 0.12,
}

/** FFT size choices (Settings › FFT size): the bins asked of the core, up to its `limits.bins.max`. */
export const FFT_SIZES = [2048, 4096, 8192, 16384] as const
export type FftSize = (typeof FFT_SIZES)[number]
/** What a core without spectrum limits serves (no WG8 bins cap): the floor of every cap. */
export const FFT_FALLBACK_MAX = 2048

/** The bins the plot asks for: the chosen size, within what this core serves (`binsMax`, null: unknown). */
export function fftBins(size: FftSize, binsMax: number | null): number {
	return Math.max(128, Math.min(size, binsMax ?? FFT_FALLBACK_MAX))
}

/** Display › Discoveries on the spectrum (DESIGN.md "Auto band map = discoveries"): every one, decoded ones, or none. */
export const DISCOVERY_TAG_MODES = ["all", "decoded", "off"] as const
export type DiscoveryTagMode = (typeof DISCOVERY_TAG_MODES)[number]

/**
 * Display › Click to tune (SDR++'s Normal / Center tuning, SDR#'s Free / Center): the click moves the listening
 * channel and the display stays, or every tune recentres the receiver on it.
 */
export const CLICK_TUNINGS = ["free", "centre"] as const
export type ClickTuning = (typeof CLICK_TUNINGS)[number]

/** Map › Beyond the offline map: OpenFreeMap's tiles, or a blank ground that asks nothing of anyone. */
export const MAP_TILES = ["online", "blank"] as const
export type MapTiles = (typeof MAP_TILES)[number]

/** Map › Trail length in minutes (the board's choices). */
export const MAP_TRAILS = [5, 15, 60] as const
export type MapTrail = (typeof MAP_TRAILS)[number]

/** Map › Labels: how soon, zooming in, items get their names. */
export const MAP_LABELS = ["few", "normal", "many"] as const
export type MapLabels = (typeof MAP_LABELS)[number]

/** A spectrum scale in dBFS, bottom and top. */
export interface FixedLevels {
	readonly minDb: number
	readonly maxDb: number
}

export interface DevicePrefs {
	readonly density: Density
	readonly motion: Motion
	/** Auto follows the noise floor; Fixed holds `fixedLevels`. */
	readonly spectrumRange: SpectrumRange
	/** The scale Fixed holds: where Auto stood when Fixed was picked. */
	readonly fixedLevels: FixedLevels | null
	readonly averaging: Averaging
	/** Bins asked of the core; the core serves at most its limit (fftBins). */
	readonly fftSize: FftSize
	/** Which spectrum signals get a chip (plot/label-gate.ts). */
	readonly signalLabels: SignalLabelsMode
	/** Which scanner discoveries tag the spectrum (plot/discovery-tags.ts). */
	readonly discoveryTags: DiscoveryTagMode
	/** What a click on the spectrum moves (plot/plot-store.ts tuneTo). */
	readonly clickTuning: ClickTuning
	readonly mapTiles: MapTiles
	readonly mapTrail: MapTrail
	readonly mapLabels: MapLabels
}

export const DEFAULT_DEVICE: DevicePrefs = {
	density: "comfy",
	motion: "system",
	spectrumRange: "auto",
	fixedLevels: null,
	averaging: "low",
	fftSize: 8192,
	signalLabels: "clear",
	discoveryTags: "all",
	clickTuning: "free",
	mapTiles: "online",
	mapTrail: 15,
	mapLabels: "normal",
}
export const DEVICE_STORAGE_KEY = "wavekit.web.device"

/** The slice of MediaQueryList the store listens to. */
export interface MotionQuery {
	readonly matches: boolean
	addEventListener(type: "change", listener: () => void): void
}

const pick = <T extends string>(
	list: readonly T[],
	v: unknown,
	fallback: T,
): T =>
	typeof v === "string" && (list as readonly string[]).includes(v)
		? (v as T)
		: fallback

/** A stored scale: two finite dBFS values, the bottom at least 10 dB under the top, within −200 … 30. */
function parseLevels(v: unknown): FixedLevels | null {
	if (typeof v !== "object" || v === null) return null
	const o = v as Record<string, unknown>
	const lo = o["minDb"]
	const hi = o["maxDb"]
	if (typeof lo !== "number" || typeof hi !== "number") return null
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
	if (lo < -200 || hi > 30 || hi - lo < 10) return null
	return { minDb: lo, maxDb: hi }
}

/** Parses stored prefs; anything missing or unknown falls back to the default, field by field. */
export function parseDevicePrefs(raw: string | null): DevicePrefs {
	if (!raw) return DEFAULT_DEVICE
	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return DEFAULT_DEVICE
	}
	if (typeof data !== "object" || data === null) return DEFAULT_DEVICE
	const o = data as Record<string, unknown>
	return {
		density: pick(DENSITIES, o["density"], DEFAULT_DEVICE.density),
		motion: pick(MOTIONS, o["motion"], DEFAULT_DEVICE.motion),
		spectrumRange: pick(
			SPECTRUM_RANGES,
			o["spectrumRange"],
			DEFAULT_DEVICE.spectrumRange,
		),
		fixedLevels: parseLevels(o["fixedLevels"]),
		averaging: pick(AVERAGINGS, o["averaging"], DEFAULT_DEVICE.averaging),
		fftSize: (FFT_SIZES as readonly unknown[]).includes(o["fftSize"])
			? (o["fftSize"] as FftSize)
			: DEFAULT_DEVICE.fftSize,
		signalLabels: pick(
			SIGNAL_LABELS,
			o["signalLabels"],
			DEFAULT_DEVICE.signalLabels,
		),
		discoveryTags: pick(
			DISCOVERY_TAG_MODES,
			o["discoveryTags"],
			DEFAULT_DEVICE.discoveryTags,
		),
		clickTuning: pick(
			CLICK_TUNINGS,
			o["clickTuning"],
			DEFAULT_DEVICE.clickTuning,
		),
		mapTiles: pick(MAP_TILES, o["mapTiles"], DEFAULT_DEVICE.mapTiles),
		mapTrail: (MAP_TRAILS as readonly unknown[]).includes(o["mapTrail"])
			? (o["mapTrail"] as MapTrail)
			: DEFAULT_DEVICE.mapTrail,
		mapLabels: pick(MAP_LABELS, o["mapLabels"], DEFAULT_DEVICE.mapLabels),
	}
}

/** The scale the spectrum draws: Fixed's when it has one, else what Auto found (`auto`). */
export function spectrumLevels(
	prefs: DevicePrefs,
	auto: FixedLevels,
): FixedLevels {
	return prefs.spectrumRange === "fixed" && prefs.fixedLevels
		? prefs.fixedLevels
		: auto
}

const sameLevels = (a: FixedLevels | null, b: FixedLevels | null): boolean =>
	a === b ||
	(a !== null && b !== null && a.minDb === b.minDb && a.maxDb === b.maxDb)

/** The scope attributes: motion is resolved, so "system" on a reduced-motion device reads "reduce". */
export function deviceAttributes(
	prefs: DevicePrefs,
	systemReduces: boolean,
): Readonly<Record<"data-wk-density" | "data-wk-motion", string>> {
	return {
		"data-wk-density": prefs.density,
		"data-wk-motion":
			prefs.motion === "reduce" || systemReduces ? "reduce" : "full",
	}
}

export class DevicePrefsStore {
	#prefs: DevicePrefs
	readonly #storage: KeyValueStorage | null
	readonly #target: AttributeTarget | null
	readonly #query: MotionQuery | null
	readonly #listeners = new Set<() => void>()

	constructor(
		storage: KeyValueStorage | null,
		target: AttributeTarget | null,
		query: MotionQuery | null,
	) {
		this.#storage = storage
		this.#target = target
		this.#query = query
		let raw: string | null = null
		try {
			raw = storage?.getItem(DEVICE_STORAGE_KEY) ?? null
		} catch {
			raw = null
		}
		this.#prefs = parseDevicePrefs(raw)
		this.#apply()
		query?.addEventListener("change", () => {
			this.#apply()
			this.#emit()
		})
	}

	readonly getState = (): DevicePrefs => this.#prefs

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	/** True when motion is reduced, by the setting or by the system. */
	reducesMotion(): boolean {
		return this.#prefs.motion === "reduce" || this.#query?.matches === true
	}

	set(patch: Partial<DevicePrefs>): void {
		const next = { ...this.#prefs, ...patch }
		const prev = this.#prefs
		if (
			next.density === prev.density &&
			next.motion === prev.motion &&
			next.spectrumRange === prev.spectrumRange &&
			sameLevels(next.fixedLevels, prev.fixedLevels) &&
			next.averaging === prev.averaging &&
			next.fftSize === prev.fftSize &&
			next.signalLabels === prev.signalLabels &&
			next.discoveryTags === prev.discoveryTags &&
			next.clickTuning === prev.clickTuning &&
			next.mapTiles === prev.mapTiles &&
			next.mapTrail === prev.mapTrail &&
			next.mapLabels === prev.mapLabels
		)
			return
		this.#prefs = next
		this.#apply()
		try {
			this.#storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(next))
		} catch {
			// private mode or quota: the choice holds for this page only
		}
		this.#emit()
	}

	#apply(): void {
		if (!this.#target) return
		for (const [k, v] of Object.entries(
			deviceAttributes(this.#prefs, this.#query?.matches === true),
		))
			this.#target.setAttribute(k, v)
	}

	#emit(): void {
		for (const l of [...this.#listeners]) l()
	}
}

function motionQuery(): MotionQuery | null {
	try {
		return typeof matchMedia === "function"
			? matchMedia("(prefers-reduced-motion: reduce)")
			: null
	} catch {
		return null
	}
}

/** The app's device store; applying on creation sets <html> before the first render. */
export const devicePrefsStore = new DevicePrefsStore(
	browserStorage(),
	typeof document === "undefined" ? null : document.documentElement,
	motionQuery(),
)
