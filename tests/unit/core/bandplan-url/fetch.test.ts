import { afterEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import {
	createBandPlanUrlFetcher,
	type ResolvedAddress,
} from "../../../../src/core/bandplan-url/index.js"
import {
	HOSTS,
	PUBLIC,
	URL_OK,
	fakeRequest,
	resolveTo,
	type FakeResponseSpec,
} from "./helpers.js"

const MiB = 1024 * 1024

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p
	} catch (error) {
		expect(error).toBeInstanceOf(BandPlansError)
		return (error as BandPlansError).code
	}
	return "OK"
}

function setup(
	spec: FakeResponseSpec,
	addresses: readonly ResolvedAddress[] = PUBLIC,
) {
	const { request, log } = fakeRequest(spec)
	const resolve = vi.fn(resolveTo(addresses))
	const fetcher = createBandPlanUrlFetcher({
		resolve,
		request,
		userAgent: "WaveKit/test",
	})
	return { fetcher, log, resolve }
}

describe("rule 1: URL", () => {
	it.each([
		["http", "http://raw.githubusercontent.com/a"],
		["user info", "https://u:p@raw.githubusercontent.com/a"],
		["user only", "https://u@raw.githubusercontent.com/a"],
		["port", "https://raw.githubusercontent.com:8443/a"],
		["default port written", "https://raw.githubusercontent.com:443/a"],
		["fragment", "https://raw.githubusercontent.com/a#x"],
		["empty fragment", "https://raw.githubusercontent.com/a#"],
		["IPv4 literal", "https://185.199.108.133/a"],
		["IPv4 numeric shorthand", "https://0x7f000001/a"],
		["IPv6 literal", "https://[::1]/a"],
		["host not in list", "https://example.com/a"],
		["subdomain", "https://x.raw.githubusercontent.com/a"],
		["suffix trick", "https://raw.githubusercontent.com.evil.com/a"],
		["trailing dot", "https://raw.githubusercontent.com./a"],
		["backslash", "https:\\\\raw.githubusercontent.com/a"],
		["whitespace", " https://raw.githubusercontent.com/a"],
		["tab inside", "https://raw.github\tusercontent.com/a"],
		["too long", `https://raw.githubusercontent.com/${"a".repeat(2048)}`],
		["not a URL", "nope"],
	])("refuses %s before any resolution", async (_name, url) => {
		const { fetcher, resolve, log } = setup({})
		expect(await codeOf(fetcher(url, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
		expect(resolve).not.toHaveBeenCalled()
		expect(log.calls).toHaveLength(0)
	})

	it("refuses everything with an empty host list", async () => {
		const { fetcher, resolve } = setup({})
		expect(await codeOf(fetcher(URL_OK, []))).toBe("BANDPLANS_URL_REFUSED")
		expect(resolve).not.toHaveBeenCalled()
	})

	it("lower-cases the host and matches exactly", async () => {
		const { fetcher, resolve } = setup({ chunks: [Buffer.from("x")] })
		const out = await fetcher("https://RAW.GitHubUserContent.com/a", HOSTS)
		expect(out.contentType).toBe("text/plain")
		expect(resolve).toHaveBeenCalledWith("raw.githubusercontent.com")
	})
})

describe("rule 2: DNS", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"169.254.169.254",
		"::1",
		"fd00::",
		"::ffff:10.0.0.1",
		"64:ff9b::a00:1",
		"garbage",
	])("refuses resolution to %s", async address => {
		const { fetcher, log } = setup({}, [
			{ address, family: address.includes(":") ? 6 : 4 },
		])
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
		expect(log.calls).toHaveLength(0)
	})

	it("refuses mixed public and private answers", async () => {
		const { fetcher, log } = setup({}, [
			{ address: "185.199.108.133", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		])
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
		expect(log.calls).toHaveLength(0)
	})

	it("empty answer is FETCH_FAILED", async () => {
		const { fetcher } = setup({}, [])
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
	})

	it("DNS failure (rejecting and throwing resolvers) is FETCH_FAILED", async () => {
		const { request } = fakeRequest({})
		const rejecting = createBandPlanUrlFetcher({
			resolve: () => Promise.reject(new Error("ENOTFOUND")),
			request,
		})
		expect(await codeOf(rejecting(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		const throwing = createBandPlanUrlFetcher({
			resolve: () => {
				throw new Error("sync")
			},
			request,
		})
		expect(await codeOf(throwing(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		// Flag released: a second call proceeds to the same failure, not BUSY.
		expect(await codeOf(throwing(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
	})

	it("resolves exactly once", async () => {
		const { fetcher, resolve } = setup({ chunks: [Buffer.from("x")] })
		await fetcher(URL_OK, HOSTS)
		expect(resolve).toHaveBeenCalledTimes(1)
	})
})

describe("rule 3: connect", () => {
	it("pins the checked address, SNI and Host, no agent, TLS verified", async () => {
		const { fetcher, log } = setup({ chunks: [Buffer.from("x")] }, [
			{ address: "2606:50c0:8000::154", family: 6 },
			{ address: "185.199.108.133", family: 4 },
		])
		await fetcher(`${URL_OK}?token=secret`, HOSTS)
		const o = log.calls[0]
		expect(o).toBeDefined()
		expect(o?.host).toBe("2606:50c0:8000::154")
		expect(o?.port).toBe(443)
		expect(o?.family).toBe(6)
		expect(o?.servername).toBe("raw.githubusercontent.com")
		expect(o?.agent).toBe(false)
		expect(o?.rejectUnauthorized).toBe(true)
		expect(o?.path).toBe("/o/r/main/plan.csv?token=secret")
		expect(o?.headers).toEqual({
			Host: "raw.githubusercontent.com",
			Accept: expect.stringContaining("text/plain") as unknown,
			"Accept-Encoding": "identity",
			"User-Agent": "WaveKit/test",
		})
		expect(
			Object.keys(o?.headers ?? {}).map(k => k.toLowerCase()),
		).not.toContain("cookie")
		expect(o).not.toHaveProperty("auth")
		const lookup = o?.lookup
		expect(lookup).toBeTypeOf("function")
		const one = await new Promise<unknown[]>(res => {
			lookup?.("evil.example", { all: false }, (...args: unknown[]) =>
				res(args),
			)
		})
		expect(one).toEqual([null, "2606:50c0:8000::154", 6])
		const all = await new Promise<unknown[]>(res => {
			lookup?.("evil.example", { all: true }, (...args: unknown[]) => res(args))
		})
		expect(all).toEqual([null, [{ address: "2606:50c0:8000::154", family: 6 }]])
	})

	it("socket error is FETCH_FAILED and releases the flag", async () => {
		const { fetcher, log } = setup({ requestError: true })
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		expect(log.destroyed).toBeGreaterThanOrEqual(2)
	})

	it("a throwing request seam is FETCH_FAILED and releases the flag", async () => {
		const fetcher = createBandPlanUrlFetcher({
			resolve: resolveTo(PUBLIC),
			request: () => {
				throw new Error("no")
			},
		})
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
	})
})

describe("rule 4: response", () => {
	it.each([301, 302, 307, 308])(
		"%i with an allowed Location is not followed",
		async status => {
			const { fetcher, log } = setup({
				status,
				headers: { location: URL_OK, "content-type": "text/plain" },
			})
			expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
				"BANDPLANS_URL_FETCH_FAILED",
			)
			expect(log.calls).toHaveLength(1)
		},
	)

	it.each([204, 404, 500])("%i is FETCH_FAILED", async status => {
		const { fetcher } = setup({ status })
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
	})

	it.each(["gzip", "br", "deflate", "identity, gzip"])(
		"encoding %s is refused",
		async enc => {
			const { fetcher } = setup({
				headers: { "content-type": "text/plain", "content-encoding": enc },
			})
			expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
		},
	)

	it("explicit identity encoding is accepted", async () => {
		const { fetcher } = setup({
			headers: { "content-type": "text/plain", "content-encoding": "Identity" },
			chunks: [Buffer.from("ok")],
		})
		expect((await fetcher(URL_OK, HOSTS)).bytes).toEqual(
			new Uint8Array(Buffer.from("ok")),
		)
	})

	it.each(["text/html", "image/png", "text/plainx"])(
		"media type %s is refused",
		async t => {
			const { fetcher } = setup({ headers: { "content-type": t } })
			expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
		},
	)

	it("missing media type is refused", async () => {
		const { fetcher } = setup({ headers: {} })
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_URL_REFUSED")
	})

	it("media type is lower-cased with parameters dropped", async () => {
		const { fetcher } = setup({
			headers: { "content-type": "Application/JSON; charset=utf-8" },
			chunks: [Buffer.from("{}")],
		})
		expect((await fetcher(URL_OK, HOSTS)).contentType).toBe("application/json")
	})

	it("Content-Length 1 MiB + 1 is TOO_LARGE before reading", async () => {
		const { fetcher, log } = setup({
			headers: {
				"content-type": "text/plain",
				"content-length": String(MiB + 1),
			},
			hang: true,
		})
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_IMPORT_TOO_LARGE",
		)
		expect(log.responses[0]?.destroyed).toBe(true)
	})

	it("a chunked body crossing 1 MiB is TOO_LARGE and destroyed", async () => {
		const chunk = Buffer.alloc(256 * 1024, 0x41)
		const { fetcher, log } = setup({
			chunks: [chunk, chunk, chunk, chunk, Buffer.from("x")],
			hang: true,
		})
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_IMPORT_TOO_LARGE",
		)
		expect(log.responses[0]?.destroyed).toBe(true)
		expect(log.destroyed).toBeGreaterThanOrEqual(1)
	})

	it("exactly 1 MiB is accepted", async () => {
		const chunk = Buffer.alloc(256 * 1024, 0x41)
		const { fetcher } = setup({ chunks: [chunk, chunk, chunk, chunk] })
		expect((await fetcher(URL_OK, HOSTS)).bytes.length).toBe(MiB)
	})

	it("a response stream error is FETCH_FAILED", async () => {
		const { fetcher } = setup({
			chunks: [Buffer.from("x")],
			responseError: true,
		})
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe(
			"BANDPLANS_URL_FETCH_FAILED",
		)
	})
})

describe("rule 5: deadline and in-flight", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("a stall past 10 s is TIMEOUT, destroys the request, frees the flag", async () => {
		vi.useFakeTimers()
		const { fetcher, log } = setup({
			hang: true,
			chunks: [Buffer.from("partial")],
		})
		const p = codeOf(fetcher(URL_OK, HOSTS))
		await vi.advanceTimersByTimeAsync(9_999)
		expect(log.destroyed).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(await p).toBe("BANDPLANS_URL_TIMEOUT")
		expect(log.destroyed).toBe(1)
		expect(log.responses[0]?.destroyed).toBe(true)
		const again = codeOf(fetcher(URL_OK, HOSTS))
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await again).toBe("BANDPLANS_URL_TIMEOUT")
	})

	it("the deadline also covers a hanging DNS lookup", async () => {
		vi.useFakeTimers()
		const { request, log } = fakeRequest({})
		const fetcher = createBandPlanUrlFetcher({
			resolve: () => new Promise(() => undefined),
			request,
		})
		const p = codeOf(fetcher(URL_OK, HOSTS))
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await p).toBe("BANDPLANS_URL_TIMEOUT")
		expect(log.calls).toHaveLength(0)
	})

	it("an injected timer source is honoured", async () => {
		let fire: (() => void) | undefined
		const { request } = fakeRequest({ hang: true })
		const fetcher = createBandPlanUrlFetcher({
			resolve: resolveTo(PUBLIC),
			request,
			timers: {
				setTimeout: cb => {
					fire = cb
					return 1
				},
				clearTimeout: () => undefined,
			},
		})
		const p = codeOf(fetcher(URL_OK, HOSTS))
		await new Promise(r => setImmediate(r))
		fire?.()
		expect(await p).toBe("BANDPLANS_URL_TIMEOUT")
	})

	it("a second concurrent fetch is BUSY; the first still completes", async () => {
		vi.useFakeTimers()
		const { fetcher } = setup({ hang: true })
		const first = codeOf(fetcher(URL_OK, HOSTS))
		expect(await codeOf(fetcher(URL_OK, HOSTS))).toBe("BANDPLANS_BUSY")
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await first).toBe("BANDPLANS_URL_TIMEOUT")
	})

	it("separate fetcher instances do not share the flag", async () => {
		vi.useFakeTimers()
		const a = setup({ hang: true }).fetcher
		const b = setup({ chunks: [Buffer.from("x")] }).fetcher
		const pa = codeOf(a(URL_OK, HOSTS))
		expect(await codeOf(b(URL_OK, HOSTS))).toBe("OK")
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await pa).toBe("BANDPLANS_URL_TIMEOUT")
	})
})

describe("rule 6: errors and logs carry no body or query", () => {
	it("logs host and path only; errors carry the fixed message", async () => {
		const lines: unknown[] = []
		const sink = {
			child: () => sink,
			warn: (...args: unknown[]) => lines.push(args),
			debug: (...args: unknown[]) => lines.push(args),
			info: (...args: unknown[]) => lines.push(args),
			error: (...args: unknown[]) => lines.push(args),
		}
		const body = "SECRET-BODY-BYTES"
		const run = async (spec: FakeResponseSpec): Promise<unknown> => {
			const { request } = fakeRequest(spec)
			const fetcher = createBandPlanUrlFetcher({
				resolve: resolveTo(PUBLIC),
				request,
				logger: sink as unknown as Logger,
			})
			try {
				return await fetcher(`${URL_OK}?q=SECRET-QUERY`, HOSTS)
			} catch (error) {
				return error
			}
		}
		const errors = [
			await run({ status: 500, chunks: [Buffer.from(body)] }),
			await run({
				headers: { "content-type": "text/html" },
				chunks: [Buffer.from(body)],
			}),
			await run({ requestError: true }),
		]
		await run({ chunks: [Buffer.from(body)] })
		const text =
			JSON.stringify(lines) +
			errors.map(e => String((e as Error).message) + JSON.stringify(e)).join()
		expect(lines.length).toBeGreaterThan(0)
		expect(text).toContain("raw.githubusercontent.com")
		expect(text).toContain("/o/r/main/plan.csv")
		expect(text).not.toContain("SECRET-QUERY")
		expect(text).not.toContain("SECRET-BODY")
		expect(text).not.toContain("secret-body")
		for (const e of errors) expect(e).toBeInstanceOf(BandPlansError)
	})
})

describe("body buffering (bounded memory)", () => {
	it("copies 100 000 one-byte chunks into one cap-sized allocation", async () => {
		const chunks = Array.from({ length: 100_000 }, (_, i) =>
			Buffer.from([0x41 + (i % 26)]),
		)
		const { fetcher } = setup({ chunks })
		const out = await fetcher(URL_OK, HOSTS)
		expect(out.bytes.length).toBe(100_000)
		expect(Buffer.from(out.bytes).equals(Buffer.concat(chunks))).toBe(true)
		// A single backing allocation of the cap, not a concatenation of retained chunks.
		expect(out.bytes.buffer.byteLength).toBe(MiB)
		expect(out.bytes.byteOffset).toBe(0)
	})

	it("preallocates the announced Content-Length when within the cap", async () => {
		const { fetcher } = setup({
			headers: { "content-type": "text/plain", "content-length": "5" },
			chunks: [Buffer.from("he"), Buffer.from("llo")],
		})
		const out = await fetcher(URL_OK, HOSTS)
		expect(Buffer.from(out.bytes).toString()).toBe("hello")
		expect(out.bytes.buffer.byteLength).toBe(5)
	})

	it("a body longer than announced (within the cap) still arrives intact", async () => {
		const { fetcher } = setup({
			headers: { "content-type": "text/plain", "content-length": "2" },
			chunks: [Buffer.from("he"), Buffer.from("llo")],
		})
		const out = await fetcher(URL_OK, HOSTS)
		expect(Buffer.from(out.bytes).toString()).toBe("hello")
	})
})
