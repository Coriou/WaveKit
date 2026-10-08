import type { ReactElement } from "react"
import type { AppState, WriteIntent } from "../data/types.js"
import type { Action, ViewId, ViewKeyCtx } from "../ui/actions.js"
import type { HeightClass, WidthClass } from "../ui/line.js"
import type { UiState } from "../ui/ui-state.js"

export interface ViewProps {
	state: AppState
	ui: UiState
	/** Content width excluding the 1-column left gutter. */
	width: number
	/** Content rows available to the view. */
	height: number
	heightClass: HeightClass
	widthClass: WidthClass
}

export type Effect =
	| { kind: "write"; intent: WriteIntent }
	| { kind: "copy"; text: string }

export interface ViewOutcome {
	ui: UiState
	effects: Effect[]
}

export interface ViewKeyInfo {
	/** Selectable row ids in display order (top → bottom). */
	rowIds: string[]
	pageSize: number
	ctx: ViewKeyCtx
}

export interface ViewModule {
	id: ViewId
	title: string
	Component: (props: ViewProps) => ReactElement
	keyInfo(
		state: AppState,
		ui: UiState,
		width: number,
		height: number,
	): ViewKeyInfo
	/** View-specific actions. Return undefined to fall back to applyUiAction. */
	onAction?(
		action: Action,
		state: AppState,
		ui: UiState,
	): ViewOutcome | undefined
}
