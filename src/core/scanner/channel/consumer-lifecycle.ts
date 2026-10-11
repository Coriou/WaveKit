/**
 * Scanner component cleanup, independent of channel native/local accounting.
 * Composition retains this inert owner before any scanner constructor effect.
 */
import type {
	ChannelSettlementObserver,
	CleanupOutcome,
	ProviderLifetime,
} from "../../channelizer/settlement-observer.js"
import { WaveKitError } from "../../../utils/errors.js"

export type ScannerCleanupSlot =
	| "service"
	| "probes"
	| "grants"
	| "tap"
	| "classifier"
	| "producer"
	| "admission"

export interface ScannerStopHandle {
	readonly producerSettled: Promise<void>
	readonly completed: Promise<void>
}

interface CleanupSlot {
	attempt: (() => Promise<CleanupOutcome>) | undefined
	outcome: CleanupOutcome | undefined
}

interface Deferred {
	readonly promise: Promise<void>
	readonly resolve: () => void
	readonly reject: (reason: unknown) => void
}

const SLOT_NAMES: readonly ScannerCleanupSlot[] = Object.freeze([
	"service",
	"probes",
	"grants",
	"tap",
	"classifier",
	"producer",
	"admission",
])
const OK: CleanupOutcome = Object.freeze({ ok: true })
const CLEANUP_FAILED: CleanupOutcome = Object.freeze({
	ok: false,
	state: "failed",
	detail: "Scanner component cleanup failed",
})
const INSPECTION_FAILED: CleanupOutcome = Object.freeze({
	ok: false,
	state: "failed",
	detail: "Scanner final ownership inspection failed",
})

function deferred(): Deferred {
	let resolve!: () => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})
	// Keep an externally retained partial-construction handle from causing an unhandled rejection.
	// Its original rejecting promise is still returned to every caller.
	void promise.catch(() => undefined)
	return { promise, resolve, reject }
}

function frozenOutcome(outcome: CleanupOutcome): CleanupOutcome {
	return outcome.ok
		? OK
		: Object.freeze({ ok: false, state: outcome.state, detail: outcome.detail })
}

function outcomeError(
	outcome: Exclude<CleanupOutcome, { readonly ok: true }>,
): WaveKitError {
	return new WaveKitError(
		outcome.detail,
		outcome.state === "failed"
			? "SCANNER_COMPONENT_CLEANUP_FAILED"
			: "SCANNER_COMPONENT_CLEANUP_UNKNOWN",
	)
}

export class ScannerLifecycleOwner {
	private readonly slots: Record<ScannerCleanupSlot, CleanupSlot> = {
		service: { attempt: undefined, outcome: undefined },
		probes: { attempt: undefined, outcome: undefined },
		grants: { attempt: undefined, outcome: undefined },
		tap: { attempt: undefined, outcome: undefined },
		classifier: { attempt: undefined, outcome: undefined },
		producer: { attempt: undefined, outcome: undefined },
		admission: { attempt: undefined, outcome: undefined },
	}
	private sealed = false
	private constructionOutcome: CleanupOutcome | undefined
	private readonly constructionSettled = deferred()
	private firstFailure:
		| Exclude<CleanupOutcome, { readonly ok: true }>
		| undefined
	private producerOutcome: CleanupOutcome | undefined
	private handle: Readonly<ScannerStopHandle> | undefined
	private producerBarrier: Deferred | undefined
	private completedBarrier: Deferred | undefined
	private finalizationStarted = false

	get admissionSealed(): boolean {
		return this.sealed
	}

	/**
	 * Register before the first effect. The closure owns the actual component inventory even if
	 * construction throws. It returns ok only after EACH actual sibling/late create has drained,
	 * exact successful subscriptions have been removed, and component references have been released.
	 * It must never await native/provider/registry final settlement or later shutdown phases.
	 */
	ownCleanup(
		slot: ScannerCleanupSlot,
		attempt: () => Promise<CleanupOutcome>,
	): boolean {
		const owned = this.slots[slot]
		if (
			this.sealed ||
			owned.attempt !== undefined ||
			owned.outcome !== undefined
		)
			return false
		owned.attempt = attempt
		return true
	}

	sealAdmission(): void {
		this.sealed = true
	}

