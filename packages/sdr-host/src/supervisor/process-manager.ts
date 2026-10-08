import * as fs from "node:fs"
import * as path from "node:path"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "@wavekit/shared"
import type { SdrHostConfig } from "../config.js"

export interface ProcessState {
	running: boolean
	pid: number | undefined
	restartCount: number
	lastRestartAt: Date | null
	lastError: string | null
}

export interface RtlmuxStats {
	clients: number
	bytesPerSec: number
	totalBytesSent: number
	clientDetails: Array<{
		id: number
		address: string
		bytesDropped: number
	}>
}

interface RawRtlmuxClient {
	client: { host: string; port: number }
	dataOut: number
	dropped?: { size?: number }
}

interface InternalProcessState extends ProcessState {
	lastPid?: number
	seenOnce: boolean
}

interface ProcessManagerOptions {
	procRoot?: string
	fetchFn?: typeof fetch
	now?: () => number
	processPollIntervalMs?: number
	statsPollIntervalMs?: number
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
	private processPollingInterval: ReturnType<typeof setInterval> | null = null
	private statsPollingInterval: ReturnType<typeof setInterval> | null = null
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
	private lastStatsSample: {
		at: number
		totalBytesSent: number
		pid: number | undefined
	} | null = null
	private currentStats: RtlmuxStats = {
		clients: 0,
		bytesPerSec: 0,
		totalBytesSent: 0,
		clientDetails: [],
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
		this.now = options.now ?? (() => Date.now())
		this.processPollIntervalMs = options.processPollIntervalMs ?? 2000
		this.statsPollIntervalMs = options.statsPollIntervalMs ?? 2000
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
	 * Returns current rtlmux stats.
	 */
	getRtlmuxStats(): RtlmuxStats {
		return { ...this.currentStats }
	}

	/**
	 * Stops monitoring.
	 */
	async shutdown(): Promise<void> {
		this.log.info("Stopping process monitoring")
		this.stopProcessPolling()
		this.stopStatsPolling()
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
				state.lastRestartAt = new Date(this.now())
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
		if (this.statsPollingInterval) return
		const pollStats = async (): Promise<void> => {
			if (!this.rtlmuxState.running) {
				this.lastStatsSample = null
				this.currentStats = {
					clients: 0,
					bytesPerSec: 0,
					totalBytesSent: 0,
					clientDetails: [],
				}
				return
			}

			try {
				const response = await this.fetchFn(
					`http://127.0.0.1:${statsPort}/stats.json`,
				)
				if (response.ok) {
					const data = (await response.json()) as {
						clients?: number | RawRtlmuxClient[]
						bytes_per_sec?: number
						total_bytes_sent?: number
						client_details?: Array<{
							id: number
							address: string
							bytes_dropped: number
						}>
					}
					// slepp/rtlmux exposes a clients array, not the legacy numeric
					// count / client_details shape. Normalize both into our API.
					const rawClients = Array.isArray(data.clients) ? data.clients : null
					const totalBytesSent =
						data.total_bytes_sent ??
						rawClients?.reduce((total, client) => total + client.dataOut, 0) ??
						0
					const at = this.now()
					const previous = this.lastStatsSample
					const elapsedSeconds = previous ? (at - previous.at) / 1000 : 0
					const bytesPerSec =
						data.bytes_per_sec ??
						(previous &&
						previous.pid === this.rtlmuxState.pid &&
						elapsedSeconds > 0
							? Math.max(
									0,
									(totalBytesSent - previous.totalBytesSent) / elapsedSeconds,
								)
							: 0)
					this.lastStatsSample = {
						at,
						totalBytesSent,
						pid: this.rtlmuxState.pid,
					}
					this.currentStats = {
						clients: rawClients
							? rawClients.length
							: ((data.clients as number | undefined) ?? 0),
						bytesPerSec,
						totalBytesSent,
						clientDetails: rawClients
							? rawClients.map((client, index) => ({
									id: index,
									address: `${client.client.host.includes(":") ? `[${client.client.host}]` : client.client.host}:${client.client.port}`,
									bytesDropped: client.dropped?.size ?? 0,
								}))
							: (data.client_details?.map(c => ({
									id: c.id,
									address: c.address,
									bytesDropped: c.bytes_dropped,
								})) ?? []),
					}
				}
			} catch {
				// Stats endpoint not yet available, ignore
			}
		}

		this.statsPollingInterval = setInterval(() => {
			void pollStats()
		}, this.statsPollIntervalMs)
	}

	private stopStatsPolling(): void {
		if (!this.statsPollingInterval) return
		clearInterval(this.statsPollingInterval)
		this.statsPollingInterval = null
	}
}
