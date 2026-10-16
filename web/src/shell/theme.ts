// Theme controller: data-wk-theme / data-wk-ground / data-wk-accent on <html>, persisted in localStorage.
// Pure apart from the storage and element passed in, so the persistence logic tests in node with fakes.

export const THEMES = ["dark", "light"] as const
export type ThemeName = (typeof THEMES)[number]

/** Dark grounds; light is always on the paper ground. */
export const GROUNDS = ["ink", "graphite", "black"] as const
export type Ground = (typeof GROUNDS)[number]

export const ACCENTS = ["phosphor", "ice", "violet", "coral", "mono"] as const
export type Accent = (typeof ACCENTS)[number]

export interface ThemePrefs {
	readonly theme: ThemeName
	readonly ground: Ground
	readonly accent: Accent
}

export const DEFAULT_THEME: ThemePrefs = {
	theme: "dark",
	ground: "black",
	accent: "mono",
}
export const THEME_STORAGE_KEY = "wavekit.web.theme"

/** The slice of the Web Storage API the controller uses. */
export interface KeyValueStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

/** The attribute target (an Element in the browser). */
export interface AttributeTarget {
	setAttribute(name: string, value: string): void
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
export function parseThemePrefs(raw: string | null): ThemePrefs {
	if (!raw) return DEFAULT_THEME
	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return DEFAULT_THEME
	}
	if (typeof data !== "object" || data === null) return DEFAULT_THEME
	const o = data as Record<string, unknown>
	return {
		theme: pick(THEMES, o["theme"], DEFAULT_THEME.theme),
		ground: pick(GROUNDS, o["ground"], DEFAULT_THEME.ground),
		accent: pick(ACCENTS, o["accent"], DEFAULT_THEME.accent),
	}
}

/** Reads prefs; a missing, blocked or throwing storage gives the default. */
export function loadThemePrefs(storage: KeyValueStorage | null): ThemePrefs {
	if (!storage) return DEFAULT_THEME
	try {
		return parseThemePrefs(storage.getItem(THEME_STORAGE_KEY))
	} catch {
		return DEFAULT_THEME
	}
}

/** Writes prefs; returns false when the storage is missing or throws (private mode, quota). */
export function saveThemePrefs(
	storage: KeyValueStorage | null,
	prefs: ThemePrefs,
): boolean {
	if (!storage) return false
	try {
		storage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs))
		return true
	} catch {
		return false
	}
}

/** The scope attributes for prefs. Light always renders on the paper ground; the dark ground is still remembered. */
export function themeAttributes(
	prefs: ThemePrefs,
): Readonly<
	Record<"data-wk-theme" | "data-wk-ground" | "data-wk-accent", string>
> {
	return {
		"data-wk-theme": prefs.theme,
		"data-wk-ground": prefs.theme === "light" ? "paper" : prefs.ground,
		"data-wk-accent": prefs.accent,
	}
}

export function applyTheme(target: AttributeTarget, prefs: ThemePrefs): void {
	for (const [k, v] of Object.entries(themeAttributes(prefs)))
		target.setAttribute(k, v)
}

export class ThemeStore {
	#prefs: ThemePrefs
	readonly #storage: KeyValueStorage | null
	readonly #target: AttributeTarget | null
	readonly #listeners = new Set<() => void>()

	constructor(storage: KeyValueStorage | null, target: AttributeTarget | null) {
		this.#storage = storage
		this.#target = target
		this.#prefs = loadThemePrefs(storage)
		if (target) applyTheme(target, this.#prefs)
	}

	readonly getState = (): ThemePrefs => this.#prefs

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	set(patch: Partial<ThemePrefs>): void {
		const next = { ...this.#prefs, ...patch }
		if (
			next.theme === this.#prefs.theme &&
			next.ground === this.#prefs.ground &&
			next.accent === this.#prefs.accent
		)
			return
		this.#prefs = next
		if (this.#target) applyTheme(this.#target, next)
		saveThemePrefs(this.#storage, next)
		for (const l of [...this.#listeners]) l()
	}
}

/** window.localStorage, or null where reading it throws (blocked site data, sandboxed frames). */
export function browserStorage(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage
	} catch {
		return null
	}
}

/** The app's theme store; applying on creation sets <html> before the first render. */
export const themeStore = new ThemeStore(
	browserStorage(),
	typeof document === "undefined" ? null : document.documentElement,
)
