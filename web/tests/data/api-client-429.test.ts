// Band inspection UX req 2.1: Activity reads retry on 429, never before Retry-After, at most 3 times.
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	ApiClient,
	isApiError,
	rateLimitWait,
	retriesOn429,
	retryAfterMs,
} from "../../src/data/api-client.ts"

const NOW = Date.parse("2026-10-25T08:00:00.000Z")

function client(answers: (string | null | "ok")[], random = 0, now = NOW) {
	const waits: number[] = []
	let i = 0
	const api = new ApiClient({
		now: () => now,
		random: () => random,
		sleep: async ms => {
			waits.push(ms)
		},
		fetch: async () => {
			const a = answers[Math.min(i++, answers.length - 1)]
			if (a === "ok") return new Response(JSON.stringify({ items: [] }))
			const headers = new Headers()
			if (a !== null && a !== undefined) headers.set("Retry-After", a)
			return new Response(
				JSON.stringify({ code: "RATE_LIMITED", message: "Too many" }),
				{
					status: 429,
					headers,
				},
			)
		},
	})
	return { api, waits, count: () => i }
}

describe("Retry-After", () => {
	it("reads seconds and HTTP dates; refuses the rest", () => {
		expect(retryAfterMs("1", NOW)).toBe(1000)
		expect(retryAfterMs("0", NOW)).toBe(0)
		expect(retryAfterMs(new Date(NOW + 3000).toUTCString(), NOW)).toBe(3000)
		expect(retryAfterMs(new Date(NOW - 3000).toUTCString(), NOW)).toBe(0)
		for (const bad of [
			"",
			"-1",
			"1.5",
			"soon-ish",
			"12345678901234567890",
			null,
			undefined,
		])
			expect(retryAfterMs(bad, NOW)).toBeNull()
	})

	it("only Activity reads retry", () => {
		expect(retriesOn429("GET", "/api/activity")).toBe(true)
		expect(retriesOn429("GET", "/api/activity/timeline")).toBe(true)
		expect(retriesOn429("GET", "/api/activity/bandmap")).toBe(true)
		expect(retriesOn429("POST", "/api/activity/facets")).toBe(true)
		expect(retriesOn429("POST", "/api/activity")).toBe(false)
		expect(retriesOn429("GET", "/api/scanner/discoveries")).toBe(false)
	})
})

describe("ApiClient 429 retry", () => {
	it("seconds: waits at least what the server asked, then succeeds", async () => {
		const { api, waits } = client(["1", "ok"], 0.999)
		await expect(api.get("/api/activity")).resolves.toEqual({ items: [] })
		expect(waits).toHaveLength(1)
		expect(waits[0]).toBeGreaterThanOrEqual(1000)
		expect(waits[0]).toBeLessThanOrEqual(1200)
	})

	it("an HTTP date and a past date", async () => {
		const date = client([new Date(NOW + 2000).toUTCString(), "ok"])
		await date.api.get("/api/activity")
		expect(date.waits).toEqual([2000])
		const past = client([new Date(NOW - 5000).toUTCString(), "ok"])
		await past.api.get("/api/activity")
		expect(past.waits).toEqual([250])
	})

	it("malformed or absent: 500, 1000, 2000 ms, then the 4th 429 surfaces", async () => {
		const { api, waits, count } = client(["soon-ish", null, "x", "y"])
		const error = await api.get("/api/activity").catch((e: unknown) => e)
		expect(waits).toEqual([500, 1000, 2000])
		expect(count()).toBe(4)
		expect(isApiError(error) && error.status).toBe(429)
	})

	it("10 000 ms retries; 10 001 ms surfaces at once with when to try again", async () => {
		const at = client(["10", "ok"])
		await at.api.get("/api/activity")
		expect(at.waits).toEqual([10_000])
		const atDate = client([new Date(NOW).toUTCString(), "ok"], 0, NOW - 10_000)
		await atDate.api.get("/api/activity")
		expect(atDate.waits).toEqual([10_000])
		// an HTTP date 10 001 ms ahead (dates have whole seconds: move the clock instead)
		const over = client([new Date(NOW).toUTCString()], 0, NOW - 10_001)
		const error = await over.api.get("/api/activity").catch((e: unknown) => e)
		expect(over.waits).toEqual([])
		expect((error as Error).message).toBe("rate limited, retry in 11 s")
		const thirty = client(["30"])
		const e30 = await thirty.api.get("/api/activity").catch((e: unknown) => e)
		expect((e30 as Error).message).toBe("rate limited, retry in 30 s")
	})

	it("a route that does not retry surfaces the 429 untouched", async () => {
		const { api, waits } = client(["1", "ok"])
		await expect(api.get("/api/scanner/discoveries")).rejects.toMatchObject({
			status: 429,
		})
		expect(waits).toEqual([])
	})

	it("an abort mid-wait stops at once", async () => {
		const abort = new AbortController()
		let calls = 0
		const api = new ApiClient({
			fetch: async () => {
				calls++
				return new Response("{}", {
					status: 429,
					headers: { "Retry-After": "5" },
				})
			},
		})
		const p = api.get("/api/activity", { signal: abort.signal })
		await new Promise(r => setTimeout(r, 10))
		abort.abort()
		await expect(p).rejects.toMatchObject({ name: "AbortError" })
		expect(calls).toBe(1)
	})

	// Feature: band-inspection-ux, Property 6: never before Retry-After, jitter within 20 %, at most 4 attempts
	// Validates: Requirements 2.1
	it("any Retry-After and attempt", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.nat({ max: 30 }).map(String),
					fc
						.integer({ min: -60_000, max: 60_000 })
						.map(ms => new Date(NOW + ms).toUTCString()),
					fc.string({ maxLength: 10 }),
				),
				fc.nat({ max: 6 }),
				fc.double({ min: 0, max: 0.9999999, noNaN: true }),
				(header, attempt, r) => {
					const asked = retryAfterMs(header, NOW)
					const d = asked ?? 500 * 2 ** attempt
					const out = rateLimitWait(header, attempt, NOW, r)
					if (d > 10_000 || attempt >= 3) expect(out.retry).toBe(false)
					else {
						expect(out.retry).toBe(true)
						if (out.retry) {
							const base = Math.max(d, 250)
							expect(out.waitMs).toBeGreaterThanOrEqual(base)
							expect(out.waitMs).toBeLessThanOrEqual(base * 1.2 + 1e-9)
						}
					}
				},
			),
			{ numRuns: 300 },
		)
	})
})
