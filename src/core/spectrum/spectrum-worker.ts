/**
 * worker_threads entry (built to dist/spectrum-worker.js). A thin wrapper:
 * every validated input goes to SpectrumPipeline.handle(), events go back,
 * and each transferred byte buffer is transferred back for reuse.
 */
import { parentPort } from "node:worker_threads"
import { WaveKitError } from "../../utils/errors.js"
import type { PipelineConfig, PipelineEvent, PipelineInput } from "./types.js"
import { SpectrumPipeline } from "./pipeline.js"
import { encodeEventsForWire } from "./summary-wire.js"
import { MainToWorkerSchema, type WorkerToMain } from "./worker-protocol.js"

const port = parentPort
if (!port) {
	throw new WaveKitError(
		"spectrum-worker must run inside a worker thread",
		"SCANNER_WORKER_CONTEXT",
	)
}

let pipeline: SpectrumPipeline | null = null

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
		case "init":
			pipeline = new SpectrumPipeline(message.config as PipelineConfig)
			return
		case "input": {
			const input = message.input as PipelineInput
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
					const transfer: ArrayBuffer[] = []
					encodeEventsForWire(events, transfer)
					post({ type: "events", events }, transfer)
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
