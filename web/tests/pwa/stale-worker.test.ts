import { describe, expect, it } from "vitest"
import { KILL_SWITCH_WORKER } from "../../build/kill-switch.ts"
import { dropWorkers } from "../../src/pwa/stale.ts"
import { cacheName } from "../../src/pwa/sw-policy.ts"

interface Waiter {
	waitUntil(p: Promise<unknown>): void
}

/** Runs the kill-switch script in a fake worker scope and fires its lifecycle events. */
function runKillSwitch(cacheKeys: string[]) {
	const listeners = new Map<string, (e: Waiter) => void>()
	const log: string[] = []
	const keys = new Set(cacheKeys)
	const scope = {
		addEventListener: (type: string, fn: (e: Waiter) => void) =>
			listeners.set(type, fn),
		skipWaiting: () => {
			log.push("skipWaiting")
			return Promise.resolve()
		},
		registration: {
			unregister: () => {
				log.push("unregister")
				return Promise.resolve(true)
			},
		},
		clients: {
			matchAll: (options: { type: string }) => {
				log.push(`matchAll:${options.type}`)
				return Promise.resolve([
					{
						url: "http://127.0.0.1:5199/#/map",
						navigate: (url: string) => {
							log.push(`navigate:${url}`)
							return Promise.resolve(null)
						},
					},
				])
			},
		},
	}
	const caches = {
		keys: () => Promise.resolve([...keys]),
		delete: (key: string) => Promise.resolve(keys.delete(key)),
	}
	// the worker script is the unit under test: run it against the fake scope
	new Function("self", "caches", KILL_SWITCH_WORKER)(scope, caches)
	const fire = async (type: string) => {
		const pending: Promise<unknown>[] = []
		listeners.get(type)?.({ waitUntil: p => void pending.push(p) })
		await Promise.all(pending)
	}
	return { fire, log, keys }
}

describe("the dev server's /sw.js", () => {
	it("takes over at once, drops the shell caches, unregisters and reloads the pages it held", async () => {
		const worker = runKillSwitch([cacheName("abc"), cacheName("def"), "other"])
		await worker.fire("install")
		expect(worker.log).toEqual(["skipWaiting"])
		await worker.fire("activate")
		expect([...worker.keys]).toEqual(["other"])
		expect(worker.log).toEqual([
			"skipWaiting",
			"unregister",
			"matchAll:window",
			"navigate:http://127.0.0.1:5199/#/map",
		])
	})

	it("answers no fetch: every request goes to the network", () => {
		expect(KILL_SWITCH_WORKER).not.toContain('"fetch"')
	})
})

describe("dropWorkers (a page that keeps no worker)", () => {
	const registration = (scope: string, log: string[]) => ({
		scope,
		unregister: () => {
			log.push(scope)
			return Promise.resolve(true)
		},
	})

	it("unregisters the workers of its own scope and deletes the shell caches only", async () => {
		const log: string[] = []
		const keys = new Set([cacheName("abc"), "someone-else"])
		const dropped = await dropWorkers(
			"http://127.0.0.1:5199/",
			{
				getRegistrations: () =>
					Promise.resolve([
						registration("http://127.0.0.1:5199/", log),
						registration("http://127.0.0.1:5199/other-app/", log),
					]),
			},
			{
				keys: () => Promise.resolve([...keys]),
				delete: key => Promise.resolve(keys.delete(key)),
			},
		)
		expect(dropped).toBe(1)
		expect(log).toEqual(["http://127.0.0.1:5199/"])
		expect([...keys]).toEqual(["someone-else"])
	})

	it("never rejects: a browser that refuses is left alone", async () => {
		await expect(
			dropWorkers(
				"http://127.0.0.1:5199/",
				{ getRegistrations: () => Promise.reject(new Error("blocked")) },
				undefined,
			),
		).resolves.toBe(0)
	})
})
