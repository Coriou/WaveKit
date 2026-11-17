// followDeepLinks (src/shell/deep-link-sync.ts): a hash set from outside (a link, the address bar, a test) opens what
// it names, even when the app's state changes before the browser dispatches hashchange (a task later). Seen in a
// real browser on a loaded host: `location.hash = "#/scanner"`, then a store change rewrote the hash back to the
// open drawer's before hashchange ran, so the Scanner never opened.
import { afterEach, describe, expect, it } from "vitest"

import type { AppServices } from "../../src/app/services.ts"
import { followDeepLinks } from "../../src/shell/deep-link-sync.ts"
import { shellStore } from "../../src/shell/store.ts"

/** A window whose hash setter dispatches hashchange on a later task, as a browser does. */
function fakeWindow(initial: string) {
	const listeners = new Set<() => void>()
	let hash = initial
	const location = {
		pathname: "/",
		search: "",
		get hash() {
			return hash
		},
		set hash(next: string) {
			hash = next.startsWith("#") || next === "" ? next : `#${next}`
			setTimeout(() => {
				for (const l of listeners) l()
			}, 0)
		},
	}
	const history = {
		state: null,
		// replaceState never fires hashchange
		replaceState: (_s: unknown, _t: string, url: string) => {
			const i = url.indexOf("#")
			hash = i < 0 ? "" : url.slice(i)
		},
	}
	return {
		location,
		history,
		addEventListener: (type: string, l: () => void) => {
			if (type === "hashchange") listeners.add(l)
		},
		removeEventListener: (type: string, l: () => void) => {
			if (type === "hashchange") listeners.delete(l)
		},
	}
}

/** The services followDeepLinks reads: an Activity store that only notifies. */
function fakeServices() {
	const subs = new Set<() => void>()
	const activity = {
		get: () => ({
			tokens: [],
			chip: null,
			range: null,
			audio: false,
			openId: null,
		}),
		restore: () => undefined,
		subscribe: (l: () => void) => {
			subs.add(l)
			return () => subs.delete(l)
		},
	}
	return {
		services: { activity } as unknown as AppServices,
		notify: () => {
			for (const l of subs) l()
		},
	}
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const g = globalThis as { window?: unknown }

afterEach(async () => {
	shellStore.closeDrawer()
	await tick()
	delete g.window
})

describe("followDeepLinks", () => {
	it("opens a hash set from outside when the app's state changes before hashchange", async () => {
		const win = fakeWindow("#/recordings")
		g.window = win
		const { services, notify } = fakeServices()
		const stop = followDeepLinks(services)
		try {
			await tick()
			expect(shellStore.getState().drawer).toBe("recordings")
			win.location.hash = "#/scanner"
			// live data moves the app's state in the same task, before the browser dispatches hashchange
			notify()
			await tick()
			expect(shellStore.getState().drawer).toBe("scanner")
			expect(win.location.hash).toBe("#/scanner")
		} finally {
			stop()
		}
	})

	it("still writes the app's own changes to the hash", async () => {
		const win = fakeWindow("")
		g.window = win
		const { services } = fakeServices()
		const stop = followDeepLinks(services)
		try {
			await tick()
			shellStore.openDrawer("settings")
			await tick()
			expect(win.location.hash).toBe("#/settings")
			// and keeps writing after an outside change was applied
			win.location.hash = "#/scanner"
			await tick()
			shellStore.openDrawer("recordings")
			await tick()
			expect(win.location.hash).toBe("#/recordings")
		} finally {
			stop()
		}
	})
})
