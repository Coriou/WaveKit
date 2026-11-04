// Hit lookups share one queue across drawer effects. A restart invalidates results, not the cap.
import { isApiError } from "./api-client.ts"

export type HitLookupState = "pending" | "available" | "unavailable"
export const HIT_LOOKUP_LIMIT = 20
const RETRY_DELAYS = [250, 1000] as const

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer)
			reject(new DOMException("Aborted", "AbortError"))
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort)
			resolve()
		}, ms)
		signal.addEventListener("abort", abort, { once: true })
		if (signal.aborted) abort()
	})
}

export class HitDiscoveryLoader {
	private states = new Map<string, HitLookupState>()
	private queue: string[] = []
	private active = new Set<AbortController>()
	private generation = 0
	private disposed = false

	constructor(
		private readonly read: (
			id: string,
			signal: AbortSignal,
		) => Promise<unknown>,
		private readonly changed: (
			states: ReadonlyMap<string, HitLookupState>,
		) => void,
	) {}

	request(ids: Iterable<string>): void {
		if (this.disposed) return
		let changed = false
		for (const id of ids) {
			if (this.states.has(id)) continue
			this.states.set(id, "pending")
			this.queue.push(id)
			changed = true
		}
		if (changed) this.publish()
		this.pump()
	}

	reset(): void {
		this.generation++
		this.queue = []
		this.states.clear()
		for (const controller of this.active) controller.abort()
		this.publish()
	}

	dispose(): void {
		this.disposed = true
		this.reset()
	}

	private publish(): void {
		if (!this.disposed) this.changed(new Map(this.states))
	}

	private pump(): void {
		while (
			!this.disposed &&
			this.active.size < HIT_LOOKUP_LIMIT &&
			this.queue.length
		) {
			const id = this.queue.shift()!
			const controller = new AbortController()
			this.active.add(controller)
			void this.run(id, controller, this.generation)
		}
	}

	private async run(
		id: string,
		controller: AbortController,
		generation: number,
	): Promise<void> {
		let state: HitLookupState = "unavailable"
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					await this.read(id, controller.signal)
					state = "available"
					break
				} catch (error) {
					if (
						controller.signal.aborted ||
						(isApiError(error) && error.status === 404)
					)
						break
					const ms = RETRY_DELAYS[attempt]
					if (ms === undefined) break
					await delay(ms, controller.signal)
				}
			}
		} catch {
			// Cancellation during backoff; a reset owns the new state.
		} finally {
			this.active.delete(controller)
			if (!this.disposed && generation === this.generation) {
				this.states.set(id, state)
				this.publish()
			}
			this.pump()
		}
	}
}
