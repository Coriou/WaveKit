import {
	ActivityQueryBusyError,
	ActivityQueryClosedError,
} from "./errors.js"

interface Waiter {
	clientKey: string
	resolve: (release: () => void) => void
	reject: (error: Error) => void
}

/**
 * One executing reader and a short queue. A second request from the same
 * client is refused even when the global queue has room.
 */
export class QueryAdmission {
	private executing = 0
	private readonly queue: Waiter[] = []
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
		if (this.executing >= this.maxExecuting && this.queue.length >= this.maxQueued) {
			return Promise.reject(new ActivityQueryBusyError())
		}
		this.clients.set(clientKey, inflight + 1)
		if (this.executing < this.maxExecuting) {
			this.executing += 1
			return Promise.resolve(() => this.release(clientKey))
		}
		return new Promise((resolve, reject) => {
			this.queue.push({ clientKey, resolve, reject })
		})
	}

	close(): void {
		this.closed = true
		const queued = this.queue.splice(0)
		for (const waiter of queued) {
			this.forget(waiter.clientKey)
			waiter.reject(new ActivityQueryClosedError())
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
		if (this.closed || this.executing >= this.maxExecuting) return
		const next = this.queue.shift()
		if (!next) return
		this.executing += 1
		next.resolve(() => this.release(next.clientKey))
	}
}
