import { z } from "zod"
import { ageMs, readStatusFile } from "./status-file.js"

/**
 * First-boot progress, written by pi-image-firstboot.py as a sanitized,
 * allowlisted JSON file in a dedicated host directory that compose mounts
 * read-only. The boot partition (which holds Wi-Fi and account configuration)
 * is never mounted into the container.
 */
export const SETUP_STATUS_FILE = "setup.json"

const SetupFileSchema = z.object({
	schema: z.literal(1),
	state: z.enum(["running", "complete", "failed"]),
	phase: z
		.enum(["cloud-init", "install", "publish", "done"])
		.nullable()
		.default(null),
	updatedAt: z.string().datetime({ offset: true }),
	bootId: z.string().max(64).nullable().default(null),
	exitCode: z.number().int().min(0).max(255).nullable().default(null),
})

export interface SetupStatusValue {
	state: "running" | "complete" | "failed" | "interrupted"
	phase: string | null
	updatedAt: string
	updatedAgeMs: number | null
	exitCode: number | null
}

export function readSetupStatus(
	dir: string,
	currentBootId: string | null,
	/** Pi wall clock, the same clock firstboot used for updatedAt. */
	wallNow: number = Date.now(),
): { value: SetupStatusValue | null; reason: string | null } {
	const { value: file, reason } = readStatusFile(
		dir,
		SETUP_STATUS_FILE,
		SetupFileSchema,
		"setup status",
	)
	if (!file) return { value: null, reason }
	// A "running" record from an earlier boot means setup was cut off by a
	// reboot or power loss; boot IDs survive the Pi's missing real-time clock.
	const interrupted =
		file.state === "running" &&
		file.bootId !== null &&
		currentBootId !== null &&
		file.bootId !== currentBootId
	return {
		value: {
			state: interrupted ? "interrupted" : file.state,
			phase: file.phase,
			updatedAt: file.updatedAt,
			updatedAgeMs: ageMs(file.updatedAt, wallNow),
			exitCode: file.exitCode,
		},
		reason: null,
	}
}
