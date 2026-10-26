import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type {
	EfficiencyBudgetSettings,
	EfficiencyBudgetValue,
	EfficiencyBudgetResolution,
} from "@wavekit/api-types"
import { atomicWrite } from "../../core/scanner/store/atomic-write.js"
import { WaveKitError } from "../../utils/errors.js"
import { CpuBudgetSchema, hostCpuBudget } from "./cpu-budget.js"

// 2^8 bytes accommodates the version and single budget field plus whitespace.
// Read one byte past this limit to distinguish an exact-sized file from overflow.
export const BUDGET_SETTINGS_MAX_BYTES = 256
export const BUDGET_SETTINGS_FILE = "decoder-efficiency.json"
const FileSchema = z
	.object({ version: z.literal(1), cpuBudgetCores: CpuBudgetSchema })
	.strict()

export interface EfficiencyBudgetService {
	view(): EfficiencyBudgetSettings
	update(value: EfficiencyBudgetValue): Promise<EfficiencyBudgetSettings>
}

export async function readBudgetSettings(file: string): Promise<unknown> {
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	)
	try {
		if (!(await handle.stat()).isFile()) return undefined
		const buffer = Buffer.alloc(BUDGET_SETTINGS_MAX_BYTES + 1)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		if (bytesRead > BUDGET_SETTINGS_MAX_BYTES) return undefined
		return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown
	} finally {
		await handle.close()
	}
}

/** Same atomic tmp + fsync + rename writer used by runtime scanner state. */
export async function openEfficiencyBudget(options: {
	stateDir: string
	configured?: EfficiencyBudgetValue
	resolve?: (value: EfficiencyBudgetValue) => EfficiencyBudgetResolution
	read?: (file: string) => Promise<unknown>
	write?: typeof atomicWrite
	onChanged?: (settings: EfficiencyBudgetSettings) => void
}): Promise<EfficiencyBudgetService> {
	const file = join(options.stateDir, BUDGET_SETTINGS_FILE)
	const resolve = options.resolve ?? hostCpuBudget
	let value = CpuBudgetSchema.parse(options.configured ?? "auto")
	try {
		const stored = FileSchema.safeParse(
			await (options.read ?? readBudgetSettings)(file),
		)
		if (stored.success) value = stored.data.cpuBudgetCores
	} catch {
		// Missing or malformed state falls back to the validated startup policy.
	}
	let settings: EfficiencyBudgetSettings = {
		cpuBudgetCores: value,
		resolved: resolve(value),
	}
	let tail: Promise<unknown> = Promise.resolve()
	return {
		view: () => structuredClone(settings),
		update(next) {
			const parsed = CpuBudgetSchema.safeParse(next)
			if (!parsed.success)
				return Promise.reject(
					new WaveKitError("Invalid CPU budget", "EFFICIENCY_BUDGET_INVALID"),
				)
			const work = tail.then(async () => {
				const resolved = resolve(parsed.data)
				try {
					await (options.write ?? atomicWrite)(
						file,
						`${JSON.stringify({ version: 1, cpuBudgetCores: parsed.data })}\n`,
					)
				} catch {
					throw new WaveKitError(
						"Could not persist CPU budget",
						"EFFICIENCY_BUDGET_STORE_UNAVAILABLE",
					)
				}
				settings = { cpuBudgetCores: parsed.data, resolved }
				options.onChanged?.(structuredClone(settings))
				return structuredClone(settings)
			})
			tail = work.catch(() => undefined)
			return work
		},
	}
}
