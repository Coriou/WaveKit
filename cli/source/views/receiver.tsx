import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { receiverExternalNotice } from "../ui/keymap.js"
import { applyEditKey, startEdit } from "../ui/tuner-edit.js"
import type { UiState } from "../ui/ui-state.js"
import {
	controlConfirm,
	receiverControl,
	receiverController,
	receiverLines,
	receiverTuner,
	reviewHeldNotice,
	tunerConfirm,
} from "../view-models/receiver.js"
import type { ViewModule, ViewOutcome, ViewProps } from "./types.js"

function ReceiverComponent({
	state,
	ui,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	return (
		<Lines
			lines={receiverLines(state, ui, width, height, heightClass === "roomy")}
			width={width + 1}
			height={height}
		/>
	)
}

export const receiverView: ViewModule = {
	id: "receiver",
	title: "Receiver",
	Component: ReceiverComponent,
	keyInfo: (state: AppState, _ui: UiState) => ({
		rowIds: [],
		pageSize: 1,
		ctx: { ...EMPTY_VIEW_CTX, control: receiverControl(state) },
	}),
	onAction: (action, state, ui): ViewOutcome | undefined => {
		const notice = (text: string): ViewOutcome => ({
			ui: { ...ui, notice: { text, at: state.now } },
			effects: [],
		})
		switch (action.type) {
			case "edit-open": {
				const t = receiverTuner(state)
				if (!t) return notice("tuner state ?")
				if (t.controlMode !== "internal")
					return notice(receiverExternalNotice(receiverController(state)))
				return { ui: { ...ui, edit: startEdit(t) }, effects: [] }
			}
			case "edit-key":
				return ui.edit
					? {
							ui: { ...ui, edit: applyEditKey(ui.edit, action.key) },
							effects: [],
						}
					: undefined
			case "edit-review": {
				if (!ui.edit) return undefined
				const confirm = tunerConfirm(ui.edit, state)
				// Held while nothing changed or a field is out of core's range (R42).
				return confirm
					? { ui: { ...ui, confirm }, effects: [] }
					: notice(reviewHeldNotice(ui.edit))
			}
			case "edit-discard":
				return { ui: { ...ui, edit: null }, effects: [] }
			case "control-toggle": {
				const confirm = controlConfirm(state)
				return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
			}
			default:
				return undefined
		}
	},
}
