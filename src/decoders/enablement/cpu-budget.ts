import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { z } from "zod"
import type {
	EfficiencyBudgetResolution,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

// Explicit budgets retain the existing interval (0, 64]; auto uses half
// the available CPUs, clamped to [3/4, 64] cores.
export const CpuBudgetSchema = z.union([
	z.literal("auto"),
	z.number().finite().positive().max(64),
])

/** Pure given its CPU count and reader; malformed quotas mean no quota. */
export function resolveCpuBudget(
	value: EfficiencyBudgetValue,
	deps: { cpuCount: number; readCpuMax: () => string },
): EfficiencyBudgetResolution {
	const parsed = CpuBudgetSchema.safeParse(value)
	if (parsed.success && typeof parsed.data === "number")
		return { mode: "configured", cores: parsed.data, label: "configured" }
	// An invalid CPU count fails to the minimum auto budget (one available CPU).
	let cpus =
		Number.isSafeInteger(deps.cpuCount) && deps.cpuCount > 0 ? deps.cpuCount : 1
	try {
		const match = /^(max|[0-9]+)\s+([0-9]+)$/.exec(deps.readCpuMax().trim())
		if (match && match[1] !== "max") {
			const quota = Number(match[1])
			const period = Number(match[2])
			if (
				Number.isSafeInteger(quota) &&
				quota > 0 &&
				Number.isSafeInteger(period) &&
				period > 0
			)
				cpus = Math.min(cpus, quota / period)
		}
	} catch {
		// Non-Linux hosts and unreadable cgroups use process CPU availability.
	}
	const cores = Math.min(64, Math.max(0.75, cpus / 2))
	return {
		mode: "auto",
		cpus,
		cores,
		label: `auto (${cpus} CPUs → ${cores} cores)`,
	}
}

export function hostCpuBudget(
	value: EfficiencyBudgetValue,
): EfficiencyBudgetResolution {
	return resolveCpuBudget(value, {
		cpuCount: availableParallelism(),
		readCpuMax: () => readFileSync("/sys/fs/cgroup/cpu.max", "utf8"),
	})
}
