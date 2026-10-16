import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { z } from "zod"
import { CliUsageError } from "./config.js"

export class CliAccessError extends CliUsageError {
	override name = "CliAccessError"
	constructor(readonly code: string) {
		super("CLI access unavailable")
	}
}

// This small wire-format boundary mirrors core credentials, without importing
// root sources into the CLI build. A machine credential is never a pairing code.
export function isCanonicalMachineToken(value: string): boolean {
	return (
		/^[A-Za-z0-9_-]{43}$/.test(value) &&
		Buffer.from(value, "base64url").toString("base64url") === value
	)
}
const tokenSchema = z.string().refine(isCanonicalMachineToken)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const recordFields = {
	deviceId: z
		.string()
		.startsWith("device_")
		.refine(v => isCanonicalMachineToken(v.slice(7))),
	tokenHash: digestSchema,
	csrfToken: tokenSchema,
	createdAt: timeSchema,
	renewedAt: timeSchema,
	expiresAt: timeSchema,
}
const recordSchema = z.object(recordFields).strict()
// Core snapshot version 2 (WG2 access amendment 4.9-4.12) adds operator labels
// and a coarse last-seen hour. The CLI never uses them, so it only bounds their
// shape (a newer core may add kinds); unknown keys are still rejected.
const recordV2Schema = z
	.object({
		...recordFields,
		name: z.string().max(256).nullable(),
		kind: z.string().max(16).nullable(),
		lastSeenAt: z.number().int().nonnegative().nullable(),
	})
	.strict()
const stateSchema = z
	.object({
		version: z.literal(1),
		machineToken: tokenSchema,
		credentialBinding: digestSchema,
		sessions: z.union([
			z
				.object({
					version: z.literal(1),
					credentialBinding: digestSchema,
					sessions: z.array(recordSchema).max(32),
				})
				.strict(),
			z
				.object({
					version: z.literal(2),
					credentialBinding: digestSchema,
					sessions: z.array(recordV2Schema).max(32),
				})
				.strict(),
		]),
	})
	.strict()

/** Opaque: JSON, object spread and inspection do not reveal the token. */
export class MachineCredential {
	#token: string
	constructor(token: string) {
		const result = tokenSchema.safeParse(token)
		if (!result.success)
			throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
		this.#token = result.data
		Object.freeze(this)
	}
	/** Sensitive transport callback; never log or retain its result. */
	use<T>(consumer: (token: string) => T): T {
		return consumer(this.#token)
	}
}
export type CredentialProvider = () => Promise<MachineCredential>
export interface FileCredentialOptions {
	path: string
	format: "token" | "access-state"
}

function stateToken(text: string): string {
	const input: unknown = JSON.parse(text)
	const result = stateSchema.safeParse(input)
	if (!result.success) throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
	const state = result.data
	const digest = createHash("sha256")
		.update(state.machineToken, "ascii")
		.digest()
	const binding = createHash("sha256")
		.update("wavekit-access-sessions-v1\0")
		.update(digest)
		.digest("hex")
	if (
		state.credentialBinding !== binding ||
		state.sessions.credentialBinding !== binding
	)
		throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
	const ids = new Set<string>()
	const hashes = new Set<string>()
	for (const record of state.sessions.sessions) {
		if (
			ids.has(record.deviceId) ||
			hashes.has(record.tokenHash) ||
			record.createdAt > record.renewedAt ||
			record.expiresAt <= record.renewedAt ||
			record.expiresAt - record.renewedAt > 30 * 24 * 60 * 60 * 1000 ||
			createHash("sha256").update(record.csrfToken, "ascii").digest("hex") ===
				record.tokenHash
		)
			throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
		ids.add(record.deviceId)
		hashes.add(record.tokenHash)
	}
	return state.machineToken
}

/**
 * Read-only projection, usable while the core owns its writer lock. Selected
 * directory/file must already be uid-owned 0700/0600; parents must be trusted
 * and stable, as in core private storage. No provisioning, chmod or lock writes.
 * Reload each use so stopped-core credential rotation is observed.
 */
export function createFileCredentialProvider(
	options: FileCredentialOptions,
): CredentialProvider {
	const parsed = z
		.object({
			path: z.string().min(1).max(4096).refine(isAbsolute),
			format: z.enum(["token", "access-state"]),
		})
		.strict()
		.safeParse(options)
	if (!parsed.success) throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
	const { path, format } = parsed.data
	return async () => {
		let directory: FileHandle | undefined
		let file: FileHandle | undefined
		try {
			const uid = process.getuid?.()
			if (uid === undefined)
				throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			const parent = dirname(path)
			const dirStat = await fs.lstat(parent)
			if (
				!dirStat.isDirectory() ||
				dirStat.isSymbolicLink() ||
				dirStat.uid !== uid ||
				(dirStat.mode & 0o7777) !== 0o700
			)
				throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			directory = await fs.open(
				parent,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			)
			const assertDirectory = async (): Promise<void> => {
				const [current, opened] = await Promise.all([
					fs.lstat(parent),
					directory!.stat(),
				])
				if (
					!current.isDirectory() ||
					current.isSymbolicLink() ||
					current.uid !== uid ||
					(current.mode & 0o7777) !== 0o700 ||
					current.dev !== dirStat.dev ||
					current.ino !== dirStat.ino ||
					opened.dev !== current.dev ||
					opened.ino !== current.ino
				)
					throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			}
			await assertDirectory()
			const limit = format === "token" ? 128 : 64 * 1024
			const stat = await fs.lstat(path)
			const safe = (value: typeof stat): boolean =>
				value.isFile() &&
				!value.isSymbolicLink() &&
				value.uid === uid &&
				(value.mode & 0o7777) === 0o600 &&
				value.nlink === 1 &&
				value.size <= limit
			if (!safe(stat)) throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			file = await fs.open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			)
			const opened = await file.stat()
			if (!safe(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino)
				throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			const buffer = Buffer.alloc(limit + 1)
			let total = 0
			while (total < buffer.length) {
				const read = await file.read(
					buffer,
					total,
					buffer.length - total,
					total,
				)
				if (read.bytesRead === 0) break
				total += read.bytesRead
			}
			if (total > limit || !safe(await file.stat()))
				throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
			await assertDirectory()
			const text = buffer.subarray(0, total).toString("utf8")
			return new MachineCredential(
				format === "token" ? text.replace(/\r?\n$/, "") : stateToken(text),
			)
		} catch {
			throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
		} finally {
			await file?.close().catch(() => undefined)
			await directory?.close().catch(() => undefined)
		}
	}
}
