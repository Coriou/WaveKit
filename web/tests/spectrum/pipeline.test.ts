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

function setup(withCanvas: boolean, texWidth = MAX_BINS) {
	const posted: { msg: WorkerToMain; transfer: Transferable[] }[] = []
	const subs: (SpectrumSubscription | null)[] = []
	const renderer = new FakeRenderer()
	const frames = new FakeFrames()
	const timers = new FakeTimers()
	let handlers: SocketHandlers | null = null
	const widths: number[] = []
	const pipeline = new SpectrumPipeline({
		post: (msg, transfer) => posted.push({ msg, transfer: transfer ?? [] }),
		openSocket: (_url, h) => {
			handlers = h
			return { setSubscription: s => subs.push(s), dispose: () => {} }
		},
		createRenderer: (_canvas, width) => {
			widths.push(width)
			return renderer
		},
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
		texWidth,
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
		widths,
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

	it("takes rows as wide as the texture it was given (FFT size above 2048)", () => {
		const t = setup(true, 8192)
		expect(t.widths).toEqual([8192])
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: new Array<number>(6553).fill(40) }),
		})
		expect(t.renderer.rows.map(r => r.count)).toEqual([6553])
		// never narrower than the default
		expect(setup(true, 512).widths).toEqual([MAX_BINS])
		const fallback = setup(false, 8192)
		fallback.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ bytes: new Array<number>(6553).fill(40) }),
		})
		const row = fallback.ofType("row")[0]
		expect(row?.binCount).toBe(6553)
		expect(row?.buffer.byteLength).toBe(8192)
	})

	it("ignores frames of other sources (default selection fan-out)", () => {
		const t = setup(true)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ sourceId: "pi" }),
		})
		expect(t.renderer.rows.length).toBe(0)
	})

	it("resets on a spectrum:profile for another profile, and flushes meta at once", () => {
		const t = setup(true)
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		t.pipeline.onServer({
			type: "spectrum:profile",
			data: {
				selection: "source",
				sourceId: "rtl",
				profile: { key: "10:512", hz: 10, bins: 512 },
				effectiveHz: null,
				outcome: "nearest",
				adjusted: [],
			},
		})
		expect(t.ofType("reset").map(r => r.reason)).toEqual(["profile"])
		const metaBefore = t.ofType("meta").length
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ profile: "10:512", tuningTrust: "unverified" }),
		})
		expect(t.ofType("meta").length).toBe(metaBefore + 1)
		expect(t.ofType("meta").at(-1)?.meta.tuningTrust).toBe("unverified")
		t.frames.tick()
		expect(t.renderer.draws.at(-1)?.filled).toBe(1)
	})

	it("keeps the waterfall across a new epoch on the same axis and sends its meta at once", () => {
		const t = setup(true)
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		t.pipeline.onServer({ type: "spectrum:frame", data: frame({}) })
		const metaBefore = t.ofType("meta").length
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ epoch: 2, tuningTrust: "unverified" }),
		})
		expect(t.ofType("reset")).toEqual([])
		expect(t.ofType("meta").length).toBe(metaBefore + 1)
		expect(t.ofType("meta").at(-1)?.meta.epoch).toBe(2)
		t.frames.tick()
		expect(t.renderer.draws.at(-1)?.filled).toBe(3)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ epoch: 3, startHz: 446_000_000 }),
		})
		// A retune keeps the rows too (each at its own frequency); a new bin width does not.
		expect(t.ofType("reset")).toEqual([])
		t.frames.tick()
		expect(t.renderer.draws.at(-1)?.filled).toBe(4)
		t.pipeline.onServer({
			type: "spectrum:frame",
			data: frame({ epoch: 3, binHz: 2000 }),
		})
		expect(t.ofType("reset").map(r => r.reason)).toEqual(["axis"])
	})

	it("keeps the waterfall when a reconnect acks the same profile, and skips replayed rows", () => {
		const t = setup(true)
		const at = (s: number) => `2026-10-16T12:00:0${s}.000Z`
		for (const s of [0, 1, 2])
			t.pipeline.onServer({
				type: "spectrum:frame",
				data: frame({ at: at(s) }),
			})
		t.pipeline.onServer({
			type: "spectrum:profile",
			data: {
				selection: "source",
				sourceId: "rtl",
				profile: { key: "25:2048", hz: 25, bins: 2048 },
				effectiveHz: 25,
				outcome: "exact",
				adjusted: [],
				backfillFrames: 3,
			},
		})
		expect(t.ofType("reset")).toEqual([])
		// Backfill replays 1 and 2 (held), then 3 and 4 are new.
		for (const s of [1, 2, 3, 4])
			t.pipeline.onServer({
				type: "spectrum:frame",
				data: frame({ at: at(s) }),
			})
		t.frames.tick()
		expect(t.renderer.draws.at(-1)?.filled).toBe(5)
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
