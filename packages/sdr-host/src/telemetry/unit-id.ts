/**
 * The sdr-host's stable unit id: 128 random bits as 32 lower-case hex, generated once and kept in
 * `<state dir>/unit-id.json`, so it survives process restarts and image updates (the state dir is
 * a host volume). A missing or malformed file gets a new id (written atomically: a temporary file
 * renamed over it). When the id cannot be written it is not reported at all (null): an id that
 * would change at the next start must never be taken for a stable one. `receiverId` (one running
 * process) is separate and unchanged.
 */
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const UNIT_ID_FILE_NAME = "unit-id.json"
/** The file holds one short JSON object; anything larger is malformed. */
export const UNIT_ID_FILE_MAX_BYTES = 1024
const UNIT_ID = /^[0-9a-f]{32}$/

export interface UnitIdFs {
	readFile(path: string): Promise<Buffer>
	writeFile(path: string, data: string): Promise<void>
	rename(from: string, to: string): Promise<void>
	mkdir(path: string): Promise<void>
}

const nodeFs: UnitIdFs = {
	readFile: path => readFile(path),
	writeFile: (path, data) => writeFile(path, data, { mode: 0o644 }),
	rename: (from, to) => rename(from, to),
	mkdir: async path => {
		await mkdir(path, { recursive: true })
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

export interface LoadUnitIdResult {
	/** The persisted id; null when it could not be persisted (then nothing is reported). */
	unitId: string | null
	/** What happened: read back, newly written, or not persisted. */
	source: "read" | "created" | "unavailable"
}

/** Reads the unit id from `dir`, or creates and persists one. Never throws. */
export async function loadOrCreateUnitId(
	dir: string,
	fs: UnitIdFs = nodeFs,
	random: () => string = () => randomBytes(16).toString("hex"),
): Promise<LoadUnitIdResult> {
	const path = join(dir, UNIT_ID_FILE_NAME)
	const existing = await fs.readFile(path).then(parseUnitIdFile, () => null)
	if (existing !== null) return { unitId: existing, source: "read" }
	const unitId = random()
	if (!isUnitId(unitId)) return { unitId: null, source: "unavailable" }
	const tmp = `${path}.${process.pid}.tmp`
	try {
		await fs.mkdir(dir)
		await fs.writeFile(tmp, `${JSON.stringify({ version: 1, unitId })}\n`)
		await fs.rename(tmp, path)
	} catch {
		return { unitId: null, source: "unavailable" }
	}
	return { unitId, source: "created" }
}
