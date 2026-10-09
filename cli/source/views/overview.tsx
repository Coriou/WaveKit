import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { overviewModel } from "../view-models/overview.js"
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
	keyInfo: (state: AppState, ui: UiState, width: number, height: number) => {
		const m = overviewModel(state, ui, width, height, height >= 25)
		return {
			rowIds: m.rowIds,
			pageSize: m.pageSize,
			ctx: { ...EMPTY_VIEW_CTX, hasSelection: ui.selected.overview !== null },
		}
	},
	onAction: (action, _state, ui) => {
		if (action.type !== "open") return undefined
		const id = ui.selected.overview
		if (id === null) return undefined
		return {
			ui: {
				...ui,
				view: "decoders",
				selected: { ...ui.selected, decoders: id },
				detail: { ...ui.detail, decoders: { open: true, scroll: 0 } },
			},
			effects: [],
		}
	},
}
