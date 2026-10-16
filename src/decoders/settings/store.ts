/**
 * WG8 lane ST: the persisted decoder override layer `<stateDir>/decoder-settings.json`
 * (docs/specs/web-gaps-8, requirements 1.1 to 1.6, design "Decoder settings", Store).
 * Mirrors src/core/station/store.ts. The patch policy is not applied here (the service does it).
 */
import * as nodeFs from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
	DECODER_SETTINGS_FILE_MAX_BYTES,
	DECODER_SETTINGS_FILE_NAME,
	DECODER_SETTINGS_MAX_DECODERS,
	DECODER_SETTINGS_MAX_KEYS,
} from "@wavekit/api-types"
import type { DecoderSettingValue } from "@wavekit/api-types"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import { safeErrorFields } from "../safe-error-fields.js"
import {
	DECODER_SETTINGS_SCHEMA_VERSION,
	DecoderSettingsError,
} from "./contract.js"
import type { DecoderOverride, DecoderSettingsFile } from "./contract.js"

/**
 * Per-value bounds. The file cap (256 KiB) is the global bound; these keep one value from
 * taking it all and keep parse cost linear in the file size:
 * - decoder id and option key: 1..128 chars; decoder type: 1..64 chars;
 * - string value and list item: <= 256 chars; list: <= 256 items (the largest list any option
 *   schema accepts: rtl433 `protocols`, RTL433_PROTOCOLS_MAX).
 * Worst case for one value: 256 items x (256 chars + ~6 quote/comma/indent bytes) ~ 67 KiB,
 * under the 256 KiB cap; 256 entries x 64 keys x 67 KiB would not fit, so the byte cap
 * (checked first, before parse) is what bounds the whole file.
 */
export const DECODER_SETTINGS_ID_MAX_LENGTH = 128
export const DECODER_SETTINGS_KEY_MAX_LENGTH = 128
export const DECODER_SETTINGS_TYPE_MAX_LENGTH = 64
export const DECODER_SETTINGS_STRING_MAX_LENGTH = 256
export const DECODER_SETTINGS_LIST_MAX_ITEMS = 256

/** Leftover temporary files removed per open (station bound). */
export const DECODER_SETTINGS_TMP_SWEEP_MAX = 16
/** A temporary file younger than this may belong to a live writer and is kept (station bound). */
export const DECODER_SETTINGS_TMP_STALE_MS = 60_000

const CORRUPT_PREFIX = `${DECODER_SETTINGS_FILE_NAME}.corrupt-`
const TMP_PATTERN = /^decoder-settings\.json\.(\d+)\.tmp$/
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
])

/** A decoder id or option key the store never loads nor writes (prototype names). */
export function isForbiddenDecoderSettingsKey(key: string): boolean {
	return FORBIDDEN_KEYS.has(key)
}
const SEED_PER_MS = 1_000

const UNAVAILABLE_TEXT = "Decoder settings store is unavailable"
const LIMIT_TEXT = "Decoder settings exceed the store bounds"

/** The fs/promises subset the store uses (injectable for tests). */
export interface DecoderSettingsFs {
	open: typeof nodeFs.open
	rename: typeof nodeFs.rename
	unlink: typeof nodeFs.unlink
	readdir: (path: string) => Promise<string[]>
	lstat: typeof nodeFs.lstat
	mkdir: typeof nodeFs.mkdir
}

const defaultFs: DecoderSettingsFs = {
	open: nodeFs.open,
	rename: nodeFs.rename,
	unlink: nodeFs.unlink,
	readdir: (path: string) => nodeFs.readdir(path),
	lstat: nodeFs.lstat,
	mkdir: nodeFs.mkdir,
}

export interface DecoderSettingsStore {
	revision(): number
	/** Current in-memory file (deep-frozen; callers never mutate). */
	snapshot(): DecoderSettingsFile
	/**
	 * Serialised; tmp + fsync + rename + best-effort dir fsync; memory replaced only after the
	 * rename. Bounds -> DECODER_SETTINGS_LIMIT; IO failure -> DECODER_SETTINGS_STORE_UNAVAILABLE
	 * with memory unchanged. A failed write does not poison later writes.
	 */
	write(next: DecoderSettingsFile): Promise<void>
	close(): Promise<void>
}

