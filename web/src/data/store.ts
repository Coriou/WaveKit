/**
 * A tiny observable value and its React binding. Stores hold immutable snapshots: `set` and
 * `update` replace the value, and listeners run only when it changes (Object.is).
 */
import { useCallback, useSyncExternalStore } from "react"

export type Listener<T> = (value: T, previous: T) => void

export class Store<T> {
	private value: T
	private readonly listeners = new Set<Listener<T>>()

	constructor(initial: T) {
		this.value = initial
	}

	get(): T {
		return this.value
	}

	set(next: T): void {
		const previous = this.value
		if (Object.is(previous, next)) return
		this.value = next
		for (const listener of [...this.listeners]) listener(next, previous)
	}

	update(fn: (value: T) => T): void {
		this.set(fn(this.value))
	}

	subscribe = (listener: Listener<T>): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
}

/** Anything with the store's read side (stores, or derived views of them). */
export interface ReadableStore<T> {
	get(): T
	subscribe(listener: Listener<T>): () => void
}

const identity = <T>(value: T): T => value

/**
 * Reads a store in a component. The selector must return a stable value for an unchanged
 * store (a field, a primitive, or a memoised object), or React re-renders forever.
 */
export function useStore<T>(store: ReadableStore<T>): T
export function useStore<T, S>(
	store: ReadableStore<T>,
	selector: (value: T) => S,
): S
export function useStore<T, S>(
	store: ReadableStore<T>,
	selector?: (value: T) => S,
): S | T {
	const select = selector ?? (identity as (value: T) => S)
	const subscribe = useCallback(
		(notify: () => void) => store.subscribe(() => notify()),
		[store],
	)
	const read = () => select(store.get())
	return useSyncExternalStore(subscribe, read, read)
}
