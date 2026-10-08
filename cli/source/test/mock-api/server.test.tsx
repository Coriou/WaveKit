import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { startMockServer } from "./server.js"

let server: { port: number; close(): Promise<void> }
const base = () => `http://127.0.0.1:${server.port}`
const get = async <T,>(path: string): Promise<T> =>
	(await (await fetch(`${base()}${path}`)).json()) as T
const control = (path: string, body: unknown) =>
	fetch(`${base()}/__mock/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})

interface Frame {
	type: string
	channel?: string
	data: Record<string, unknown>
}

/** Opens /ws, subscribes, and collects frames until `done` returns true for one of them. */
function collect(
	channels: string[],
	done: (f: Frame) => boolean,
	before?: () => Promise<unknown>,
): Promise<Frame[]> {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
	const frames: Frame[] = []
	return new Promise<Frame[]>((resolve, reject) => {
		ws.on("error", reject)
		ws.on("open", () =>
			ws.send(JSON.stringify({ type: "subscribe", channels })),
		)
		ws.on("message", (d: WebSocket.RawData) => {
			const f = JSON.parse(d.toString()) as Frame
			frames.push(f)
			if (f.type === "subscribed" && before) void before()
			if (done(f)) {
				ws.terminate()
				resolve(frames)
			}
		})
	})
}

beforeAll(async () => {
	server = await startMockServer({ port: 0, scenario: "live" })
})
afterAll(async () => {
	await server.close()
})

describe("mock core", () => {
	it("serves REST from the scenario and evolves fanout counters", async () => {
		const health = await get<{ status: string }>("/health")
		expect(health.status).toBe("ok")
		const decoders = await get<unknown[]>("/api/decoders")
		expect(decoders).toHaveLength(9)
		const f1 = await get<{ totalBytesWritten: number }>("/api/telemetry/fanout")
		await new Promise(r => setTimeout(r, 1100))
		const f2 = await get<{ totalBytesWritten: number }>("/api/telemetry/fanout")
		expect(f2.totalBytesWritten).toBeGreaterThan(f1.totalBytesWritten)
	})
	it("keeps the scenario's branch drop ratios and backpressure set", async () => {
		const f = await get<{
			backpressureActiveCount: number
			branches: Array<{ id: string; backpressureActive: boolean }>
		}>("/api/telemetry/fanout")
		expect(f.backpressureActiveCount).toBe(4)
		expect(f.branches.filter(b => b.backpressureActive).map(b => b.id)).toEqual(
			[
				"decoder-rtl433",
				"decoder-readsb",
				"decoder-ais-catcher",
				"decoder-dumpvdl2",
			],
		)
	})
	it("shifts fixture times so ages are relative to the moment the scenario loaded", async () => {
		const decoders =
			await get<Array<{ id: string; lastOutputAt: string | null }>>(
				"/api/decoders",
			)
		const at = Date.parse(
			decoders.find(d => d.id === "dsd-fme")?.lastOutputAt ?? "",
		)
		expect(Date.now() - at).toBeGreaterThan(10_000)
		expect(Date.now() - at).toBeLessThan(20_000)
	})
	it("records writes and refuses tuner commands under external control", async () => {
		const r = await fetch(`${base()}/api/tuner/pi-iq/frequency`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"hz":446000000}',
		})
		expect(r.status).toBe(409)
		expect(((await r.json()) as { code: string }).code).toBe(
			"TUNER_CONTROL_EXTERNAL",
		)
		const calls = await get<Array<{ path: string }>>("/__mock/calls")
		expect(calls.map(c => c.path)).toContain("/api/tuner/pi-iq/frequency")
	})
	it("acks subscribe on /ws and pushes fanout snapshots", async () => {
		const frames = await collect(
			["fanout", "decoders"],
			f => f.type === "fanout:snapshot",
		)
		expect(frames[0]?.type).toBe("subscribed")
	})
	it("sends a source:status snapshot to sources subscribers", async () => {
		const frames = await collect(["sources"], f => f.type === "source:status")
		const s = frames.find(f => f.type === "source:status")
		expect(s?.channel).toBe("sources")
		expect(s?.data["id"]).toBe("pi-iq")
		expect(s?.data["activity"]).toBeDefined()
	})
	it("stops a decoder, emits decoder:stopped and a final decoder:status, and 409s a second stop", async () => {
		const stop = () =>
			fetch(`${base()}/api/decoders/direwolf/stop`, { method: "POST" })
		let first: Response | undefined
		const frames = await collect(
			["decoders"],
			f => f.type === "decoder:status" && f.data["running"] === false,
			async () => {
				first = await stop()
			},
		)
		expect(first?.status).toBe(200)
		expect(
			frames.some(
				f => f.type === "decoder:stopped" && f.data["decoderId"] === "direwolf",
			),
		).toBe(true)
		expect((await stop()).status).toBe(409)
		expect(
			(await fetch(`${base()}/api/decoders/direwolf/start`, { method: "POST" }))
				.status,
		).toBe(200)
	})
	it("switches REST failure modes", async () => {
		await control("rest", { mode: "500" })
		expect((await fetch(`${base()}/api/status`)).status).toBe(500)
		await control("rest", { mode: "ok" })
		expect((await fetch(`${base()}/api/status`)).status).toBe(200)
	})
	it("serves an older core for the legacy scenario", async () => {
		await control("scenario", { name: "legacy" })
		const sources = await get<Array<Record<string, unknown>>>("/api/sources")
		expect(sources[0]?.["activity"]).toBeUndefined()
		const fanout = await get<Record<string, unknown>>("/api/telemetry/fanout")
		expect(JSON.stringify(fanout)).not.toContain("totalBytesWritten")
		const decoders = await get<Array<Record<string, unknown>>>("/api/decoders")
		expect(
			decoders.some(
				d => "idleTimeoutMs" in d || "lastError" in d || "sourceId" in d,
			),
		).toBe(false)
		await control("scenario", { name: "live" })
		expect(
			(await get<Array<Record<string, unknown>>>("/api/sources"))[0]?.[
				"activity"
			],
		).toBeDefined()
	})
	it("applies the scenario's connection state on load", async () => {
		await control("scenario", { name: "rest-only" })
		await expect(
			new Promise((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
				ws.on("open", () => reject(new Error("ws opened")))
				ws.on("error", resolve)
			}),
		).resolves.toBeDefined()
		expect((await fetch(`${base()}/api/decoders`)).status).toBe(200)
		await control("scenario", { name: "live" })
	})
})
