export interface Store<T> {
	get(): T
	set(next: T): void
	subscribe(listener: () => void): () => void
	/** Number of committed (changed) sets; used by tests to assert ≤ 1 commit per tick. */
	commits(): number
}

export function createStore<T>(initial: T): Store<T> {
	let current = initial
	let count = 0
	const listeners = new Set<() => void>()
	return {
		get: () => current,
		set: next => {
			if (Object.is(next, current)) return
			current = next
			count++
			for (const listener of [...listeners]) listener()
		},
		subscribe: listener => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		commits: () => count,
	}
}
