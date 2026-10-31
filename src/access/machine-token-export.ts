import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { PrivateAccessStorage } from "./private-storage.js"

export type MachineTokenExportCode =
	| "ACCESS_COMMAND_INVALID"
	| "ACCESS_CREDENTIAL_UNAVAILABLE"
	| "ACCESS_TOKEN_OUT_EXISTS"
	| "ACCESS_TOKEN_OUT_UNSAFE"
	| "ACCESS_TOKEN_WRITE_FAILED"

export type MachineTokenExportResult =
	| { kind: "written" }
	| { kind: "unavailable"; code: MachineTokenExportCode }

const pathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(isAbsolute)
	.refine(value => !value.includes("\0"))
const optionsSchema = z
	.object({
		directory: pathSchema,
		out: pathSchema,
		replace: z.boolean().optional(),
	})
	.strict()

function refuse(code: MachineTokenExportCode): WaveKitError {
	return new WaveKitError("Machine credential export refused", code)
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	)
}

function codeOf(error: unknown): MachineTokenExportCode {
	return error instanceof WaveKitError &&
		(error.code === "ACCESS_TOKEN_OUT_EXISTS" ||
			error.code === "ACCESS_TOKEN_OUT_UNSAFE")
		? error.code
		: "ACCESS_TOKEN_WRITE_FAILED"
}

function within(directory: string, path: string): boolean {
	const inside = relative(directory, path)
	return (
		inside === "" ||
		(inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
	)
}

/** A replaceable target is our own single-link regular file at exactly 0600. */
async function assertReplaceable(out: string, uid: number): Promise<boolean> {
	let stat
	try {
		stat = await fs.lstat(out)
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false
		throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.uid !== uid ||
		(stat.mode & 0o7777) !== 0o600
	)
		throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
	return true
}

/**
 * Host-side export of the existing machine credential to a private file, so an
 * agent never needs a shell inside the container. It issues nothing: the file
 * holds the one credential that `PrivateAccessStorage` already owns, read through
 * its read-only boundary (safe while the core runs). `rotate-credential` revokes
 * it, as it revokes every copy; re-export after a rotation with `replace`.
 *
 * The output's parent must be an existing directory not writable by group or
 * others, so only its owner (the recipient, e.g. a host user's bind mount when
 * this runs as root in a container) can touch the name between checks; the
 * publish steps never follow a link planted at the target. The file is created
 * 0600 under a temporary name (O_EXCL, O_NOFOLLOW, fchmod past the umask),
 * fsynced, then published atomically: `link` when the name must be new (fails
 * if it appeared meanwhile), `rename` with `replace`.
 * An existing target is refused unless `replace` is set and it is already our
 * own 0600 regular file. Nothing returned or thrown carries the token or a path.
 */
export async function exportMachineToken(options: {
	directory: string
	out: string
	replace?: boolean
}): Promise<MachineTokenExportResult> {
	const parsed = optionsSchema.safeParse(options)
	if (!parsed.success)
		return { kind: "unavailable", code: "ACCESS_COMMAND_INVALID" }
	const directory = resolve(parsed.data.directory)
	const out = resolve(parsed.data.out)
	const replace = parsed.data.replace === true
	const currentUid = process.getuid?.()
	if (currentUid === undefined)
		return { kind: "unavailable", code: "ACCESS_TOKEN_WRITE_FAILED" }
	const uid = currentUid
	const parentPath = dirname(out)
	let parent: FileHandle | undefined
	try {
		const parentStat = await fs.lstat(parentPath).catch(() => {
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
		})
		if (
			!parentStat.isDirectory() ||
			parentStat.isSymbolicLink() ||
			(parentStat.mode & 0o022) !== 0
		)
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
		// The private directory admits only its own files; never write the copy
		// there, including through a symlinked ancestor.
		const [realParent, realDirectory] = await Promise.all([
			fs.realpath(parentPath),
			fs.realpath(directory).catch(() => directory),
		])
		if (within(realDirectory, join(realParent, basename(out))))
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
		const exists = await assertReplaceable(out, uid)
		if (exists && !replace) throw refuse("ACCESS_TOKEN_OUT_EXISTS")
		parent = await fs.open(
			parentPath,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		)
		const opened = await parent.stat()
		if (opened.dev !== parentStat.dev || opened.ino !== parentStat.ino)
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
	} catch (error) {
		await parent?.close().catch(() => undefined)
		return { kind: "unavailable", code: codeOf(error) }
	}
	const parentHandle = parent
	let failure: MachineTokenExportCode | undefined
	try {
		await PrivateAccessStorage.readMachineCredential({ directory }, token =>
			publish(token).catch((error: unknown) => {
				failure = codeOf(error)
			}),
		)
	} catch {
		failure ??= "ACCESS_CREDENTIAL_UNAVAILABLE"
	} finally {
		await parentHandle.close().catch(() => undefined)
	}
	return failure === undefined
		? { kind: "written" }
		: { kind: "unavailable", code: failure }

	async function publish(token: string): Promise<void> {
		const temp = join(parentPath, `.${basename(out)}-${randomUUID()}.tmp`)
		let handle: FileHandle | undefined
		let ownedTemp = false
		try {
			handle = await fs.open(
				temp,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			)
			ownedTemp = true
			await handle.chmod(0o600)
			await handle.writeFile(`${token}\n`, "utf8")
			await handle.sync()
			await handle.close()
			handle = undefined
			if (replace) {
				await assertReplaceable(out, uid)
				await fs.rename(temp, out)
				ownedTemp = false
			} else {
				await fs.link(temp, out).catch((error: unknown) => {
					throw hasCode(error, "EEXIST")
						? refuse("ACCESS_TOKEN_OUT_EXISTS")
						: error
				})
			}
			await parentHandle.sync()
		} finally {
			if (handle) await handle.close().catch(() => undefined)
			if (ownedTemp) await fs.unlink(temp).catch(() => undefined)
		}
	}
}
