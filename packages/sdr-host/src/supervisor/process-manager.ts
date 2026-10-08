import * as fs from "node:fs"
import * as path from "node:path"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "@wavekit/shared"
import type { SdrHostDelivery, SdrHostSampling } from "@wavekit/api-types"
import type { SdrHostConfig } from "../config.js"
import {
	RtlmuxStatsSchema,
	SamplingMonitor,
	type RtlmuxStats,
} from "../telemetry/sampling.js"

export interface ProcessState {
	running: boolean
	pid: number | undefined
	restartCount: number
	lastRestartAt: Date | null
	lastError: string | null
}

export type { RtlmuxStats }

/** Canonical stats are a few hundred bytes per client. */
const MAX_STATS_BYTES = 256 * 1024

interface InternalProcessState extends ProcessState {
	lastPid?: number
	seenOnce: boolean
}

interface ProcessManagerOptions {
	procRoot?: string
	fetchFn?: typeof fetch
	/** Monotonic milliseconds for polling cadence and sampling deadlines. */
	now?: () => number
	/** Wall-clock milliseconds, used only for ISO timestamps. */
	wallNow?: () => number
	processPollIntervalMs?: number
	statsPollIntervalMs?: number
	statsTimeoutMs?: number
}

/**
 * Observes rtl_tcp and rtlmux processes managed by s6.
 */
export class ProcessManager {
	private readonly log: Logger
	private readonly config: SdrHostConfig
	private readonly procRoot: string
	private readonly fetchFn: typeof fetch
	private readonly now: () => number
	private readonly processPollIntervalMs: number
	private readonly statsPollIntervalMs: number
	private readonly statsTimeoutMs: number
	private readonly wallNow: () => number
	private readonly sampling: SamplingMonitor
	private processPollingInterval: ReturnType<typeof setInterval> | null = null
	private statsTimer: ReturnType<typeof setTimeout> | null = null
	private statsInFlight: Promise<void> | null = null
	private stopped = false
	private rtlTcpState: InternalProcessState = {
		running: false,
		pid: undefined,
		restartCount: 0,
		lastRestartAt: null,
		lastError: null,
		seenOnce: false,
	}
	private rtlmuxState: InternalProcessState = {
		running: false,
		pid: undefined,
		restartCount: 0,
		lastRestartAt: null,
		lastError: null,
		seenOnce: false,
	}

	constructor(
		config: SdrHostConfig,
		logger: Logger,
		options: ProcessManagerOptions = {},
	) {
		this.config = config
		this.log = createComponentLogger(logger, "ProcessManager")
		this.procRoot = options.procRoot ?? "/proc"
		this.fetchFn = options.fetchFn ?? fetch
		this.now = options.now ?? (() => performance.now())
		this.wallNow = options.wallNow ?? (() => Date.now())
		this.processPollIntervalMs = options.processPollIntervalMs ?? 2000
		this.statsPollIntervalMs = options.statsPollIntervalMs ?? 2000
		this.statsTimeoutMs = options.statsTimeoutMs ?? 1500
		this.sampling = new SamplingMonitor({
			sampleRate: config.rtlTcp.sampleRate,
			now: this.now,
			wallNow: this.wallNow,
			maxObservationGapMs: this.statsPollIntervalMs * 2.5,
		})
	}

	/**
	 * Starts monitoring process state and rtlmux stats.
	 */
	startMonitoring(): void {
		this.refreshProcessStates()
		this.startProcessPolling()

		const statsPort = this.config.rtlmux.port + 1
		this.startStatsPolling(statsPort)
	}

	/**
	 * Returns current rtl_tcp state.
	 */
	getRtlTcpState(): ProcessState {
		const {
			seenOnce: _seenOnce,
			lastPid: _lastPid,
			...state
		} = this.rtlTcpState
		return { ...state }
	}

	/**
	 * Returns current rtlmux state.
	 */
	getRtlmuxState(): ProcessState {
		const {
			seenOnce: _seenOnce,
			lastPid: _lastPid,
			...state
		} = this.rtlmuxState
		return { ...state }
	}

	/**
	 * Returns rtlmux delivery stats in the legacy shape core's poller reads.
	 * Expired snapshots report no clients rather than cached values.
	 */
	getRtlmuxStats(): RtlmuxStats {
		return this.sampling.legacyStats()
	}

	/** Upstream sampling evidence, independent of downstream clients. */
	getSampling(): SdrHostSampling {
		return this.sampling.sampling()
	}

	getDelivery(): SdrHostDelivery {
		return this.sampling.delivery()
	}

	getSamplingHistory(): Array<[number, number | null]> {
		return this.sampling.recentHistory()
	}

	/**
	 * Stops monitoring.
	 */
	async shutdown(): Promise<void> {
		this.log.info("Stopping process monitoring")
		this.stopped = true
		this.stopProcessPolling()
		this.stopStatsPolling()
		await this.statsInFlight
	}

	private startProcessPolling(): void {
		if (this.processPollingInterval) return
		this.processPollingInterval = setInterval(() => {
			this.refreshProcessStates()
		}, this.processPollIntervalMs)
	}

