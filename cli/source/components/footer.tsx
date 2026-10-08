import type { ReactElement } from "react"
import type { KeyContext } from "../ui/keymap.js"
import type { UiState } from "../ui/ui-state.js"
import { footerWithNotice } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function Footer({
	ctx,
	notice,
	now,
	width,
}: {
	ctx: KeyContext
	notice: UiState["notice"]
	now: number
	width: number
}): ReactElement {
	return <LineView line={footerWithNotice(ctx, notice, now, width)} />
}
