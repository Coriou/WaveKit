/**
 * WG9 5.5: legacy audio URL host derivation (pure) and the route wiring.
 */

import Fastify, { type FastifyInstance } from "fastify"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	deriveLegacyAudioUrl,
	parseLegacyHost,
} from "../../../src/api/routes/legacy-audio-host.js"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { digitalVoiceRoutes } from "../../../src/api/routes/digital-voice.js"

const BASE = "http://localhost:8081/stream"

describe("deriveLegacyAudioUrl", () => {
	it.each([
		["pi.local", "http://pi.local:8081/stream"],
		["pi.local:3000", "http://pi.local:8081/stream"],
		["Pi.LOCAL", "http://pi.local:8081/stream"],
		["192.168.1.20:3000", "http://192.168.1.20:8081/stream"],
		["0.0.0.0", "http://0.0.0.0:8081/stream"],
		["[fe80::1]:3000", "http://[fe80::1]:8081/stream"],
		["[::ffff:10.0.0.1]", "http://[::ffff:10.0.0.1]:8081/stream"],
		["wavekit", "http://wavekit:8081/stream"],
		["a-b.example.org:65535", "http://a-b.example.org:8081/stream"],
	])("derives %s", (host, expected) => {
		expect(deriveLegacyAudioUrl(BASE, host, 8081)).toBe(expected)
	})

	it.each([
		["empty", ""],
		["comma list", "a.local, b.local"],
		["userinfo", "user@evil.example"],
		["userinfo with port", "user:pw@evil.example:80"],
		["CRLF", "pi.local\r\nSet-Cookie: x=1"],
		["LF", "pi.local\nx"],
		["path", "pi.local/evil"],
		["query", "pi.local?x=1"],
		["fragment", "pi.local#x"],
		["space", "pi local"],
		["unicode", "pі.local"],
		["kelvin sign", "Kevin.local"],
		["punycode-free IDN", "bücher.example"],
		["unbracketed IPv6", "fe80::1"],
		["IPv6 zone", "[fe80::1%25eth0]"],
		["bad IPv6", "[fe80:::1]"],
		["unclosed bracket", "[fe80::1"],
		["junk after bracket", "[::1]x"],
		["IPv4 octet > 255", "256.1.1.1"],
		["IPv4 leading zero", "010.0.0.1"],
		["IPv4 three parts", "10.0.1"],
		["all-numeric name", "1234"],
		["label hyphen start", "-a.local"],
		["label hyphen end", "a-.local"],
		["empty label", "a..local"],
		["trailing dot", "pi.local."],
		["label too long", `${"a".repeat(64)}.local`],
		["name too long", `${"a.".repeat(127)}ab`],
		["port too big", "pi.local:65536"],
		["port not numeric", "pi.local:http"],
		["empty port", "pi.local:"],
		["two colons", "pi.local:1:2"],
		["underscore", "pi_box.local"],
		["percent", "pi%2elocal"],
	])("refuses %s", (_name, host) => {
		expect(deriveLegacyAudioUrl(BASE, host, 8081)).toBe(BASE)
	})

	it("refuses several Host values and a missing Host", () => {
		expect(deriveLegacyAudioUrl(BASE, ["pi.local", "pi.local"], 8081)).toBe(
			BASE,
		)
		expect(deriveLegacyAudioUrl(BASE, undefined, 8081)).toBe(BASE)
	})

	it("only rewrites the exact localhost fallback with the same port", () => {
		for (const base of [
			"https://localhost:8081/stream",
			"http://localhost:8082/stream",
			"http://localhost:8081",
			"http://127.0.0.1:8081/stream",
			"https://radio.example.org/stream",
			"http://localhost:80810/stream",
			"http://localhost:8081@evil/stream",
		])
			expect(deriveLegacyAudioUrl(base, "pi.local", 8081)).toBe(base)
		expect(deriveLegacyAudioUrl(BASE, "pi.local", 0)).toBe(BASE)
		expect(deriveLegacyAudioUrl(BASE, "pi.local", Number.NaN)).toBe(BASE)
	})

	it("refuses names a URL parser would read as IPv4 or reject", () => {
		const base = "http://localhost:8081/stream"
		for (const host of ["a.1", "0x7f.0.0.1", "foo.0x", "x.123", "a.b.0x1f"]) {
			expect(deriveLegacyAudioUrl(base, host, 8081)).toBe(base)
		}
		expect(deriveLegacyAudioUrl(base, "a1.example", 8081)).toBe(
			"http://a1.example:8081/stream",
		)
	})

	it("derives with the default HTTP port 80", () => {
		expect(
			deriveLegacyAudioUrl("http://localhost:80/stream", "pi.local", 80),
		).toBe("http://pi.local:80/stream")
		expect(
			deriveLegacyAudioUrl("http://localhost:80/stream", "10.0.0.5", 80),
		).toBe("http://10.0.0.5:80/stream")
	})

	it("keeps the base path verbatim", () => {
		expect(
			deriveLegacyAudioUrl(
				"http://localhost:8082/decoders/dsd%20x/stream.wav",
				"pi.local",
				8082,
			),
		).toBe("http://pi.local:8082/decoders/dsd%20x/stream.wav")
	})
})

