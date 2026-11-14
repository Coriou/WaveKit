import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchLike } from "../../src/data/api-client.ts"
import { createDataLayer, START_RETRY_MAX_MS } from "../../src/data/index.ts"
import { json } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const SOURCES = [
	{
		id: "rtl",
		type: "rtl_tcp",
		connected: true,
		caps: { kind: "iq", format: "U8_IQ", sampleRate: 250_000 },
	},
]

describe("starting against a core that is not answering yet", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("keeps the code of a refused address", async () => {
		const fetch: FetchLike = async () => json(403, { code: "HOST_FORBIDDEN" })
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		expect(data.access.get()).toMatchObject({
			access: null,
			code: "HOST_FORBIDDEN",
		})
		data.dispose()
	})

	it("reads the access mode and loads the stores once the core answers", async () => {
		let up = false
		const paths: string[] = []
		const fetch: FetchLike = async url => {
			if (!up) throw new TypeError("Failed to fetch")
			const path = url.replace(/\?.*$/, "")
			paths.push(path)
			if (path === "/api/access/bootstrap")
				return json(404, { code: "NOT_FOUND" })
			if (path === "/api/sources") return json(200, SOURCES)
			return json(404, { code: "NOT_FOUND" })
		}
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		expect(data.access.get()).toMatchObject({ access: null, code: null })
		expect(data.access.get().error).not.toBeNull()
		expect(data.sources.get().sources).toEqual([])

		// still down: it keeps asking, no faster than the backoff allows
		await vi.advanceTimersByTimeAsync(3 * START_RETRY_MAX_MS)
		expect(data.access.get().access).toBeNull()

		up = true
		await vi.advanceTimersByTimeAsync(2 * START_RETRY_MAX_MS)
		expect(data.access.get()).toMatchObject({
			access: { mode: "legacy" },
			error: null,
			code: null,
		})
		expect(paths).toContain("/api/sources")
		expect(data.sources.get().sources.map(s => s.id)).toEqual(["rtl"])

		// answered: nothing asks again
		const asked = paths.length
		await vi.advanceTimersByTimeAsync(5 * START_RETRY_MAX_MS)
		expect(paths.filter(p => p === "/api/access/bootstrap")).toHaveLength(1)
		expect(paths.length).toBe(asked)
		data.dispose()
	})

	it("stops asking once disposed", async () => {
		let calls = 0
		const fetch: FetchLike = async () => {
			calls++
			throw new TypeError("Failed to fetch")
		}
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		data.dispose()
		const before = calls
		await vi.advanceTimersByTimeAsync(5 * START_RETRY_MAX_MS)
		expect(calls).toBe(before)
	})
})
