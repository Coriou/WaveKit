/**
 * Where SpectrumPipeline runs: a worker thread (production) or inline on the
 * calling thread (tests, which run from the source tree without a built
 * worker). Both hosts have the same contract: inputs in order, events out,
 * transferred buffers handed back through `handlers.buffer`.
 */
import { SPECTRUM_SUMMARY_BINS_MAX } from "@wavekit/api-types"
import { existsSync } from "node:fs"
import { performance, type EventLoopUtilization } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import type { EngineState, PipelineConfig, PipelineEvent } from "./types.js"
import type { ArtefactMasks } from "./artefacts.js"
import { SpectrumPipeline, spectrumMainSpanSink } from "./pipeline.js"
import { decodeEventsFromWire, wireEventProblem } from "./summary-wire.js"
import {
	WorkerToMainSchema,
	type MainToWorker,
	type WorkerPipelineInput,
	type WorkerToMain,
} from "./worker-protocol.js"

export interface PipelineHostHandlers {
	events(events: PipelineEvent[]): void
	buffer(buffer: ArrayBuffer): void
	error(err: Error): void
	/** Host cannot process further input; distinct from recoverable pipeline errors. */
	fatal?(err: Error): void
}

export interface PipelineHost {
	/** Posts one input; `transfer` (the bytes' ArrayBuffer) is detached by the call. */
	send(input: WorkerPipelineInput, transfer?: ArrayBuffer): void
	exportState(): Promise<EngineState>
	/** Current artefact masks (§ 4.9) after every input sent before the call (identify, Task 35a). Optional: test hosts need not implement it. */
	artefactMasks?(): Promise<ArtefactMasks>
	/** Worker event-loop utilisation (0–1) since start; null when not measurable (inline). */
	utilization(): number | null
	/**
	 * WG11 req 2.2: the worker's cumulative cost sample since it started (`WorkerCostMeter`: `active`
	 * is the thread's CPU time where Node reports it, event-loop active time otherwise), for a
	 * caller that measures its own window by difference, tagged with the worker's generation (unique
	 * per started worker in this process) so the caller can tell a replacement worker apart even when
	 * its counters exceed the old one's; null when not measurable. Optional: test hosts need not
	 * implement it.
	 */
	eluSample?(): WorkerEluSample | null
	close(): Promise<void>
}

/** WG11 req 2.2: a cumulative worker event-loop sample and the generation of the worker it came from. */
export interface WorkerEluSample {
	generation: number
	elu: EventLoopUtilization
}

/** Bumped on every worker start, process-wide, so no two workers share a generation. */
let nextWorkerGeneration = 0

/**
 * The two per-block worker messages, checked as `WorkerToMainSchema` checks them. Anything else,
 * malformed ones included, returns null and goes to the schema. A member the schema would strip
 * stays on the object; `onMessage` reads only the ones named here.
 */
export function hotWorkerMessage(raw: unknown): WorkerToMain | null {
	if (typeof raw !== "object" || raw === null) return null
	const m = raw as { type?: unknown; events?: unknown; buffer?: unknown }
	if (m.type === "buffer")
		return m.buffer instanceof ArrayBuffer ? (raw as WorkerToMain) : null
	if (m.type !== "events" || !Array.isArray(m.events)) return null
	for (const ev of m.events as unknown[]) {
		if (typeof ev !== "object" || ev === null || !("kind" in ev)) return null
		if (wireEventProblem(ev, SPECTRUM_SUMMARY_BINS_MAX) !== null) return null
	}
	return raw as WorkerToMain
}

/** What `WorkerCostMeter` reads of a worker. `cpuUsage` is absent on a Node without it. */
export interface WorkerCostPort {
	elu(): { idle: number; active: number }
	cpuUsage?: () => Promise<{ user: number; system: number }>
}

/**
 * Ticks (1 s each) without a CPU answer, the request hanging or rejected, before the meter stops
 * trusting its last figure and follows ELU. 10 of the guard's 60 s window can read stale at most.
 */
