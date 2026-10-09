import type { ReactElement } from "react"
import type { ViewId } from "../ui/actions.js"
import { switcherLine } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function Switcher({
	view,
	width,
}: {
	view: ViewId
	width: number
}): ReactElement {
	return <LineView line={switcherLine(view, width)} />
}
