import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { z } from "zod"
import type {
	EfficiencyBudgetResolution,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

// Explicit budgets retain the existing interval (0, 64]; auto uses half
// the available CPUs, with a 3/4-core floor capped by the effective quota.
export const CpuBudgetSchema = z.union([
	z.literal("auto"),
	z.number().finite().positive().max(64),
])

// At most 31 path components plus the mount root = 32 levels per hierarchy.
const MAX_CGROUP_LEVELS = 32

function cgroupComponents(path: string): string[] {
	const components = path.split("/").slice(1)
	if (components.length === 1 && components[0] === "") return []
	if (
		components.length >= MAX_CGROUP_LEVELS ||
		components.some(part => part === ".." || part === "." || part === "")
	)
		return []
	return components
}

function cgroupPaths(read?: () => string): {
	v2: string[]
	v1: string[] | null
} {
	let content = ""
	try {
		content = read?.() ?? ""
	} catch {
		/* Mount root fallback. */
	}
	const result: { v2: string[]; v1: string[] | null } = { v2: [], v1: null }
	const lines = content.split("\n")
	const v2Count = lines.filter(line => line.startsWith("0:")).length
	for (const line of lines) {
		const match = /^([0-9]+):([^:]*):(\/[^\0\r\n]*)$/.exec(line)
		if (!match?.[3]) continue
		if (match[1] === "0" && match[2] === "" && v2Count === 1)
			result.v2 = cgroupComponents(match[3])
		else if (match[1] !== "0" && match[2]?.split(",").includes("cpu"))
			result.v1 = cgroupComponents(match[3])
	}
	return result
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
	const paths = cgroupPaths(deps.readProcCgroup)
	const components = paths.v2
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
	if (paths.v1 !== null) {
		for (const mount of ["cpu,cpuacct", "cpu"]) {
			for (let depth = paths.v1.length; depth >= 0; depth--) {
				const prefix = [mount, ...paths.v1.slice(0, depth)].join("/")
				try {
					const quotaText = deps.readCpuMax(`${prefix}/cpu.cfs_quota_us`).trim()
					const periodText = deps
						.readCpuMax(`${prefix}/cpu.cfs_period_us`)
						.trim()
					if (!/^[0-9]+$/.test(quotaText) || !/^[0-9]+$/.test(periodText))
						continue
					const quota = Number(quotaText)
					const period = Number(periodText)
					if (
						Number.isSafeInteger(quota) &&
						quota > 0 &&
						Number.isSafeInteger(period) &&
						period > 0
					)
						cpus = Math.min(cpus, quota / period)
				} catch {
					/* Unreadable levels do not hide inherited quotas. */
				}
			}
		}
	}
	const cores = Math.min(64, cpus, Math.max(0.75, cpus / 2))
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
