import { afterEach, describe, expect, it, vi } from "vitest"

import {
	ApiClient,
	ApiError,
	REQUEST_TIMEOUT_CODE,
	REQUEST_TIMEOUT_MS,
} from "../../src/data/api-client.ts"

/** A fetch that never answers until its signal aborts (then rejects as a browser does). */
function hanging(): {
	fetch: (url: string, init?: RequestInit) => Promise<Response>
	signals: (AbortSignal | undefined)[]
} {
	const signals: (AbortSignal | undefined)[] = []
	return {
		signals,
		fetch: (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal ?? undefined
				signals.push(signal)
				signal?.addEventListener("abort", () =>
					reject(new DOMException("The operation was aborted.", "AbortError")),
				)
			}),
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("ApiClient request timeout", () => {
	it("gives up on a GET after the request's own budget with REQUEST_TIMEOUT", async () => {
		vi.useFakeTimers()
		const { fetch } = hanging()
		const api = new ApiClient({ fetch })
		const answer = api
			.request("GET", "/api/recordings", undefined, { timeoutMs: 10_000 })
			.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(9_999)
		let settled = false
		void answer.then(() => (settled = true))
		await Promise.resolve()
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		const error = await answer
		expect(error).toBeInstanceOf(ApiError)
		expect(error).toMatchObject({
			status: 0,
			code: REQUEST_TIMEOUT_CODE,
			message: "No answer from WaveKit in 10 s",
		})
	})

	it("applies a client default to GETs only, never to writes; none unless set", async () => {
		vi.useFakeTimers()
		const { fetch } = hanging()
		const api = new ApiClient({ fetch, getTimeoutMs: REQUEST_TIMEOUT_MS })
		const read = api.get("/api/system").catch((error: unknown) => error)
		let writeDone = false
		void api
			.request("POST", "/api/x", {})
			.catch(() => undefined)
			.finally(() => (writeDone = true))
		await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
		expect(await read).toMatchObject({ code: REQUEST_TIMEOUT_CODE })
		expect(writeDone).toBe(false)
		const plain = new ApiClient({ fetch })
		let plainDone = false
		void plain
			.get("/api/system")
			.catch(() => undefined)
			.finally(() => (plainDone = true))
		await vi.advanceTimersByTimeAsync(10 * REQUEST_TIMEOUT_MS)
		expect(plainDone).toBe(false)
	})

	it("a caller's abort stays an AbortError, and 0 turns the timer off", async () => {
		vi.useFakeTimers()
		const { fetch, signals } = hanging()
		const api = new ApiClient({ fetch, getTimeoutMs: 0 })
		const controller = new AbortController()
		const read = api
			.get("/api/system", { signal: controller.signal })
			.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(10 * REQUEST_TIMEOUT_MS)
		expect(signals[0]?.aborted).toBe(false)
		controller.abort()
		const error = await read
		expect(error).toBeInstanceOf(DOMException)
		expect((error as DOMException).name).toBe("AbortError")
	})

	it("a timed read whose caller aborts first is the caller's abort", async () => {
		vi.useFakeTimers()
		const { fetch } = hanging()
		const api = new ApiClient({ fetch })
		const controller = new AbortController()
		const read = api
			.get("/api/system", { signal: controller.signal, timeoutMs: 5000 })
			.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(1000)
		controller.abort()
		expect(((await read) as DOMException).name).toBe("AbortError")
	})

	it("an answer in time clears its timer", async () => {
		vi.useFakeTimers()
		const api = new ApiClient({
			fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
		})
		await api.get("/api/system")
		expect(vi.getTimerCount()).toBe(0)
	})
})
