import * as fs from "node:fs"
import * as path from "node:path"
import type { z } from "zod"

const MAX_BYTES = 4096

/**
 * Reads one small sanitized record from the host status directory that compose
 * mounts read-only: never through a symlink, never more than 4 KB, and only
 * the fields its schema allows. `label` names the record in reasons.
 */
export function readStatusFile<T extends z.ZodTypeAny>(
	dir: string,
	file: string,
	schema: T,
	label: string,
): { value: z.output<T> | null; reason: string | null } {
	let text: string
	let fd: number | null = null
	try {
		fd = fs.openSync(
			path.join(dir, file),
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
		)
		const stat = fs.fstatSync(fd)
		if (!stat.isFile())
			return { value: null, reason: `${label} is not a regular file` }
		if (stat.size > MAX_BYTES)
			return { value: null, reason: `${label} file too large` }
		const buffer = Buffer.alloc(stat.size)
		fs.readSync(fd, buffer, 0, stat.size, 0)
		text = buffer.toString("utf8")
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT")
			return { value: null, reason: "not provided by this install" }
		if (code === "ELOOP")
			return { value: null, reason: `${label} is a symlink` }
		return { value: null, reason: `${label} unreadable` }
	} finally {
		if (fd !== null) fs.closeSync(fd)
	}
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		return { value: null, reason: `${label} is not valid JSON` }
	}
	const parsed = schema.safeParse(json)
	return parsed.success
		? { value: parsed.data as z.output<T>, reason: null }
		: { value: null, reason: `${label} has an unknown format` }
}

/** Pi wall-clock age of an ISO time; null when it would be negative. */
export function ageMs(iso: string, wallNow: number): number | null {
	const age = wallNow - Date.parse(iso)
	return Number.isFinite(age) && age >= 0 ? Math.round(age) : null
}
