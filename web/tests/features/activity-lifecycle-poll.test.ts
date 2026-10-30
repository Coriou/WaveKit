import { describe, expect, it } from "vitest"

import { ApiClient } from "../../src/data/api-client.ts"
import type { ActivityAvailability } from "../../src/features/activity/lifecycle.ts"
import {
	ACTIVITY_LIFECYCLE_POLL_MS,
	lifecycleNotice,
	pollActivityAvailability,
} from "../../src/features/activity/lifecycle.ts"

type Answer = { status: number; body: unknown } | "network"

const lifecycle = (state: string) => ({
	status: 200,
	body: {
		enabled: true,
		stats: {
			lifecycle: {
				state,
				reason: null,
				attempts: 1,
				nextAttemptAt: null,
				droppedWhileClosed: 0,
			},
		},
	},
})

/** A poller over scripted status answers (the last repeats) on manual timers. */
function poller(answers: Answer[]) {
	let calls = 0
	const api = new ApiClient({
		fetch: async () => {
			const answer = answers[Math.min(calls, answers.length - 1)]!
			calls += 1
			if (answer === "network") throw new TypeError("Failed to fetch")
			return new Response(JSON.stringify(answer.body), {
				status: answer.status,
			})
		},
	})
	const seen: ActivityAvailability[] = []
	let reloads = 0
	const pending: { run: () => void; ms: number }[] = []
	const stop = pollActivityAvailability(
		api,
		a => seen.push(a),
		() => {
			reloads += 1
		},
		{
			setTimeout: (run, ms) => {
				pending.push({ run, ms })
				return pending.length
			},
			clearTimeout: () => {
				pending.length = 0
			},
		},
	)
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve()
		await new Promise(resolve => setTimeout(resolve, 0))
	}
	/** Fires the one pending poll timer, then lets the request settle. */
	const tick = async () => {
		const next = pending.shift()
		expect(next?.ms).toBe(ACTIVITY_LIFECYCLE_POLL_MS)
		next!.run()
		await settle()
	}
	return {
		seen,
		pending,
		stop,
		settle,
		tick,
		reloads: () => reloads,
		calls: () => calls,
	}
}

describe("Activity availability polling", () => {
	it("keeps polling and reloading while the list still meets a 503 after available", async () => {
		const p = poller([lifecycle("opening"), lifecycle("available")])
		await p.settle()
		expect(p.seen.at(-1)).toMatchObject({ lifecycle: { state: "opening" } })
		await p.tick()
		expect(p.reloads()).toBe(1)
		// The reload met a 503, so the drawer still polls: the next available reloads again.
		expect(p.pending).toHaveLength(1)
		await p.tick()
		expect(p.reloads()).toBe(2)
		p.stop()
		expect(p.pending).toHaveLength(0)
	})

	it("shows a neutral unreachable notice on a network error and keeps polling", async () => {
		const p = poller(["network", lifecycle("available")])
		await p.settle()
		const unreachable = p.seen.at(-1)!
		expect(unreachable).toEqual({ kind: "unknown" })
		expect(lifecycleNotice(unreachable)).toEqual({
			text: "Can’t reach the receiver",
			tone: "warn",
		})
		expect(lifecycleNotice(unreachable)?.text).not.toMatch(/starting/)
		await p.tick()
		expect(p.reloads()).toBe(1)
		p.stop()
	})

	it("stops on off and on a permanent failure", async () => {
		const off = poller([{ status: 404, body: { code: "ACTIVITY_DISABLED" } }])
		await off.settle()
		expect(off.seen).toEqual([{ kind: "off" }])
		expect(off.pending).toHaveLength(0)
		const failed = poller([lifecycle("unavailable")])
		await failed.settle()
		expect(failed.pending).toHaveLength(0)
		expect(failed.calls()).toBe(1)
	})

	it("shows nothing before the first answer", () => {
		expect(lifecycleNotice({ kind: "checking" })).toBeNull()
	})
})
