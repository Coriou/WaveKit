import { Box } from "ink"
import type { ReactElement } from "react"
import { LineView, Lines } from "../components/lines.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { formatBytes } from "../ui/format.js"
import { glyphs } from "../ui/theme.js"
import type { UiState } from "../ui/ui-state.js"
import { messagesKeys, messagesModel } from "../view-models/messages.js"
import type { ViewModule, ViewOutcome, ViewProps } from "./types.js"

/** Terminals drop large OSC 52 writes silently; above this nothing is sent (R67 M1). */
export const COPY_MAX_BYTES = 100_000

function MessagesComponent({
	state,
	ui,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	const m = messagesModel(state, ui, width, height, heightClass === "roomy")
	if (m.detail && m.placement.kind === "overlay")
		return <Lines lines={m.detail} width={width + 1} height={height} />
	const head = (
		<>
			<LineView line={m.header} width={m.listWidth + 1} />
			{m.input ? <LineView line={m.input} width={m.listWidth + 1} /> : null}
		</>
	)
	const body = m.input ? height - 2 : height - 1
	if (m.detail && m.placement.kind === "right") {
		return (
			<Box flexDirection="row" height={height}>
				<Box flexDirection="column" width={m.listWidth + 1}>
					{head}
					<Lines lines={m.list} width={m.listWidth + 1} height={body} />
				</Box>
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
		<Box flexDirection="column" height={height}>
			{head}
			<Lines lines={lines.slice(0, body)} width={width + 1} height={body} />
		</Box>
	)
}

export const messagesView: ViewModule = {
	id: "messages",
	title: "Messages",
	Component: MessagesComponent,
	keyInfo: (state, ui, width, height, heightClass) => {
		const k = messagesKeys(state, ui, width, height, heightClass === "roomy")
		return {
			rowIds: k.rowIds,
			pageSize: k.pageSize,
			newestSeq: k.newestSeq,
			...(k.detailMaxScroll !== undefined
				? { detailMaxScroll: k.detailMaxScroll }
				: {}),
			ctx: {
				...EMPTY_VIEW_CTX,
				hasSelection: k.hasSelection,
				paused: !ui.messages.following,
			},
		}
	},
	onAction: (action, state, ui): ViewOutcome | undefined => {
		if (action.type !== "copy-json") return undefined
		const seq =
			ui.selected.messages === null ? null : Number(ui.selected.messages)
		const e = state.messages.ring.entries.find(x => x.seq === seq)
		if (!e) return undefined
		const text = JSON.stringify(e.output.data, null, 2) ?? "null"
		const bytes = Buffer.byteLength(text, "utf8")
		const notice = (t: string): UiState => ({
			...ui,
			notice: { text: t, at: state.now },
		})
		if (bytes > COPY_MAX_BYTES)
			return {
				ui: notice(
					`copy not sent ${glyphs().sep} ${formatBytes(bytes)} over ${formatBytes(COPY_MAX_BYTES, 0)}`,
				),
				effects: [],
			}
		// Whether the terminal honours OSC 52 cannot be observed: say only what was done (§6.3).
		return {
			ui: notice("copy sent (OSC 52)"),
			effects: [{ kind: "copy", text }],
		}
	},
}
