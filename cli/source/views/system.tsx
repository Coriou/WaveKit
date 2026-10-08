import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import {
	presetConfirm,
	presetNames,
	systemLines,
} from "../view-models/system.js"
import type { ViewModule, ViewOutcome, ViewProps } from "./types.js"

function SystemComponent({
	state,
	width,
	height,
	heightClass,
}: ViewProps): ReactElement {
	return (
		<Lines
			lines={systemLines(state, width, height, heightClass === "roomy")}
			width={width + 1}
			height={height}
		/>
	)
}

export const systemView: ViewModule = {
	id: "system",
	title: "System",
	Component: SystemComponent,
	keyInfo: (state: AppState, _ui: UiState) => ({
		rowIds: [],
		pageSize: 1,
		ctx: {
			...EMPTY_VIEW_CTX,
			audioRunning: state.audio.value ? state.audio.value.running : null,
		},
	}),
	onAction: (action, state, ui): ViewOutcome | undefined => {
		if (action.type === "preset-open") {
			// Start at the preset after the current modulation.
			const current = presetNames(state).indexOf(
				state.audio.value?.config.modulation ?? "",
			)
			const confirm = presetConfirm(state, current + 1)
			return confirm
				? { ui: { ...ui, confirm }, effects: [] }
				: {
						ui: { ...ui, notice: { text: "no audio presets", at: state.now } },
						effects: [],
					}
		}
		// preset-next arrives while the confirm bar is open; the App passes it through.
		if (action.type === "preset-next" && ui.confirm?.kind === "preset") {
			const confirm = presetConfirm(state, (ui.confirm.presetIndex ?? 0) + 1)
			return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
		}
		return undefined
	},
}