	private stopProcessPolling(): void {
		if (!this.processPollingInterval) return
		clearInterval(this.processPollingInterval)
		this.processPollingInterval = null
	}

	private refreshProcessStates(): void {
		const rtlTcpPid = this.findPidByName("rtl_tcp")
		const rtlmuxPid = this.findPidByName("rtlmux")

		this.updateProcessState(this.rtlTcpState, rtlTcpPid, "rtl_tcp")
		this.updateProcessState(this.rtlmuxState, rtlmuxPid, "rtlmux")
	}

	private findPidByName(name: string): number | undefined {
		try {
			const entries = fs.readdirSync(this.procRoot, { withFileTypes: true })
			for (const entry of entries) {
				if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
					continue
				}
				const pid = Number(entry.name)
				const commPath = path.join(this.procRoot, entry.name, "comm")
				const cmdlinePath = path.join(this.procRoot, entry.name, "cmdline")

				try {
					const comm = fs.readFileSync(commPath, "utf8").trim()
					if (comm === name) return pid
				} catch {
					// Ignore unreadable comm files
				}

				try {
					const cmdline = fs.readFileSync(cmdlinePath, "utf8")
					// Arguments may mention a service name (e.g. s6-supervise rtlmux).
					// Match the executable itself rather than any command-line substring.
					const executable = cmdline.split("\0", 1)[0]
					if (executable && path.basename(executable) === name) return pid
				} catch {
					// Ignore unreadable cmdline files
				}
			}
		} catch (error) {
			this.log.warn({ error }, "Failed to scan process table")
		}

		return undefined
	}

	private updateProcessState(
		state: InternalProcessState,
		pid: number | undefined,
		label: string,
	): void {
		const wasRunning = state.running

		if (pid !== undefined) {
			if (state.seenOnce && (!wasRunning || state.lastPid !== pid)) {
				state.restartCount += 1
				state.lastRestartAt = new Date(this.wallNow())
			}

			state.seenOnce = true
			state.running = true
			state.pid = pid
			state.lastPid = pid
			state.lastError = null
			return
		}

		if (wasRunning) {
			state.lastError = `${label} not running`
		}

		state.running = false
		state.pid = undefined
	}

	private startStatsPolling(statsPort: number): void {
		if (this.statsTimer || this.stopped) return
		const url = `http://127.0.0.1:${statsPort}/stats.json`
		const schedule = (delayMs: number): void => {
			if (this.stopped) return
			this.statsTimer = setTimeout(() => {
				const startedAt = this.now()
				this.statsInFlight = this.pollStats(url).finally(() => {
					this.statsInFlight = null
					// Start-to-start cadence; a slow poll never overlaps the next.
					schedule(
						Math.max(0, this.statsPollIntervalMs - (this.now() - startedAt)),
					)
				})
			}, delayMs)
			this.statsTimer.unref?.()
		}
		schedule(this.statsPollIntervalMs)
	}

	private async pollStats(url: string): Promise<void> {
		this.sampling.observeProcesses(this.rtlmuxState.pid, this.rtlTcpState.pid)
		const pid = this.rtlmuxState.pid
		if (!this.rtlmuxState.running || pid === undefined) return

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.statsTimeoutMs)
		let body: unknown
		try {
			const response = await this.fetchFn(url, { signal: controller.signal })
			if (!response.ok) {
				this.sampling.observeFailure("http")
				return
			}
			const text = await readCapped(response, MAX_STATS_BYTES, controller)
			if (text === null) {
				this.sampling.observeFailure("invalid")
				return
			}
			body = JSON.parse(text)
		} catch (error) {
			this.sampling.observeFailure(
				controller.signal.aborted
					? "timeout"
					: error instanceof SyntaxError
						? "invalid"
						: "unreachable",
			)
			return
		} finally {
			clearTimeout(timeout)
		}

		const parsed = RtlmuxStatsSchema.safeParse(body)
		if (!parsed.success) {
			this.sampling.observeFailure("invalid")
			return
		}
		// Counters belong to one rtlmux process; discard a sample that may
		// straddle a restart rather than mixing two processes' counters.
		if (this.rtlmuxState.pid !== pid || !this.isProcess(pid, "rtlmux")) return
		this.sampling.observeStats(parsed.data, pid)
	}

	private isProcess(pid: number, name: string): boolean {
		try {
			return (
				fs
					.readFileSync(path.join(this.procRoot, String(pid), "comm"), "utf8")
					.trim() === name
			)
		} catch {
			return false
		}
	}

	private stopStatsPolling(): void {
		if (!this.statsTimer) return
		clearTimeout(this.statsTimer)
		this.statsTimer = null
	}
}

/** Reads a response body, aborting as soon as it exceeds `limit` bytes. */
async function readCapped(
	response: Response,
	limit: number,
	controller: AbortController,
): Promise<string | null> {
	if (!response.body) return await response.text()
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > limit) {
			controller.abort()
			await reader.cancel().catch(() => undefined)
			return null
		}
		chunks.push(value)
	}
	return Buffer.concat(chunks).toString("utf8")
}
