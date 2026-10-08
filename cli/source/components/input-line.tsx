import type { ReactElement } from "react"
import { inputLine } from "../view-models/messages.js"
import { LineView } from "./lines.js"

export function InputLine({
	text,
	width,
}: {
	text: string
	width: number
}): ReactElement {
	return <LineView line={inputLine(text, width)} />
}
