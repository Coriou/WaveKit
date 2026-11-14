/**
 * Main-thread side of the spectrum pipeline. In the OffscreenCanvas path the main thread only posts
 * view state and receives throttled frame meta; without OffscreenCanvas WebGL2 the worker still owns
 * the socket and decoding, and the same scene/renderer draws here from the rows it posts.
 */

import {
	DEFAULT_HISTORY_ROWS,
	DEFAULT_LAYOUT,
	DEFAULT_LEVELS,
	MAX_BINS,
	type MainToWorker,
	type ResetReason,
	type SpectrumFrameMeta,
	type SpectrumLayout,
	type SpectrumLevels,
	type ConnectionMessage,
	type RendererKind,
	type RendererMessage,
	type SpectrumLinkState,
	type SpectrumSize,
	type SpectrumSubscription,
	type SpectrumViewSpan,
	type WorkerToMain,
} from "./protocol.ts"
import { DEFAULT_THEME, matchAccentRamp } from "./ramp.ts"
import { Canvas2dRenderer } from "./canvas2d-renderer.ts"
import { NO_WEBGL2_REASON } from "./pipeline.ts"
import {
	CONTEXT_OPTIONS,
	SpectrumRenderer,
	type SceneRenderer,
} from "./renderer.ts"
import { SpectrumScene } from "./scene.ts"
import { RenderScheduler, animationFrame } from "./schedule.ts"
import { wsUrlFrom } from "./socket.ts"

export interface SpectrumEngineOptions {
	/** Defaults to `/ws` on the page's origin. */
	wsUrl?: string
	/** Waterfall rows kept (texture height); default 1024. */
	historyRows?: number
	/** Widest row taken (waterfall texture width); default MAX_BINS. Set it to the bins asked of the core. */
	texWidth?: number
	layout?: Partial<SpectrumLayout>
	levels?: SpectrumLevels
	/** 256 × RGBA; default the dark Match-accent ramp. */
	ramp?: Uint8Array
	/** Force the main-thread renderer (testing, or a browser with a broken OffscreenCanvas). */
	forceMainThread?: boolean
}

/**
 * What the spectrum is doing, for a person or an agent looking at an empty plot
 * (`window.__wavekit.spectrumHealth()`).
 */
export interface SpectrumHealth {
	/** What draws: WebGL2, the 2D-canvas stand-in (no graphics acceleration), or nothing. */
	rendererKind: RendererKind
	/** Where it draws: the spectrum worker (a transferred canvas) or the page. */
	rendererThread: "worker" | "main"
	/** Why the renderer is not WebGL2; null when it is. */
	reason: string | null
	/** Frames taken from the stream, and draws made, since the plot was mounted. */
	framesReceived: number
	framesDrawn: number
	/** The stream's link: connecting, live, reconnecting or failed. */
	link: SpectrumLinkState
	/** The last error the engine reported; null when none. */
	lastError: string | null
}

export type SpectrumEngineStatus =
	| ConnectionMessage
	| RendererMessage
	| { type: "reset"; reason: ResetReason }
	| { type: "profile"; outcome: string; code?: string; message?: string }
	| { type: "error"; message: string }

let offscreenWebgl2: boolean | null = null

/** Whether a canvas can be transferred and drawn with WebGL2 off the main thread (probed once). */
export function supportsOffscreenWebgl2(): boolean {
	if (offscreenWebgl2 !== null) return offscreenWebgl2
	offscreenWebgl2 = false
	try {
		if (
			typeof OffscreenCanvas === "function" &&
			typeof HTMLCanvasElement.prototype.transferControlToOffscreen ===
				"function"
		) {
			const gl = new OffscreenCanvas(1, 1).getContext("webgl2")
			if (gl) {
				offscreenWebgl2 = true
				gl.getExtension("WEBGL_lose_context")?.loseContext()
			}
		}
	} catch {
		offscreenWebgl2 = false
	}
	return offscreenWebgl2
}

/**
 * Whether a WebGL2 context can be had right now, asked afresh (a browser turns graphics
 * acceleration off after GPU crashes and back on later). True also forgets the cached probe, so
 * the next engine draws with WebGL2 again.
 */
export function webgl2AvailableNow(): boolean {
	try {
		const gl = document.createElement("canvas").getContext("webgl2")
		if (!gl) return false
		gl.getExtension("WEBGL_lose_context")?.loseContext()
		offscreenWebgl2 = null
		return true
	} catch {
		return false
	}
}

