import type { Readable } from "node:stream"
import type {
	ChannelProvider,
	ChannelRequestResult,
} from "../../channelizer/types.js"
import type {
	ObservedAcquisitionHandle,
	ObservedGrantBinding,
} from "../../channelizer/settlement-observer.js"
import type { ScannerChannelAttempt } from "./consumer-types.js"
import { RuntimeListenerRegistration } from "./consumer-lifecycle.js"

/** Exact acquisition identity and synchronous intake fence; release is logical only. */
export class GrantLifecycle {
	private currentBinding: ObservedGrantBinding | undefined
	private stream: Readable | undefined
	private sealed = false
	private callbackFailed = false
	private reclaimed = false
	private gapNotified = false
	private released: Promise<void> | undefined
	private readonly unsubscribe: () => void
	private readonly errorListener = (): void => this.invalidate()
	private readonly registrations: RuntimeListenerRegistration[] = []

	constructor(
		readonly attempt: ScannerChannelAttempt,
		readonly handle: ObservedAcquisitionHandle,
		private readonly provider: ChannelProvider,
		private readonly current: () => boolean,
		private readonly ended: () => void,
		private readonly discontinuity: (() => void) | undefined = undefined,
	) {
		// Coverage exists before acquisition, including grant invalidation before await resumes.
		this.unsubscribe = handle.onChange(() => {
			const snapshot = handle.snapshot()
			if (snapshot.continuityLost && !this.gapNotified) {
				this.gapNotified = true
				try {
					this.discontinuity?.()
				} catch {
					this.callbackFailed = true
					this.invalidate()
				}
			}
			if (snapshot.ended || !this.attemptCurrent()) this.invalidate()
		})
	}
	get continuityLost(): boolean {
		return this.handle.snapshot().continuityLost
	}

	get binding(): ObservedGrantBinding | undefined {
		return this.live ? this.currentBinding : undefined
	}
	get readable(): Readable | undefined {
		return this.live ? this.stream : undefined
	}

	get live(): boolean {
		const snapshot = this.handle.snapshot()
		return (
			!this.sealed &&
			this.attemptCurrent() &&
			!snapshot.ended &&
			this.currentBinding !== undefined &&
			snapshot.currentBinding === this.currentBinding &&
			this.stream !== undefined &&
			!this.stream.destroyed &&
			!this.stream.readableEnded
		)
	}

	adopt(result: Extract<ChannelRequestResult, { ok: true }>): boolean {
		const binding = this.handle.binding
		if (
			this.sealed ||
			this.registrations.length !== 0 ||
			!this.attemptCurrent() ||
			this.handle.snapshot().ended ||
			!binding ||
			binding.sourceId !== this.attempt.sourceId ||
			binding.decoderId !== this.attempt.decoderId ||
			binding.channelId !== result.channelId ||
			binding.generation !== result.generation ||
			binding.realised.outputRateHz !== 48000 ||
			binding.realised.format !== "cf32" ||
			result.realised.outputRateHz !== 48000 ||
			result.realised.format !== "cf32" ||
			binding.realised.groupDelaySamples !==
				result.realised.groupDelaySamples ||
			!Number.isFinite(binding.realised.groupDelaySamples) ||
			binding.realised.groupDelaySamples < 0 ||
			result.stream.destroyed ||
			result.stream.readableEnded
		) {
			try {
				result.stream.destroy()
			} catch {
				this.callbackFailed = true
			}
			this.releaseResult(result.channelId)
			this.invalidate()
			return false
		}
		this.currentBinding = binding
		this.stream = result.stream
		// Retain all exact owners BEFORE the first registration can cancel adoption.
		for (const event of ["error", "end", "close"] as const) {
			const stream = result.stream
			this.registrations.push(
				new RuntimeListenerRegistration(
					() => {
						if (event === "error") stream.on(event, this.errorListener)
						else stream.once(event, this.errorListener)
					},
					() => {
						stream.off(event, this.errorListener)
					},
					() => !stream.listeners(event).includes(this.errorListener),
				),
			)
		}
		try {
			for (const registration of this.registrations) {
				if (this.sealed || !registration.register()) break
			}
		} catch {
			this.callbackFailed = true
			this.invalidate()
		}
		if (!this.live) {
			this.invalidate()
			return false
		}
		return true
	}

	/** Clear identity BEFORE callbacks, abort, stream close or release can reenter. */
	invalidate(): void {
		if (this.sealed) {
			this.removeRegistrations()
			return
		}
		this.sealed = true
		const binding = this.currentBinding
		const stream = this.stream
		this.currentBinding = undefined
		this.stream = undefined
		try {
			this.ended()
		} catch {
			this.callbackFailed = true
		} finally {
			try {
				this.handle.cancel()
			} catch {
				this.callbackFailed = true
			}
			if (stream) {
				this.removeRegistrations()
				try {
					stream.destroy()
				} catch {
					this.callbackFailed = true
				}
			}
			if (binding) this.releaseResult(binding.channelId)
		}
	}

	/** No physical credit is implied by this promise. */
	logicalDrain(): Promise<void> {
		return this.released ?? Promise.resolve()
	}

	/** Keep native/local unknown tombstones; no elapsed time, ID or generation credit. */
	reclaimIfSettled(): boolean {
		if (this.reclaimed) return true
		if (!this.sealed) return false
		this.removeRegistrations()
		const state = this.handle.snapshot()
		if (
			this.callbackFailed ||
			this.registrations.some(
				registration => !registration.settled || registration.failed,
			) ||
			state.native !== "settled" ||
			state.local !== "settled" ||
			Object.values(state.components).some(value => value !== "settled")
		)
			return false
		try {
			this.unsubscribe()
		} catch {
			this.callbackFailed = true
			return false
		}
		this.reclaimed = true
		return true
	}

	private removeRegistrations(): void {
		for (const registration of this.registrations) {
			try {
				registration.remove()
			} catch {
				this.callbackFailed = true
			}
		}
	}

	private attemptCurrent(): boolean {
		try {
			return this.current()
		} catch {
			return false
		}
	}

	private releaseResult(channelId: string): void {
		if (this.released) return
		// Claim before invoking the provider, whose synchronous destruction can reenter.
		let resolve!: () => void
		let reject!: (error: unknown) => void
		this.released = new Promise<void>((yes, no) => {
			resolve = yes
			reject = no
		})
		void this.released.catch(() => undefined)
		try {
			void this.provider.releaseChannel(channelId).then(resolve, reject)
		} catch (error) {
			reject(error)
		}
	}
}
