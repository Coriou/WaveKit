import { describe, expect, it } from "vitest"
import { SpectrumPipeline } from "../../src/spectrum/pipeline.ts"
import {
	DEFAULT_LAYOUT,
	DEFAULT_LEVELS,
	MAX_BINS,
	type MainToWorker,
	type SpectrumSubscription,
	type WorkerToMain,
} from "../../src/spectrum/protocol.ts"
import type { SocketHandlers } from "../../src/spectrum/socket.ts"
import { FakeFrames, FakeRenderer, FakeTimers } from "./fakes.ts"
import { frame } from "./frames.ts"

function setup(withCanvas: boolean) {
	const posted: { msg: WorkerToMain; transfer: Transferable[] }[] = []
	const subs: (SpectrumSubscription | null)[] = []
	const renderer = new FakeRenderer()
	const frames = new FakeFrames()
	const timers = new FakeTimers()
	let handlers: SocketHandlers | null = null
	const pipeline = new SpectrumPipeline({
		post: (msg, transfer) => posted.push({ msg, transfer: transfer ?? [] }),
		openSocket: (_url, h) => {
			handlers = h
			return { setSubscription: s => subs.push(s), dispose: () => {} }
		},
		createRenderer: () => renderer,
		frame: frames,
		timers,
	})
	const init: MainToWorker = {
		type: "init",
		wsUrl: "ws://x/ws",
		size: { widthCss: 100, heightCss: 100, dpr: 1 },
		layout: DEFAULT_LAYOUT,
		levels: DEFAULT_LEVELS,
		ramp: new Uint8Array(1024),
		historyRows: 16,
		...(withCanvas ? { canvas: {} as OffscreenCanvas } : {}),
	}
	pipeline.handle(init)
	pipeline.handle({
		type: "subscribe",
		subscription: { sourceId: "rtl", hz: 25, bins: 2048 },
	})
	posted.length = 0
	const ofType = <T extends WorkerToMain["type"]>(type: T) =>
		posted
			.filter(p => p.msg.type === type)
			.map(p => p.msg as Extract<WorkerToMain, { type: T }>)
	return {
		pipeline,
		posted,
		subs,
		renderer,
		frames,
		timers,
		ofType,
		handlers: () => handlers,
	}
}

describe("SpectrumPipeline (OffscreenCanvas path)", () => {
	it("subscribes, decodes frames onto the GPU and renders once per animation frame", () => {
		const t = setup(true)
		expect(t.subs).toEqual([{ sourceId: "rtl", hz: 25, bins: 2048 }])
		expect(t.pipeline.rendering).toBe(true)
		for (let i = 0; i < 3; i++)
			t.pipeline.onServer({
				type: "spectrum:frame",
				data: frame({ bytes: [i + 1, 2, 3] }),
			})
		expect(t.renderer.rows.map(r => [r.index, r.first, r.count])).toEqual([
			[0, 1, 3],
			[1, 2, 3],
			[2, 3, 3],
		])
		expect(t.renderer.draws.length).toBe(0)
		t.frames.tick()
		expect(t.renderer.draws.length).toBe(1)
		expect(t.ofType("row")).toEqual([])
	})

	it("ignores frames of other sources (default selection fan-out)", () => {
		const t = setup(true)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ sourceId: "pi" }),
		})
		expect(t.renderer.rows.length).toBe(0)
	})

	it("resets on spectrum:profile and on an epoch change, and flushes meta at once", () => {
		const t = setup(true)
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		t.pipeline.onServer({
			type: "spectrum:profile",
			data: {
				selection: "source",
				sourceId: "rtl",
				profile: null,
				effectiveHz: null,
				outcome: "exact",
				adjusted: [],
			},
		})
		expect(t.ofType("reset").map(r => r.reason)).toEqual(["profile"])
		const metaBefore = t.ofType("meta").length
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ tuningTrust: "unverified" }),
		})
		expect(t.ofType("meta").length).toBe(metaBefore + 1)
		expect(t.ofType("meta").at(-1)?.meta.tuningTrust).toBe("unverified")
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({ epoch: 2 }) })
		expect(t.ofType("reset").map(r => r.reason)).toEqual(["profile", "epoch"])
		t.frames.tick()
		expect(t.renderer.draws.at(-1)?.filled).toBe(1)
	})

	it("throttles meta to ≤ 10 per second at 25 frames per second", () => {
		const t = setup(true)
		for (let i = 0; i < 25; i++) {
			t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
			t.timers.advance(40)
		}
		t.timers.advance(200)
		const n = t.ofType("meta").length
		expect(n).toBeGreaterThanOrEqual(9)
		expect(n).toBeLessThanOrEqual(11)
	})

	it("resets when the subscribed source changes and resubscribes", () => {
		const t = setup(true)
		t.pipeline.handle({
			type: "subscribe",
			subscription: { sourceId: "rtl", hz: 25, bins: 2048 },
		})
		expect(t.subs.length).toBe(1)
		t.pipeline.handle({ type: "subscribe", subscription: { sourceId: "pi" } })
		expect(t.subs.at(-1)).toEqual({ sourceId: "pi" })
		expect(t.ofType("reset").map(r => r.reason)).toEqual(["subscription"])
	})

	it("drops a frame whose bins do not decode and reports it once", () => {
		const t = setup(true)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: { ...frame({}), bins: "@@@@" },
		})
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: { ...frame({}), bins: "@@@@" },
		})
		expect(t.renderer.rows.length).toBe(0)
		expect(t.ofType("error").length).toBe(1)
	})
})

describe("SpectrumPipeline (fallback path)", () => {
	it("posts rows as transferable buffers and reuses recycled ones", () => {
		const t = setup(false)
		expect(t.pipeline.rendering).toBe(false)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: [5, 6, 7] }),
		})
		const first = t.posted.find(p => p.msg.type === "row")
		expect(first).toBeDefined()
		const row = first?.msg as Extract<WorkerToMain, { type: "row" }>
		expect(first?.transfer).toEqual([row.buffer])
		expect(row.binCount).toBe(3)
		expect(Array.from(new Uint8Array(row.buffer, 0, 3))).toEqual([5, 6, 7])
		t.pipeline.handle({ type: "recycle", buffer: row.buffer })
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: [8, 9, 10] }),
		})
		expect(t.ofType("row").at(-1)?.buffer).toBe(row.buffer)
	})

	it("bounds rows in flight when the main thread falls behind", () => {
		const t = setup(false)
		for (let i = 0; i < 20; i++)
			t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		expect(t.ofType("row").length).toBe(8)
		expect(t.ofType("row")[0]?.buffer.byteLength).toBe(MAX_BINS)
	})
})

describe("SpectrumPipeline probe", () => {
	it("answers with the newest row's peak, null before any row", () => {
		const t = setup(true)
		t.pipeline.handle({
			type: "probe",
			id: 1,
			startHz: 445_000_000,
			endHz: 445_001_000,
		})
		expect(t.ofType("probe")).toEqual([{ type: "probe", id: 1, db: null }])
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: [10, 20, 30, 40] }),
		})
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: [50, 60, 70, 80] }),
		})
		// bins of 1 kHz from 445.000 MHz: [445.001, 445.003) covers bins 1 and 2 of the newest row
		t.pipeline.handle({
			type: "probe",
			id: 2,
			startHz: 445_001_000,
			endHz: 445_003_000,
		})
		expect(t.ofType("probe")[1]).toEqual({
			type: "probe",
			id: 2,
			db: 70 / 2 - 127.5,
		})
	})
})
