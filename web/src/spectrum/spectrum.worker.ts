/**
 * Spectrum worker: its own `/ws` connection (spectrum channel only), base64 decode, waterfall history,
 * and WebGL2 drawing on a transferred OffscreenCanvas (or decoded rows posted back as a fallback).
 */

import { SpectrumPipeline } from "./pipeline.ts"
import type { MainToWorker, WorkerToMain } from "./protocol.ts"
import { CONTEXT_OPTIONS, SpectrumRenderer } from "./renderer.ts"
import { animationFrame, realTimers } from "./schedule.ts"
import { SpectrumSocket } from "./socket.ts"

interface WorkerScope {
	postMessage(message: WorkerToMain, transfer: Transferable[]): void
	onmessage: ((event: MessageEvent<MainToWorker>) => void) | null
	close(): void
}

const scope = self as unknown as WorkerScope

const pipeline = new SpectrumPipeline({
	post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
	openSocket: (url, handlers) => new SpectrumSocket(url, handlers),
	createRenderer: (canvas, texWidth, depth) => {
		const gl = canvas.getContext("webgl2", CONTEXT_OPTIONS)
		return gl ? new SpectrumRenderer(gl, texWidth, depth) : null
	},
	frame: animationFrame(),
	timers: realTimers,
})

scope.onmessage = event => {
	const msg = event.data
	if (msg.type === "init" && msg.canvas) {
		const canvas = msg.canvas
		canvas.addEventListener("webglcontextlost", e => e.preventDefault())
		canvas.addEventListener("webglcontextrestored", () =>
			pipeline.rebuild(canvas),
		)
	}
	pipeline.handle(msg)
	if (msg.type === "dispose") scope.close()
}
