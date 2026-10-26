import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import {
	BUDGET_SETTINGS_MAX_BYTES,
	openEfficiencyBudget,
	readBudgetSettings,
} from "../../../../src/decoders/enablement/budget-settings.js"
import { resolveCpuBudget } from "../../../../src/decoders/enablement/cpu-budget.js"

const resolve = (value: Parameters<typeof resolveCpuBudget>[0]) =>
	resolveCpuBudget(value, { cpuCount: 8, readCpuMax: () => "max 100000" })
it("loads validated state and falls back for missing, malformed or future state", async () => {
	for (const stored of [
		undefined,
		{},
		{ version: 2, cpuBudgetCores: 4 },
		{ version: 1, cpuBudgetCores: 0 },
	]) {
		const service = await openEfficiencyBudget({
			stateDir: "unused",
			configured: 3,
			resolve,
			read: async () => stored,
		})
		expect(service.view().cpuBudgetCores).toBe(3)
	}
	const service = await openEfficiencyBudget({
		stateDir: "unused",
		resolve,
		read: async () => ({ version: 1, cpuBudgetCores: 2 }),
	})
	expect(service.view().resolved).toMatchObject({
		mode: "configured",
		cores: 2,
	})
})
it("uses configured or auto budgets when state cannot be read", async () => {
	for (const configured of [3, "auto"] as const) {
		const service = await openEfficiencyBudget({
			stateDir: "unused",
			configured,
			resolve,
			read: async () => {
				throw new TypeError("unreadable state")
			},
		})
		expect(service.view()).toEqual({
			cpuBudgetCores: configured,
			resolved: resolve(configured),
		})
	}
})
it("serializes durable updates and only publishes after a successful write", async () => {
	const changed = vi.fn()
	const write = vi
		.fn()
		.mockRejectedValueOnce(new TypeError("disk"))
		.mockResolvedValue(undefined)
	const service = await openEfficiencyBudget({
		stateDir: "unused",
		resolve,
		read: async () => undefined,
		write,
		onChanged: changed,
	})
	await expect(service.update(3)).rejects.toMatchObject({
		code: "EFFICIENCY_BUDGET_STORE_UNAVAILABLE",
	})
	expect(service.view().cpuBudgetCores).toBe("auto")
	expect(changed).not.toHaveBeenCalled()
	await Promise.all([service.update(2), service.update("auto")])
	expect(
		changed.mock.calls.map(
			call => (call[0] as { cpuBudgetCores: unknown }).cpuBudgetCores,
		),
	).toEqual([2, "auto"])
	expect(service.view().resolved.cores).toBe(4)
	await expect(service.update(0)).rejects.toMatchObject({
		code: "EFFICIENCY_BUDGET_INVALID",
	})
	expect(write).toHaveBeenCalledTimes(3)
})
it("persists across reopening and bounds reads at and past the file limit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-budget-"))
	try {
		const service = await openEfficiencyBudget({ stateDir: dir, resolve })
		await service.update(3)
		const reopened = await openEfficiencyBudget({ stateDir: dir, resolve })
		expect(reopened.view().cpuBudgetCores).toBe(3)
		const file = join(dir, "bounded.json")
		const json = '{"version":1,"cpuBudgetCores":"auto"}'
		await writeFile(file, json.padEnd(BUDGET_SETTINGS_MAX_BYTES))
		expect(await readBudgetSettings(file)).toEqual({
			version: 1,
			cpuBudgetCores: "auto",
		})
		await writeFile(file, json.padEnd(BUDGET_SETTINGS_MAX_BYTES + 1))
		expect(await readBudgetSettings(file)).toBeUndefined()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