export const COST_METER_MAX_MISSES = 10

/**
 * The cost sample the passive guard judges: the worker's event-loop counters with `active` reduced
 * to the thread's own CPU time. ELU's `active` is wall time inside a callback, so a thread preempted
 * mid-frame by other work on the host counts as busy, and the same pipeline reads 0.3 on a quiet host
 * and 0.7 on a loaded one. CPU time does not move with the load, and a real overrun still shows.
 *
 * `cpuUsage` answers asynchronously, so a sample carries the previous tick's CPU figure: at most one
 * tick (1 s) stale at each end of the guard's 60 s window. Both counters only go forward, since the
 * guard reads a counter going back as a restart of its window. Until the first answer there is no
 * sample (the guard's "no measurement"). A Node without the call reports plain ELU.
 *
 * A worker that has not answered for `COST_METER_MAX_MISSES` ticks, whether its requests hang or
 * reject, is judged on ELU, so an overrun is never hidden: `active` advances by ELU's own advance per
 * tick (if no sample was reported yet that is all of ELU, so plain ELU). An answer is a cumulative
 * figure, so it covers every tick since the previous one, those read as stale and those ELU stood in
 * for. It adds what it exceeds ELU's credit by, so nothing is lost and nothing counted twice. When
 * ELU credited more than CPU time, as on a preempted worker, the excess stays (`cpuBaseMs`): paying
 * it back would hold `active` still and hide a later overrun for as long as that took.
 *
 * So, when each tick's CPU time is at most its ELU, whatever the pattern of answers, rejections and
 * hangs: `active` ≤ ELU's `active` at all times, and below the CPU time by at most the CPU time of
 * `COST_METER_MAX_MISSES` ticks. An answer read at tick t carries tick t - 1, so at t + 9 that is 10
 * ticks behind; at t + 10 ELU takes over and each tick credits at least its CPU time, so the gap stops
 * growing and holds those 10 ticks until the next answer. Over any window between two samples the
 * advance of `active` is at least the window's CPU time less that, and at most the window's ELU plus
 * that (a late answer lands in the window after its ticks). Above CPU time it reaches only what ELU credited, which takes `COST_METER_MAX_MISSES` ticks
 * in a row without an answer.
 */
export class WorkerCostMeter {
	private cpuMs: number | null = null
	/** Added to CPU time: what ELU credited beyond the CPU time of the same ticks. */
	private cpuBaseMs = 0
	/** ELU credited since the last answer; that answer's CPU figure has not covered it yet. */
	private eluCreditMs = 0
	private pending = false
	private misses = 0
	private last = { idle: 0, active: 0 }
	/** ELU's `active` at the last reported sample. */
	private lastEluActive = 0

	constructor(private readonly port: WorkerCostPort) {}

	sample(): EventLoopUtilization | null {
		const elu = this.port.elu()
		const raw = (): EventLoopUtilization => {
			const total = elu.idle + elu.active
			return {
				idle: elu.idle,
				active: elu.active,
				utilization: total > 0 ? elu.active / total : 0,
			}
		}
		if (!this.port.cpuUsage) return raw()
		this.refresh()
		if (this.misses >= COST_METER_MAX_MISSES)
			this.eluCreditMs += Math.max(0, elu.active - this.lastEluActive)
		else if (this.cpuMs === null) return null
		const target = Math.min(
			elu.active,
			(this.cpuMs ?? 0) + this.cpuBaseMs + this.eluCreditMs,
		)
		const total = elu.idle + elu.active
		const active = Math.max(this.last.active, target)
		const idle = Math.max(this.last.idle, total - active)
		this.last = { idle, active }
		this.lastEluActive = elu.active
		const sum = active + idle
		return { idle, active, utilization: sum > 0 ? active / sum : 0 }
	}