export interface DecoderSettingsStoreOptions {
	stateDir: string
	logger: Logger
	now?: () => number
	fs?: DecoderSettingsFs
}

const BoundedString = (max: number) => z.string().min(1).max(max)

const ValueSchema = z.union([
	z.boolean(),
	z.number().finite(),
	z.string().max(DECODER_SETTINGS_STRING_MAX_LENGTH),
	z
		.array(z.string().max(DECODER_SETTINGS_STRING_MAX_LENGTH))
		.max(DECODER_SETTINGS_LIST_MAX_ITEMS),
	z.array(z.number().finite()).max(DECODER_SETTINGS_LIST_MAX_ITEMS),
])

const OverrideSchema = z
	.object({
		type: BoundedString(DECODER_SETTINGS_TYPE_MAX_LENGTH),
		enabled: z.boolean().optional(),
		options: z.record(
			BoundedString(DECODER_SETTINGS_KEY_MAX_LENGTH),
			ValueSchema,
		),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict()

const FileSchema = z
	.object({
		schemaVersion: z.literal(DECODER_SETTINGS_SCHEMA_VERSION),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		decoders: z.record(
			BoundedString(DECODER_SETTINGS_ID_MAX_LENGTH),
			OverrideSchema,
		),
	})
	.strict()

export type ParsedDecoderSettings =
	| { corrupt: false; file: DecoderSettingsFile }
	| { corrupt: true; lostRevision: number | undefined }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Counts and prototype keys, checked before Zod copies keys into fresh objects. */
function withinCountsAndSafeKeys(raw: unknown): boolean {
	if (!isPlainRecord(raw) || !Object.hasOwn(raw, "decoders")) return true
	const decoders = raw["decoders"]
	if (!isPlainRecord(decoders)) return true
	const ids = Object.keys(decoders)
	if (ids.length > DECODER_SETTINGS_MAX_DECODERS) return false
	for (const id of ids) {
		if (FORBIDDEN_KEYS.has(id)) return false
		const entry = decoders[id]
		if (!isPlainRecord(entry) || !Object.hasOwn(entry, "options")) continue
		const options = entry["options"]
		if (!isPlainRecord(options)) continue
		const keys = Object.keys(options)
		if (keys.length > DECODER_SETTINGS_MAX_KEYS) return false
		if (keys.some(key => FORBIDDEN_KEYS.has(key))) return false
	}
	return true
}

function lostRevisionOf(raw: unknown): number | undefined {
	if (!isPlainRecord(raw) || !Object.hasOwn(raw, "revision")) return undefined
	const value = raw["revision"]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function withoutNegativeZero(value: DecoderSettingValue): DecoderSettingValue {
	if (typeof value === "number") return value + 0
	if (!Array.isArray(value)) return value
	const list: readonly (string | number)[] = value
	return list.every(item => typeof item === "number")
		? list.map(item => (item as number) + 0)
		: value
}

function toFile(data: z.infer<typeof FileSchema>): DecoderSettingsFile {
	// Null-prototype records: no key can reach Object.prototype.
	const decoders = Object.create(null) as Record<string, DecoderOverride>
	for (const [id, entry] of Object.entries(data.decoders)) {
		const options = Object.create(null) as Record<
			string,
			DecoderOverride["options"][string]
		>
		for (const [key, value] of Object.entries(entry.options)) {
			// JSON cannot carry -0; normalise so memory equals what a reload yields.
			options[key] = withoutNegativeZero(value)
		}
		const override: DecoderOverride =
			entry.enabled === undefined
				? { type: entry.type, options, updatedAt: entry.updatedAt }
				: {
						type: entry.type,
						enabled: entry.enabled,
						options,
						updatedAt: entry.updatedAt,
					}
		decoders[id] = override
	}
	return {
		schemaVersion: DECODER_SETTINGS_SCHEMA_VERSION,
		revision: data.revision,
		decoders,
	}
}

/**
 * Pure parse of the file text. Any wrong shape anywhere, an oversized text, too many entries
 * or keys, or a prototype key makes the whole file corrupt (no partial trust).
 */
export function parseDecoderSettingsFile(text: string): ParsedDecoderSettings {
	if (Buffer.byteLength(text, "utf8") > DECODER_SETTINGS_FILE_MAX_BYTES) {
		return { corrupt: true, lostRevision: undefined }
	}
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return { corrupt: true, lostRevision: undefined }
	}
	const lostRevision = lostRevisionOf(raw)
	if (!withinCountsAndSafeKeys(raw)) return { corrupt: true, lostRevision }
	const parsed = FileSchema.safeParse(raw)
	if (!parsed.success) return { corrupt: true, lostRevision }
	return { corrupt: false, file: toFile(parsed.data) }
}

export function serializeDecoderSettingsFile(
	file: DecoderSettingsFile,
): string {
	return `${JSON.stringify(file, null, "\t")}\n`
}

/** `max(now x 1000, lost + 1)`, falling back to `now x 1000` if not a safe integer. */
export function seedDecoderSettingsRevision(
	nowMs: number,
	lostRevision: number | undefined,
): number {
	const base = Number.isFinite(nowMs)
		? Math.max(0, Math.floor(nowMs)) * SEED_PER_MS
		: 0
	const safeBase = Number.isSafeInteger(base) ? base : 0
	if (lostRevision === undefined) return safeBase
	const seed = Math.max(safeBase, Math.floor(lostRevision) + 1)
	return Number.isSafeInteger(seed) ? seed : safeBase
}

function deepFreeze(file: DecoderSettingsFile): DecoderSettingsFile {
	for (const entry of Object.values(file.decoders)) {
		for (const value of Object.values(entry.options)) {
			if (Array.isArray(value)) Object.freeze(value)
		}
		Object.freeze(entry.options)
		Object.freeze(entry)
	}
	Object.freeze(file.decoders)
	return Object.freeze(file)
}

function emptyFile(revision: number): DecoderSettingsFile {
	return deepFreeze({
		schemaVersion: DECODER_SETTINGS_SCHEMA_VERSION,
		revision,
		decoders: Object.create(null) as Record<string, DecoderOverride>,
	})
}

type ReadResult = string | null | "oversized"

async function readBounded(
	fs: DecoderSettingsFs,
	path: string,
): Promise<ReadResult> {
	let handle
	try {
		handle = await fs.open(path, "r")
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "ENOTDIR") return null
		throw error
	}
	try {
		const stat = await handle.stat()
		if (stat.size > DECODER_SETTINGS_FILE_MAX_BYTES) return "oversized"
		const buffer = Buffer.alloc(DECODER_SETTINGS_FILE_MAX_BYTES + 1)
		let length = 0
		for (;;) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length,
			)
			if (bytesRead === 0) break
			length += bytesRead
			if (length > DECODER_SETTINGS_FILE_MAX_BYTES) return "oversized"
		}
		return buffer.subarray(0, length).toString("utf8")
	} finally {
		await handle.close()
	}
}

