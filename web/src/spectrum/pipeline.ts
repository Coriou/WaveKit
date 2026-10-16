/**
 * The worker's logic, free of worker globals so it can be unit-tested: socket messages in, decoded rows
 * into the history and onto the GPU (OffscreenCanvas path) or posted to the main thread (fallback).
 */

import type { SpectrumFrameEventData } from "@wavekit/api-types"
import { decodeBase64Into } from "./codec.ts"
import { WaterfallHistory, axisOf, profileEventResets } from "./history.ts"
import {
	MAX_BINS,
	type InitMessage,
	type MainToWorker,
	type ResetReason,
	type SpectrumFrameMeta,
	type SpectrumLayout,
	type SpectrumLevels,
	type SpectrumSize,
	type SpectrumSubscription,
	type SpectrumViewSpan,
	type WorkerToMain,
} from "./protocol.ts"
import type { SceneRenderer } from "./renderer.ts"
import { SpectrumScene } from "./scene.ts"
import {
	type FrameCancel,
	type FrameRequest,
	RenderScheduler,
	Throttle,
	type TimerApi,
} from "./schedule.ts"
import type { SocketHandlers, SpectrumServerMessage } from "./socket.ts"

/** Meta is posted at most this often (ms). */
export const META_INTERVAL_MS = 100
/** Fallback path: rows in flight to the main thread before new ones are dropped. */
export const MAX_ROWS_IN_FLIGHT = 8

export interface SocketLike {
	setSubscription(sub: SpectrumSubscription | null): void
	dispose(): void
}

export interface PipelineDeps {
	post: (msg: WorkerToMain, transfer?: Transferable[]) => void
	openSocket: (url: string, handlers: SocketHandlers) => SocketLike
	/** Creates the renderer on a transferred canvas; null when WebGL2 is unavailable there. */
	createRenderer: (
		canvas: OffscreenCanvas,
		texWidth: number,
		depth: number,
	) => SceneRenderer | null
	frame: { request: FrameRequest; cancel: FrameCancel }
	timers: TimerApi
}

export function frameMeta(frame: SpectrumFrameEventData): SpectrumFrameMeta {
	return {
		sourceId: frame.sourceId,
		centerHz: frame.centerHz,
		startHz: frame.startHz,
		binHz: frame.binHz,
		binCount: frame.binCount,
		sampleRateHz: frame.sampleRateHz,
		floorDbfs: frame.floorDbfs,
		thresholdDb: frame.thresholdDb,
		tracks: frame.tracks,
		tuningTrust: frame.tuningTrust,
		epoch: frame.epoch,
		at: frame.at,
	}
}

function sameSubscription(
	a: SpectrumSubscription | null,
	b: SpectrumSubscription | null,
): boolean {
	if (a === null || b === null) return a === b
	return a.sourceId === b.sourceId && a.hz === b.hz && a.bins === b.bins
}

export class SpectrumPipeline {
	private readonly deps: PipelineDeps
	private socket: SocketLike | null = null
	private history: WaterfallHistory | null = null
	private scene: SpectrumScene | null = null
	private renderer: SceneRenderer | null = null
	private scheduler: RenderScheduler | null = null
	private readonly meta: Throttle<SpectrumFrameEventData>
	private subscription: SpectrumSubscription | null = null
	private readonly pool: ArrayBuffer[] = []
	private inFlight = 0
	private decodeErrorReported = false
	/** The next frame's meta goes out at once (first frame after a reset). */
	private metaFresh = true
	private state: {
		size: SpectrumSize
		layout: SpectrumLayout
		levels: SpectrumLevels
		ramp: Uint8Array
		view: SpectrumViewSpan | null
	} | null = null

	constructor(deps: PipelineDeps) {
		this.deps = deps
		this.meta = new Throttle(
			META_INTERVAL_MS,
			frame => deps.post({ type: "meta", meta: frameMeta(frame) }),
			deps.timers,
		)
	}

	/** True when this pipeline draws (OffscreenCanvas path). */
	get rendering(): boolean {
		return this.scene !== null
	}

	handle(msg: MainToWorker): void {
		switch (msg.type) {
			case "init":
				this.init(msg)
				return
			case "subscribe":
				this.setSubscription(msg.subscription)
				return
			case "view":
				if (this.state) this.state.view = msg.view
				this.scene?.setView(msg.view)
				return
			case "levels":
				if (this.state) this.state.levels = msg.levels
				this.scene?.setLevels(msg.levels)
				return
			case "ramp":
				if (this.state) this.state.ramp = msg.ramp
				this.scene?.setRamp(msg.ramp)
				return
			case "layout":
				if (this.state) this.state.layout = msg.layout
				this.scene?.setLayout(msg.layout)
				return
			case "resize":
				if (this.state) this.state.size = msg.size
				this.scene?.setSize(msg.size)
				return
			case "recycle":
				this.inFlight = Math.max(0, this.inFlight - 1)
				if (
					msg.buffer.byteLength >= MAX_BINS &&
					this.pool.length < MAX_ROWS_IN_FLIGHT
				)
					this.pool.push(msg.buffer)
				return
			case "dispose":
				this.dispose()
				return
		}
	}

