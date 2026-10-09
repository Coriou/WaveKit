import type { ReactElement } from "react"
import type { KeyContext } from "../ui/keymap.js"
import { helpLines } from "../view-models/help.js"
import { Lines } from "./lines.js"

export function HelpOverlay({
	ctx,
	width,
	height,
}: {
	ctx: KeyContext
	width: number
	height: number
}): ReactElement {
	const lines = helpLines(ctx, width, height)
	return <Lines lines={lines} width={width + 1} height={height} />
}
