import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"

/**
 * First-boot progress, written by pi-image-firstboot.py as a sanitized,
 * allowlisted JSON file in a dedicated host directory that compose mounts
 * read-only. The boot partition (which holds Wi-Fi and account configuration)
 * is never mounted into the container.
 */
export const SETUP_STATUS_FILE = "setup.json"
const MAX_BYTES = 4096

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
	let text: string
	let fd: number | null = null
	try {
		fd = fs.openSync(
			path.join(dir, SETUP_STATUS_FILE),
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
		)
		const stat = fs.fstatSync(fd)
		if (!stat.isFile())
			return { value: null, reason: "setup status is not a regular file" }
		if (stat.size > MAX_BYTES)
			return { value: null, reason: "setup status file too large" }
		const buffer = Buffer.alloc(stat.size)
		fs.readSync(fd, buffer, 0, stat.size, 0)
		text = buffer.toString("utf8")
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT")
			return { value: null, reason: "not provided by this install" }
		if (code === "ELOOP")
			return { value: null, reason: "setup status is a symlink" }
		return { value: null, reason: "setup status unreadable" }
	} finally {
		if (fd !== null) fs.closeSync(fd)
	}

	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		return { value: null, reason: "setup status is not valid JSON" }
	}
	const parsed = SetupFileSchema.safeParse(json)
	if (!parsed.success)
		return { value: null, reason: "setup status has an unknown format" }
	const file = parsed.data
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
			updatedAgeMs: (() => {
				const age = wallNow - Date.parse(file.updatedAt)
				return Number.isFinite(age) && age >= 0 ? Math.round(age) : null
			})(),
			exitCode: file.exitCode,
		},
		reason: null,
	}
}
