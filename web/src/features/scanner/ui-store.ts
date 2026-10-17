/**
 * Scanner view state shared by the drawer, the plan pane, the Tuner hold row and the spectrum:
 * whether the "Scan a band" plan is shown, and a range to prefill it with (Shift-drag on the
 * spectrum, "Scan this range"). The plan pane is a task: none of this is remembered.
 */
import type { FreqRange } from "@wavekit/api-types"
import { Store } from "../../data/store.ts"

export interface ScannerUiState {
	/** The plan pane (setup, or running mode while a sweep runs) is shown. */
	planOpen: boolean
	/** A range to add to the plan when it opens; consumed by the planner. */
	prefill: FreqRange | null
	/** The discovery opened in place in the drawer list. */
	openDiscoveryId: string | null
}

export const scannerUi = new Store<ScannerUiState>({
	planOpen: false,
	prefill: null,
	openDiscoveryId: null,
})

export function openPlan(prefill: FreqRange | null = null): void {
	scannerUi.update(s => ({ ...s, planOpen: true, prefill: prefill ?? s.prefill }))
}

export function closePlan(): void {
	scannerUi.update(s => ({ ...s, planOpen: false, prefill: null }))
}

export function takePrefill(): FreqRange | null {
	const { prefill } = scannerUi.get()
	if (prefill) scannerUi.update(s => ({ ...s, prefill: null }))
	return prefill
}

export function openDiscovery(id: string | null): void {
	scannerUi.update(s => ({ ...s, openDiscoveryId: id }))
}