// Feature: web-gaps-9, Property 9: Host derivation is inert
// Validates: Requirements 5.5
describe("Property 9: Host derivation is inert", () => {
	const hostChar = fc.constantFrom(
		..."abcXYZ019-.:[]@/?#%_ \r\n\t,;Kіü".split(""),
	)
	const hostile = fc.oneof(
		fc.string(),
		fc.string({ unit: hostChar, maxLength: 40 }),
		fc.domain(),
		fc.ipV4(),
		fc.ipV6().map(ip => `[${ip}]`),
		fc.ipV6(),
		fc
			.tuple(fc.domain(), fc.integer({ min: 0, max: 99_999 }))
			.map(([d, p]) => `${d}:${String(p)}`),
		fc.webUrl(),
		fc.emailAddress(),
	)
	const DERIVED = /^http:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\]):8081\/stream$/

	it("output is the base or http://<valid host>:<audio port>/stream", () => {
		fc.assert(
			fc.property(hostile, host => {
				const out = deriveLegacyAudioUrl(BASE, host, 8081)
				if (out === BASE) return
				const match = DERIVED.exec(out)
				expect(match).not.toBeNull()
				expect(parseLegacyHost(host)).toBe(match?.[1])
				// The derived URL round-trips through WHATWG URL unchanged in host.
				const url = new URL(out)
				expect(url.port).toBe("8081")
				expect(url.pathname).toBe("/stream")
				expect(url.username).toBe("")
				expect(url.search).toBe("")
			}),
			{ numRuns: 500 },
		)
	})

	it("arrays of hosts never derive", () => {
		fc.assert(
			fc.property(fc.array(hostile, { minLength: 2, maxLength: 4 }), hosts => {
				expect(deriveLegacyAudioUrl(BASE, hosts, 8081)).toBe(BASE)
			}),
			{ numRuns: 100 },
		)
	})

	it("a non-fallback base never changes", () => {
		fc.assert(
			fc.property(fc.webUrl(), hostile, (base, host) => {
				fc.pre(!base.startsWith("http://localhost:8081/"))
				expect(deriveLegacyAudioUrl(base, host, 8081)).toBe(base)
			}),
			{ numRuns: 100 },
		)
	})
})

