/**
 * The setup plan being composed. It outlives the pane's component (a resize moves the plan between the attached
 * pane and the pushed-in screen) but not the task: closing the plan forgets it (DESIGN.md: the plan pane is a task).
 */
import { Store } from "../../../data/store.ts"
import { scannerUi } from "../ui-store.ts"
import { EMPTY_DRAFT, type PlanDraft } from "./plan.ts"
import type { View } from "./ruler.ts"

export interface SetupState {
	readonly draft: PlanDraft
	/** The ruler's visible stretch, null until the planner fits it. */
	readonly view: View | null
}

export const setupStore = new Store<SetupState>({
	draft: EMPTY_DRAFT,
	view: null,
})

scannerUi.subscribe((next, prev) => {
	if (prev.planOpen && !next.planOpen)
		setupStore.set({ draft: EMPTY_DRAFT, view: null })
})

export function updateDraft(fn: (d: PlanDraft) => PlanDraft): void {
	setupStore.update(s => ({ ...s, draft: fn(s.draft) }))
}

export function setView(view: View): void {
	setupStore.update(s => ({ ...s, view }))
}
