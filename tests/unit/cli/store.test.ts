import { describe, expect, it, vi } from "vitest"
import { createStore } from "../../../cli/source/data/store.js"

describe("createStore", () => {
	it("notifies subscribers once per changed set and skips identical values", () => {
		const store = createStore({ n: 1 })
		const listener = vi.fn()
		const off = store.subscribe(listener)
		const next = { n: 2 }
		store.set(next)
		store.set(next)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.get()).toBe(next)
		expect(store.commits()).toBe(1)
		off()
		store.set({ n: 3 })
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
