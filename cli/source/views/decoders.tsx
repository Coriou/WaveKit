import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { memoOne } from "../data/memo.js"
import {
	decoderConfirm,
	decodersModel,
	suspensionKind,
} from "../view-models/decoders.js"
import type { ViewModule, ViewProps } from "./types.js"

/** keyInfo and the component ask for the same model in one commit: build it once (D3). */
const model = memoOne(decodersModel)

function DecodersComponent({
	state,
	ui,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	const m = model(state, ui, width, height, heightClass === "roomy")
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
	keyInfo: (state, ui, width, height, heightClass) => {
		const m = model(state, ui, width, height, heightClass === "roomy")
		return {
			rowIds: m.rowIds,
			pageSize: m.pageSize,
			ctx: {
				...EMPTY_VIEW_CTX,
				hasSelection: m.selected !== null,
				decoderRunning: m.selected ? m.selected.row.running : null,
				decoderPinned: m.selected?.pinned === true,
				decoderSuspension: suspensionKind(m.selected),
			},
			...(m.notice !== null ? { notice: m.notice } : {}),
			...(m.detailMaxScroll !== null
				? { detailMaxScroll: m.detailMaxScroll }
				: {}),
		}
	},
	onAction: (action, state, ui) => {
		if (action.type !== "decoder-op" || ui.selected.decoders === null)
			return undefined
		const confirm = decoderConfirm(state, ui.selected.decoders, action.op)
		return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
	},
}
