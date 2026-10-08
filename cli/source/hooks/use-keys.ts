import { useInput } from "ink"
import { useRef } from "react"
import type { Action } from "../ui/actions.js"
import { keyName, resolveKey, type KeyContext } from "../ui/keymap.js"

/** The single root useInput (spec §7). Ink parses one key per stdin chunk; no escape buffer unless tmux validation shows a need (§15). */
export function useKeys(ctx: KeyContext, dispatch: (a: Action) => void): void {
	const ref = useRef({ ctx, dispatch })
	ref.current = { ctx, dispatch }
	useInput((input, key) => {
		const action = resolveKey(ref.current.ctx, keyName(input, key))
		if (action) ref.current.dispatch(action)
	})
}
