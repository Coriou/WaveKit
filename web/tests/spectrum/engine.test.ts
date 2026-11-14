import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MainToWorker, WorkerToMain } from "../../src/spectrum/protocol.ts"

class FakeWorker {
	static last: FakeWorker | null = null
	posted: MainToWorker[] = []
	onmessage: ((event: { data: WorkerToMain }) => void) | null = null
	onerror: unknown = null
	constructor() {
		FakeWorker.last = this
	}
	postMessage(message: MainToWorker): void {
		this.posted.push(message)
	}
	terminate(): void {}
	/** A message from the worker. */
	says(message: WorkerToMain): void {
		this.onmessage?.({ data: message })
	}
}

const context2d = () => ({
	canvas: { width: 0, height: 0 },
	clearRect: () => {},
	beginPath: () => {},
	moveTo: () => {},
	lineTo: () => {},
	stroke: () => {},
	drawImage: () => {},
	putImageData: () => {},
	createImageData: (width: number, height: number) => ({
		width,
		height,
		data: new Uint8ClampedArray(width * height * 4),
	}),
})

interface Browser {
	/** OffscreenCanvas contexts this browser gives; absent: no OffscreenCanvas at all. */
	offscreen?: { webgl2: boolean; twoD: boolean }
	/** A 2D context on the page's canvas. */
	page2d: boolean
}

/** A browser as the engine sees it; the page never has WebGL2 here (that path is the real renderer's). */
async function engineIn(browser: Browser) {
	vi.resetModules()
	FakeWorker.last = null
	vi.stubGlobal("Worker", FakeWorker)
	vi.stubGlobal("location", { href: "http://127.0.0.1:1/" })
	vi.stubGlobal("document", {
		createElement: () => ({
			width: 0,
			height: 0,
			getContext: (kind: string) => (kind === "2d" ? context2d() : null),
		}),
	})
	vi.stubGlobal(
		"HTMLCanvasElement",
		class {
			transferControlToOffscreen(): void {}
		},
	)
	const offscreen = browser.offscreen
	if (offscreen)
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				getContext(kind: string): unknown {
					if (kind === "webgl2")
						return offscreen.webgl2 ? { getExtension: () => null } : null
					return kind === "2d" && offscreen.twoD ? {} : null
				}
			},
		)
	const canvas = {
		clientWidth: 100,
		clientHeight: 100,
		getContext: (kind: string) =>
			kind === "2d" && browser.page2d ? context2d() : null,
		transferControlToOffscreen: () => ({ transferred: true }),
	}
	const { SpectrumEngine } = await import("../../src/spectrum/engine.ts")
	const engine = new SpectrumEngine(canvas as unknown as HTMLCanvasElement)
	const worker = FakeWorker.last as FakeWorker | null
	if (!worker) throw new Error("no worker")
	const init = worker.posted.find(m => m.type === "init")
	return { engine, worker, transferred: init?.type === "init" && !!init.canvas }
}

describe("SpectrumEngine: where and with what it draws", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("draws in the worker with WebGL2 when the browser has it there", async () => {
		const t = await engineIn({
			offscreen: { webgl2: true, twoD: true },
			page2d: true,
		})
		expect(t.engine.mode).toBe("offscreen")
		expect(t.transferred).toBe(true)
		// until the worker says, nothing draws yet, and the readout says so
		expect(t.engine.health()).toMatchObject({
			rendererKind: "none",
			rendererThread: "worker",
			reason: "The renderer is starting",
		})
		t.worker.says({ type: "renderer", kind: "webgl2" })
		expect(t.engine.health()).toMatchObject({
			rendererKind: "webgl2",
			reason: null,
		})
	})

	it("without WebGL2 still draws in the worker, on a 2D canvas, when it can be transferred", async () => {
		const t = await engineIn({
			offscreen: { webgl2: false, twoD: true },
			page2d: true,
		})
		expect(t.engine.mode).toBe("offscreen")
		expect(t.transferred).toBe(true)
		const seen: unknown[] = []
		t.engine.onStatus(status => seen.push(status))
		t.worker.says({
			type: "renderer",
			kind: "canvas2d",
			reason: "no WebGL2",
		})
		expect(seen).toEqual([
			{ type: "renderer", kind: "canvas2d", reason: "no WebGL2" },
		])
		expect(t.engine.health()).toMatchObject({
			rendererKind: "canvas2d",
			rendererThread: "worker",
			reason: "no WebGL2",
		})
	})

	it("without any OffscreenCanvas draws on the page with a 2D canvas, and tells a listener at once", async () => {
		const t = await engineIn({ page2d: true })
		expect(t.engine.mode).toBe("main")
		expect(t.transferred).toBe(false)
		const seen: { type: string; kind?: string }[] = []
		t.engine.onStatus(status => seen.push(status))
		expect(seen).toEqual([
			{
				type: "renderer",
				kind: "canvas2d",
				reason: expect.stringContaining("WebGL2 is unavailable"),
			},
		])
		expect(t.engine.health()).toMatchObject({
			rendererKind: "canvas2d",
			rendererThread: "main",
			lastError: null,
		})
	})

	it("with no context at all says so instead of failing silently", async () => {
		const t = await engineIn({ page2d: false })
		expect(t.engine.mode).toBe("none")
		const seen: { type: string; kind?: string; reason?: string }[] = []
		t.engine.onStatus(status => seen.push(status))
		expect(seen[0]).toMatchObject({ type: "renderer", kind: "none" })
		expect(t.engine.health()).toMatchObject({
			rendererKind: "none",
			lastError: expect.stringContaining("no graphics context"),
		})
	})
})

