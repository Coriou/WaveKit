import { useMemo, useSyncExternalStore } from "react"
import { memoOne } from "../data/memo.js"
import type { Store } from "../data/store.js"

/** useSyncExternalStore over the single store; the selector is memoised on state identity so getSnapshot is stable. */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
	const memo = useMemo(() => memoOne(selector), [selector])
	return useSyncExternalStore(store.subscribe, () => memo(store.get()))
}
