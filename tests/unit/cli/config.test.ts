import { describe, expect, it, vi } from "vitest"
import {
	CliUsageError,
	DISCOVERY_CANDIDATES,
	deriveBase,
	deriveWs,
	discover,
	resolveExplicit,
	type FetchLike,
} from "../../../cli/source/data/config.js"

const json = (status: number, body: unknown) =>
	Promise.resolve({
		ok: status < 400,
		status,
		statusText: "",
		json: () => Promise.resolve(body),
	})

describe("resolveExplicit", () => {
	it("prefers --api, then WAVEKIT_API_URL, then WAVEKIT_WS_URL(S)", () => {
		const env = {
			WAVEKIT_API_URL: "http://192.0.2.5:9000",
			WAVEKIT_WS_URL: "ws://192.0.2.6:9000/ws",
		}
		expect(resolveExplicit("http://192.0.2.4:9000", env)).toEqual({
			base: "http://192.0.2.4:9000",
			ws: "ws://192.0.2.4:9000/ws",
			explicit: true,
		})
		expect(resolveExplicit(undefined, env)?.base).toBe("http://192.0.2.5:9000")
		expect(
			resolveExplicit(undefined, { WAVEKIT_WS_URL: "ws://192.0.2.6:9000/ws" }),
		).toEqual({
			base: "http://192.0.2.6:9000",
			ws: "ws://192.0.2.6:9000/ws",
			explicit: true,
		})
		expect(
			resolveExplicit(undefined, {
				WAVEKIT_WS_URLS: "wss://192.0.2.7/ws, ws://192.0.2.8/ws",
			})?.base,
		).toBe("https://192.0.2.7")
		expect(resolveExplicit(undefined, {})).toBeNull()
	})
	it("rewrites localhost and refuses the RTL-TCP relay port", () => {
		expect(resolveExplicit("http://localhost:9000", {})?.base).toBe(
			"http://127.0.0.1:9000",
		)
		expect(() => resolveExplicit("http://127.0.0.1:4713", {})).toThrow(
			CliUsageError,
		)
	})
	it("derives URLs both ways", () => {
		expect(deriveWs("https://192.0.2.9:8443")).toBe("wss://192.0.2.9:8443/ws")
		expect(deriveBase("ws://192.0.2.9:9000/ws")).toBe("http://192.0.2.9:9000")
	})
})

describe("A1 fix round 1: URL validation", () => {
	it("refuses a URL without an http(s) or ws(s) scheme, with a hint", () => {
		expect(() => resolveExplicit("localhost:9000", {})).toThrow(CliUsageError)
		expect(() => resolveExplicit("localhost:9000", {})).toThrow(
			/did you mean http:\/\/localhost:9000\?/,
		)
		expect(() => resolveExplicit("127.0.0.1:9000", {})).toThrow(
			/did you mean http:\/\/127\.0\.0\.1:9000\?/,
		)
		expect(() => resolveExplicit("file:///x", {})).toThrow(CliUsageError)
		expect(() => resolveExplicit("ftp://h", {})).toThrow(CliUsageError)
		expect(() =>
			resolveExplicit(undefined, { WAVEKIT_WS_URL: "localhost:9000/ws" }),
		).toThrow(CliUsageError)
	})
	it("maps a ws(s) --api URL to its http(s) REST base", () => {
		expect(resolveExplicit("ws://192.0.2.4:9000/ws", {})).toEqual({
			base: "http://192.0.2.4:9000",
			ws: "ws://192.0.2.4:9000/ws",
			explicit: true,
		})
		expect(resolveExplicit("wss://192.0.2.4/ws", {})?.base).toBe(
			"https://192.0.2.4",
		)
		expect(resolveExplicit("https://192.0.2.4:8443", {})?.base).toBe(
			"https://192.0.2.4:8443",
		)
	})
})

describe("A1 fix round 1: WS env scheme", () => {
	it("maps an http(s) WAVEKIT_WS_URL to ws(s) and keeps https for REST", () => {
		expect(
			resolveExplicit(undefined, { WAVEKIT_WS_URL: "https://192.0.2.4/ws" }),
		).toEqual({
			base: "https://192.0.2.4",
			ws: "wss://192.0.2.4/ws",
			explicit: true,
		})
		expect(
			resolveExplicit(undefined, { WAVEKIT_WS_URL: "http://192.0.2.4:9000/ws" })
				?.ws,
		).toBe("ws://192.0.2.4:9000/ws")
		expect(deriveBase("https://192.0.2.9:8443/ws")).toBe(
			"https://192.0.2.9:8443",
		)
	})
})

describe("A2 fix round 1: fragments", () => {
	it("refuses a URL with a fragment (ws throws on it)", () => {
		expect(() => resolveExplicit("http://192.0.2.4:9000/#x", {})).toThrow(
			CliUsageError,
		)
		expect(() => resolveExplicit("http://192.0.2.4:9000#", {})).toThrow(
			CliUsageError,
		)
		expect(() =>
			resolveExplicit(undefined, {
				WAVEKIT_WS_URL: "ws://192.0.2.4:9000/ws#frag",
			}),
		).toThrow(CliUsageError)
	})
})

describe("discover", () => {
	it("never probes localhost or 4713", () => {
		for (const c of DISCOVERY_CANDIDATES) {
			expect(c).not.toContain("localhost")
			expect(c).not.toContain(":4713")
		}
		expect(DISCOVERY_CANDIDATES).toEqual([
			"http://127.0.0.1:9000",
			"http://127.0.0.1:3000",
		])
	})
	it("adopts the first candidate whose /health says status ok, even with 503", async () => {
		const fetchFn = vi.fn<FetchLike>(url =>
			url.includes(":9000")
				? json(503, { status: "ok", timestamp: "t" })
				: json(200, { status: "ok" }),
		)
		const r = await discover(fetchFn)
		expect(r.target?.base).toBe("http://127.0.0.1:9000")
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})
	it("skips a different service answering HTML (review focus 1)", async () => {
		const fetchFn = vi.fn<FetchLike>(url =>
			url.includes(":9000")
				? Promise.reject(new TypeError("fetch failed"))
				: Promise.resolve({
						ok: true,
						status: 200,
						statusText: "OK",
						json: () => Promise.reject(new SyntaxError("Unexpected token <")),
					}),
		)
		const r = await discover(fetchFn)
		expect(r.target).toBeNull()
		expect(r.tried).toEqual(["127.0.0.1:9000", "127.0.0.1:3000"])
	})
	it("skips JSON that is not a WaveKit /health body", async () => {
		const r = await discover(() => json(200, { hello: "world" }))
		expect(r.target).toBeNull()
	})
})
