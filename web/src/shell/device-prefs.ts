// Display › On this device: density and motion, persisted in localStorage and applied as data-wk-density /
// data-wk-motion on <html>. Motion "system" resolves through prefers-reduced-motion, so CSS and code only ever
// test data-wk-motion="reduce". Pure apart from the storage, element and media query passed in (tests use fakes).

import {
	browserStorage,
	type AttributeTarget,
	type KeyValueStorage,
} from "./theme.ts"

export const DENSITIES = ["comfy", "compact"] as const
export type Density = (typeof DENSITIES)[number]

export const MOTIONS = ["system", "reduce"] as const
export type Motion = (typeof MOTIONS)[number]

export interface DevicePrefs {
	readonly density: Density
	readonly motion: Motion
}

export const DEFAULT_DEVICE: DevicePrefs = {
	density: "comfy",
	motion: "system",
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
	}
}

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
		if (
			next.density === this.#prefs.density &&
			next.motion === this.#prefs.motion
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
