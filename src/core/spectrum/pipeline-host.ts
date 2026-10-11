/**
 * Where SpectrumPipeline runs: a worker thread (production) or inline on the
 * calling thread (tests, which run from the source tree without a built
 * worker). Both hosts have the same contract: inputs in order, events out,
 * transferred buffers handed back through `handlers.buffer`.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import type {
	EngineState,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
} from "./types.js"
import type { ArtefactMasks } from "./artefacts.js"
import { SpectrumPipeline } from "./pipeline.js"
import { WorkerToMainSchema, type MainToWorker } from "./worker-protocol.js"

export interface PipelineHostHandlers {
	events(events: PipelineEvent[]): void
	buffer(buffer: ArrayBuffer): void
	error(err: Error): void
	/** Host cannot process further input; distinct from recoverable pipeline errors. */
	fatal?(err: Error): void
}

export interface PipelineHost {
	/** Posts one input; `transfer` (the bytes' ArrayBuffer) is detached by the call. */
	send(input: PipelineInput, transfer?: ArrayBuffer): void
	exportState(): Promise<EngineState>
	/** Current artefact masks (§ 4.9) after every input sent before the call (identify, Task 35a). Optional: test hosts need not implement it. */
	artefactMasks?(): Promise<ArtefactMasks>
	/** Worker event-loop utilisation (0–1) since start; null when not measurable (inline). */
	utilization(): number | null
	close(): Promise<void>
}

export type PipelineHostMode = "thread" | "inline"

const CLOSE_TIMEOUT_MS = 2000
const EXPORT_TIMEOUT_MS = 2000

/** dist/index.js → dist/spectrum-worker.js (both built flat by scripts/build-file.mjs). */
export function defaultWorkerUrl(): URL {
	return new URL("./spectrum-worker.js", import.meta.url)
}

function asError(err: unknown): Error {
	return err instanceof Error
		? err
		: new WaveKitError(String(err), "SCANNER_PIPELINE_ERROR")
}

export class InlinePipelineHost implements PipelineHost {
	private pipeline: SpectrumPipeline | null

	constructor(
		cfg: PipelineConfig,
		private readonly handlers: PipelineHostHandlers,
	) {
		this.pipeline = new SpectrumPipeline(cfg)
	}

	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		if (!this.pipeline) {
			if (transfer) this.handlers.buffer(transfer)
			return
		}
		let events: PipelineEvent[] = []
		try {
			events = this.pipeline.handle(input)
		} catch (err) {
			this.handlers.error(asError(err))
		}
		if (transfer) this.handlers.buffer(transfer)
		if (events.length > 0) this.handlers.events(events)
	}

	exportState(): Promise<EngineState> {
		if (!this.pipeline) {
			return Promise.reject(
				new WaveKitError("Pipeline host closed", "SCANNER_PIPELINE_CLOSED"),
			)
		}
		return Promise.resolve(this.pipeline.exportEngineState())
	}

	artefactMasks(): Promise<ArtefactMasks> {
		if (!this.pipeline) {
			return Promise.reject(
				new WaveKitError("Pipeline host closed", "SCANNER_PIPELINE_CLOSED"),
			)
		}
		return Promise.resolve(this.pipeline.artefactMasks())
	}

	utilization(): number | null {
		return null
	}

	close(): Promise<void> {
		this.pipeline = null
		return Promise.resolve()
	}
}

export class ThreadPipelineHost implements PipelineHost {
	private readonly worker: Worker
	private readonly eluStart: ReturnType<
		Worker["performance"]["eventLoopUtilization"]
	>
	private readonly log: Logger
	private readonly exports = new Map<
		number,
		{
			resolve: (s: EngineState) => void
			reject: (e: Error) => void
			timer: NodeJS.Timeout
		}
	>()
	private readonly maskRequests = new Map<
		number,
		{
			resolve: (m: ArtefactMasks) => void
			reject: (e: Error) => void
			timer: NodeJS.Timeout
		}
	>()
	private nextRequestId = 0
	private closing = false
	private exited = false
	private fatalReported = false

	constructor(
		cfg: PipelineConfig,
		private readonly handlers: PipelineHostHandlers,
		workerUrl: URL,
		logger: Logger,
	) {
		this.log = createComponentLogger(logger, "SpectrumWorkerHost")
		if (!existsSync(fileURLToPath(workerUrl))) {
			throw new WaveKitError(
				`Spectrum worker not found at ${fileURLToPath(workerUrl)}; run pnpm run build`,
				"SCANNER_WORKER_MISSING",
			)
		}
		this.worker = new Worker(workerUrl, { name: `spectrum-${cfg.sourceId}` })
		this.eluStart = this.worker.performance.eventLoopUtilization()
		this.worker.on("message", (raw: unknown) => this.onMessage(raw))
		this.worker.on("error", err => this.reportFatal(asError(err))) // @types/node types the listener arg as unknown
		this.worker.on("exit", code => {
			this.exited = true
			for (const [id, pending] of this.exports) {
				clearTimeout(pending.timer)
				pending.reject(
					new WaveKitError("Spectrum worker exited", "SCANNER_WORKER_EXIT"),
				)
				this.exports.delete(id)
			}
			for (const [id, pending] of this.maskRequests) {
				clearTimeout(pending.timer)
				pending.reject(
					new WaveKitError("Spectrum worker exited", "SCANNER_WORKER_EXIT"),
				)
				this.maskRequests.delete(id)
			}
			if (!this.closing) {
				this.reportFatal(
					new WaveKitError(
						`Spectrum worker exited with code ${code}`,
						"SCANNER_WORKER_EXIT",
					),
				)
			}
		})
		this.post({ type: "init", config: cfg })
	}

