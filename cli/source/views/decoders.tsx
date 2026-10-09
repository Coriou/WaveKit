import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { decoderConfirm, decodersModel } from "../view-models/decoders.js"
import type { ViewModule, ViewProps } from "./types.js"

/** keyInfo gets content rows only; roomy terminals (≥ 30 rows) leave ≥ 25 content rows. Affects pageSize only. */
const ROOMY_CONTENT = 25

function DecodersComponent({
	state,
	ui,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	const m = decodersModel(state, ui, width, height, heightClass === "roomy")
	if (m.detail && m.placement.kind === "overlay")
		return <Lines lines={m.detail} width={width + 1} height={height} />
	if (m.detail && m.placement.kind === "right") {
		return (
			<Box flexDirection="row" height={height}>
				<Lines lines={m.list} width={m.listWidth + 1} height={height} />
				<Box width={2} />
				<Lines
					lines={m.detail}
					width={m.detailWidth}
					height={height}
					indent={0}
				/>
			</Box>
		)
	}
	const lines = m.detail ? [...m.list, [], ...m.detail] : m.list
	return (
		<Lines lines={lines.slice(0, height)} width={width + 1} height={height} />
	)
}

export const decodersView: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: DecodersComponent,
	keyInfo: (state: AppState, ui: UiState, width: number, height: number) => {
		const m = decodersModel(state, ui, width, height, height >= ROOMY_CONTENT)
		return {
			rowIds: m.rowIds,
			pageSize: m.pageSize,
			ctx: {
				...EMPTY_VIEW_CTX,
				hasSelection: m.selected !== null,
				decoderRunning: m.selected ? m.selected.row.running : null,
			},
		}
	},
	onAction: (action, state, ui) => {
		if (action.type !== "decoder-op" || ui.selected.decoders === null)
			return undefined
		const confirm = decoderConfirm(state, ui.selected.decoders, action.op)
		return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
	},
}
