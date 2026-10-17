import { describe, expect, it } from "vitest"

import {
	DEFAULT_DEVICE,
	DEVICE_STORAGE_KEY,
	deviceAttributes,
	DevicePrefsStore,
	fftBins,
	parseDevicePrefs,
	spectrumLevels,
	type MotionQuery,
} from "../../src/shell/device-prefs.ts"
import type { KeyValueStorage } from "../../src/shell/theme.ts"

class FakeStorage implements KeyValueStorage {
	readonly data = new Map<string, string>()
	getItem(k: string): string | null {
		return this.data.get(k) ?? null
	}
	setItem(k: string, v: string): void {
		this.data.set(k, v)
	}
}

class FakeElement {
	readonly attrs: Record<string, string> = {}
	setAttribute(k: string, v: string): void {
		this.attrs[k] = v
	}
}

class FakeQuery implements MotionQuery {
	matches = false
	#listener: (() => void) | null = null
	addEventListener(_: "change", l: () => void): void {
		this.#listener = l
	}
	flip(matches: boolean): void {
		this.matches = matches
		this.#listener?.()
	}
}

describe("device prefs", () => {
	it("defaults to comfortable and following the system, field by field", () => {
		expect(DEFAULT_DEVICE).toEqual({
			density: "comfy",
			motion: "system",
			spectrumRange: "auto",
			fixedLevels: null,
			averaging: "low",
			fftSize: 8192,
			signalLabels: "clear",
			clickTuning: "free",
			mapTiles: "online",
			mapTrail: 15,
			mapLabels: "normal",
		})
		expect(parseDevicePrefs(null)).toEqual(DEFAULT_DEVICE)
		expect(parseDevicePrefs("{bad")).toEqual(DEFAULT_DEVICE)
		expect(
			parseDevicePrefs(JSON.stringify({ density: "compact", motion: "fast" })),
		).toEqual({ ...DEFAULT_DEVICE, density: "compact" })
		expect(
			parseDevicePrefs(
				JSON.stringify({ mapTiles: "blank", mapTrail: 60, mapLabels: "many" }),
			),
		).toEqual({
			...DEFAULT_DEVICE,
			mapTiles: "blank",
			mapTrail: 60,
			mapLabels: "many",
		})
		expect(
			parseDevicePrefs(
				JSON.stringify({ mapTiles: "sat", mapTrail: 30, mapLabels: 2 }),
			),
		).toEqual(DEFAULT_DEVICE)
	})

	it("keeps an FFT size from the list and asks the core for no more than it serves", () => {
		const raw = (o: object) => parseDevicePrefs(JSON.stringify(o))
		expect(raw({ fftSize: 4096 }).fftSize).toBe(4096)
		for (const bad of [1000, "4096", 32768, null])
			expect(raw({ fftSize: bad }).fftSize).toBe(8192)
		expect(fftBins(8192, 2048)).toBe(2048)
		expect(fftBins(4096, 8192)).toBe(4096)
		expect(fftBins(16384, 8192)).toBe(8192)
		expect(fftBins(8192, 3000)).toBe(3000)
		// limits not known yet: what every core serves
		expect(fftBins(8192, null)).toBe(2048)
		const store = new DevicePrefsStore(new FakeStorage(), null, null)
		let changes = 0
		store.subscribe(() => changes++)
		store.set({ fftSize: 8192 })
		expect(changes).toBe(0)
		store.set({ fftSize: 4096 })
		expect(changes).toBe(1)
	})

	it("keeps the spectrum's range and averaging, dropping a scale that makes no sense", () => {
		const raw = (o: object) => parseDevicePrefs(JSON.stringify(o))
		expect(
			raw({
				spectrumRange: "fixed",
				fixedLevels: { minDb: -80, maxDb: 0 },
				averaging: "high",
			}),
		).toEqual({
			...DEFAULT_DEVICE,
			spectrumRange: "fixed",
			fixedLevels: { minDb: -80, maxDb: 0 },
			averaging: "high",
		})
		expect(raw({ averaging: "max" }).averaging).toBe("low")
		for (const bad of [
			{ minDb: -20, maxDb: -25 },
			{ minDb: -300, maxDb: 0 },
			{ minDb: "-80", maxDb: 0 },
			{ minDb: null, maxDb: 0 },
			[1, 2],
		])
			expect(raw({ fixedLevels: bad }).fixedLevels).toBeNull()
	})

	it("draws Fixed's scale when it has one, else Auto's", () => {
		const auto = { minDb: -75, maxDb: 0 }
		const held = { minDb: -110, maxDb: -10 }
		expect(spectrumLevels(DEFAULT_DEVICE, auto)).toBe(auto)
		expect(spectrumLevels({ ...DEFAULT_DEVICE, fixedLevels: held }, auto)).toBe(
			auto,
		)
		expect(
			spectrumLevels(
				{ ...DEFAULT_DEVICE, spectrumRange: "fixed", fixedLevels: held },
				auto,
			),
		).toBe(held)
		expect(
			spectrumLevels({ ...DEFAULT_DEVICE, spectrumRange: "fixed" }, auto),
		).toBe(auto)
	})

	it("resolves motion: Reduce always reduces, Follow system follows the query", () => {
		const comfy = {
			...DEFAULT_DEVICE,
			density: "comfy",
			motion: "system",
		} as const
		expect(deviceAttributes(comfy, false)["data-wk-motion"]).toBe("full")
		expect(deviceAttributes(comfy, true)["data-wk-motion"]).toBe("reduce")
		expect(
			deviceAttributes({ ...comfy, motion: "reduce" }, false)["data-wk-motion"],
		).toBe("reduce")
	})
})

describe("DevicePrefsStore", () => {
	it("applies on creation, persists changes and follows the system setting live", () => {
		const st = new FakeStorage()
		st.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ density: "compact" }))
		const el = new FakeElement()
		const q = new FakeQuery()
		const store = new DevicePrefsStore(st, el, q)
		expect(el.attrs).toEqual({
			"data-wk-density": "compact",
			"data-wk-motion": "full",
		})
		let calls = 0
		store.subscribe(() => calls++)

		q.flip(true)
		expect(el.attrs["data-wk-motion"]).toBe("reduce")
		expect(store.reducesMotion()).toBe(true)
		expect(calls).toBe(1)

		q.flip(false)
		store.set({ motion: "reduce" })
		expect(el.attrs["data-wk-motion"]).toBe("reduce")
		expect(parseDevicePrefs(st.getItem(DEVICE_STORAGE_KEY))).toEqual({
			...DEFAULT_DEVICE,
			density: "compact",
			motion: "reduce",
		})
		store.set({ motion: "reduce" })
		expect(calls).toBe(3)
		store.set({ spectrumRange: "fixed", fixedLevels: { minDb: -90, maxDb: 0 } })
		expect(calls).toBe(4)
		// an equal scale is no change
		store.set({ fixedLevels: { minDb: -90, maxDb: 0 } })
		expect(calls).toBe(4)
		store.set({ averaging: "off" })
		expect(calls).toBe(5)
		expect(parseDevicePrefs(st.getItem(DEVICE_STORAGE_KEY))).toMatchObject({
			spectrumRange: "fixed",
			fixedLevels: { minDb: -90, maxDb: 0 },
			averaging: "off",
		})
	})

	it("works without storage, element or media query", () => {
		const store = new DevicePrefsStore(null, null, null)
		expect(() => store.set({ density: "compact" })).not.toThrow()
		expect(store.getState().density).toBe("compact")
		expect(store.reducesMotion()).toBe(false)
	})
})
