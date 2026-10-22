import type { DropAttribution } from "@wavekit/api-types"
import { z } from "zod"
import {
	HOST_LOOP_DELAY_MS,
	LINK_GAP_MS,
} from "../../core/link-burst/contract.js"

export interface IntervalEvidence {
	complete: boolean
	branchDrops: ReadonlyMap<string, number>
	absorberOverflow: number | null
	maxGapMs: number | null
	loopDelayMaxMs: number | null
	cpuPercent: number | null
	cpuGuardPercent: number
	shortfall: boolean | null
	upstreamDropDelta: number | null
}

const nonNegative = z.number().finite().nonnegative()
const evidenceSchema = z.object({
	complete: z.boolean(),
	branchDrops: z.map(z.string(), nonNegative),
	absorberOverflow: nonNegative.nullable(),
	maxGapMs: nonNegative.nullable(),
	loopDelayMaxMs: nonNegative.nullable(),
	cpuPercent: nonNegative.nullable(),
	cpuGuardPercent: nonNegative,
	shortfall: z.boolean().nullable(),
	upstreamDropDelta: nonNegative.nullable(),
})

export function attributeInterval(e: IntervalEvidence): DropAttribution {
	try {
		const parsed = evidenceSchema.safeParse(e)
		if (!parsed.success || !parsed.data.complete) return "unknown"
		const input = parsed.data
		let positive = 0
		for (const drop of input.branchDrops.values()) {
			if (drop > 0) positive++
		}
		const overflow = (input.absorberOverflow ?? 0) > 0
		if (positive === 0 && !overflow) return "none"
		if (positive > 0 && positive < input.branchDrops.size && !overflow)
			return "consumer"
		// Drops on every branch do not prove host overload: a consumer release
		// can affect siblings too. Require independent loop/CPU evidence below;
		// otherwise retain link evidence or fail closed to unknown.
		if ((input.upstreamDropDelta ?? 0) > 0) return "unknown"
		// Event-loop starvation makes ingest gaps unreliable link evidence.
		if (
			(input.loopDelayMaxMs !== null &&
				input.loopDelayMaxMs >= HOST_LOOP_DELAY_MS) ||
			(input.cpuPercent !== null && input.cpuPercent >= input.cpuGuardPercent)
		)
			return "host"
		if (
			input.maxGapMs !== null &&
			input.loopDelayMaxMs !== null &&
			input.shortfall === false &&
			input.maxGapMs - input.loopDelayMaxMs >= LINK_GAP_MS
		)
			return "link"
		if (
			input.branchDrops.size === 1 &&
			positive === 1 &&
			input.absorberOverflow === 0 &&
			input.maxGapMs !== null &&
			input.maxGapMs < LINK_GAP_MS &&
			input.shortfall === false &&
			input.loopDelayMaxMs !== null &&
			input.cpuPercent !== null
		)
			return "consumer"
		return "unknown"
	} catch {
		return "unknown"
	}
}
