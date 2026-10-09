import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { createStore, type Store } from "../data/store.js"
import { renderAt } from "../test/harness.js"
import { useStore } from "./use-store.js"

const selectN = (s: { n: number; other: number }) => s.n

let renders = 0
function Show({ store }: { store: Store<{ n: number; other: number }> }) {
	const n = useStore(store, selectN)
	renders++
	return <Text>n={n}</Text>
}

describe("useStore", () => {
	it("re-renders on store commits", async () => {
		const store = createStore({ n: 1, other: 0 })
		const h = await renderAt(<Show store={store} />, { cols: 40, rows: 10 })
		expect(h.text()).toBe("n=1")
		store.set({ n: 2, other: 0 })
		await h.waitFor(f => f[0] === "n=2")
		h.unmount()
	})
	it("bails out when the selected slice did not change", async () => {
		const store = createStore({ n: 1, other: 0 })
		const h = await renderAt(<Show store={store} />, { cols: 40, rows: 10 })
		const before = renders
		store.set({ n: 1, other: 1 })
		store.set({ n: 1, other: 2 })
		await new Promise(r => setTimeout(r, 30))
		expect(renders).toBe(before)
		store.set({ n: 3, other: 2 })
		await h.waitFor(f => f[0] === "n=3")
		expect(renders).toBe(before + 1)
		h.unmount()
	})
})