export class SpectrumEngine {
	/** "offscreen": the worker draws; "main": this thread draws; "none": no WebGL2 at all. */
	readonly mode: "offscreen" | "main" | "none"
	private readonly worker: Worker
	private readonly canvas: HTMLCanvasElement
	private readonly metaListeners = new Set<(meta: SpectrumFrameMeta) => void>()
	private readonly statusListeners = new Set<
		(status: SpectrumEngineStatus) => void
	>()
	private scene: SpectrumScene | null = null
	private renderer: SceneRenderer | null = null
	private rendererKind: RendererKind = "none"
	private rendererReason: string | null = "The renderer is starting"
	private frames = 0
	private draws = 0
	private link: SpectrumLinkState = "connecting"
	private lastError: string | null = null
	private scheduler: RenderScheduler | null = null
	private layout: SpectrumLayout
	private latestMeta: SpectrumFrameMeta | null = null
	private disposed = false
	private paused = false
	private sourcePaused = false
	private probeSeq = 0
	private readonly probes = new Map<number, (db: number | null) => void>()

	constructor(canvas: HTMLCanvasElement, opts: SpectrumEngineOptions = {}) {
		this.canvas = canvas
		this.layout = { ...DEFAULT_LAYOUT, ...opts.layout }
		const levels = opts.levels ?? DEFAULT_LEVELS
		const ramp = opts.ramp ?? matchAccentRamp(DEFAULT_THEME)
		const historyRows = opts.historyRows ?? DEFAULT_HISTORY_ROWS
		const texWidth = Math.max(MAX_BINS, opts.texWidth ?? MAX_BINS)
		const size = canvasSize(canvas)
		this.worker = new Worker(new URL("./spectrum.worker.ts", import.meta.url), {
			type: "module",
			name: "wavekit-spectrum",
		})
		this.worker.onmessage = (event: MessageEvent<WorkerToMain>) =>
			this.onWorker(event.data)
		this.worker.onerror = event =>
			this.emitStatus({
				type: "error",
				message: event.message || "spectrum worker failed",
			})

		const base = {
			type: "init" as const,
			wsUrl: opts.wsUrl ?? wsUrlFrom(location.href),
			size,
			layout: this.layout,
			levels,
			ramp,
			historyRows,
			texWidth,
		}
		if (!opts.forceMainThread && supportsOffscreenWebgl2()) {
			const offscreen = canvas.transferControlToOffscreen()
			this.mode = "offscreen"
			this.post({ ...base, canvas: offscreen }, [offscreen])
			return
		}
		// No OffscreenCanvas WebGL2: draw here, with WebGL2 if this thread has it, else with a 2D canvas
		// (graphics acceleration off or blocked: the trace and the waterfall still draw, in basic mode).
		const gl = canvas.getContext("webgl2", CONTEXT_OPTIONS)
		let renderer: SceneRenderer | null = null
		if (gl) renderer = new SpectrumRenderer(gl, texWidth, historyRows)
		else {
			const ctx = canvas.getContext("2d")
			const buffer = document.createElement("canvas")
			const bufferCtx = buffer.getContext("2d")
			if (ctx && bufferCtx)
				renderer = new Canvas2dRenderer(ctx, texWidth, historyRows, {
					canvas: buffer,
					ctx: bufferCtx,
				})
		}
		this.mode = renderer ? "main" : "none"
		this.rendererKind = renderer?.kind ?? "none"
		this.rendererReason =
			this.rendererKind === "webgl2"
				? null
				: this.rendererKind === "canvas2d"
					? NO_WEBGL2_REASON
					: "This browser gave the spectrum no graphics context (no WebGL2, no 2D canvas)"
		if (renderer) {
			const frame = animationFrame()
			const scheduler = new RenderScheduler(
				() => {
					if (!this.scene) return
					this.scene.render()
					this.draws++
				},
				frame.request,
				frame.cancel,
			)
			this.renderer = renderer
			this.scheduler = scheduler
			this.scene = new SpectrumScene(renderer, {
				depth: historyRows,
				texWidth,
				layout: this.layout,
				levels,
				size,
				invalidate: () => {
					if (!this.paused) scheduler.invalidate()
				},
			})
			this.scene.setRamp(ramp)
		} else this.lastError = this.rendererReason
		this.post(base)
	}

	setSubscription(subscription: SpectrumSubscription | null): void {
		this.post({ type: "subscribe", subscription })
	}

	/** Visible span (zoom/pan); null shows the whole capture. */
	setView(view: SpectrumViewSpan | null): void {
		if (this.scene) this.scene.setView(view)
		else this.post({ type: "view", view })
	}

	setLevels(levels: SpectrumLevels): void {
		if (this.scene) this.scene.setLevels(levels)
		else this.post({ type: "levels", levels })
	}

	/** 256 × RGBA colour ramp (see rampFromTheme). */
	setRamp(ramp: Uint8Array): void {
		if (this.scene) this.scene.setRamp(ramp)
		else this.post({ type: "ramp", ramp })
	}

	setLayout(layout: Partial<SpectrumLayout>): void {
		this.layout = { ...this.layout, ...layout }
		if (this.scene) this.scene.setLayout(this.layout)
		else this.post({ type: "layout", layout: this.layout })
	}

	resize(widthCss: number, heightCss: number, dpr: number): void {
		const size: SpectrumSize = { widthCss, heightCss, dpr }
		if (this.scene) this.scene.setSize(size)
		else this.post({ type: "resize", size })
	}

