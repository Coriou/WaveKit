import type { ReactElement } from "react"
import type { AppState } from "../data/types.js"
import type { KeyContext } from "../ui/keymap.js"
import { helpLines } from "../view-models/help.js"
import { Lines } from "./lines.js"

export function HelpOverlay({
	ctx,
	state,
	width,
	height,
}: {
	ctx: KeyContext
	state: AppState
	width: number
	height: number
}): ReactElement {
	const lines = helpLines(ctx, width, height, {
		invalidFrames: state.conn.invalidFrames,
		rejectedItems: state.conn.rejectedItems,
	})
	return <Lines lines={lines} width={width + 1} height={height} />
}
