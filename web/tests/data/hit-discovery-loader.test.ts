import { afterEach, expect, it, vi } from "vitest"
import { ApiError } from "../../src/data/api-client.ts"
import {
	HitDiscoveryLoader,
	HIT_LOOKUP_LIMIT,
	type HitLookupState,
} from "../../src/data/hit-discovery-loader.ts"

const failure = (status: number) =>
	new ApiError({
		status,
		code: "FAILED",
		message: "Unavailable",
		body: null,
		method: "GET",
		path: "/synthetic",
	})
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

it("caps 500 dead hits across repeated requests and never retries 404", async () => {
	const pending: (() => void)[] = []
	const read = vi.fn(
		() => new Promise((_, reject) => pending.push(() => reject(failure(404)))),
	)
	let states: ReadonlyMap<string, HitLookupState> = new Map()
	const loader = new HitDiscoveryLoader(read, s => {
		states = s
	})
	const ids = Array.from({ length: 500 }, (_, i) => String(i))
	loader.request(ids)
	loader.request(ids)
	expect(HIT_LOOKUP_LIMIT).toBe(20)
	expect(read).toHaveBeenCalledTimes(20)
	expect(states.get("499")).toBe("pending")
	for (let batch = 0; batch < 25; batch++) {
		pending.splice(0).forEach(done => done())
		await flush()
	}
	expect(read).toHaveBeenCalledTimes(500)
	expect([...states.values()]).toEqual(Array(500).fill("unavailable"))
	loader.request(ids)
	expect(read).toHaveBeenCalledTimes(500)
	loader.dispose()
})

it("backs off twice on transient errors and publishes pending until exhausted", async () => {
	vi.useFakeTimers()
	const read = vi.fn().mockRejectedValue(failure(503))
	let state: HitLookupState | undefined
	const loader = new HitDiscoveryLoader(read, s => {
		state = s.get("a")
	})
	loader.request(["a"])
	await flush()
	expect(state).toBe("pending")
	await vi.advanceTimersByTimeAsync(249)
	expect(read).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(1)
	expect(read).toHaveBeenCalledTimes(2)
	await vi.advanceTimersByTimeAsync(999)
	expect(read).toHaveBeenCalledTimes(2)
	await vi.advanceTimersByTimeAsync(1)
	expect(read).toHaveBeenCalledTimes(3)
	expect(state).toBe("unavailable")
	loader.dispose()
})

it("reset clears stale outcomes but retains the cap until old requests finish", async () => {
	const pending: (() => void)[] = []
	const read = vi.fn(() => new Promise<void>(resolve => pending.push(resolve)))
	let states: ReadonlyMap<string, HitLookupState> = new Map()
	const loader = new HitDiscoveryLoader(read, s => {
		states = s
	})
	const ids = Array.from({ length: 20 }, (_, i) => String(i))
	loader.request(ids)
	loader.reset()
	expect(states.size).toBe(0)
	loader.request(ids)
	expect(read).toHaveBeenCalledTimes(20)
	pending.splice(0).forEach(done => done())
	await flush()
	expect(read).toHaveBeenCalledTimes(40)
	expect(states.get("0")).toBe("pending")
	pending.splice(0).forEach(done => done())
	await flush()
	expect(states.get("0")).toBe("available")
	loader.reset()
	loader.request(["0"])
	expect(states.get("0")).toBe("pending")
	expect(read).toHaveBeenCalledTimes(41)
	loader.dispose()
	pending.splice(0).forEach(done => done())
	await flush()
})
