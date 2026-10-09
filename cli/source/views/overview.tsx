import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { overviewKeys, overviewModel } from "../view-models/overview.js"
import type { ViewModule, ViewProps } from "./types.js"

function OverviewComponent({
	state,
	ui,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	const m = overviewModel(state, ui, width, height, heightClass === "roomy")
	if (m.layout === "stacked")
		return <Lines lines={m.left} width={width + 1} height={height} />
	return (
		<Box flexDirection="row" height={height}>
			<Lines lines={m.left} width={m.leftWidth + 1} height={height} />
			<Box width={2} />
			<Lines lines={m.right} width={m.rightWidth} height={height} indent={0} />
		</Box>
	)
}

export const overviewView: ViewModule = {
	id: "overview",
	title: "Overview",
	Component: OverviewComponent,
	// D: the app's height class; A6 M8: row ids and page size without the whole model.
	keyInfo: (state, ui, width, height, heightClass) => {
		const k = overviewKeys(state, width, height, heightClass === "roomy")
		return {
			rowIds: k.rowIds,
			pageSize: k.pageSize,
			ctx: { ...EMPTY_VIEW_CTX, hasSelection: ui.selected.overview !== null },
		}
	},
	// M9: Enter is applyUiAction's "open", which takes Overview to the Decoders detail.
}
