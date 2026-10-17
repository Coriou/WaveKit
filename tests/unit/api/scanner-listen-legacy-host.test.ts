/**
 * WG9 req 5.5: the scanner listen answer's localhost fallback stream URLs follow the
 * request Host per response when the route option is set; otherwise they are unchanged.
 */

import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { deriveLegacyAudioUrlFromBase } from "../../../src/api/routes/legacy-audio-host.js"

const stored = {
	mode: "live-audio",
	sourceId: "rtl",
	frequencyHz: 446_056_250,
	offsetHz: 55_970,
	httpUrl: "http://localhost:8081/stream",
	wavUrl: "http://localhost:8081/stream.wav",
}

async function app(legacyAudioHost?: boolean, result: object = stored) {
	const listen = vi.fn(() => Promise.resolve({ ...result }))
	const fastify = Fastify({ logger: false })
	await fastify.register(scannerRoutes, {
		scanner: { listen } as unknown as ScannerRouteService,
		...(legacyAudioHost === undefined ? {} : { legacyAudioHost }),
	})
	return fastify
}

const post = (f: Awaited<ReturnType<typeof app>>, host: string) =>
	f.inject({
		method: "POST",
		url: "/api/scanner/discoveries/d_1/listen",
		headers: { host },
	})

describe("scanner listen legacy host (WG9 5.5)", () => {
	it("derives both URLs from the Host and marks the answer no-store", async () => {
		const res = await post(await app(true), "receiver.lan:9000")
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.json()).toEqual({
			...stored,
			httpUrl: "http://receiver.lan:8081/stream",
			wavUrl: "http://receiver.lan:8081/stream.wav",
		})
	})

	it("is byte-identical without the option", async () => {
		const res = await post(await app(), "receiver.lan:9000")
		expect(res.body).toBe(JSON.stringify(stored))
		expect(res.headers["cache-control"]).toBeUndefined()
	})

	it.each(["localhost:9000", "bad host", "a.1", "0x7f.0.0.1"])(
		"keeps the stored URLs for Host %s",
		async host => {
			const res = await post(await app(true), host)
			expect(res.json()).toEqual(stored)
			expect(res.headers["cache-control"]).toBeUndefined()
		},
	)

	it("leaves a configured public origin untouched", async () => {
		const configured = {
			...stored,
			httpUrl: "https://audio.example:9001/stream",
			wavUrl: "https://audio.example:9001/stream.wav",
		}
		const res = await post(await app(true, configured), "receiver.lan:9000")
		expect(res.json()).toEqual(configured)
	})

	it("reads the port from the URL and refuses a non-localhost or malformed base", () => {
		expect(
			deriveLegacyAudioUrlFromBase("http://localhost:80/stream", "pi.lan"),
		).toBe("http://pi.lan:80/stream")
		for (const base of [
			"http://localhost/stream",
			"http://localhost:0/stream",
			"http://localhost:99999/stream",
			"http://127.0.0.1:8081/stream",
			"https://localhost:8081/stream",
		])
			expect(deriveLegacyAudioUrlFromBase(base, "pi.lan")).toBe(base)
	})
})
