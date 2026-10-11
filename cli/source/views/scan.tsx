import { Box } from "ink"
import { Lines } from "../components/lines.js"
import { Spectrum } from "../components/spectrum.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import {
	scanModel,
	scanRowIds,
	scanSources,
	scanDetail,
	scanIdentifyReady,
} from "../view-models/scan.js"
import type { ViewModule, ViewProps } from "./types.js"

function ScanComponent({ state, ui, width, height }: ViewProps) {
	const model = scanModel(state, ui, width, height)
	return (
		<Box flexDirection="column" height={height}>
			<Lines
				lines={model.lines}
				width={width + 1}
				height={height - model.plotHeight}
			/>
			{model.plotHeight > 0 ? (
				<Spectrum
					scan={state.scan}
					width={width}
					height={model.plotHeight}
					now={state.now}
				/>
			) : null}
		</Box>
	)
}
export const scanView: ViewModule = {
	id: "scan",
	title: "Scan",
	Component: ScanComponent,
	keyInfo: (state, ui, width, height) => ({
		rowIds: scanRowIds(state, ui),
		pageSize: Math.max(1, height - 3),
		detailMaxScroll: Math.max(
			0,
			scanDetail(state, ui, width).length -
				Math.max(
					1,
					height -
						(ui.scan.receipt
							? 1
							: (state.scan.lanes.status.value && height >= 18 ? 4 : 3) +
								(ui.scan.tab === "discoveries" ? 1 : 0)),
				),
		),
		ctx: {
			...EMPTY_VIEW_CTX,
			hasSelection: scanRowIds(state, ui).length > 0,
			scanIdentifyReady: scanIdentifyReady(state, ui, width, height),
			scanReceipt: state.identify?.receipt != null,
		},
	}),
	onAction: (action, state, ui) => {
		const clear = {
			confirm: ui.confirm?.kind === "identify" ? null : ui.confirm,
			selected: { ...ui.selected, scan: null },
			detail: { ...ui.detail, scan: { open: false, scroll: 0 } },
		}
		if (action.type === "scan-receipt")
			return {
				ui: {
					...ui,
					...clear,
					scan: { ...ui.scan, receipt: true },
					detail: { ...ui.detail, scan: { open: true, scroll: 0 } },
				},
				effects: [],
			}
		if (action.type === "scan-tab")
			return {
				ui: {
					...ui,
					...clear,
					scan: { ...ui.scan, tab: action.tab, receipt: false },
				},
				effects: [],
			}
		if (action.type === "scan-source") {
			const sources = scanSources(state)
			const sourceId =
				sources[
					(sources.indexOf(ui.scan.sourceId ?? "") + 1) % sources.length
				] ?? null
			return {
				ui: {
					...ui,
					...clear,
					scan: {
						...ui.scan,
						sourceId,
						receipt: false,
						retry: ui.scan.retry + 1,
						cursor: null,
					},
				},
				effects: [],
			}
		}
		if (action.type === "scan-next-page" || action.type === "scan-first-page") {
			if (ui.scan.tab !== "discoveries") return { ui, effects: [] }
			const cursor =
				action.type === "scan-first-page"
					? null
					: state.scan.lanes.discoveries.value?.nextCursor
			if (
				cursor === undefined ||
				(cursor === null && action.type === "scan-next-page")
			)
				return { ui, effects: [] }
			return {
				ui: { ...ui, ...clear, scan: { ...ui.scan, cursor, receipt: false } },
				effects: [],
			}
		}
		return undefined
	},
}
