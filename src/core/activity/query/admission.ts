import { ActivityQueryBusyError, ActivityQueryClosedError } from "./errors.js"

interface Waiter {
	clientKey: string
	resolve: (release: () => void) => void
	reject: (error: Error) => void
}

/** Point-in-time counters, for tests and diagnostics. */
export interface QueryAdmissionSnapshot {
	executing: number
	queued: number
	/** Executing plus queued requests per client key. */
	inFlight: Record<string, number>
	/** Queued requests per client key. */
	queuedByClient: Record<string, number>
}

/**
 * Bounded reader admission. At most `maxExecuting` reads run, at most
 * `maxQueued` wait, and one client holds at most `maxInFlightPerClient`
 * of those (executing plus queued). A client's own requests run in arrival
 * order; across clients the queue is served round robin, so one client's
 * burst cannot starve another. A request is refused only when its client is
 * at its cap or the shared queue is full.
 */
export class QueryAdmission {
	private executing = 0
	private queued = 0
	/** Per-client FIFO of waiting requests. */
	private readonly queues = new Map<string, Waiter[]>()
	/** Clients with waiting requests, in service order. */
	private readonly rotation: string[] = []
	private readonly clients = new Map<string, number>()
	private closed = false

	constructor(
		private readonly maxExecuting: number,
		private readonly maxQueued: number,
		private readonly maxInFlightPerClient: number,
	) {}

	acquire(clientKey: string): Promise<() => void> {
		if (this.closed) return Promise.reject(new ActivityQueryClosedError())
		const inflight = this.clients.get(clientKey) ?? 0
		if (inflight >= this.maxInFlightPerClient) {
			return Promise.reject(new ActivityQueryBusyError())
		}
		if (this.executing < this.maxExecuting && this.queued === 0) {
			this.clients.set(clientKey, inflight + 1)
			this.executing += 1
			return Promise.resolve(this.releaser(clientKey))
		}
		if (this.queued >= this.maxQueued) {
			return Promise.reject(new ActivityQueryBusyError())
		}
		this.clients.set(clientKey, inflight + 1)
		return new Promise((resolve, reject) => {
			let queue = this.queues.get(clientKey)
			if (!queue) {
				queue = []
				this.queues.set(clientKey, queue)
				this.rotation.push(clientKey)
			}
			queue.push({ clientKey, resolve, reject })
			this.queued += 1
		})
	}

	close(): void {
		this.closed = true
		const waiting: Waiter[] = []
		for (const key of this.rotation)
			waiting.push(...(this.queues.get(key) ?? []))
		this.queues.clear()
		this.rotation.length = 0
		this.queued = 0
		for (const waiter of waiting) {
			this.forget(waiter.clientKey)
			waiter.reject(new ActivityQueryClosedError())
		}
	}

	snapshot(): QueryAdmissionSnapshot {
		const queuedByClient: Record<string, number> = {}
		for (const [key, queue] of this.queues) queuedByClient[key] = queue.length
		return {
			executing: this.executing,
			queued: this.queued,
			inFlight: Object.fromEntries(this.clients),
			queuedByClient,
		}
	}

	/** A release that counts once, however often it is called. */
	private releaser(clientKey: string): () => void {
		let released = false
		return () => {
			if (released) return
			released = true
			this.release(clientKey)
		}
	}

	private release(clientKey: string): void {
		this.executing = Math.max(0, this.executing - 1)
		this.forget(clientKey)
		this.pump()
	}

	private forget(clientKey: string): void {
		const left = (this.clients.get(clientKey) ?? 1) - 1
		if (left <= 0) this.clients.delete(clientKey)
		else this.clients.set(clientKey, left)
	}

	private pump(): void {
		while (!this.closed && this.executing < this.maxExecuting) {
			const key = this.rotation.shift()
			if (key === undefined) return
			const queue = this.queues.get(key)
			const next = queue?.shift()
			if (!queue || !next) {
				this.queues.delete(key)
				continue
			}
			if (queue.length > 0) this.rotation.push(key)
			else this.queues.delete(key)
			this.queued -= 1
			this.executing += 1
			next.resolve(this.releaser(next.clientKey))
		}
	}
}
