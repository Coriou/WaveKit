// "Raise CPU budget" from the tuned card's "On this band" and its Undo. The raise reads the budget first and asks for
// one more core (raisedBudget); both writes send the value they expect to replace (PUT `expected`), so the core
// refuses one that a change made meanwhile (Settings, another browser) would overwrite. Every outcome reaches the toast.
import { z } from "zod/v4"
import type {
	EfficiencyBudgetSettings,
	EfficiencyBudgetUpdateRequest,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import { ApiError } from "../../data/api-client.ts"
import { failedWrite, WRITE_OK } from "../../data/setting-write.ts"
import { raisedBudget } from "./band-decoders.ts"

const ROUTE = "/api/decoders/efficiency/budget"

/** A conditional write: on a conflict, `current` is the budget the core kept. */
export type BudgetWrite =
	| { ok: true }
	| { ok: false; message: string; current?: EfficiencyBudgetValue }

/** What the raise needs: EfficiencyBudgetStore's read (settings/efficiency-budget.ts) and a conditional save. */
export interface BudgetPort {
	load(): Promise<void>
	get(): {
		unavailable: boolean
		settings: EfficiencyBudgetSettings | null
		error: string | null
	}
	/** Saves `value` only while the core's budget is still `expected`; never rejects. */
	saveIf(
		expected: EfficiencyBudgetValue,
		value: EfficiencyBudgetValue,
	): Promise<BudgetWrite>
}

const conflict = z.object({
	code: z.literal("EFFICIENCY_BUDGET_CONFLICT"),
	current: z.object({
		cpuBudgetCores: z.union([z.literal("auto"), z.number().positive()]),
	}),
})

/** The raise's port: reads through `store`, writes with PUT `expected`, then reads again so the store holds the result. */
export function budgetPort(
	api: Pick<ApiClient, "put">,
	store: Pick<BudgetPort, "load" | "get">,
): BudgetPort {
	return {
		load: () => store.load(),
		get: () => store.get(),
		async saveIf(expected, value) {
			const body: EfficiencyBudgetUpdateRequest = {
				cpuBudgetCores: value,
				expected,
			}
			let result: BudgetWrite
			try {
				await api.put<unknown>(ROUTE, body)
				result = WRITE_OK
			} catch (error) {
				const refused =
					error instanceof ApiError && error.status === 409
						? conflict.safeParse(error.body)
						: null
				result = refused?.success
					? {
							ok: false,
							message: "it was changed elsewhere",
							current: refused.data.current.cpuBudgetCores,
						}
					: failedWrite(error)
			}
			await store.load()
			return result
		},
	}
}

export type BudgetToast = (
	text: string,
	options?: { undo?: () => void; tone?: "warn" },
) => void

const valueText = (v: EfficiencyBudgetValue) =>
	v === "auto" ? "automatic" : `${v} cores`

/** Why a write was refused, naming the budget the core kept when it was changed elsewhere. */
const refusal = (r: Extract<BudgetWrite, { ok: false }>) =>
	r.current === undefined
		? r.message
		: `it was changed elsewhere to ${valueText(r.current)}`

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
	const result = await store.saveIf(before, next)
	if (!result.ok)
		return result.current === undefined
			? result.message
			: `The CPU budget was changed elsewhere to ${valueText(result.current)}`
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
 * Puts `before` back while the budget still reads `set`, the value the raise wrote; the core checks this in the
 * same step as the write. Resolves true when restored; otherwise a warning toast says why and the budget is left as it is.
 */
export async function undoRaise(
	store: BudgetPort,
	set: number,
	before: EfficiencyBudgetValue,
	toast: BudgetToast,
): Promise<boolean> {
	const result = await store.saveIf(set, before)
	if (!result.ok) {
		toast(`CPU budget not restored: ${refusal(result)}`, { tone: "warn" })
		return false
	}
	toast(`CPU budget back to ${valueText(before)}`)
	return true
}

/**
 * While a verdict suggests raising the budget: reads it now and again after every verdicts read, so a budget this
 * card saw at its maximum and that was lowered elsewhere offers Raise again. Returns the stop.
 */
export function followBudget(
	verdicts: { subscribe(listener: () => void): () => void },
	budget: Pick<BudgetPort, "load">,
): () => void {
	void budget.load()
	return verdicts.subscribe(() => void budget.load())
}
