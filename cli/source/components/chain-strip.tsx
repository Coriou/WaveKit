import type { ReactElement } from "react"
import type { AppState } from "../data/types.js"
import { stripLine } from "../ui/strip.js"
import { stripInput } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function ChainStrip({
	state,
	width,
}: {
	state: AppState
	width: number
}): ReactElement {
	return <LineView line={stripLine(stripInput(state), width)} />
}