	private reportFatal(err: Error): void {
		if (this.closing || this.fatalReported) return
		this.fatalReported = true
		if (this.handlers.fatal) this.handlers.fatal(err)
		else this.handlers.error(err)
	}

	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		if (this.exited) {
			if (transfer) this.handlers.buffer(transfer)
			return
		}
		this.post({ type: "input", input }, transfer ? [transfer] : [])
	}

	exportState(): Promise<EngineState> {
		if (this.exited) {
			return Promise.reject(
				new WaveKitError("Spectrum worker exited", "SCANNER_WORKER_EXIT"),
			)
		}
		const requestId = this.nextRequestId++
		return new Promise<EngineState>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.exports.delete(requestId)
				reject(
					new WaveKitError(
						"Spectrum worker state export timed out",
						"SCANNER_WORKER_TIMEOUT",
					),
				)
			}, EXPORT_TIMEOUT_MS)
			this.exports.set(requestId, { resolve, reject, timer })
			this.post({ type: "export-state", requestId })
		})
	}

	artefactMasks(): Promise<ArtefactMasks> {
		if (this.exited) {
			return Promise.reject(
				new WaveKitError("Spectrum worker exited", "SCANNER_WORKER_EXIT"),
			)
		}
		const requestId = this.nextRequestId++
		return new Promise<ArtefactMasks>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.maskRequests.delete(requestId)
				reject(
					new WaveKitError(
						"Spectrum worker artefact masks timed out",
						"SCANNER_WORKER_TIMEOUT",
					),
				)
			}, EXPORT_TIMEOUT_MS)
			this.maskRequests.set(requestId, { resolve, reject, timer })
			this.post({ type: "artefact-masks", requestId })
		})
	}

	utilization(): number | null {
		if (this.exited) return null
		return this.worker.performance.eventLoopUtilization(this.eluStart)
			.utilization
	}

	async close(): Promise<void> {
		if (this.exited) return
		this.closing = true
		const exited = new Promise<void>(resolve =>
			this.worker.once("exit", () => resolve()),
		)
		this.post({ type: "close" })
		const timer = setTimeout(() => {
			void this.worker.terminate().catch((err: unknown) => {
				this.log.warn({ err }, "Spectrum worker terminate failed")
			})
		}, CLOSE_TIMEOUT_MS)
		await exited
		clearTimeout(timer)
	}

	private post(message: MainToWorker, transfer: ArrayBuffer[] = []): void {
		this.worker.postMessage(message, transfer)
	}

	private onMessage(raw: unknown): void {
		const parsed = WorkerToMainSchema.safeParse(raw)
		if (!parsed.success) {
			this.handlers.error(
				new WaveKitError(
					`Invalid spectrum worker message: ${parsed.error.message}`,
					"SCANNER_WORKER_PROTOCOL",
				),
			)
			return
		}
		const message = parsed.data
		switch (message.type) {
			case "events":
				this.handlers.events(message.events)
				return
			case "buffer":
				this.handlers.buffer(message.buffer)
				return
			case "engine-state": {
				const pending = this.exports.get(message.requestId)
				if (!pending) return
				clearTimeout(pending.timer)
				this.exports.delete(message.requestId)
				pending.resolve(message.state as EngineState)
				return
			}
			case "artefact-masks": {
				const pending = this.maskRequests.get(message.requestId)
				if (!pending) return
				clearTimeout(pending.timer)
				this.maskRequests.delete(message.requestId)
				pending.resolve(message.masks as ArtefactMasks)
				return
			}
			case "error":
				this.handlers.error(
					new WaveKitError(message.message, "SCANNER_WORKER_ERROR"),
				)
				return
		}
	}
}

export function createPipelineHost(
	mode: PipelineHostMode,
	cfg: PipelineConfig,
	handlers: PipelineHostHandlers,
	opts: { workerUrl?: URL; logger: Logger },
): PipelineHost {
	return mode === "inline"
		? new InlinePipelineHost(cfg, handlers)
		: new ThreadPipelineHost(
				cfg,
				handlers,
				opts.workerUrl ?? defaultWorkerUrl(),
				opts.logger,
			)
}
