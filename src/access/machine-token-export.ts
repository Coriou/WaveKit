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

interface Identity {
	dev: number
	ino: number
}

function same(a: Identity, b: Identity): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

/** Test seam: runs at the publish step's race points (no production caller passes it). */
export interface MachineTokenExportHooks {
	step?: (name: "before-publish" | "after-publish") => Promise<void> | void
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
 *
 * Publication is anchored to the validated parent, not its pathname: Node has no
 * `linkat`/`renameat`, so the command changes the working directory into the
 * parent and checks that `.` is the directory it validated, then creates, links
 * and renames by bare name. The working directory pins the inode, so swapping the
 * parent path (or an ancestor) for a symlink to the private directory afterwards
 * cannot redirect the write. The parent path's identity (dev/ino) and that it is
 * neither the private directory nor inside it are checked immediately before and
 * after `link`/`rename`; on any mismatch what was written is removed from the
 * pinned directory and the export is refused. It changes the process working
 * directory for the publish and restores it, so it runs only in the one-shot
 * access command, never in the core.
 *
 * An existing target is refused unless `replace` is set and it is already our
 * own 0600 regular file. Nothing returned or thrown carries the token or a path.
 */
export async function exportMachineToken(
	options: {
		directory: string
		out: string
		replace?: boolean
	},
	hooks: MachineTokenExportHooks = {},
): Promise<MachineTokenExportResult> {
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
	const name = basename(out)
	let parent: FileHandle | undefined
	let parentId: Identity
	let realDirectory: string
	let privateId: Identity | undefined
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
		parentId = parentStat
		// The private directory admits only its own files; never write the copy
		// there, including through a symlinked ancestor.
		realDirectory = await fs.realpath(directory).catch(() => directory)
		privateId = await fs.stat(realDirectory).catch(() => undefined)
		const realParent = await fs.realpath(parentPath)
		if (within(realDirectory, join(realParent, name)))
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
		const exists = await assertReplaceable(out, uid)
		if (exists && !replace) throw refuse("ACCESS_TOKEN_OUT_EXISTS")
		parent = await fs.open(
			parentPath,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		)
		if (!same(await parent.stat(), parentId))
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
	} catch (error) {
		await parent?.close().catch(() => undefined)
		return { kind: "unavailable", code: codeOf(error) }
	}
	const parentHandle = parent
	const pinnedId = parentId
	const privateDirectory = realDirectory
	const privateIdentity = privateId
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

	/**
	 * The parent path still names the pinned directory, `.` is that directory, and
	 * neither is the private directory or inside it. Throws `ACCESS_TOKEN_OUT_UNSAFE`.
	 */
	async function assertAnchored(): Promise<void> {
		const [path, here] = await Promise.all([
			fs.lstat(parentPath).catch(() => undefined),
			fs.stat(".").catch(() => undefined),
		])
		if (
			!path ||
			!here ||
			path.isSymbolicLink() ||
			!same(path, pinnedId) ||
			!same(here, pinnedId) ||
			(privateIdentity !== undefined && same(here, privateIdentity))
		)
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
		// getcwd reports where the pinned inode is now, whatever path reached it.
		if (within(privateDirectory, join(process.cwd(), name)))
			throw refuse("ACCESS_TOKEN_OUT_UNSAFE")
	}

	async function publish(token: string): Promise<void> {
		const previous = process.cwd()
		const temp = `.${name}-${randomUUID()}.tmp`
		let handle: FileHandle | undefined
		let ownedTemp = false
		let published = false
		let entered = false
		try {
			process.chdir(parentPath)
			entered = true
			await assertAnchored()
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
			if (replace) await assertReplaceable(name, uid)
			await assertAnchored()
			await hooks.step?.("before-publish")
			if (replace) {
				await fs.rename(temp, name)
				ownedTemp = false
			} else {
				await fs.link(temp, name).catch((error: unknown) => {
					throw hasCode(error, "EEXIST")
						? refuse("ACCESS_TOKEN_OUT_EXISTS")
						: error
				})
			}
			published = true
			await hooks.step?.("after-publish")
			await assertAnchored()
			await parentHandle.sync()
		} catch (error) {
			// Still inside the pinned directory: these bare names cannot reach elsewhere.
			if (published && entered) await fs.unlink(name).catch(() => undefined)
			throw error
		} finally {
			if (handle) await handle.close().catch(() => undefined)
			if (ownedTemp && entered) await fs.unlink(temp).catch(() => undefined)
			if (entered)
				try {
					process.chdir(previous)
				} catch {
					// The caller's directory went away: stay put, nothing else uses it.
				}
		}
	}
}
