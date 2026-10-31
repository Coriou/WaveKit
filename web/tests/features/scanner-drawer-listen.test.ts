import { describe, expect, it } from "vitest"
import type { Discovery } from "@wavekit/api-types"

import type { AppServices } from "../../src/app/services.ts"
import { ApiError, Store } from "../../src/data/index.ts"
import {
	listenTo,
	tuneLanded,
} from "../../src/features/scanner/drawer/actions.ts"
import type { TuningState } from "../../src/features/tuning.ts"
import { appToast } from "../../src/shell/toast.ts"

const d = {
	id: "d1",
	frequencyHz: 161_150_000,
	measuredOffsetHz: 500,
} as Discovery

const outOfWindow = () =>
	new ApiError({
		status: 409,
		code: "OUT_OF_WINDOW",
		message: "outside",
		body: null,
		method: "POST",
		path: "/api/scanner/discoveries/d1/listen",
	})

/** Fake services: `listenDiscovery` answers from `answers` in turn; the tuner lands when `finish` is called. */
function setup(answers: (Error | null)[], wanted = false) {
	const calls: string[] = []
	const tuning = new Store<TuningState>({ targetHz: null, error: null })
	let finish: (error: string | null) => void = () => undefined
	const services = {
		data: {
			scanner: {
				listenDiscovery: (id: string) => {
					calls.push(`retarget ${id}`)
					const a = answers.shift() ?? null
					return a ? Promise.reject(a) : Promise.resolve({})
				},
			},
		},
		tuning: Object.assign(tuning, {
			tune: (hz: number) => {
				calls.push(`tune ${hz}`)
				tuning.set({ targetHz: hz, error: null })
				finish = error => {
					if (error) tuning.update(s => ({ ...s, error }))
					tuning.update(s => ({ ...s, targetHz: null }))
				}
				return Promise.resolve()
			},
		}),
		listen: {
			wanted,
			unlock: () => void calls.push("unlock"),
			get: () => ({ wanted: services.listen.wanted }),
			start: () => {
				calls.push("start")
				services.listen.wanted = true
				return Promise.resolve()
			},
		},
	}
	return {
		services: services as unknown as Pick<
			AppServices,
			"data" | "tuning" | "listen"
		>,
		calls,
		tuning,
		finish: (error: string | null = null) => finish(error),
	}
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe("scanner drawer Listen", () => {
	it("unlocks in the click, retargets in the window, then plays", async () => {
		const { services, calls } = setup([null])
		const done = listenTo(services, d)
		// synchronous part of the click: unlock, then the core is asked
		expect(calls).toEqual(["unlock", "retarget d1"])
		await done
		expect(calls).toEqual(["unlock", "retarget d1", "start"])
		expect(appToast.get()?.text).toBe("Listening to 161.150")
	})

	it("out of the window: tunes first and plays only once the tune landed", async () => {
		const { services, calls, finish } = setup([outOfWindow(), null])
		const done = listenTo(services, d)
		await flush()
		// a slow tune: nothing plays yet (it would be the previous frequency)
		expect(calls).toEqual(["unlock", "retarget d1", "tune 161150500"])
		finish()
		await done
		expect(calls).toEqual([
			"unlock",
			"retarget d1",
			"tune 161150500",
			"retarget d1",
			"start",
		])
	})

	it("never plays when the tune fails", async () => {
		const { services, calls, finish } = setup([outOfWindow()])
		const done = listenTo(services, d)
		await flush()
		finish("No tuner source")
		await done
		expect(calls).not.toContain("start")
		expect(appToast.get()?.text).toBe("Could not tune: No tuner source")
	})

	it("never plays when the core refuses", async () => {
		const { services, calls } = setup([new Error("locked out")])
		await listenTo(services, d)
		expect(calls).toEqual(["unlock", "retarget d1"])
		expect(appToast.get()?.tone).toBe("warn")
	})

	it("leaves audio already on alone: no unlock, no start", async () => {
		const { services, calls } = setup([null], true)
		await listenTo(services, d)
		expect(calls).toEqual(["retarget d1"])
	})
})

describe("tuneLanded", () => {
	it("is true when the target settles without an error", async () => {
		const s = new Store<TuningState>({ targetHz: 100, error: null })
		const p = tuneLanded(s, 100)
		s.set({ targetHz: null, error: null })
		expect(await p).toBe(true)
	})

	it("is false when a later target replaces it", async () => {
		const s = new Store<TuningState>({ targetHz: 100, error: null })
		const p = tuneLanded(s, 100)
		s.set({ targetHz: 200, error: null })
		expect(await p).toBe(false)
	})

	it("is false on an error, and answers at once when already settled", async () => {
		const s = new Store<TuningState>({ targetHz: null, error: "x" })
		expect(await tuneLanded(s, 100)).toBe(false)
	})
})
