/**
 * WG4 lane ST: the persisted UI layer `<stateDir>/station.json` (requirement 6.4, 6.7).
 */
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { StationField } from "@wavekit/api-types"
import { STATION_FIELDS } from "@wavekit/api-types"
import { StationConfigSchema } from "../../config.js"
import type { Logger } from "../../utils/logger.js"
import {
	STATION_STORE_CORRUPT_KEEP,
	STATION_STORE_FILE,
	STATION_STORE_MAX_BYTES,
	STATION_STORE_SCHEMA_VERSION,
} from "./contract.js"
import type { StationStoreFile, StationStoredValue } from "./contract.js"
import type { StationFieldValue, StationLayerValues } from "./layers.js"

export interface StationStoreState {
	revision: number
	fields: Partial<Record<StationField, StationStoredValue>>
}

const CORRUPT_PREFIX = `${STATION_STORE_FILE}.corrupt-`

/** The write path's temporary file: `station.json.<pid>.tmp`. */
const TMP_PATTERN = /^station\.json\.\d+\.tmp$/

/** Leftover temporary files removed per open (a crash leaves at most one per pid). */
export const STATION_STORE_TMP_SWEEP_MAX = 16

/**
 * The revision a fresh layer starts at after a corrupt or unreadable file: above any
 * revision the lost file can have held, so a stale `If-Match` cannot match again. The clock
 * (ms) is above every revision reachable by one write per ms; a still-readable `revision`
 * in the lost file raises it further.
 */
function seedRevision(now: number, bytes: Buffer | null): number {
	let seed = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0
	if (bytes !== null) {
		try {
			const raw: unknown = JSON.parse(bytes.toString("utf8"))
			const previous =
				typeof raw === "object" && raw !== null && "revision" in raw
					? raw.revision
					: undefined
			if (typeof previous === "number" && Number.isFinite(previous))
				seed = Math.max(seed, Math.floor(previous) + 1)
		} catch {
			// Not JSON: the clock seed stands.
		}
	}
	return Math.min(seed, Number.MAX_SAFE_INTEGER)
}

/** Removes `station.json.<pid>.tmp` files a crash left behind (bounded, best effort). */
async function sweepTmp(stateDir: string, log: Logger): Promise<void> {
	let entries: string[]
	try {
		entries = await readdir(stateDir)
	} catch {
		return
	}
	const stale = entries
		.filter(name => TMP_PATTERN.test(name))
		.slice(0, STATION_STORE_TMP_SWEEP_MAX)
	for (const name of stale) {
		await unlink(join(stateDir, name)).catch((error: unknown) => {
			log.debug(
				{ err: error, name },
				"Could not remove a stale station tmp file",
			)
		})
	}
}

const FileSchema = z
	.object({
		schemaVersion: z.number(),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		fields: z.record(z.string(), z.unknown()),
	})
	.strict()

const StoredValueSchema = z
	.object({
		value: z.union([z.string(), z.number()]),
		provenance: z.literal("ui"),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict()

/** Validates one value as the YAML `station` block would; returns the normalised value. */
export function validateStationValue(
	field: StationField,
	value: unknown,
): StationFieldValue | null {
	const result = StationConfigSchema.shape[field].safeParse(value)
	if (!result.success || result.data === undefined) return null
	// JSON cannot carry -0; normalise so a value round-trips through the file.
	return typeof result.data === "number" ? result.data + 0 : result.data
}

export function storeValues(state: StationStoreState): StationLayerValues {
	const out: StationLayerValues = {}
	for (const field of STATION_FIELDS) {
		const stored = state.fields[field]
		if (stored !== undefined) out[field] = stored.value
	}
	return out
}

class CorruptStore extends Error {}

function parseStore(bytes: Buffer): StationStoreState {
	let raw: unknown
	try {
		raw = JSON.parse(bytes.toString("utf8"))
	} catch {
		throw new CorruptStore("not JSON")
	}
	const parsed = FileSchema.safeParse(raw)
	if (!parsed.success) throw new CorruptStore("schema mismatch")
	if (parsed.data.schemaVersion !== STATION_STORE_SCHEMA_VERSION) {
		throw new CorruptStore(`schemaVersion ${parsed.data.schemaVersion}`)
	}
	const fields: Partial<Record<StationField, StationStoredValue>> = {}
	for (const field of STATION_FIELDS) {
		if (!Object.hasOwn(parsed.data.fields, field)) continue
		const entry = StoredValueSchema.safeParse(parsed.data.fields[field])
		if (!entry.success) continue
		const value = validateStationValue(field, entry.data.value)
		if (value === null) continue
		fields[field] = { ...entry.data, value }
	}
	// A stored half pair is ignored.
	if ((fields.lat === undefined) !== (fields.lon === undefined)) {
		delete fields.lat
		delete fields.lon
	}
	return { revision: parsed.data.revision, fields }
}

/** Parses file bytes; null when the file is corrupt, oversized or of another version. */
export function parseStationStore(bytes: Uint8Array): StationStoreState | null {
	if (bytes.length > STATION_STORE_MAX_BYTES) return null
	try {
		return parseStore(Buffer.from(bytes))
	} catch {
		return null
	}
}

async function readBounded(path: string): Promise<Buffer | null | "oversized"> {
	let handle
	try {
		handle = await open(path, "r")
	} catch (error: unknown) {
		// No file can exist there: a missing file or a path through a non-directory.
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "ENOTDIR") return null
		throw error
	}
	try {
		const stat = await handle.stat()
		if (stat.size > STATION_STORE_MAX_BYTES) return "oversized"
		const buffer = Buffer.alloc(STATION_STORE_MAX_BYTES + 1)
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
			if (length > STATION_STORE_MAX_BYTES) return "oversized"
		}
		return buffer.subarray(0, length)
	} finally {
		await handle.close()
	}
}

