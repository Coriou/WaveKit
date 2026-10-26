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

// At most 31 path components plus the mount root = 32 quota reads.
const MAX_CGROUP_LEVELS = 32

function cgroupComponents(readProcCgroup?: () => string): string[] {
	try {
		const lines = readProcCgroup?.()
			.split("\n")
			.filter(line => line.startsWith("0:"))
		if (lines?.length !== 1) return []
		const match = /^0::(\/[^\0\r\n]*)$/.exec(lines[0] ?? "")
		if (!match?.[1]) return []
		const components = match[1].split("/").slice(1)
		if (components.length === 1 && components[0] === "") return []
		if (
			components.length >= MAX_CGROUP_LEVELS ||
			components.some(part => part === ".." || part === "." || part === "")
		)
			return []
		return components
	} catch {
		return []
	}
}

/** Pure given its CPU count and readers; malformed quotas mean no quota. */
export function resolveCpuBudget(
	value: EfficiencyBudgetValue,
	deps: {
		cpuCount: number
		readProcCgroup?: () => string
		readCpuMax: (relativePath: string) => string
	},
): EfficiencyBudgetResolution {
	const parsed = CpuBudgetSchema.safeParse(value)
	if (parsed.success && typeof parsed.data === "number")
		return { mode: "configured", cores: parsed.data, label: "configured" }
	// An invalid CPU count fails to the minimum auto budget (one available CPU).
	let cpus =
		Number.isSafeInteger(deps.cpuCount) && deps.cpuCount > 0 ? deps.cpuCount : 1
	const components = cgroupComponents(deps.readProcCgroup)
	for (let depth = components.length; depth >= 0; depth--) {
		const relativePath = [...components.slice(0, depth), "cpu.max"].join("/")
		try {
			const match = /^(max|[0-9]+)\s+([0-9]+)$/.exec(
				deps.readCpuMax(relativePath).trim(),
			)
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
			// An unreadable level does not hide quotas at its ancestors.
		}
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
		readProcCgroup: () => readFileSync("/proc/self/cgroup", "utf8"),
		readCpuMax: relativePath =>
			readFileSync(`/sys/fs/cgroup/${relativePath}`, "utf8"),
	})
}