	/** Exactly one checkpoint; failure seals future effects without claiming existing effects cleaned. */
	completeConstruction(outcome: CleanupOutcome): void {
		if (this.constructionOutcome !== undefined) return
		const decision = frozenOutcome(outcome)
		this.constructionOutcome = decision
		if (!decision.ok) {
			this.sealAdmission()
			this.rememberFailure(decision)
		}
		this.constructionSettled.resolve()
	}

	/** Phase40 only. Claim the immutable first handle BEFORE any cleanup callback can reenter. */
	beginStop(): Readonly<ScannerStopHandle> {
		if (this.handle !== undefined) return this.handle
		this.sealAdmission()
		const producer = deferred()
		const completed = deferred()
		const handle = Object.freeze({
			producerSettled: producer.promise,
			completed: completed.promise,
		})
		this.producerBarrier = producer
		this.completedBarrier = completed
		this.handle = handle
		// A constructor must record its success/catch checkpoint. No guessed absence or timeout
		// releases ongoing construction. Already-registered closures retain every late resource.
		void this.constructionSettled.promise
			.then(() => this.cleanupComponents())
			.catch(() => {
				this.rememberFailure(CLEANUP_FAILED)
				this.finishComponents()
			})
		return handle
	}

	/**
	 * Phase66 only, after composition's actual phase60/65 attempts. Core inspection is synchronous
	 * and nonwaiting; no native cleanup, registry drain or source/fanout shutdown is invoked here.
	 * Standalone stop and partial-constructor cleanup share this exact first completion promise.
	 */
	finalizeStopNative(
		observer: ChannelSettlementObserver | undefined,
		lifetime?: ProviderLifetime,
	): Promise<void> {
		const handle = this.beginStop()
		if (this.finalizationStarted) return handle.completed
		this.finalizationStarted = true
		void handle.producerSettled
			.catch(() => undefined)
			.then(() => {
				// Helper ok already proves its actual component/subscription refs were removed. Only
				// successful original closures can now be forgotten; failed/unknown owners stay retained.
				for (const name of SLOT_NAMES) {
					const slot = this.slots[name]
					if (slot.outcome?.ok === true) slot.attempt = undefined
				}
				let final: CleanupOutcome
				try {
					const inspected =
						observer !== undefined
							? observer.inspectFinal(this.producerOutcome ?? CLEANUP_FAILED)
							: lifetime !== undefined
								? lifetime.inspectFinal(this.producerOutcome ?? CLEANUP_FAILED)
								: (this.producerOutcome ?? CLEANUP_FAILED)
					final = frozenOutcome(inspected)
				} catch {
					final = INSPECTION_FAILED
				}
				if (!final.ok) this.rememberFailure(final)
				const failure = this.firstFailure
				if (failure === undefined) this.completedBarrier?.resolve()
				else this.completedBarrier?.reject(outcomeError(failure))
			})
			.catch(() => {
				this.rememberFailure(INSPECTION_FAILED)
				const failure = this.firstFailure
				if (failure !== undefined)
					this.completedBarrier?.reject(outcomeError(failure))
			})
		return handle.completed
	}

	private async cleanupComponents(): Promise<void> {
		// Every fixed slot starts independently. Each returned promise must represent actual cleanup,
		// so an early failure cannot settle phase40 while a sibling remains owned or pending.
		await Promise.allSettled(
			SLOT_NAMES.map(async name => {
				const slot = this.slots[name]
				if (slot.attempt === undefined) return
				let outcome: CleanupOutcome
				try {
					outcome = frozenOutcome(await slot.attempt())
				} catch {
					outcome = CLEANUP_FAILED
				}
				slot.outcome = outcome
				if (!outcome.ok) this.rememberFailure(outcome)
			}),
		)
		this.finishComponents()
	}

	private rememberFailure(outcome: CleanupOutcome): void {
		if (!outcome.ok && this.firstFailure === undefined)
			this.firstFailure = outcome
	}

	private finishComponents(): void {
		if (this.producerOutcome !== undefined) return
		const failure = this.firstFailure
		this.producerOutcome = failure ?? OK
		if (failure === undefined) this.producerBarrier?.resolve()
		else this.producerBarrier?.reject(outcomeError(failure))
	}
}