async function quarantine(
	stateDir: string,
	now: number,
	log: Logger,
): Promise<void> {
	try {
		const entries = await readdir(stateDir)
		const old = entries.filter(name => name.startsWith(CORRUPT_PREFIX)).sort()
		// Keep STATION_STORE_CORRUPT_KEEP copies including the one about to be made.
		const remove = old.slice(
			0,
			Math.max(0, old.length - (STATION_STORE_CORRUPT_KEEP - 1)),
		)
		for (const name of remove) {
			await unlink(join(stateDir, name)).catch(() => undefined)
		}
		await rename(
			join(stateDir, STATION_STORE_FILE),
			join(stateDir, `${CORRUPT_PREFIX}${now}`),
		)
	} catch (error: unknown) {
		log.warn({ err: error }, "Could not move the corrupt station store aside")
	}
}

/**
 * Loads the UI layer. Missing is empty; corrupt, oversized or wrong-version is warned once,
 * moved to `station.json.corrupt-<ms>` and loads empty with a seeded revision (as does an
 * unreadable file). Stale temporary files of the write path are removed first. Never throws.
 */
export async function loadStationStore(
	stateDir: string,
	log: Logger,
	now: () => number = Date.now,
): Promise<StationStoreState> {
	const path = join(stateDir, STATION_STORE_FILE)
	await sweepTmp(stateDir, log)
	let bytes: Buffer | null | "oversized"
	try {
		bytes = await readBounded(path)
	} catch (error: unknown) {
		log.warn(
			{ err: error },
			"Station store unreadable; using an empty UI layer",
		)
		return { revision: seedRevision(now(), null), fields: {} }
	}
	if (bytes === null) return { revision: 0, fields: {} }
	let reason: string
	if (bytes === "oversized") {
		reason = `larger than ${STATION_STORE_MAX_BYTES} bytes`
	} else {
		try {
			return parseStore(bytes)
		} catch (error: unknown) {
			reason = error instanceof Error ? error.message : "invalid"
		}
	}
	log.warn(
		{ reason },
		"Station store is corrupt; ignoring it and starting empty",
	)
	const at = now()
	await quarantine(stateDir, at, log)
	return {
		revision: seedRevision(at, bytes === "oversized" ? null : bytes),
		fields: {},
	}
}

export function serializeStationStore(state: StationStoreState): string {
	const fields: StationStoreFile["fields"] = {}
	for (const field of STATION_FIELDS) {
		const stored = state.fields[field]
		if (stored !== undefined) fields[field] = stored
	}
	const file: StationStoreFile = {
		schemaVersion: STATION_STORE_SCHEMA_VERSION,
		revision: state.revision,
		fields,
	}
	return `${JSON.stringify(file, null, "\t")}\n`
}

/** Atomically persists the UI layer: mkdir -p, tmp, fsync, rename, best-effort dir fsync. */
export async function writeStationStore(
	stateDir: string,
	state: StationStoreState,
): Promise<void> {
	const body = serializeStationStore(state)
	if (Buffer.byteLength(body) > STATION_STORE_MAX_BYTES) {
		throw new RangeError("station store exceeds its size bound")
	}
	await mkdir(stateDir, { recursive: true })
	const tmp = join(stateDir, `${STATION_STORE_FILE}.${process.pid}.tmp`)
	try {
		const handle = await open(tmp, "w", 0o644)
		try {
			await handle.writeFile(body, "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(tmp, join(stateDir, STATION_STORE_FILE))
	} catch (error: unknown) {
		await unlink(tmp).catch(() => undefined)
		throw error
	}
	try {
		const dir = await open(stateDir, "r")
		try {
			await dir.sync()
		} finally {
			await dir.close()
		}
	} catch {
		// Directory fsync is best effort (unsupported on some platforms).
	}
}