function liveStatus() {
	return {
		enabled: true,
		running: true,
		sourceId: "s",
		sourceConnected: true,
		sourceIqSampleRate: 2400000,
		config: {
			enabled: true,
			sourceId: "s",
			httpPort: 8081,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: 0,
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 10,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: true,
			offsetHz: 0,
		},
		effectiveSampleRate: 25000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 1,
		bytesStreamed: 5,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
}

function dvStatus() {
	const url = "http://localhost:8082/decoders/dsd%20x/stream"
	return {
		enabled: true,
		running: true,
		config: {
			enabled: true,
			httpPort: 8082,
			voiceSlot: "both",
			jitterBufferMs: 250,
			maxBufferMs: 1000,
		},
		sampleRate: 8000,
		audioFormat: "s16le",
		channels: 1,
		httpUrl: url,
		wavUrl: `${url}.wav`,
		clientCount: 0,
		bytesStreamed: 0,
		decoders: [
			{
				decoderId: "dsd x",
				mode: "auto",
				udpPort: 41234,
				httpUrl: url,
				wavUrl: `${url}.wav`,
				clientCount: 0,
				bytesStreamed: 0,
				datagramsReceived: 0,
				datagramsRejected: 0,
				encryptedDatagramsDropped: 0,
				droppedSamples: 0,
				underruns: 0,
				bufferedMs: 0,
				call: null,
			},
		],
		call: null,
	}
}

// Recorded from the frozen code (5669c187) before the change.
const LIVE_GOLDEN =
	'{"enabled":true,"running":true,"sourceId":"s","sourceConnected":true,"sourceIqSampleRate":2400000,"config":{"enabled":true,"httpPort":8081,"modulation":"nfm","bandwidth":12500,"squelch":0,"noiseReduction":"off","lowPass":0,"highPass":0,"gain":10,"deEmphasis":false,"deEmphasisTau":50,"audioFormat":"s16le","iqDcBlock":true,"sourceId":"s","squelchMode":"manual","autoMarginDb":6,"noiseQuietingDb":6,"offsetHz":0},"effectiveSampleRate":25000,"decimationFactor":96,"httpUrl":"http://localhost:8081/stream","clientCount":1,"bytesStreamed":5,"pipelineHealth":"running","wavUrl":"http://localhost:8081/stream.wav","pipelineRestarts":0}'
const DV_GOLDEN =
	'{"enabled":true,"running":true,"config":{"enabled":true,"httpPort":8082,"voiceSlot":"both","jitterBufferMs":250,"maxBufferMs":1000},"sampleRate":8000,"audioFormat":"s16le","channels":1,"httpUrl":"http://localhost:8082/decoders/dsd%20x/stream","wavUrl":"http://localhost:8082/decoders/dsd%20x/stream.wav","clientCount":0,"bytesStreamed":0,"decoders":[{"decoderId":"dsd x","mode":"auto","udpPort":41234,"httpUrl":"http://localhost:8082/decoders/dsd%20x/stream","wavUrl":"http://localhost:8082/decoders/dsd%20x/stream.wav","clientCount":0,"bytesStreamed":0,"datagramsReceived":0,"datagramsRejected":0,"encryptedDatagramsDropped":0,"droppedSamples":0,"underruns":0,"bufferedMs":0,"call":null}],"call":null}'

describe("legacyAudioHost route option", () => {
	let app: FastifyInstance | undefined
	afterEach(async () => {
		await app?.close()
		app = undefined
	})

	async function build(legacyAudioHost: boolean | undefined) {
		const live = liveStatus()
		const dv = dvStatus()
		const liveDemod = { getStatus: vi.fn(() => live) }
		const digitalVoice = { getStatus: vi.fn(() => dv) }
		const logs: string[] = []
		app = Fastify({
			logger: {
				level: "trace",
				stream: { write: (line: string) => void logs.push(line) },
			},
		})
		await app.register(liveAudioRoutes, {
			liveDemod: liveDemod as never,
			...(legacyAudioHost === undefined ? {} : { legacyAudioHost }),
		})
		await app.register(digitalVoiceRoutes, {
			digitalVoice: digitalVoice as never,
			...(legacyAudioHost === undefined ? {} : { legacyAudioHost }),
		})
		return { app, live, dv, logs }
	}

	it.each([undefined, false])(
		"option %s: byte-identical to the frozen response, no Cache-Control",
		async option => {
			const { app } = await build(option)
			const live = await app.inject({
				method: "GET",
				url: "/api/live-audio/status",
				headers: { host: "pi.local:3000" },
			})
			expect(live.body).toBe(LIVE_GOLDEN)
			expect(live.headers["cache-control"]).toBeUndefined()
			const dv = await app.inject({
				method: "GET",
				url: "/api/digital-voice/status",
				headers: { host: "pi.local:3000" },
			})
			expect(dv.body).toBe(DV_GOLDEN)
			expect(dv.headers["cache-control"]).toBeUndefined()
		},
	)

	it("option true: derives per response, no-store, stored status untouched, host never logged", async () => {
		const { app, live, dv, logs } = await build(true)
		const liveBefore = structuredClone(live)
		const dvBefore = structuredClone(dv)
		const res = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
			headers: { host: "pi.local:3000" },
		})
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.body).toBe(
			LIVE_GOLDEN.replaceAll("localhost:8081", "pi.local:8081"),
		)
		const dvRes = await app.inject({
			method: "GET",
			url: "/api/digital-voice/status",
			headers: { host: "[fe80::1]:3000" },
		})
		expect(dvRes.headers["cache-control"]).toBe("no-store")
		expect(dvRes.body).toBe(
			DV_GOLDEN.replaceAll("localhost:8082", "[fe80::1]:8082"),
		)
		expect(live).toEqual(liveBefore)
		expect(dv).toEqual(dvBefore)
		const logged = logs.join("")
		expect(logged).not.toContain("pi.local:8081")
		expect(logged).not.toContain("[fe80::1]:8082")
	})

	it("option true with a hostile Host: frozen body, no Cache-Control", async () => {
		const { app } = await build(true)
		for (const host of ["user@evil", "a.local/x", "fe80::1", "a,b"]) {
			const res = await app.inject({
				method: "GET",
				url: "/api/live-audio/status",
				headers: { host },
			})
			expect(res.body).toBe(LIVE_GOLDEN)
			expect(res.headers["cache-control"]).toBeUndefined()
		}
	})

	it("option true with several Host headers: frozen body", async () => {
		const { app } = await build(true)
		app.addHook("onRequest", async request => {
			// light-my-request merges headers; emulate a wire request with two Host lines.
			Object.defineProperty(request.raw, "rawHeaders", {
				value: ["Host", "pi.local", "Host", "evil.example"],
			})
		})
		for (const url of ["/api/live-audio/status", "/api/digital-voice/status"]) {
			const res = await app.inject({
				method: "GET",
				url,
				headers: { host: "pi.local" },
			})
			expect(res.body).toBe(url.includes("live") ? LIVE_GOLDEN : DV_GOLDEN)
			expect(res.headers["cache-control"]).toBeUndefined()
		}
	})

	it("option true never reads X-Forwarded-Host", async () => {
		const { app } = await build(true)
		const res = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
			headers: { host: "a,b", "x-forwarded-host": "evil.example" },
		})
		expect(res.body).toBe(LIVE_GOLDEN)
	})
})
