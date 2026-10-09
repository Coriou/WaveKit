import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connect } from "node:net"
import WebSocket from "ws"
import { loadScenario } from "../scenarios.js"
import { SCENARIO_NAMES } from "../scenario-types.js"
import { resolveScenario, startMockServer } from "./server.js"

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
	port = server.port,
): Promise<Frame[]> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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

/** Subscribes and collects every frame for `ms` after the subscribe ack. */
function collectFor(
	channels: string[],
	ms: number,
	afterAck?: () => Promise<unknown>,
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
			if (f.type !== "subscribed") return
			void (afterAck ? afterAck() : Promise.resolve()).then(() =>
				setTimeout(() => {
					ws.terminate()
					resolve(frames)
				}, ms),
			)
		})
	})
}
const post = (path: string, body?: unknown) =>
	fetch(`${base()}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	})

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
			f =>
				f.type === "decoder:status" &&
				f.data["id"] === "direwolf" &&
				f.data["running"] === false,
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
	it("does not replay recorded frames after a WS drop until the next scenario load", async () => {
		const outputs = (fs: Frame[]) =>
			fs.filter(f => f.type === "decoder:output").length
		expect(outputs(await collectFor(["decoders"], 200))).toBeGreaterThan(0)
		await control("ws", { mode: "drop" })
		await control("ws", { mode: "up" })
		expect(outputs(await collectFor(["decoders"], 300))).toBe(0)
		await control("scenario", { name: "live" })
		expect(outputs(await collectFor(["decoders"], 200))).toBeGreaterThan(0)
	})
	it("pushes a new scenario's frames to connected clients", async () => {
		const frames = await collectFor(["decoders", "sources"], 300, () =>
			control("scenario", { name: "burst" }),
		)
		const ids = frames
			.filter(f => f.type === "decoder:output")
			.map(f => f.data["decoderId"])
		expect(ids).toContain("direwolf")
		const status = frames.filter(f => f.type === "source:status").pop()
		expect(
			(status?.data["caps"] as Record<string, unknown>)["centerFreq"],
		).toBe(1090000000)
		await control("scenario", { name: "live" })
	})
	it("records writes even when the REST mode fails them", async () => {
		await fetch(`${base()}/__mock/reset`, { method: "POST" })
		await control("rest", { mode: "fail" })
		await expect(post("/api/decoders/readsb/restart")).rejects.toThrow()
		await control("rest", { mode: "500" })
		expect((await post("/api/live-audio/start")).status).toBe(500)
		await control("rest", { mode: "ok" })
		const calls = await get<Array<{ path: string }>>("/__mock/calls")
		expect(calls.map(c => c.path)).toEqual([
			"/api/decoders/readsb/restart",
			"/api/live-audio/start",
		])
	})
	it("answers bad input with 400 and never reads outside the scenario directory", async () => {
		const r = await fetch(`${base()}/api/decoders/%E0%A4%A`)
		expect(r.status).toBe(400)
		expect(((await r.json()) as { code: string }).code).toBe("FST_ERR_BAD_URL")
		for (const name of ["../../../package", "nope", 7]) {
			expect((await control("scenario", { name })).status).toBe(400)
		}
		expect((await control("ws", { mode: "bogus" })).status).toBe(400)
		expect((await control("rest", {})).status).toBe(400)
		expect((await control("fanout", { dropPercent: 140 })).status).toBe(400)
		expect((await control("burst", { perSecond: -1 })).status).toBe(400)
		expect((await control("source", { state: "gone" })).status).toBe(400)
		expect((await get<{ status: string }>("/health")).status).toBe("ok")
	})
	it("rejects when the port is taken or invalid", async () => {
		await expect(
			startMockServer({ port: server.port, scenario: "live" }),
		).rejects.toThrow(/EADDRINUSE/)
		await expect(
			startMockServer({ port: 70000, scenario: "live" }),
		).rejects.toThrow(/invalid port/)
		await expect(
			startMockServer({ port: 0, scenario: "../x" }),
		).rejects.toThrow(/unknown scenario/)
	})
	it("emits tuner:command-sent with core command names and numeric values", async () => {
		const frames = await collectFor(["tuner"], 300, async () => {
			await post("/api/tuner/pi-iq/control-mode", { mode: "internal" })
			await post("/api/tuner/pi-iq/frequency", { hz: 446000000 })
			await post("/api/tuner/pi-iq/ppm", { ppm: -3 })
			await post("/api/tuner/pi-iq/gain-mode", { mode: "agc" })
		})
		const sent = frames
			.filter(f => f.type === "tuner:command-sent")
			.map(f => [f.data["command"], f.data["value"]])
		expect(sent).toEqual([
			["set-frequency", 446000000],
			["set-freq-correction", 4294967293],
			["set-gain-mode", 0],
		])
		await control("scenario", { name: "live" })
	})
	it("stops IQ while the source is stale and resumes when it streams", async () => {
		const frames = await collectFor(["sources"], 100, () =>
			control("source", { state: "stale" }),
		)
		const last = frames.filter(f => f.type === "source:status").pop()
		expect((last?.data["activity"] as Record<string, unknown>)["state"]).toBe(
			"stale",
		)
		const f1 = await get<{ totalBytesWritten: number }>("/api/telemetry/fanout")
		await new Promise(r => setTimeout(r, 300))
		const f2 = await get<{ totalBytesWritten: number }>("/api/telemetry/fanout")
		expect(f2.totalBytesWritten).toBe(f1.totalBytesWritten)
		await control("source", { state: "disconnected" })
		expect(
			(await get<Array<Record<string, unknown>>>("/api/sources"))[0]?.[
				"connected"
			],
		).toBe(false)
		await control("source", { state: "streaming" })
		await new Promise(r => setTimeout(r, 300))
		const f3 = await get<{ totalBytesWritten: number }>("/api/telemetry/fanout")
		expect(f3.totalBytesWritten).toBeGreaterThan(f2.totalBytesWritten)
		await control("scenario", { name: "live" })
	})
	it("animates crash-loop restarts from the history and keeps restarting", async () => {
		const crash = await startMockServer({
			port: 0,
			scenario: "crash-loop",
			historyStepMs: 100,
			crashEveryMs: 250,
		})
		try {
			const first = (await (
				await fetch(`http://127.0.0.1:${crash.port}/api/decoders/acarsdec`)
			).json()) as { restartCount: number }
			expect(first.restartCount).toBe(10)
			const frames = await collect(
				["decoders"],
				f =>
					f.type === "decoder:status" &&
					f.data["id"] === "acarsdec" &&
					Number(f.data["restartCount"]) >= 14,
				undefined,
				crash.port,
			)
			const counts = frames
				.filter(f => f.type === "decoder:status" && f.data["id"] === "acarsdec")
				.map(f => f.data["restartCount"])
			// The replayed status shows the live count; then one decoder:status per restart.
			expect(Number(counts[0])).toBeLessThanOrEqual(11)
			counts.slice(1).forEach((c, i) => expect(c).toBe(Number(counts[i]) + 1))
			expect(counts[counts.length - 1]).toBe(14)
		} finally {
			await crash.close()
		}
	})
	it("starts non-crash-looping decoders at the scenario's current values", async () => {
		await control("scenario", { name: "live" })
		const dsd = await get<{ stats: { eventsOut: number } }>(
			"/api/decoders/dsd-fme",
		)
		expect(dsd.stats.eventsOut).toBe(3)
	})
	it("does not replay on load when the scenario's WS starts closed", async () => {
		await control("scenario", { name: "rest-only" })
		await control("ws", { mode: "up" })
		const frames = await collectFor(["decoders"], 200)
		expect(frames.filter(f => f.type === "decoder:output")).toHaveLength(0)
		await control("scenario", { name: "live" })
	})
	it("refuses an upgrade with an unparsable request target and keeps serving", async () => {
		const closed = await new Promise<boolean>(resolve => {
			const sock = connect(server.port, "127.0.0.1", () => {
				sock.write(
					"GET http://[bad HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
				)
			})
			sock.on("close", () => resolve(true))
			sock.on("error", () => resolve(true))
			setTimeout(() => {
				sock.destroy()
				resolve(false)
			}, 2000)
		})
		expect(closed).toBe(true)
		expect((await get<{ status: string }>("/health")).status).toBe("ok")
	})
	it("an operator restart during the history ends that decoder's crash loop", async () => {
		const crash = await startMockServer({
			port: 0,
			scenario: "crash-loop",
			historyStepMs: 150,
			crashEveryMs: 200,
		})
		const at = (p: string) => `http://127.0.0.1:${crash.port}${p}`
		try {
			const dsd = (await (await fetch(at("/api/decoders/dsd-fme"))).json()) as {
				stats: { eventsOut: number }
			}
			expect(dsd.stats.eventsOut).toBe(3)
			expect(
				(await fetch(at("/api/decoders/acarsdec/restart"), { method: "POST" }))
					.status,
			).toBe(200)
			await new Promise(r => setTimeout(r, 900))
			const acars = (await (
				await fetch(at("/api/decoders/acarsdec"))
			).json()) as {
				restartCount: number
			}
			expect(acars.restartCount).toBe(0)
		} finally {
			await crash.close()
		}
	})
	it("resolves scenario times exactly like the loader (I9)", () => {
		for (const name of SCENARIO_NAMES) {
			const mock = resolveScenario(name) as {
				rest: Record<string, { body?: unknown }>
				ws: Array<{ type: string; data: unknown }>
			}
			const loader = loadScenario(name)
			for (const path of [
				"/api/decoders",
				"/api/sources",
				"/api/tuner-relay",
				"/api/live-audio/status",
			])
				expect(mock.rest[path]?.body, `${name} ${path}`).toEqual(
					loader.rest[path]?.body,
				)
			const outputs = (ws: Array<{ type: string; data: unknown }>) =>
				ws.filter(f => f.type === "decoder:output").map(f => f.data)
			expect(outputs(mock.ws), name).toEqual(outputs(loader.ws))
		}
	})
})