async function listDir(fs: DecoderSettingsFs, dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir)
	} catch {
		return []
	}
}

async function sweepTmp(
	fs: DecoderSettingsFs,
	stateDir: string,
	entries: readonly string[],
	log: Logger,
): Promise<void> {
	let removed = 0
	let failed = 0
	const nowMs = Date.now()
	for (const name of entries) {
		if (removed >= DECODER_SETTINGS_TMP_SWEEP_MAX) break
		const match = TMP_PATTERN.exec(name)
		if (match === null || Number(match[1]) === process.pid) continue
		const path = join(stateDir, name)
		try {
			const stat = await fs.lstat(path)
			if (
				!stat.isFile() ||
				nowMs - stat.mtimeMs < DECODER_SETTINGS_TMP_STALE_MS
			)
				continue
			await fs.unlink(path)
			removed += 1
		} catch {
			failed += 1
		}
	}
	if (failed > 0)
		log.debug({ failed }, "Could not remove stale decoder settings tmp files")
}

function corruptCopies(entries: readonly string[]): string[] {
	return entries.filter(name => name.startsWith(CORRUPT_PREFIX))
}

async function quarantinedRevision(
	fs: DecoderSettingsFs,
	stateDir: string,
	entries: readonly string[],
): Promise<{ found: boolean; revision: number | undefined }> {
	const newest = corruptCopies(entries)
		.map(name => ({ name, at: Number(name.slice(CORRUPT_PREFIX.length)) }))
		.sort((left, right) => (right.at || 0) - (left.at || 0))[0]
	if (newest === undefined) return { found: false, revision: undefined }
	try {
		const text = await readBounded(fs, join(stateDir, newest.name))
		if (text === null || text === "oversized")
			return { found: true, revision: undefined }
		const parsed = parseDecoderSettingsFile(text)
		return {
			found: true,
			revision: parsed.corrupt ? parsed.lostRevision : parsed.file.revision,
		}
	} catch {
		return { found: true, revision: undefined }
	}
}

