/**
 * The sdr-host's stable unit id: 128 random bits as 32 lower-case hex, generated once and kept in
 * `<state dir>/unit-id.json`, so it survives process restarts and image updates while the state
 * dir is a mounted volume. A missing (ENOENT) or malformed file gets a new id, written crash-safe:
 * a temporary file written and fsynced through its handle, renamed over the target, then the
 * directory fsynced; the temporary file is removed when any step fails. Any other read error
 * (EACCES, EIO, EISDIR, ...) keeps the file as it is and reports no id. In a container the state
 * dir must be a mount point (a volume): otherwise it lives in the container layer and changes at
 * every recreate, so no id is reported. Whenever the id would not be stable it is not reported at
 * all (null, with a reason): an id that would change must never be taken for a stable one.
 * `receiverId` (one running process) is separate and unchanged.
 */
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export const UNIT_ID_FILE_NAME = "unit-id.json"
/** The file holds one short JSON object; anything larger is malformed. */
export const UNIT_ID_FILE_MAX_BYTES = 1024
const UNIT_ID = /^[0-9a-f]{32}$/

/** Why no unit id is reported (null while one is). */
export type UnitIdReason =
	| "state-not-persistent"
	| "state-unreadable"
	| "state-unwritable"

export interface UnitIdFileHandle {
	writeFile(data: string): Promise<void>
	sync(): Promise<void>
	close(): Promise<void>
}

export interface UnitIdFs {
	readFile(path: string): Promise<Buffer>
	/** Opens `path` for writing (created or truncated). */
	open(path: string): Promise<UnitIdFileHandle>
	rename(from: string, to: string): Promise<void>
	unlink(path: string): Promise<void>
	mkdir(path: string): Promise<void>
	/** fsyncs a directory (makes a rename in it durable). */
	syncDir(path: string): Promise<void>
}

const nodeFs: UnitIdFs = {
	readFile: path => readFile(path),
	open: path => open(path, "w", 0o644),
	rename: (from, to) => rename(from, to),
	unlink: path => unlink(path),
	mkdir: async path => {
		await mkdir(path, { recursive: true })
	},
	syncDir: async path => {
		const handle = await open(path, "r")
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
	},
}

export function isUnitId(value: unknown): value is string {
	return typeof value === "string" && UNIT_ID.test(value)
}

function parseUnitIdFile(raw: Buffer): string | null {
	if (raw.length > UNIT_ID_FILE_MAX_BYTES) return null
	try {
		const json: unknown = JSON.parse(raw.toString("utf8"))
		if (typeof json !== "object" || json === null) return null
		const record = json as Record<string, unknown>
		return record["version"] === 1 && isUnitId(record["unitId"])
			? record["unitId"]
			: null
	} catch {
		return null
	}
}

function errorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined
	const code = (err as { code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

export type LoadUnitIdResult =
	| { unitId: string; source: "read" | "created"; reason: null }
	| { unitId: null; source: "unavailable"; reason: UnitIdReason }

/** Reads the unit id from `dir`, or creates and persists one. Never throws. */
export async function loadOrCreateUnitId(
	dir: string,
	fs: UnitIdFs = nodeFs,
	random: () => string = () => randomBytes(16).toString("hex"),
): Promise<LoadUnitIdResult> {
	const path = join(dir, UNIT_ID_FILE_NAME)
	let raw: Buffer | null
	try {
		raw = await fs.readFile(path)
	} catch (err) {
		// Only a missing file is regenerated; anything else may hide the real id.
		if (errorCode(err) !== "ENOENT")
			return { unitId: null, source: "unavailable", reason: "state-unreadable" }
		raw = null
	}
	const existing = raw === null ? null : parseUnitIdFile(raw)
	if (existing !== null)
		return { unitId: existing, source: "read", reason: null }
	const unitId = random()
	if (!isUnitId(unitId))
		return { unitId: null, source: "unavailable", reason: "state-unwritable" }
	const tmp = `${path}.${process.pid}.tmp`
	let tmpCreated = false
	try {
		await fs.mkdir(dir)
		const handle = await fs.open(tmp)
		tmpCreated = true
		try {
			await handle.writeFile(`${JSON.stringify({ version: 1, unitId })}\n`)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(tmp, path)
		tmpCreated = false
		await fs.syncDir(dir)
	} catch {
		if (tmpCreated) await fs.unlink(tmp).catch(() => undefined)
		return { unitId: null, source: "unavailable", reason: "state-unwritable" }
	}
	return { unitId, source: "created", reason: null }
}

/** Whether the state dir survives a container recreate. */
export type StatePersistence =
	| "mount"
	| "not-mount"
	| "not-container"
	| "unknown"

export interface StatePersistenceProbe {
	/** The st_dev of a path (rejects like fs.stat). */
	deviceOf(path: string): Promise<number>
	/** True when this process runs in a container. */
	inContainer(): boolean
}

const nodeProbe: StatePersistenceProbe = {
	deviceOf: async path => (await stat(path)).dev,
	inContainer: () =>
		existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
}

/**
 * Outside a container the state dir is on the host's own disk ("not-container"). In one it must
 * be a mount point (its st_dev differs from its parent's), else it lives in the container layer.
 * A missing dir is not a mount; any other stat failure is "unknown" (the id is kept, with a log).
 */
export async function stateDirPersistence(
	dir: string,
	probe: StatePersistenceProbe = nodeProbe,
): Promise<StatePersistence> {
	if (!probe.inContainer()) return "not-container"
	const abs = resolve(dir)
	const parent = dirname(abs)
	if (parent === abs) return "mount"
	let own: number
	try {
		own = await probe.deviceOf(abs)
	} catch (err) {
		return errorCode(err) === "ENOENT" ? "not-mount" : "unknown"
	}
	try {
		return own !== (await probe.deviceOf(parent)) ? "mount" : "not-mount"
	} catch {
		return "unknown"
	}
}

export interface UnitIdStartup {
	result: LoadUnitIdResult
	persistence: StatePersistence
}

/** The startup path: a state dir that does not persist reports no id (and nothing is written). */
export async function loadUnitIdAtStartup(
	dir: string,
	deps: {
		fs?: UnitIdFs
		probe?: StatePersistenceProbe
		random?: () => string
	} = {},
): Promise<UnitIdStartup> {
	const persistence = await stateDirPersistence(dir, deps.probe)
	if (persistence === "not-mount")
		return {
			persistence,
			result: {
				unitId: null,
				source: "unavailable",
				reason: "state-not-persistent",
			},
		}
	return {
		persistence,
		result: await loadOrCreateUnitId(dir, deps.fs, deps.random),
	}
}
