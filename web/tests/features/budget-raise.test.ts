import { describe, expect, it, vi } from "vitest"
import type {
	EfficiencyBudgetSettings,
	EfficiencyBudgetUpdateRequest,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

import { ApiError } from "../../src/data/api-client.ts"
import {
	budgetPort,
	followBudget,
	raiseBudget,
	undoRaise,
	type BudgetPort,
	type BudgetToast,
} from "../../src/features/tuned/budget-raise.ts"

const configured = (cores: number): EfficiencyBudgetSettings => ({
	cpuBudgetCores: cores,
	resolved: { mode: "configured", cores, label: "configured" },
})
const auto = (cpus: number, cores: number): EfficiencyBudgetSettings => ({
	cpuBudgetCores: "auto",
	resolved: { mode: "auto", cpus, cores, label: `${cores} of ${cpus}` },
})

const settingsOf = (value: EfficiencyBudgetValue): EfficiencyBudgetSettings =>
	value === "auto" ? auto(8, 4) : configured(value)

/**
 * The core's budget route and an EfficiencyBudgetStore stand-in, joined by budgetPort: `remote` is the core's
 * value, read on load; PUT with `expected` writes only while it still matches, else 409 like the core.
 */
function fakeStore(initial: EfficiencyBudgetSettings) {
	const state = {
		remote: initial,
		readError: null as string | null,
		saveError: null as string | null,
		/** Runs inside the PUT before the core compares: another client's write landing first. */
		beforeCompare: null as (() => void) | null,
		seen: { unavailable: false, settings: null, error: null } as ReturnType<
			BudgetPort["get"]
		>,
	}
	const saves: EfficiencyBudgetValue[] = []
	const api = {
		put: <T>(path: string, body?: unknown): Promise<T> => {
			const { cpuBudgetCores, expected } = body as EfficiencyBudgetUpdateRequest
			state.beforeCompare?.()
			state.beforeCompare = null
			if (state.saveError !== null)
				return Promise.reject(new Error(state.saveError))
			if (expected !== undefined && expected !== state.remote.cpuBudgetCores)
				return Promise.reject(
					new ApiError({
						status: 409,
						code: "EFFICIENCY_BUDGET_CONFLICT",
						message: "conflict",
						body: {
							code: "EFFICIENCY_BUDGET_CONFLICT",
							current: state.remote,
						},
						method: "PUT",
						path,
					}),
				)
			saves.push(cpuBudgetCores)
			state.remote = settingsOf(cpuBudgetCores)
			return Promise.resolve(state.remote as T)
		},
	}
	const reads = {
		load: () => {
			state.seen =
				state.readError === null
					? { unavailable: false, settings: state.remote, error: null }
					: { ...state.seen, error: state.readError }
			return Promise.resolve()
		},
		get: () => state.seen,
	}
	const store = budgetPort(api, reads)
	return { store, state, saves }
}

function recorder() {
	const toasts: { text: string; tone?: "warn"; undo?: () => void }[] = []
	const toast: BudgetToast = (text, options = {}) => {
		toasts.push({ text, ...options })
	}
	return { toasts, toast }
}

describe("raise the CPU budget from the tuned card", () => {
	it("raises by exactly one core and offers Undo", async () => {
		const { store, saves } = fakeStore(configured(1.5))
		const { toasts, toast } = recorder()
		const changed = vi.fn()
		expect(await raiseBudget(store, toast, changed)).toBeNull()
		expect(saves).toEqual([2.5])
		expect(changed).toHaveBeenCalledOnce()
		expect(toasts).toHaveLength(1)
		expect(toasts[0]?.text).toBe("CPU budget raised to 2.5 cores")
		expect(toasts[0]?.undo).toBeTypeOf("function")
	})

	it("refuses at the maximum without writing", async () => {
		const { store, saves } = fakeStore(configured(64))
		const { toasts, toast } = recorder()
		expect(await raiseBudget(store, toast, vi.fn())).toBe(
			"The CPU budget is already at its maximum",
		)
		expect(saves).toEqual([])
		expect(toasts).toEqual([])
	})

	it("reports a failed save and offers no Undo", async () => {
		const { store, state } = fakeStore(configured(2))
		state.saveError = "Read-only access"
		const { toasts, toast } = recorder()
		const changed = vi.fn()
		expect(await raiseBudget(store, toast, changed)).toBe("Read-only access")
		expect(changed).not.toHaveBeenCalled()
		expect(toasts).toEqual([])
	})

	it("Undo puts the old value back while the budget is still the raised one", async () => {
		const { store, saves } = fakeStore(auto(8, 4))
		const { toasts, toast } = recorder()
		const changed = vi.fn()
		await raiseBudget(store, toast, changed)
		expect(saves).toEqual([5])
		toasts[0]?.undo?.()
		await vi.waitFor(() => expect(toasts).toHaveLength(2))
		expect(saves).toEqual([5, "auto"])
		expect(toasts[1]).toEqual({ text: "CPU budget back to automatic" })
		expect(changed).toHaveBeenCalledTimes(2)
	})

	it("Undo that fails to save warns and says the budget was not restored", async () => {
		const { store, state } = fakeStore(configured(3))
		const { toast, toasts } = recorder()
		await raiseBudget(store, toast, vi.fn())
		state.saveError = "Core unreachable"
		expect(await undoRaise(store, 4, 3, toast)).toBe(false)
		expect(toasts.at(-1)).toEqual({
			text: "CPU budget not restored: Core unreachable",
			tone: "warn",
		})
		expect(state.remote.cpuBudgetCores).toBe(4)
	})

	it("Undo leaves a budget changed elsewhere in the meantime", async () => {
		const { store, state, saves } = fakeStore(configured(3))
		const { toast, toasts } = recorder()
		await raiseBudget(store, toast, vi.fn())
		state.remote = configured(8)
		expect(await undoRaise(store, 4, 3, toast)).toBe(false)
		expect(saves).toEqual([4])
		expect(toasts.at(-1)).toEqual({
			text: "CPU budget not restored: it was changed elsewhere to 8 cores",
			tone: "warn",
		})
		expect(state.remote.cpuBudgetCores).toBe(8)
	})

	it("Undo loses the race to a write landing between its read and its save, and leaves that write", async () => {
		const { store, state, saves } = fakeStore(configured(3))
		const { toast, toasts } = recorder()
		await raiseBudget(store, toast, vi.fn())
		expect(saves).toEqual([4])
		// another browser saves 8 after this card last saw 4, just before Undo's write reaches the core
		state.beforeCompare = () => {
			state.remote = configured(8)
		}
		expect(await undoRaise(store, 4, 3, toast)).toBe(false)
		expect(saves).toEqual([4])
		expect(state.remote.cpuBudgetCores).toBe(8)
		expect(toasts.at(-1)).toEqual({
			text: "CPU budget not restored: it was changed elsewhere to 8 cores",
			tone: "warn",
		})
		// the store read again, so the card shows the value the core kept
		expect(store.get().settings?.cpuBudgetCores).toBe(8)
	})

	it("the raise itself refuses to overwrite a write landing after its read", async () => {
		const { store, state, saves } = fakeStore(configured(3))
		state.beforeCompare = () => {
			state.remote = configured(1)
		}
		const { toast, toasts } = recorder()
		const changed = vi.fn()
		expect(await raiseBudget(store, toast, changed)).toBe(
			"The CPU budget was changed elsewhere to 1 cores",
		)
		expect(saves).toEqual([])
		expect(state.remote.cpuBudgetCores).toBe(1)
		expect(changed).not.toHaveBeenCalled()
		expect(toasts).toEqual([])
	})

	it("does not raise when the budget cannot be read", async () => {
		const { store, state, saves } = fakeStore(configured(3))
		state.readError = "Network error"
		const { toast } = recorder()
		expect(await raiseBudget(store, toast, vi.fn())).toBe("Network error")
		expect(saves).toEqual([])
	})
})

describe("follow the CPU budget while a verdict suggests raising it", () => {
	it("reads it now and after every verdicts read until stopped", () => {
		const listeners = new Set<() => void>()
		const verdicts = {
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		}
		const load = vi.fn(() => Promise.resolve())
		const stop = followBudget(verdicts, { load })
		expect(load).toHaveBeenCalledOnce()
		for (const l of listeners) l()
		for (const l of listeners) l()
		expect(load).toHaveBeenCalledTimes(3)
		stop()
		expect(listeners.size).toBe(0)
	})
})