/** Moves the corrupt file aside, keeping only the new copy. True when the file was moved. */
async function quarantine(
	fs: DecoderSettingsFs,
	stateDir: string,
	at: number,
	log: Logger,
): Promise<boolean> {
	try {
		const old = corruptCopies(await fs.readdir(stateDir))
		for (const name of old) {
			await fs.unlink(join(stateDir, name)).catch(() => undefined)
		}
		await fs.rename(
			join(stateDir, DECODER_SETTINGS_FILE_NAME),
			join(stateDir, `${CORRUPT_PREFIX}${at}`),
		)
		return true
	} catch (error: unknown) {
		log.warn(
			{ err: safeErrorFields(error) },
			"Could not move the corrupt decoder settings file aside",
		)
		return false
	}
}

interface Loaded {
	file: DecoderSettingsFile
	/** The store must refuse every write for this process lifetime. */
	sealed: boolean
}

async function load(
	fs: DecoderSettingsFs,
	stateDir: string,
	log: Logger,
	now: () => number,
): Promise<Loaded> {
	const entries = await listDir(fs, stateDir)
	await sweepTmp(fs, stateDir, entries, log)
	let text: ReadResult
	try {
		text = await readBounded(fs, join(stateDir, DECODER_SETTINGS_FILE_NAME))
	} catch (error: unknown) {
		// Unreadable (EACCES, EIO, ...): its revision is unknown, so it must never become current
		// again. Move it aside like a corrupt file. If that also fails the file stays in place
		// and a later write (or a later process, once it is readable) could resurrect or
		// overwrite it out of order, so the store is sealed: it starts empty and refuses every
		// write with STORE_UNAVAILABLE for this process lifetime (fail closed).
		log.warn(
			{ err: safeErrorFields(error) },
			"Decoder settings file unreadable; starting empty",
		)
		const at = now()
		const moved = await quarantine(fs, stateDir, at, log)
		if (!moved)
			log.warn(
				{},
				"Decoder settings store refuses writes until the file is readable or removed",
			)
		return {
			file: emptyFile(seedDecoderSettingsRevision(at, undefined)),
			sealed: !moved,
		}
	}
	if (text === null) {
		const lost = await quarantinedRevision(fs, stateDir, entries)
		return {
			file: emptyFile(
				lost.found ? seedDecoderSettingsRevision(now(), lost.revision) : 0,
			),
			sealed: false,
		}
	}
	let lostRevision: number | undefined
	let reason: "oversized" | "invalid"
	if (text === "oversized") {
		reason = "oversized"
	} else {
		const parsed = parseDecoderSettingsFile(text)
		if (!parsed.corrupt) return { file: deepFreeze(parsed.file), sealed: false }
		reason = "invalid"
		lostRevision = parsed.lostRevision
	}
	log.warn(
		{ reason },
		"Decoder settings file is corrupt; ignoring it and starting empty",
	)
	const at = now()
	await quarantine(fs, stateDir, at, log)
	return {
		file: emptyFile(seedDecoderSettingsRevision(at, lostRevision)),
		sealed: false,
	}
}

