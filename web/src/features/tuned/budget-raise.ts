// "Raise CPU budget" from the tuned card's "On this band" and its Undo. The raise reads the budget first and asks for
// one more core (raisedBudget); Undo puts the old value back only while the budget is still the one the raise set,
// so a change made meanwhile (Settings, another browser) is never overwritten. Every outcome reaches the toast.
import type {
	EfficiencyBudgetValue,
	EfficiencyBudgetSettings,
} from "@wavekit/api-types"

import type { SettingWriteResult } from "../../data/setting-write.ts"
import { raisedBudget } from "./band-decoders.ts"

/** What the raise needs of EfficiencyBudgetStore (settings/efficiency-budget.ts); loads and saves never reject. */
export interface BudgetPort {
	load(): Promise<void>
	get(): {
		unavailable: boolean
		settings: EfficiencyBudgetSettings | null
		error: string | null
	}
	save(value: EfficiencyBudgetValue): Promise<SettingWriteResult>
}

export type BudgetToast = (
	text: string,
	options?: { undo?: () => void; tone?: "warn" },
) => void

const valueText = (v: EfficiencyBudgetValue) =>
	v === "auto" ? "automatic" : `${v} cores`

/**
 * Raises the budget by one core and toasts it with an Undo; `changed` runs after the raise and after an
 * Undo that restored. Resolves with the failure message, else null.
 */
export async function raiseBudget(
	store: BudgetPort,
	toast: BudgetToast,
	changed: () => void,
): Promise<string | null> {
	await store.load()
	const s = store.get()
	if (s.unavailable) return "This WaveKit has no CPU budget setting"
	if (!s.settings || s.error !== null)
		return s.error ?? "The CPU budget could not be read"
	const before = s.settings.cpuBudgetCores
	const next = raisedBudget(s.settings.resolved)
	if (next === null) return "The CPU budget is already at its maximum"
	const result = await store.save(next)
	if (!result.ok) return result.message
	changed()
	toast(`CPU budget raised to ${valueText(next)}`, {
		undo: () =>
			void undoRaise(store, next, before, toast).then(
				restored => {
					if (restored) changed()
				},
				() => undefined,
			),
	})
	return null
}

/**
 * Puts `before` back while the budget still reads `set`, the value the raise wrote. Resolves true when
 * restored; otherwise a warning toast says why and the budget is left as it is.
 */
export async function undoRaise(
	store: BudgetPort,
	set: number,
	before: EfficiencyBudgetValue,
	toast: BudgetToast,
): Promise<boolean> {
	const failed = (why: string) => {
		toast(`CPU budget not restored: ${why}`, { tone: "warn" })
		return false
	}
	await store.load()
	const s = store.get()
	if (!s.settings || s.error !== null)
		return failed(s.error ?? "it could not be read")
	const now = s.settings.cpuBudgetCores
	if (now !== set)
		return failed(`it was changed elsewhere to ${valueText(now)}`)
	const result = await store.save(before)
	if (!result.ok) return failed(result.message)
	toast(`CPU budget back to ${valueText(before)}`)
	return true
}
