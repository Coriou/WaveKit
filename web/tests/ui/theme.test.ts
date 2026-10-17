import { describe, expect, it } from "vitest"

import {
	DEFAULT_THEME,
	loadThemePrefs,
	parseThemePrefs,
	saveThemePrefs,
	THEME_STORAGE_KEY,
	themeAttributes,
	ThemeStore,
	type KeyValueStorage,
} from "../../src/shell/theme.ts"

class FakeStorage implements KeyValueStorage {
	readonly data = new Map<string, string>()
	getItem(k: string): string | null {
		return this.data.get(k) ?? null
	}
	setItem(k: string, v: string): void {
		this.data.set(k, v)
	}
}

const throwing: KeyValueStorage = {
	getItem() {
		throw new Error("SecurityError")
	},
	setItem() {
		throw new Error("QuotaExceededError")
	},
}

class FakeElement {
	readonly attrs: Record<string, string> = {}
	setAttribute(k: string, v: string): void {
		this.attrs[k] = v
	}
}

describe("theme prefs", () => {
	it("defaults to dark, black, mono", () => {
		expect(DEFAULT_THEME).toEqual({
			theme: "dark",
			ground: "black",
			accent: "mono",
			waterfall: "match",
		})
		expect(loadThemePrefs(null)).toEqual(DEFAULT_THEME)
		expect(loadThemePrefs(new FakeStorage())).toEqual(DEFAULT_THEME)
	})

	it("falls back field by field on unknown or broken values", () => {
		expect(parseThemePrefs("{not json")).toEqual(DEFAULT_THEME)
		expect(parseThemePrefs("null")).toEqual(DEFAULT_THEME)
		expect(
			parseThemePrefs(
				JSON.stringify({ theme: "light", ground: "neon", accent: 3 }),
			),
		).toEqual({
			theme: "light",
			ground: "black",
			accent: "mono",
			waterfall: "match",
		})
	})

	it("survives a storage that throws", () => {
		expect(loadThemePrefs(throwing)).toEqual(DEFAULT_THEME)
		expect(saveThemePrefs(throwing, DEFAULT_THEME)).toBe(false)
		expect(() =>
			new ThemeStore(throwing, null).set({ accent: "ice" }),
		).not.toThrow()
	})

	it("round-trips through storage", () => {
		const st = new FakeStorage()
		expect(
			saveThemePrefs(st, {
				theme: "dark",
				ground: "graphite",
				accent: "violet",
				waterfall: "classic",
			}),
		).toBe(true)
		expect(st.data.has(THEME_STORAGE_KEY)).toBe(true)
		expect(loadThemePrefs(st)).toEqual({
			theme: "dark",
			ground: "graphite",
			accent: "violet",
			waterfall: "classic",
		})
	})

	it("light renders on paper but remembers the dark ground", () => {
		expect(
			themeAttributes({
				theme: "light",
				ground: "ink",
				accent: "coral",
				waterfall: "amber",
			}),
		).toEqual({
			"data-wk-theme": "light",
			"data-wk-ground": "paper",
			"data-wk-accent": "coral",
			"data-wk-waterfall": "amber",
		})
	})
})

describe("ThemeStore", () => {
	it("applies stored prefs on creation, then applies and persists each change", () => {
		const st = new FakeStorage()
		st.setItem(
			THEME_STORAGE_KEY,
			JSON.stringify({ theme: "dark", ground: "ink", accent: "phosphor" }),
		)
		const el = new FakeElement()
		const store = new ThemeStore(st, el)
		expect(el.attrs).toEqual({
			"data-wk-theme": "dark",
			"data-wk-ground": "ink",
			"data-wk-accent": "phosphor",
			"data-wk-waterfall": "match",
		})

		let calls = 0
		store.subscribe(() => calls++)
		store.set({ theme: "light" })
		expect(el.attrs["data-wk-ground"]).toBe("paper")
		expect(calls).toBe(1)
		expect(loadThemePrefs(st)).toEqual({
			theme: "light",
			ground: "ink",
			accent: "phosphor",
			waterfall: "match",
		})

		store.set({ theme: "light" })
		expect(calls).toBe(1)

		store.set({ theme: "dark" })
		expect(el.attrs["data-wk-ground"]).toBe("ink")
	})
})
