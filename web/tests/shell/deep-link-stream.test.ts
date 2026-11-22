// followDeepLinks (src/shell/deep-link-sync.ts) under a stream of store updates: a link that names an Activity filter
// (`#/activity?cat=voice`) must open that filter and keep it in the address bar, even when live data notifies the
// stores before, between and after the browser's events, and when the hashchange is late (a loaded host).
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AppServices } from "../../src/app/services.ts"
import { followDeepLinks } from "../../src/shell/deep-link-sync.ts"
import { shellStore } from "../../src/shell/store.ts"

interface ActivityState {
	tokens: never[]
	chip: string | null
	range: null
	audio: boolean
	openId: null
}

/** A window whose hash setter fires popstate and hashchange `delay` ms later, as a browser does (one task or more). */
function fakeWindow(initial: string, delay: number) {
	const listeners = {
		hashchange: new Set<() => void>(),
		popstate: new Set<() => void>(),
	}
	let hash = initial
	const fire = (type: "hashchange" | "popstate") => {
		for (const l of listeners[type]) l()
	}
	const location = {
		pathname: "/",
		search: "",
		get hash() {
			return hash
		},
		set hash(next: string) {
			hash = next.startsWith("#") || next === "" ? next : `#${next}`
			setTimeout(() => {
				fire("popstate")
				fire("hashchange")
			}, delay)
		},
	}
	const history = {
		state: null,
		replaceState: (_s: unknown, _t: string, url: string) => {
			const i = url.indexOf("#")
			hash = i < 0 ? "" : url.slice(i)
		},
	}
	return {
		location,
		history,
		addEventListener: (type: string, l: () => void) => {
			if (type === "hashchange" || type === "popstate") listeners[type].add(l)
		},
		removeEventListener: (type: string, l: () => void) => {
			if (type === "hashchange" || type === "popstate")
				listeners[type].delete(l)
		},
	}
}

/** An Activity store that keeps what restore() gives it and notifies on every change, like the real one. */
function activityStore() {
	const subs = new Set<() => void>()
	let state: ActivityState = {
		tokens: [],
		chip: null,
		range: null,
		audio: false,
		openId: null,
	}
	const notify = () => {
		for (const l of subs) l()
	}
	const activity = {
		get: () => state,
		restore: (next: Partial<ActivityState>) => {
			state = { ...state, ...next, tokens: [] }
			notify()
		},
		subscribe: (l: () => void) => {
			subs.add(l)
			return () => subs.delete(l)
		},
	}
	return {
		services: { activity } as unknown as AppServices,
		notify,
		chip: () => state.chip,
	}
}

const g = globalThis as { window?: unknown }

afterEach(() => {
	shellStore.closeDrawer()
	vi.useRealTimers()
	delete g.window
})

describe("followDeepLinks with streaming store updates", () => {
	for (const delay of [0, 1, 50, 2000]) {
		it(`opens #/activity?cat=voice set from script, hashchange ${delay} ms late, data streaming`, async () => {
			vi.useFakeTimers()
			const win = fakeWindow("#/activity", delay)
			g.window = win
			const store = activityStore()
			const stop = followDeepLinks(store.services)
			try {
				await vi.advanceTimersByTimeAsync(5)
				expect(shellStore.getState().drawer).toBe("activity")
				expect(store.chip()).toBeNull()
				// live data before the link, in the same task, and on every later task until well after the events
				store.notify()
				win.location.hash = "#/activity?cat=voice"
				store.notify()
				for (let t = 0; t < delay + 200; t += 1) {
					store.notify()
					shellStore.openDrawer("activity")
					await vi.advanceTimersByTimeAsync(1)
				}
				expect(store.chip()).toBe("voice")
				expect(win.location.hash).toBe("#/activity?cat=voice")
			} finally {
				stop()
			}
		})
	}

	it("a filter the app sets after the link is written, and a late event for the link does not undo it", async () => {
		vi.useFakeTimers()
		const win = fakeWindow("#/activity", 50)
		g.window = win
		const store = activityStore()
		const stop = followDeepLinks(store.services)
		try {
			await vi.advanceTimersByTimeAsync(5)
			win.location.hash = "#/activity?cat=voice"
			// live data finds the link pending: the adopt path opens it on the next task, long before the late events
			store.notify()
			await vi.advanceTimersByTimeAsync(5)
			expect(store.chip()).toBe("voice")
			// the reader picks another category before the browser's late events arrive
			store.services.activity.restore({ chip: "paging" } as never)
			await vi.advanceTimersByTimeAsync(5)
			expect(win.location.hash).toBe("#/activity?cat=paging")
			await vi.advanceTimersByTimeAsync(100)
			expect(store.chip()).toBe("paging")
			expect(win.location.hash).toBe("#/activity?cat=paging")
		} finally {
			stop()
		}
	})
})
