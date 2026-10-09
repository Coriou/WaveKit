import type { SdrHostLastBoot } from "@wavekit/api-types"
import { z } from "zod"
import { ageMs, readStatusFile } from "./status-file.js"

/**
 * How the previous boot ended, written once per boot by the image's
 * wavekit-boot-report service (scripts/pi-boot-report.py) next to setup.json.
 */
export const BOOT_REPORT_FILE = "last-boot.json"

const BootReportSchema = z.object({
	schema: z.literal(1),
	bootId: z.string().max(64).nullable(),
	previous: z
		.object({
			lastEntryAt: z.string().datetime({ offset: true }),
			cleanShutdown: z.boolean(),
		})
		.nullable(),
	undervoltageSinceBoot: z.boolean().nullable(),
	throttledSinceBoot: z.boolean().nullable(),
	watchdogReset: z.literal(true).nullable(),
})

export function readBootReport(
	dir: string,
	currentBootId: string | null,
	/** Pi wall clock, the clock the report's timestamps came from. */
	wallNow: number = Date.now(),
): { value: SdrHostLastBoot | null; reason: string | null } {
	const { value: file, reason } = readStatusFile(
		dir,
		BOOT_REPORT_FILE,
		BootReportSchema,
		"boot report",
	)
	if (!file) return { value: null, reason }
	// A report from an earlier boot describes that boot, not this one.
	if (file.bootId === null || file.bootId !== currentBootId)
		return { value: null, reason: "not recorded for this boot yet" }
	return {
		value: {
			previous: file.previous && {
				...file.previous,
				lastEntryAgeMs: ageMs(file.previous.lastEntryAt, wallNow),
			},
			undervoltageSinceBoot: file.undervoltageSinceBoot,
			throttledSinceBoot: file.throttledSinceBoot,
			watchdogReset: file.watchdogReset,
		},
		reason: null,
	}
}