	/** Socket input. */
	onServer(msg: SpectrumServerMessage): void {
		if (msg.type === "spectrum:profile") {
			const data = msg.data
			const sourceId = this.subscription?.sourceId ?? null
			if (profileEventResets(data, sourceId)) this.reset("profile")
			const out: WorkerToMain = { type: "profile", outcome: data.outcome }
			if (data.code !== undefined) out.code = data.code
			if (data.message !== undefined) out.message = data.message
			this.deps.post(out)
			return
		}
		this.onFrame(msg.data)
	}

	/** Context restored: a new renderer gets the ramp and the whole history again. */
	rebuild(canvas: OffscreenCanvas): void {
		const state = this.state
		const history = this.history
		if (!state || !history) return
		this.renderer = null
		this.scene = null
		this.attachRenderer(canvas, history.depth)
		const scene = this.scene as SpectrumScene | null
		const axis = history.axis
		if (!scene || !axis) return
		for (let age = history.filled - 1; age >= 0; age--) {
			const row = history.row(age)
			if (row) scene.addRow(axis, row, axis.binCount)
		}
	}

	dispose(): void {
		this.socket?.dispose()
		this.socket = null
		this.scheduler?.dispose()
		this.meta.dispose()
		this.renderer?.dispose()
		this.renderer = null
		this.scene = null
	}

	private init(msg: InitMessage): void {
		this.state = {
			size: msg.size,
			layout: msg.layout,
			levels: msg.levels,
			ramp: msg.ramp,
			view: null,
		}
		this.history = new WaterfallHistory(msg.historyRows, MAX_BINS)
		if (msg.canvas) this.attachRenderer(msg.canvas, msg.historyRows)
		this.socket = this.deps.openSocket(msg.wsUrl, {
			message: m => this.onServer(m),
			state: state => this.deps.post({ type: "connection", state }),
		})
		if (this.subscription) this.socket.setSubscription(this.subscription)
	}

	private attachRenderer(canvas: OffscreenCanvas, depth: number): void {
		const state = this.state
		if (!state) return
		let renderer: SceneRenderer | null = null
		try {
			renderer = this.deps.createRenderer(canvas, MAX_BINS, depth)
		} catch (err) {
			this.deps.post({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			})
		}
		if (!renderer) {
			this.deps.post({
				type: "error",
				message: "WebGL2 is unavailable on the OffscreenCanvas",
			})
			return
		}
		this.renderer = renderer
		this.scheduler ??= new RenderScheduler(
			() => this.scene?.render(),
			this.deps.frame.request,
			this.deps.frame.cancel,
		)
		const scheduler = this.scheduler
		const scene = new SpectrumScene(renderer, {
			depth,
			texWidth: MAX_BINS,
			layout: state.layout,
			levels: state.levels,
			size: state.size,
			invalidate: () => scheduler.invalidate(),
		})
		scene.setRamp(state.ramp)
		scene.setView(state.view)
		this.scene = scene
	}

	private setSubscription(sub: SpectrumSubscription | null): void {
		if (sameSubscription(this.subscription, sub)) return
		const sourceChanged =
			(this.subscription?.sourceId ?? null) !== (sub?.sourceId ?? null)
		this.subscription = sub
		if (sourceChanged) this.reset("subscription")
		this.socket?.setSubscription(sub)
	}

	private reset(reason: ResetReason): void {
		this.history?.reset()
		this.scene?.reset()
		this.metaFresh = true
		this.deps.post({ type: "reset", reason })
	}

	private onFrame(frame: SpectrumFrameEventData): void {
		const history = this.history
		const sub = this.subscription
		if (!history || !sub || frame.sourceId !== sub.sourceId) return
		const axis = axisOf(frame)
		const reason = history.begin(axis)
		if (reason !== null) {
			this.scene?.reset()
			this.deps.post({ type: "reset", reason })
		}
		const slot = history.slot()
		const n = decodeBase64Into(frame.bins, slot)
		if (n < 0) {
			if (!this.decodeErrorReported)
				this.deps.post({
					type: "error",
					message: "spectrum frame bins failed to decode",
				})
			this.decodeErrorReported = true
			return
		}
		const count = Math.min(n, frame.binCount)
		history.commit()
		if (this.scene) {
			this.scene.addRow(axis, slot, count)
		} else if (this.inFlight < MAX_ROWS_IN_FLIGHT) {
			const buffer = this.pool.pop() ?? new ArrayBuffer(MAX_BINS)
			new Uint8Array(buffer, 0, count).set(slot.subarray(0, count))
			this.inFlight++
			this.deps.post({ type: "row", axis, buffer, binCount: count }, [buffer])
		}
		if (reason !== null || this.metaFresh) this.meta.flush(frame)
		else this.meta.push(frame)
		this.metaFresh = false
	}
}
