import { Text } from "ink"
import type { ReactElement } from "react"
import { tooSmallText } from "../ui/frame.js"

export function TooSmall({
	cols,
	rows,
}: {
	cols: number
	rows: number
}): ReactElement {
	return <Text wrap="truncate-end">{tooSmallText(cols, rows)}</Text>
}
