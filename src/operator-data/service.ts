import { randomUUID } from "node:crypto"
import { transition } from "./domain.js"
import type { DomainContext, TransitionResult } from "./domain.js"
import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	parseMutation,
	validateSnapshot,
} from "./schema.js"
import type { OperatorDataMutation, OperatorDataSnapshot } from "./schema.js"
import { OperatorDataStorage } from "./storage.js"
import type { OperatorDataStorageOptions } from "./storage.js"

export interface OperatorDataServiceOptions {
	stateDir: string
	/** Synchronous publication only; promises are not a supported transport. */
	onCommit?: (snapshot: OperatorDataSnapshot) => undefined
	context?: DomainContext
	/** Narrow test seam around real local storage I/O. */
	storageStage?: OperatorDataStorageOptions["stage"]
}
export interface OperatorDataMutationResult extends TransitionResult {
	/** Internal transport outcome, separate from durable mutation success. */
	delivery: "sent" | "failed" | "unmounted" | "not-needed"
}
const unavailable = () => new OperatorDataError("OPERATOR_DATA_UNAVAILABLE")

/** One local durable authority. Admitted work may commit even if its caller disconnects;
 * an unknown response outcome requires refetch/reconciliation, never automatic retry.
 */
export class OperatorDataService {
	private current: OperatorDataSnapshot
	private tail: Promise<void> = Promise.resolve()
	private admitted = 0
	private closing = false
	private closed = false
	private closeResult: Promise<void> | undefined
	private constructor(
		private readonly storage: OperatorDataStorage,
		private readonly context: DomainContext,
		private readonly onCommit: OperatorDataServiceOptions["onCommit"],
	) {
		this.current = storage.snapshot()
	}
	static async open(
		options: OperatorDataServiceOptions,
	): Promise<OperatorDataService> {
		const context = options.context
			? { now: options.context.now, uuid: options.context.uuid }
			: { now: () => new Date().toISOString(), uuid: randomUUID }
		const sink = options.onCommit
		const storage = await OperatorDataStorage.open({
			stateDir: options.stateDir,
			...(options.storageStage ? { stage: options.storageStage } : {}),
		})
		return new OperatorDataService(storage, context, sink)
	}
	snapshot(): OperatorDataSnapshot {
		if (this.closed || !this.storage.isAvailable()) throw unavailable()
		return validateSnapshot(this.current)
	}
	mutate(input: unknown): Promise<OperatorDataMutationResult> {
		let mutation: OperatorDataMutation
		try {
			if (this.closing || !this.storage.isAvailable()) throw unavailable()
			// Zod parses into detached objects before any bounded queue slot is taken.
			mutation = parseMutation(input)
			if (this.admitted >= OPERATOR_DATA_LIMITS.waitingTransactions + 1)
				throw new OperatorDataError("OPERATOR_DATA_BUSY")
		} catch (error) {
			return Promise.reject(error)
		}
		this.admitted += 1
		const operation = this.tail
			.then(() => this.commit(mutation))
			.finally(() => {
				this.admitted -= 1
			})
		// A failed transaction cannot poison later accepted work.
		this.tail = operation.then(
			() => undefined,
			() => undefined,
		)
		return operation
	}
	close(): Promise<void> {
		if (!this.closeResult) {
			this.closing = true
			this.closeResult = this.tail.then(() => {
				this.closed = true
				return this.storage.close()
			})
		}
		return this.closeResult
	}
	private async commit(
		mutation: OperatorDataMutation,
	): Promise<OperatorDataMutationResult> {
		// Closing admission does not cancel operations accepted before close().
		if (this.closed || !this.storage.isAvailable()) throw unavailable()
		const proposal = transition(this.current, mutation, this.context)
		if (!proposal.changed) return { ...proposal, delivery: "not-needed" }
		await this.storage.persist(proposal.snapshot)
		this.current = proposal.snapshot
		// Swap, detached sink invocation and result capture have no await boundary.
		const delivery = this.publish()
		return { ...proposal, snapshot: this.snapshot(), delivery }
	}
	private publish(): OperatorDataMutationResult["delivery"] {
		if (!this.onCommit) return "unmounted"
		try {
			const result: unknown = this.onCommit(this.snapshot())
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				"then" in result &&
				typeof result.then === "function"
			) {
				// Defend against a mistyped async sink without waiting or leaking rejection.
				void Promise.resolve(result).catch(() => undefined)
				return "failed"
			}
			return "sent"
		} catch {
			return "failed"
		}
	}
}
