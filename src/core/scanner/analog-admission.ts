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

/** One analog slot and the probe pool core budget, shared by replay and identify. */
export class AnalogAdmission implements AnalogTrialRunner {
	private busy = false
	private readonly stopped = new AbortController()

	constructor(
		private readonly runner: AnalogTrialRunner,
		private readonly reserveCores: (cores: number) => (() => void) | null,
	) {}

	reserve(cores: number): (() => void) | null {
		if (this.busy || this.stopped.signal.aborted) return null
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

	stop(): void {
		this.stopped.abort()
	}
}
