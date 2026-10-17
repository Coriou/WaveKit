import { describe, expect, it } from "vitest"

import {
	DEFAULT_DEVICE,
	DEVICE_STORAGE_KEY,
	deviceAttributes,
	DevicePrefsStore,
	parseDevicePrefs,
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
		expect(DEFAULT_DEVICE).toEqual({ density: "comfy", motion: "system" })
		expect(parseDevicePrefs(null)).toEqual(DEFAULT_DEVICE)
		expect(parseDevicePrefs("{bad")).toEqual(DEFAULT_DEVICE)
		expect(
			parseDevicePrefs(JSON.stringify({ density: "compact", motion: "fast" })),
		).toEqual({ density: "compact", motion: "system" })
	})

	it("resolves motion: Reduce always reduces, Follow system follows the query", () => {
		const comfy = { density: "comfy", motion: "system" } as const
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
			density: "compact",
			motion: "reduce",
		})
		store.set({ motion: "reduce" })
		expect(calls).toBe(3)
	})

	it("works without storage, element or media query", () => {
		const store = new DevicePrefsStore(null, null, null)
		expect(() => store.set({ density: "compact" })).not.toThrow()
		expect(store.getState().density).toBe("compact")
		expect(store.reducesMotion()).toBe(false)
	})
})
