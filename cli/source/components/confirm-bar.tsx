import { Text } from "ink"
import { useContext, type ReactElement } from "react"
import { roleProps } from "../ui/theme.js"
import type { ConfirmRequest } from "../ui/ui-state.js"
import { confirmLine } from "../view-models/chrome.js"
import { ColorContext } from "./lines.js"

/** The confirm bar is one of the three inverse elements (spec §8). */
export function ConfirmBar({
	confirm,
	width,
}: {
	confirm: ConfirmRequest
	width: number
}): ReactElement {
	const color = useContext(ColorContext)
	return (
		<Text wrap="truncate-end">
			{" "}
			<Text inverse>
				{confirmLine(confirm, width).map((s, i) => (
					<Text key={i} {...roleProps(s.role, color, s.bold === true)}>
						{s.text}
					</Text>
				))}
			</Text>
		</Text>
	)
}
