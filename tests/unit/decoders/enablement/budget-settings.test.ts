import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import {
	BUDGET_SETTINGS_MAX_BYTES,
	openEfficiencyBudget,
	readBudgetSettings,
} from "../../../../src/decoders/enablement/budget-settings.js"
import { ConfigSchema } from "../../../../src/config.js"
import type { Logger } from "../../../../src/utils/logger.js"
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
			source: "config",
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

it("reports budget provenance and reads live cores without cloning", async () => {
	for (const configured of [undefined, "auto", 3] as const) {
		for (const stored of [undefined, { version: 1, cpuBudgetCores: 2 }]) {
			const service = await openEfficiencyBudget({
				stateDir: "unused",
				resolve,
				...(configured === undefined ? {} : { configured }),
				read: async () => stored,
				write: async () => {},
			})
			expect(service.view().source).toBe(
				stored ? "saved" : configured === undefined ? "default" : "config",
			)
			const snapshot = service.view()
			snapshot.resolved.cores = 99
			expect(service.cores()).toBe(
				resolve(stored ? 2 : (configured ?? "auto")).cores,
			)
			await service.update(1)
			expect(service.cores()).toBe(1)
			expect(service.view().source).toBe("saved")
		}
	}
})

it("logs a saved override once and a failed notification without external content", async () => {
	const info = vi.fn()
	const warn = vi.fn()
	const log = { child: vi.fn(() => ({ info, warn })) } as unknown as Logger
	const service = await openEfficiencyBudget({
		stateDir: "unused",
		configured: 3,
		resolve,
		log,
		read: async () => ({ version: 1, cpuBudgetCores: 2 }),
		write: async () => {},
		onChanged: () => {
			throw new TypeError("external detail")
		},
	})
	expect(info).toHaveBeenCalledExactlyOnceWith(
		{ cpuBudgetCores: 2 },
		"Saved decoder CPU budget overrides startup configuration",
	)
	await expect(service.update(1)).resolves.toMatchObject({ cpuBudgetCores: 1 })
	expect(warn).toHaveBeenCalledExactlyOnceWith(
		"CPU budget change notification failed",
	)
	expect(info).toHaveBeenCalledOnce()
})

it.each([
	{ efficiency: { cpuGuardPercent: 90 }, source: "default" },
	{
		efficiency: { cpuGuardPercent: 90, cpuBudgetCores: "auto" },
		source: "config",
	},
])(
	"reports $source for a parsed efficiency policy",
	async ({ efficiency, source }) => {
		const config = ConfigSchema.parse({ decoderPolicy: { efficiency } })
		const configured = config.decoderPolicy?.efficiency?.cpuBudgetCores
		const service = await openEfficiencyBudget({
			stateDir: "unused",
			resolve,
			...(configured === undefined ? {} : { configured }),
			read: async () => undefined,
		})
		expect(service.view()).toMatchObject({ source, cpuBudgetCores: "auto" })
	},
)