function checkBounds(next: DecoderSettingsFile): string {
	const ids = Object.keys(next.decoders)
	if (ids.length > DECODER_SETTINGS_MAX_DECODERS)
		throw new DecoderSettingsError("DECODER_SETTINGS_LIMIT", LIMIT_TEXT)
	for (const id of ids) {
		const entry = next.decoders[id]
		if (
			entry !== undefined &&
			Object.keys(entry.options).length > DECODER_SETTINGS_MAX_KEYS
		)
			throw new DecoderSettingsError("DECODER_SETTINGS_LIMIT", LIMIT_TEXT)
	}
	const body = serializeDecoderSettingsFile(next)
	if (Buffer.byteLength(body, "utf8") > DECODER_SETTINGS_FILE_MAX_BYTES)
		throw new DecoderSettingsError("DECODER_SETTINGS_LIMIT", LIMIT_TEXT)
	return body
}

export async function openDecoderSettingsStore(
	opts: DecoderSettingsStoreOptions,
): Promise<DecoderSettingsStore> {
	const { stateDir } = opts
	const fs = opts.fs ?? defaultFs
	const now = opts.now ?? Date.now
	const log = createComponentLogger(opts.logger, "DecoderSettings")
	const loaded = await load(fs, stateDir, log, now)
	let current = loaded.file
	const sealed = loaded.sealed
	let chain: Promise<void> = Promise.resolve()
	let closed = false

	const persist = async (next: DecoderSettingsFile): Promise<void> => {
		if (
			closed ||
			sealed ||
			Object.keys(next.decoders).some(id => FORBIDDEN_KEYS.has(id))
		)
			throw new DecoderSettingsError(
				"DECODER_SETTINGS_STORE_UNAVAILABLE",
				UNAVAILABLE_TEXT,
			)
		const body = checkBounds(next)
		// Memory must equal what a reload yields; a shape the loader refuses would be lost.
		const parsed = parseDecoderSettingsFile(body)
		if (parsed.corrupt)
			throw new DecoderSettingsError("DECODER_SETTINGS_LIMIT", LIMIT_TEXT)
		const tmp = join(
			stateDir,
			`${DECODER_SETTINGS_FILE_NAME}.${process.pid}.tmp`,
		)
		try {
			await fs.mkdir(stateDir, { recursive: true })
			let created = false
			try {
				// Exclusive create: never open (and so never truncate) an existing entry, a planted
				// symlink included. A leftover entry of ours is unlinked (unlink removes the link,
				// not its target) and the create retried once; a second clash fails closed.
				const exclusive = () => fs.open(tmp, "wx", 0o644)
				let handle
				try {
					handle = await exclusive()
				} catch (error: unknown) {
					if ((error as { code?: unknown } | null)?.code !== "EEXIST")
						throw error
					await fs.unlink(tmp)
					handle = await exclusive()
				}
				created = true
				try {
					await handle.writeFile(body, "utf8")
					await handle.sync()
				} finally {
					await handle.close()
				}
				await fs.rename(tmp, join(stateDir, DECODER_SETTINGS_FILE_NAME))
			} catch (error: unknown) {
				if (created) await fs.unlink(tmp).catch(() => undefined)
				throw error
			}
		} catch (error: unknown) {
			log.warn(
				{ err: safeErrorFields(error) },
				"Could not write the decoder settings file",
			)
			throw new DecoderSettingsError(
				"DECODER_SETTINGS_STORE_UNAVAILABLE",
				UNAVAILABLE_TEXT,
			)
		}
		current = deepFreeze(parsed.file)
		try {
			const dir = await fs.open(stateDir, "r")
			try {
				await dir.sync()
			} finally {
				await dir.close()
			}
		} catch {
			// Directory fsync is best effort (unsupported on some platforms).
		}
	}

	return {
		revision: () => current.revision,
		snapshot: () => current,
		write(next) {
			const result = chain.then(() => persist(next))
			chain = result.catch(() => undefined)
			return result
		},
		async close() {
			closed = true
			await chain
		},
	}
}