	private refresh(): void {
		if (this.pending) {
			this.misses++
			return
		}
		this.pending = true
		this.port.cpuUsage!()
			.then(usage => {
				const previous = this.cpuMs ?? 0
				const cpuMs = Math.max(previous, (usage.user + usage.system) / 1000)
				this.cpuBaseMs += Math.max(0, this.eluCreditMs - (cpuMs - previous))
				this.eluCreditMs = 0
				this.cpuMs = cpuMs
				this.misses = 0
			})
			.catch(() => {
				// Counted here since no request is left pending for the next tick to count. A stopped
				// worker lands here too; its exit path reports it and the host stops sampling.
				this.misses++
			})
			.finally(() => {
				this.pending = false
			})
	}
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
		profile?: { sampleEvery: number },
	) {
		this.pipeline = new SpectrumPipeline(cfg, profile ? { profile } : {})
	}

	send(input: WorkerPipelineInput, transfer?: ArrayBuffer): void {
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

	eluSample(): WorkerEluSample | null {
		return null
	}

	close(): Promise<void> {
		this.pipeline = null
		return Promise.resolve()
	}
}

export class ThreadPipelineHost implements PipelineHost {
	private readonly worker: Worker
	private readonly costMeter: WorkerCostMeter
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
	private readonly generation: number

	constructor(
		cfg: PipelineConfig,
		private readonly handlers: PipelineHostHandlers,
		workerUrl: URL,
		logger: Logger,
		private readonly profile?: { sampleEvery: number },
	) {
		this.log = createComponentLogger(logger, "SpectrumWorkerHost")
		if (!existsSync(fileURLToPath(workerUrl))) {
			throw new WaveKitError(
				`Spectrum worker not found at ${fileURLToPath(workerUrl)}; run pnpm run build`,
				"SCANNER_WORKER_MISSING",
			)
		}
		this.worker = new Worker(workerUrl, { name: `spectrum-${cfg.sourceId}` })
		this.generation = ++nextWorkerGeneration
		this.eluStart = this.worker.performance.eventLoopUtilization()
		const worker = this.worker
		const cpuUsage = (
			worker as unknown as {
				cpuUsage?: () => Promise<{ user: number; system: number }>
			}
		).cpuUsage
		this.costMeter = new WorkerCostMeter({
			elu: () => worker.performance.eventLoopUtilization(),
			...(cpuUsage ? { cpuUsage: () => cpuUsage.call(worker) } : {}),
		})
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
		this.post(
			this.profile
				? { type: "init", config: cfg, profile: this.profile }
				: { type: "init", config: cfg },
		)
	}

	private reportFatal(err: Error): void {
		if (this.closing || this.fatalReported) return
		this.fatalReported = true
		if (this.handlers.fatal) this.handlers.fatal(err)
		else this.handlers.error(err)
	}

	send(input: WorkerPipelineInput, transfer?: ArrayBuffer): void {
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

	eluSample(): WorkerEluSample | null {
		if (this.exited) return null
		const elu = this.costMeter.sample()
		return elu === null ? null : { generation: this.generation, elu }
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
		let message = hotWorkerMessage(raw)
		if (message === null) {
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
			message = parsed.data as WorkerToMain
		}
		switch (message.type) {
			case "events": {
				const sink = spectrumMainSpanSink()
				if (sink) {
					const t0 = performance.now()
					decodeEventsFromWire(message.events)
					sink("summary-decode", performance.now() - t0)
				} else {
					decodeEventsFromWire(message.events)
				}
				this.handlers.events(message.events)
				return
			}
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
	opts: {
		workerUrl?: URL
		logger: Logger
		profile?: { sampleEvery: number }
	},
): PipelineHost {
	return mode === "inline"
		? new InlinePipelineHost(cfg, handlers, opts.profile)
		: new ThreadPipelineHost(
				cfg,
				handlers,
				opts.workerUrl ?? defaultWorkerUrl(),
				opts.logger,
				opts.profile,
			)
}