describe("SpectrumEngine: the health readout and the WebGL2 probe", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("follows the worker's counts, the link and the last error", async () => {
		const t = await engineIn({
			offscreen: { webgl2: true, twoD: true },
			page2d: true,
		})
		t.worker.says({ type: "renderer", kind: "webgl2" })
		t.worker.says({ type: "connection", state: "live" })
		t.worker.says({ type: "stats", frames: 412, draws: 410 })
		t.worker.says({ type: "error", message: "bins failed to decode" })
		expect(t.engine.health()).toEqual({
			rendererKind: "webgl2",
			rendererThread: "worker",
			reason: null,
			framesReceived: 412,
			framesDrawn: 410,
			link: "live",
			lastError: "bins failed to decode",
		})
	})

	it("counts the rows it draws itself on the page", async () => {
		const t = await engineIn({ page2d: true })
		const axis = {
			sourceId: "rtl",
			epoch: 1,
			profile: "25:2048",
			binHz: 1000,
			startHz: 0,
			binCount: 4,
		}
		for (let i = 0; i < 3; i++)
			t.worker.says({
				type: "row",
				axis,
				buffer: Uint8Array.from([1, 2, 3, 4]).buffer,
				binCount: 4,
			})
		vi.advanceTimersByTime(100)
		expect(t.engine.health()).toMatchObject({ framesReceived: 3 })
		expect(t.engine.health().framesDrawn).toBeGreaterThan(0)
	})

	it("asks the worker, where the renderer lives, whether WebGL2 is back", async () => {
		const t = await engineIn({
			offscreen: { webgl2: false, twoD: true },
			page2d: true,
		})
		const answer = t.engine.probeWebgl2()
		const asked = t.worker.posted.find(m => m.type === "probeWebgl")
		expect(asked).toBeDefined()
		if (asked?.type !== "probeWebgl") return
		t.worker.says({ type: "webgl", id: asked.id, available: true })
		await expect(answer).resolves.toBe(true)
		const again = t.engine.probeWebgl2()
		const second = t.worker.posted.filter(m => m.type === "probeWebgl").at(-1)
		if (second?.type !== "probeWebgl") return
		t.worker.says({ type: "webgl", id: second.id, available: false })
		await expect(again).resolves.toBe(false)
	})
})

describe("rendererPlan", () => {
	it("prefers the worker whenever a canvas can be drawn there, with WebGL2 or 2D", async () => {
		const { rendererPlan } = await import("../../src/spectrum/engine.ts")
		expect(rendererPlan({ offscreenWebgl2: true, offscreen2d: true })).toBe(
			"offscreen",
		)
		expect(rendererPlan({ offscreenWebgl2: false, offscreen2d: true })).toBe(
			"offscreen",
		)
		expect(rendererPlan({ offscreenWebgl2: false, offscreen2d: false })).toBe(
			"main",
		)
		expect(
			rendererPlan({
				offscreenWebgl2: true,
				offscreen2d: true,
				forceMainThread: true,
			}),
		).toBe("main")
	})
})
