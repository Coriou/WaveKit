import type { IqCaptureRequest } from "./iq-capture-contract.js"
import { setTimeout as delay } from "node:timers/promises"
import {
	ANALOG_TRIAL_CORES,
	type AnalogTrialMode,
	type AnalogTrialResult,
	type AnalogTrialRunner,
} from "./scanner-redesign-contract.js"

function cancelled(mode: AnalogTrialMode): AnalogTrialResult {
	return {
		outcome: "no-sync",
		mode,
		voice: false,
		tones: { ctcssHz: null, dcs: null, audioSeconds: 0 },
		stats: null,
		error: "cancelled",
	}
}

/** Replay retains its core reservation; private trials share the two-capture ceiling. */
export class AnalogAdmission implements AnalogTrialRunner {
	private busy = false
	readonly runLive?: NonNullable<AnalogTrialRunner["runLive"]>
	private readonly live = new Map<string, number>()
	private readonly stopped = new AbortController()

	constructor(
		private readonly runner: AnalogTrialRunner,
		private readonly reserveCores: (cores: number) => (() => void) | null,
	) {
		if (runner.runLive)
			this.runLive = (req, mode, signal) => this.liveRun(req, mode, signal)
	}

	reserve(cores: number): (() => void) | null {
		if (this.busy || this.liveCount() >= 2 || this.stopped.signal.aborted)
			return null
		const release = this.reserveCores(cores)
		if (!release) return null
		this.busy = true
		let released = false
		return () => {
			if (released) return
			released = true
			this.busy = false
			release()
		}
	}

	async run(
		captureId: string,
		mode: AnalogTrialMode,
		caller: AbortSignal,
	): Promise<AnalogTrialResult> {
		const signal = AbortSignal.any([caller, this.stopped.signal])
		let release: (() => void) | null = null
		while (!signal.aborted) {
			release = this.reserve(ANALOG_TRIAL_CORES)
			if (release) break
			try {
				await delay(25, undefined, { signal })
			} catch {
				return cancelled(mode)
			}
		}
		if (!release) return cancelled(mode)
		let onAbort = (): void => {}
		try {
			const aborted = new Promise<AnalogTrialResult>(resolve => {
				onAbort = () => resolve(cancelled(mode))
				signal.addEventListener("abort", onAbort, { once: true })
			})
			const running = Promise.resolve().then(() =>
				signal.aborted
					? cancelled(mode)
					: this.runner.run(captureId, mode, signal),
			)
			return await Promise.race([running, aborted])
		} finally {
			signal.removeEventListener("abort", onAbort)
			release()
		}
	}

	private async liveRun(
		req: IqCaptureRequest,
		mode: AnalogTrialMode,
		caller: AbortSignal,
	): Promise<AnalogTrialResult> {
		const signal = AbortSignal.any([caller, this.stopped.signal])
		while (!signal.aborted && (this.live.get(req.sourceId) ?? 0) >= 2) {
			try {
				await delay(25, undefined, { signal })
			} catch {
				return cancelled(mode)
			}
		}
		if (signal.aborted || !this.runner.runLive) return cancelled(mode)
		this.live.set(req.sourceId, (this.live.get(req.sourceId) ?? 0) + 1)
		try {
			return await this.runner.runLive(req, mode, signal)
		} finally {
			const left = (this.live.get(req.sourceId) ?? 1) - 1
			if (left > 0) this.live.set(req.sourceId, left)
			else this.live.delete(req.sourceId)
		}
	}

	private liveCount(): number {
		return [...this.live.values()].reduce((sum, count) => sum + count, 0)
	}

	stop(): void {
		this.stopped.abort()
	}
}
