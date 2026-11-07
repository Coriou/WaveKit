/**
 * worker_threads entry (built to dist/spectrum-worker.js). A thin wrapper:
 * every validated input goes to SpectrumPipeline.handle(), events go back,
 * and each transferred byte buffer is transferred back for reuse.
 *
 * Frame path: the wasm kernel (dist/spectrum-frame.wasm, frame-wasm.ts) when it validates and
 * instantiates, else the JS path; one info line per worker says which and why.
 * `WAVEKIT_SPECTRUM_FRAME_PATH=js` forces JS, `=wasm` warns when the kernel is unavailable, and
 * `WAVEKIT_SPECTRUM_FRAME_WASM` points at another artefact.
 */
import { performance } from "node:perf_hooks"
import process from "node:process"
import { parentPort } from "node:worker_threads"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, createLogger } from "../../utils/logger.js"
import type { PipelineConfig, PipelineEvent } from "./types.js"
import {
	FRAME_WASM_FILE,
	framePathChoice,
	loadFrameWasm,
} from "./frame-wasm.js"
import type { FrameWasmLoad } from "./frame-wasm.js"
import { SpectrumPipeline } from "./pipeline.js"
import { encodeEventsForWire } from "./summary-wire.js"
import {
	MainToWorkerSchema,
	type WorkerPipelineInput,
	type WorkerToMain,
} from "./worker-protocol.js"

const port = parentPort
if (!port) {
	throw new WaveKitError(
		"spectrum-worker must run inside a worker thread",
		"SCANNER_WORKER_CONTEXT",
	)
}

let pipeline: SpectrumPipeline | null = null
let pathLogged = false
/** Compiled once per worker: a re-init reuses it. */
let frameWasm: FrameWasmLoad | null = null

function selectFrameWasm(): FrameWasmLoad {
	const choice = framePathChoice(process.env["WAVEKIT_SPECTRUM_FRAME_PATH"])
	if (choice === "js")
		return { ok: false, reason: "WAVEKIT_SPECTRUM_FRAME_PATH=js" }
	frameWasm ??= loadFrameWasm(
		process.env["WAVEKIT_SPECTRUM_FRAME_WASM"] ??
			new URL(`./${FRAME_WASM_FILE}`, import.meta.url),
	)
	return frameWasm
}

function logFramePath(p: SpectrumPipeline, sourceId: string): void {
	if (pathLogged) return
	pathLogged = true
	const log = createComponentLogger(
		createLogger({ level: "info" }),
		"SpectrumWorker",
	)
	const { path, reason } = p.framePath
	const wanted =
		framePathChoice(process.env["WAVEKIT_SPECTRUM_FRAME_PATH"]) === "wasm"
	if (wanted && path !== "wasm")
		log.warn(
			{ sourceId, path, reason },
			"spectrum frame path (wasm unavailable)",
		)
	else log.info({ sourceId, path, reason }, "spectrum frame path")
}

function post(message: WorkerToMain, transfer: ArrayBuffer[] = []): void {
	port!.postMessage(message, transfer)
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/** Hands back the buffer of a bytes input even when the message was rejected. */
function returnBuffer(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) return
	const input = (raw as { input?: { bytes?: unknown } }).input
	if (input?.bytes instanceof Uint8Array) {
		const buffer = input.bytes.buffer as ArrayBuffer
		post({ type: "buffer", buffer }, [buffer])
	}
}

port.on("message", (raw: unknown) => {
	const parsed = MainToWorkerSchema.safeParse(raw)
	if (!parsed.success) {
		post({
			type: "error",
			message: `invalid worker message: ${parsed.error.message}`,
		})
		returnBuffer(raw)
		return
	}
	const message = parsed.data
	switch (message.type) {
		case "init": {
			const load = selectFrameWasm()
			pipeline = new SpectrumPipeline(message.config as PipelineConfig, {
				...(message.profile ? { profile: message.profile } : {}),
				...(load.ok
					? { frameWasm: load.module }
					: { frameWasmReason: load.reason }),
			})
			logFramePath(pipeline, message.config.sourceId)
			return
		}
		case "input": {
			const input = message.input as WorkerPipelineInput
			if (!pipeline) {
				post({ type: "error", message: "input before init" })
			} else {
				let events: PipelineEvent[] = []
				try {
					events = pipeline.handle(input)
				} catch (err) {
					post({ type: "error", message: errorMessage(err) })
				}
				if (events.length > 0) {
					// Clock only when this handle finished a sampled block.
					const span = pipeline.wireSpanOpen()
					const t0 = span ? performance.now() : 0
					const transfer: ArrayBuffer[] = []
					encodeEventsForWire(events, transfer)
					post({ type: "events", events }, transfer)
					if (span) pipeline.chargeWireSpan(performance.now() - t0)
				}
			}
			if (input.kind === "bytes") {
				const buffer = input.bytes.buffer as ArrayBuffer
				post({ type: "buffer", buffer }, [buffer])
			}
			return
		}
		case "export-state":
			if (!pipeline) {
				post({ type: "error", message: "export-state before init" })
				return
			}
			post({
				type: "engine-state",
				requestId: message.requestId,
				state: pipeline.exportEngineState(),
			})
			return
		case "artefact-masks":
			if (!pipeline) {
				post({ type: "error", message: "artefact-masks before init" })
				return
			}
			// Answered after every input posted before the request (messages are ordered).
			post({
				type: "artefact-masks",
				requestId: message.requestId,
				masks: pipeline.artefactMasks(),
			})
			return
		case "close":
			pipeline = null
			port.close()
			return
	}
})