	/** Stops drawing while the plot is covered (rows keep landing in the history); a resume draws once. */
	setPaused(paused: boolean): void {
		if (paused === this.paused) return
		this.paused = paused
		if (this.scene) {
			if (!paused) this.scheduler?.invalidate()
		} else this.post({ type: "paused", paused })
	}

	/**
	 * The receiver of the subscribed source is paused or resumed: the worker's socket stops
	 * resubscribing a stream that cannot flow, and resubscribes once on the resume.
	 */
	setSourcePaused(paused: boolean): void {
		if (paused === this.sourcePaused) return
		this.sourcePaused = paused
		this.post({ type: "sourcePaused", paused })
	}

	/**
	 * Frames are expected now (the tab became visible, the feed or the tuning changed): the worker's
	 * socket resubscribes a stream with no recent live frame, or reconnects a dropped one, at once.
	 */
	kick(): void {
		this.post({ type: "kick" })
	}

	/** The newest row's peak dBFS over [startHz, endHz] (hover readout); null when nothing is there. */
	probe(startHz: number, endHz: number): Promise<number | null> {
		if (this.disposed) return Promise.resolve(null)
		const id = ++this.probeSeq
		return new Promise(resolve => {
			this.probes.set(id, resolve)
			this.post({ type: "probe", id, startHz, endHz })
		})
	}

	/** Per-frame axis meta, at most ~10 per second. Returns an unsubscribe function. */
	onFrameMeta(cb: (meta: SpectrumFrameMeta) => void): () => void {
		this.metaListeners.add(cb)
		if (this.latestMeta) cb(this.latestMeta)
		return () => this.metaListeners.delete(cb)
	}

	/**
	 * Connection, renderer, reset, profile outcome and error notices; the renderer's current state
	 * is told at once. Returns an unsubscribe function.
	 */
	onStatus(cb: (status: SpectrumEngineStatus) => void): () => void {
		this.statusListeners.add(cb)
		if (this.mode !== "offscreen") cb(this.rendererStatus())
		return () => this.statusListeners.delete(cb)
	}

	/** What the spectrum is doing right now. */
	health(): SpectrumHealth {
		return {
			rendererKind: this.rendererKind,
			rendererThread: this.mode === "offscreen" ? "worker" : "main",
			reason: this.rendererReason,
			framesReceived: this.frames,
			framesDrawn: this.draws,
			link: this.link,
			lastError: this.lastError,
		}
	}

	private rendererStatus(): RendererMessage {
		return this.rendererReason === null
			? { type: "renderer", kind: this.rendererKind }
			: {
					type: "renderer",
					kind: this.rendererKind,
					reason: this.rendererReason,
				}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.post({ type: "dispose" })
		this.worker.onmessage = null
		// Let the worker close its socket, then make sure it is gone.
		setTimeout(() => this.worker.terminate(), 500)
		this.scheduler?.dispose()
		this.renderer?.dispose()
		this.scene = null
		this.metaListeners.clear()
		this.statusListeners.clear()
		for (const resolve of this.probes.values()) resolve(null)
		this.probes.clear()
	}

	private post(msg: MainToWorker, transfer: Transferable[] = []): void {
		if (this.disposed && msg.type !== "dispose") return
		this.worker.postMessage(msg, transfer)
	}

	private onWorker(msg: WorkerToMain): void {
		switch (msg.type) {
			case "meta":
				this.latestMeta = msg.meta
				for (const cb of this.metaListeners) cb(msg.meta)
				return
			case "row":
				this.frames++
				this.scene?.addRow(
					msg.axis,
					new Uint8Array(msg.buffer, 0, msg.binCount),
					msg.binCount,
				)
				this.post({ type: "recycle", buffer: msg.buffer }, [msg.buffer])
				return
			case "reset":
				this.latestMeta = null
				this.scene?.reset()
				this.emitStatus(msg)
				return
			case "probe":
				this.probes.get(msg.id)?.(msg.db)
				this.probes.delete(msg.id)
				return
			case "stats":
				this.frames = msg.frames
				this.draws = msg.draws
				return
			case "renderer":
				this.rendererKind = msg.kind
				this.rendererReason = msg.reason ?? null
				this.emitStatus(msg)
				return
			case "connection":
				this.link = msg.state
				this.emitStatus(msg)
				return
			case "error":
				this.lastError = msg.message
				this.emitStatus(msg)
				return
			case "profile":
				this.emitStatus(msg)
				return
		}
	}

	private emitStatus(status: SpectrumEngineStatus): void {
		for (const cb of this.statusListeners) cb(status)
	}
}

function canvasSize(canvas: HTMLCanvasElement): SpectrumSize {
	return {
		widthCss: Math.max(1, canvas.clientWidth),
		heightCss: Math.max(1, canvas.clientHeight),
		dpr: globalThis.devicePixelRatio || 1,
	}
}
