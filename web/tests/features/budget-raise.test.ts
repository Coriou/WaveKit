import { describe, expect, it, vi } from "vitest"
import type {
	EfficiencyBudgetSettings,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

import type { SettingWriteResult } from "../../src/data/setting-write.ts"
import {
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

/** An EfficiencyBudgetStore stand-in: `remote` is the core's value, read on load and written on save. */
function fakeStore(initial: EfficiencyBudgetSettings) {
	const state = {
		remote: initial as EfficiencyBudgetSettings,
		readError: null as string | null,
		saveError: null as string | null,
		seen: { unavailable: false, settings: null, error: null } as ReturnType<
			BudgetPort["get"]
		>,
	}
	const saves: EfficiencyBudgetValue[] = []
	const store: BudgetPort = {
		load: () => {
			state.seen =
				state.readError === null
					? { unavailable: false, settings: state.remote, error: null }
					: { ...state.seen, error: state.readError }
			return Promise.resolve()
		},
		get: () => state.seen,
		save: (value): Promise<SettingWriteResult> => {
			saves.push(value)
			if (state.saveError !== null)
				return Promise.resolve({ ok: false, message: state.saveError })
			state.remote =
				value === "auto"
					? auto(8, 4)
					: {
							cpuBudgetCores: value,
							resolved: {
								mode: "configured",
								cores: value,
								label: "configured",
							},
						}
			state.seen = { unavailable: false, settings: state.remote, error: null }
			return Promise.resolve({ ok: true })
		},
	}
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

	it("Undo does not write when the budget cannot be read again", async () => {
		const { store, state, saves } = fakeStore(configured(3))
		const { toast, toasts } = recorder()
		await raiseBudget(store, toast, vi.fn())
		state.readError = "Network error"
		expect(await undoRaise(store, 4, 3, toast)).toBe(false)
		expect(saves).toEqual([4])
		expect(toasts.at(-1)).toEqual({
			text: "CPU budget not restored: Network error",
			tone: "warn",
		})
	})
})
