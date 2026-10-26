/** Runtime decoder admission budget, independent of the host CPU guard. */
export type EfficiencyBudgetValue = "auto" | number
export type EfficiencyBudgetResolution =
	| { mode: "auto"; cpus: number; cores: number; label: string }
	| { mode: "configured"; cores: number; label: "configured" }
export interface EfficiencyBudgetSettings {
	cpuBudgetCores: EfficiencyBudgetValue
	resolved: EfficiencyBudgetResolution
}
