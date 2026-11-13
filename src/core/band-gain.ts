/**
 * Runtime band gain settings: the YAML `tuner.bandGain` section, replaced as a whole by a
 * PUT /api/tuner-band-gain override persisted in `<stateDir>/tuner-band-gain.json` (tmp +
 * fsync + rename, as the scanner's settings.json). A change is kept in memory only after
 * it was written, so the next boot sees what the API answered. With "apply to my tuning",
 * the operator's gain from before a band is kept in `<stateDir>/tuner-band-gain-saved.json`.
 */
import { open } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
	BAND_GAIN_LABEL_MAX_LENGTH,
	BAND_GAIN_MAX_ENTRIES,
	BAND_GAIN_MAX_HZ,
	BAND_GAIN_MAX_TENTHS_DB,
	BAND_GAIN_MIN_HZ,
	BAND_GAIN_MIN_TENTHS_DB,
} from "@wavekit/api-types"
import type {
	BandGainEntry,
	BandGainSettings,
	BandGainSettingsView,
	BandGainValue,
	TunerGainMode,
} from "@wavekit/api-types"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import { atomicWrite } from "./scanner/store/atomic-write.js"
import { BandGainSettingsSchema, bandGainAt } from "./band-gain-schema.js"
import { isReceiverKey, RECEIVER_KEY_MAX_LENGTH } from "./receiver-identity.js"

export const BAND_GAIN_FILE_NAME = "tuner-band-gain.json"
const FILE_VERSION = 1
/**
 * 32 entries x about 110 bytes each (two 10-digit Hz values, a gain, a 48-char label, keys
 * and tab indentation) is about 3.5 KiB; 16 KiB leaves room and bounds the read before parse.
 */
export const BAND_GAIN_FILE_MAX_BYTES = 16 * 1024

const FileSchema = z
	.object({
		version: z.literal(FILE_VERSION),
		settings: BandGainSettingsSchema,
	})
	.strict()

export const BAND_GAIN_SAVED_FILE_NAME = "tuner-band-gain-saved.json"
/**
 * The saved gain records kept per receiver (each with `receiverKey`). A file of its own,
 * so BAND_GAIN_SAVED_FILE_NAME keeps the format older images read (their strict schema refuses
 * a `receiverKey`) and an image rolled back keeps its records. Same bounds as the legacy file.
 */
export const BAND_GAIN_SAVED_RECEIVERS_FILE_NAME =
	"tuner-band-gain-saved-receivers.json"
/**
 * Saved gain records per file: one per tuner source (legacy file) or per tuner source and
 * receiver (receivers file); 16 is far above the sources one core runs times the receivers each
 * reaches.
 */
export const BAND_GAIN_SAVED_MAX_SOURCES = 16
const SAVED_SOURCE_ID_MAX_LENGTH = 128
/**
 * 16 records x about 340 bytes each (a 128-char source id, a receiver key of at most 128
 * characters, the mode, a 3-digit gain, keys and tab indentation) is about 5.4 KiB; 8 KiB leaves
 * room and bounds the read before parse. Ids that JSON escapes take more, so a write is bounded
 * by its serialised bytes too.
 */
export const BAND_GAIN_SAVED_FILE_MAX_BYTES = 8 * 1024

/**
 * One saved pre-band gain: per source and per receiver key. A record without
 * `receiverKey` is from before receiver namespacing; the first receiver identified adopts it.
 */
export interface SavedOperatorGainRecord {
	sourceId: string
	receiverKey?: string
	saved: SavedOperatorGain | null
}

/** The operator's gain from before a band gain (null gain: an AGC gain that was unknown). */
export interface SavedOperatorGain {
	gainMode: TunerGainMode
	gain: number | null
}

const ReceiverKeySchema = z
	.string()
	.max(RECEIVER_KEY_MAX_LENGTH)
	.refine(v => isReceiverKey(v))
const savedFileSchema = <K extends z.ZodTypeAny>(receiverKey: K) =>
	z
		.object({
			version: z.literal(FILE_VERSION),
			sources: z
				.array(
					z
						.object({
							sourceId: z.string().min(1).max(SAVED_SOURCE_ID_MAX_LENGTH),
							receiverKey,
							// null: the gain was unknown when the band gain went on (nothing to restore).
							saved: z
								.object({
									gainMode: z.enum(["manual", "agc"]),
									gain: z
										.number()
										.int()
										.min(BAND_GAIN_MIN_TENTHS_DB)
										.max(BAND_GAIN_MAX_TENTHS_DB)
										.nullable(),
								})
								.strict()
								.nullable(),
						})
						.strict(),
				)
				.max(BAND_GAIN_SAVED_MAX_SOURCES),
		})
		.strict()
/**
 * The legacy file. Written without `receiverKey` (the older images' format); a keyed record in it
 * (written by a build before the receivers file) is still read, and moves to the receivers file
 * at the next write.
 */
const SavedFileSchema = savedFileSchema(ReceiverKeySchema.optional())
const SavedReceiversFileSchema = savedFileSchema(ReceiverKeySchema)

/** The read bound was exceeded: the file is never buffered past `maxBytes + 1` bytes. */
const TOO_LARGE = "EFBIG"

/**
 * Reads at most `maxBytes`: the size is checked on the open handle before reading, and one
 * byte past the bound is read to catch a file that grew since.
 */
export async function readFileBounded(
	path: string,
	maxBytes: number,
): Promise<Buffer> {
	const handle = await open(path, "r")
	try {
		const { size } = await handle.stat()
		if (size > maxBytes) throw new WaveKitError("File too large", TOO_LARGE)
		const buffer = Buffer.alloc(maxBytes + 1)
		let length = 0
		while (length < buffer.byteLength) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.byteLength - length,
				length,
			)
			if (bytesRead === 0) break
			length += bytesRead
		}
		if (length > maxBytes) throw new WaveKitError("File too large", TOO_LARGE)
		return buffer.subarray(0, length)
	} finally {
		await handle.close()
	}
}

/** An fs error code (or EFBIG), never anything else from the error. */
function errorCode(err: unknown): string {
	const code =
		typeof err === "object" && err !== null
			? (err as { code?: unknown }).code
			: undefined
	return typeof code === "string" && /^E[A-Z]{1,15}$/.test(code)
		? code
		: "unknown"
}

export class BandGainSettingsError extends WaveKitError {
	constructor(
		message: string,
		code: "BAND_GAIN_INVALID" | "BAND_GAIN_WRITE_FAILED",
		readonly statusCode: 400 | 500,
	) {
		super(message, code)
		this.name = "BandGainSettingsError"
	}
}

/** Zod output without explicit undefined labels (exactOptionalPropertyTypes). */
function normalise(
	parsed: z.infer<typeof BandGainSettingsSchema>,
): BandGainSettings {
	return {
		applyToMyTuning: parsed.applyToMyTuning,
		entries: parsed.entries.map(entry => {
			const out: BandGainEntry = {
				minHz: entry.minHz,
				maxHz: entry.maxHz,
				gain: entry.gain,
			}
			if (entry.label !== undefined) out.label = entry.label
			return out
		}),
	}
}

function freezeSettings(settings: BandGainSettings): BandGainSettings {
	for (const entry of settings.entries) Object.freeze(entry)
	Object.freeze(settings.entries)
	return Object.freeze(settings)
}

const EXPECTED =
	'expected {"applyToMyTuning": boolean, "entries": [{"minHz": integer Hz, "maxHz": integer Hz, "gain": integer tenths of a dB or "keep", "label"?: string}]}'

/**
 * A 400 message naming where the body failed and what is expected. Built from schema keys
 * and array indices only: no submitted value or unknown key is ever echoed.
 */
export function bandGainValidationMessage(err: z.ZodError): string {
	const known = new Set([
		"applyToMyTuning",
		"entries",
		"minHz",
		"maxHz",
		"gain",
		"label",
	])
	const where = err.issues.slice(0, 4).map(issue => {
		const path = issue.path
			.filter(p => typeof p === "number" || known.has(p))
			.join(".")
		const custom =
			issue.code === z.ZodIssueCode.custom ? `: ${issue.message}` : ""
		return `${path === "" ? "body" : path}${custom}`
	})
	return (
		`Invalid band gain settings at ${where.join(", ")}; ${EXPECTED}. ` +
		`Ranges are inclusive (${BAND_GAIN_MIN_HZ}-${BAND_GAIN_MAX_HZ} Hz), minHz < maxHz, ` +
		`no overlaps, at most ${BAND_GAIN_MAX_ENTRIES} entries, gain ` +
		`${BAND_GAIN_MIN_TENTHS_DB}-${BAND_GAIN_MAX_TENTHS_DB} tenths, label at most ` +
		`${BAND_GAIN_LABEL_MAX_LENGTH} printable characters`
	)
}

export interface BandGainFs {
	/** May reject with code "EFBIG" past `maxBytes` (the default never reads past it). */
	readFile: (path: string, maxBytes: number) => Promise<Buffer>
	atomicWrite: (path: string, data: string) => Promise<void>
}

export interface BandGainSettingsServiceOptions {
	stateDir: string
	/** The validated YAML section (re-validated here). */
	config: z.output<typeof BandGainSettingsSchema>
	logger: Logger
	fs?: BandGainFs
}

/** The settings both the controller (lookup) and the route (GET/PUT) use. */
export class BandGainSettingsService {
	private readonly log: Logger
	private readonly file: string
	private readonly fs: BandGainFs
	private readonly config: BandGainSettings
	private current: BandGainSettings
	private provenance: "config" | "runtime" = "config"
	private chain: Promise<unknown> = Promise.resolve()
	private readonly savedFile: string
	private readonly savedReceiversFile: string
	/** The receivers file may hold records (read or written non-empty): an empty set rewrites it. */
	private receiversOnDisk = false
	private saved: readonly SavedOperatorGainRecord[] = []
	private savedChain: Promise<void> = Promise.resolve()

	constructor(options: BandGainSettingsServiceOptions) {
		this.log = createComponentLogger(options.logger, "BandGainSettings")
		this.file = join(options.stateDir, BAND_GAIN_FILE_NAME)
		this.savedFile = join(options.stateDir, BAND_GAIN_SAVED_FILE_NAME)
		this.savedReceiversFile = join(
			options.stateDir,
			BAND_GAIN_SAVED_RECEIVERS_FILE_NAME,
		)
		this.fs = options.fs ?? {
			readFile: (path, maxBytes) => readFileBounded(path, maxBytes),
			atomicWrite: (path, data) => atomicWrite(path, data),
		}
		const parsed = BandGainSettingsSchema.safeParse(options.config)
		if (!parsed.success)
			throw new BandGainSettingsError(
				"Invalid tuner.bandGain configuration",
				"BAND_GAIN_INVALID",
				400,
			)
		this.config = freezeSettings(normalise(parsed.data))
		this.current = this.config
	}

	/**
	 * Loads the persisted override and the saved pre-band gains. A missing file keeps the
	 * config (no saved gains); an unreadable, oversized or invalid one is ignored with a
	 * warning and is replaced by the next write.
	 */
	async load(): Promise<void> {
		await this.loadSettings()
		await this.loadSavedGains()
	}

	/** The file's text, or null (missing, unreadable or oversized: logged, never buffered). */
	private async readBounded(
		path: string,
		maxBytes: number,
		what: string,
	): Promise<string | null> {
		let raw: Buffer
		try {
			raw = await this.fs.readFile(path, maxBytes)
		} catch (err) {
			const code = errorCode(err)
			if (code === TOO_LARGE)
				this.log.warn({ maxBytes }, `${what} file is too large; ignored`)
			else if (code !== "ENOENT")
				this.log.warn(
					{ code },
					`Reading the ${what.toLowerCase()} file failed; ignored`,
				)
			return null
		}
		if (raw.byteLength > maxBytes) {
			this.log.warn({ maxBytes }, `${what} file is too large; ignored`)
			return null
		}
		return raw.toString("utf8")
	}

	private async loadSettings(): Promise<void> {
		const text = await this.readBounded(
			this.file,
			BAND_GAIN_FILE_MAX_BYTES,
			"Band gain settings",
		)
		if (text === null) return
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			this.log.warn(
				"Band gain settings file is not JSON; using the configured table",
			)
			return
		}
		const parsed = FileSchema.safeParse(json)
		if (!parsed.success) {
			this.log.warn(
				"Band gain settings file is invalid; using the configured table",
			)
			return
		}
		this.current = freezeSettings(normalise(parsed.data.settings))
		this.provenance = "runtime"
		this.log.info(
			"Band gain settings saved through the API override tuner.bandGain in the config (PUT /api/tuner-band-gain replaces them)",
		)
	}

	private async loadSavedGains(): Promise<void> {
		const legacy = await this.readSavedFile(
			this.savedFile,
			SavedFileSchema,
			"Saved pre-band gain",
		)
		const receivers = await this.readSavedFile(
			this.savedReceiversFile,
			SavedReceiversFileSchema,
			"Saved per-receiver pre-band gain",
		)
		this.receiversOnDisk =
			receivers.length > 0 || legacy.some(r => r.receiverKey !== undefined)
		// A receiver's record in both (a build before the receivers file): the receivers file's wins.
		const keyed = new Set(receivers.map(r => `${r.sourceId}\n${r.receiverKey}`))
		this.saved = [
			...legacy.filter(
				r =>
					r.receiverKey === undefined ||
					!keyed.has(`${r.sourceId}\n${r.receiverKey}`),
			),
			...receivers,
		]
	}

	/** One saved gain file's records; missing, unreadable or invalid reads as none (logged). */
	private async readSavedFile(
		path: string,
		schema: typeof SavedFileSchema | typeof SavedReceiversFileSchema,
		what: string,
	): Promise<SavedOperatorGainRecord[]> {
		const text = await this.readBounded(
			path,
			BAND_GAIN_SAVED_FILE_MAX_BYTES,
			what,
		)
		if (text === null) return []
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			this.log.warn(`${what} file is not JSON; ignored`)
			return []
		}
		const parsed = schema.safeParse(json)
		if (!parsed.success) {
			this.log.warn(`${what} file is invalid; ignored`)
			return []
		}
		return parsed.data.sources.map(record => ({
			sourceId: record.sourceId,
			...(record.receiverKey !== undefined
				? { receiverKey: record.receiverKey }
				: {}),
			saved:
				record.saved === null
					? null
					: { gainMode: record.saved.gainMode, gain: record.saved.gain },
		}))
	}

	/** The pre-band gains saved before the last shutdown, one per source (records without a receiver). */
	savedOperatorGains(): ReadonlyMap<string, SavedOperatorGain | null> {
		return new Map(this.saved.map(r => [r.sourceId, r.saved] as const))
	}

	/** Every saved pre-band gain record, per source and receiver (read by the controller at wiring). */
	savedOperatorGainRecords(): readonly SavedOperatorGainRecord[] {
		return this.saved.map(r => ({ ...r }))
	}

	/** saveOperatorGainRecords with one record per source and no receiver key. */
	saveOperatorGains(
		gains: ReadonlyMap<string, SavedOperatorGain | null>,
		required?: string,
	): Promise<boolean> {
		return this.saveOperatorGainRecords(
			[...gains].map(([sourceId, saved]) => ({ sourceId, saved })),
			required,
		)
	}

	/**
	 * Persists the controller's saved pre-band gains (a copy, taken now): the records without a
	 * receiver in BAND_GAIN_SAVED_FILE_NAME (the legacy format), those with one in
	 * BAND_GAIN_SAVED_RECEIVERS_FILE_NAME. Serialised; never rejects: resolves false when a write
	 * failed (logged; the next change writes again) or when `required` (a source id, or a record
	 * test) was not among the records written. Past BAND_GAIN_SAVED_MAX_SOURCES, or past
	 * BAND_GAIN_SAVED_FILE_MAX_BYTES serialised (an id of escaped characters takes up to 6 bytes
	 * per character), the oldest records of a file are dropped, so each file always reads back
	 * within its bound.
	 */
	saveOperatorGainRecords(
		gains: readonly SavedOperatorGainRecord[],
		required?: string | ((record: SavedOperatorGainRecord) => boolean),
	): Promise<boolean> {
		const isRequired =
			typeof required === "function"
				? required
				: (r: SavedOperatorGainRecord) => r.sourceId === required
		const valid = gains.filter(
			r =>
				r.sourceId.length > 0 &&
				r.sourceId.length <= SAVED_SOURCE_ID_MAX_LENGTH &&
				(r.receiverKey === undefined || isReceiverKey(r.receiverKey)),
		)
		const legacy = this.boundSaved(
			valid.filter(r => r.receiverKey === undefined),
		)
		const receivers = this.boundSaved(
			valid.filter(r => r.receiverKey !== undefined),
		)
		const records = [...legacy.records, ...receivers.records]
		const write = (path: string, text: string) =>
			this.fs.atomicWrite(path, text).then(
				() => true,
				() => {
					this.log.warn("Writing the saved pre-band gain failed")
					return false
				},
			)
		const run = this.savedChain.then(async () => {
			const keyedDue = receivers.records.length > 0 || this.receiversOnDisk
			const keyed =
				!keyedDue || (await write(this.savedReceiversFile, receivers.text))
			if (keyedDue && keyed) this.receiversOnDisk = receivers.records.length > 0
			const plain = await write(this.savedFile, legacy.text)
			if (!keyed || !plain) return false
			this.saved = records
			return required === undefined || records.some(isRequired)
		})
		this.savedChain = run.then(() => undefined)
		return run
	}

	/** The newest records of one file within its count and byte bounds, and their text. */
	private boundSaved(gains: readonly SavedOperatorGainRecord[]): {
		records: SavedOperatorGainRecord[]
		text: string
	} {
		const records = gains.slice(-BAND_GAIN_SAVED_MAX_SOURCES).map(r => ({
			sourceId: r.sourceId,
			...(r.receiverKey !== undefined ? { receiverKey: r.receiverKey } : {}),
			saved: r.saved === null ? null : { ...r.saved },
		}))
		const serialise = () =>
			JSON.stringify({ version: FILE_VERSION, sources: records }, null, "\t")
		let text = serialise()
		let dropped = 0
		// One record serialises to under 1 KiB (128 ids x 6 bytes), so this always ends.
		while (
			Buffer.byteLength(text, "utf8") > BAND_GAIN_SAVED_FILE_MAX_BYTES &&
			records.length > 0
		) {
			records.shift()
			dropped += 1
			text = serialise()
		}
		if (dropped > 0)
			this.log.warn(
				{ dropped, maxBytes: BAND_GAIN_SAVED_FILE_MAX_BYTES },
				"Saved pre-band gains past the file size bound; the oldest were not persisted",
			)
		return { records, text }
	}

	settings(): BandGainSettings {
		return this.current
	}

	applyToMyTuning(): boolean {
		return this.current.applyToMyTuning
	}

	gainAt(hz: number): BandGainValue {
		return bandGainAt(this.current.entries, hz)
	}

	/** The label of the entry containing `hz`, if that entry has one. */
	labelAt(hz: number): string | undefined {
		if (!Number.isFinite(hz)) return undefined
		for (const entry of this.current.entries)
			if (hz >= entry.minHz && hz <= entry.maxHz) return entry.label
		return undefined
	}

	view(): BandGainSettingsView {
		return {
			settings: {
				applyToMyTuning: this.current.applyToMyTuning,
				entries: this.current.entries.map(entry => ({ ...entry })),
			},
			provenance: this.provenance,
			limits: {
				maxEntries: BAND_GAIN_MAX_ENTRIES,
				minHz: BAND_GAIN_MIN_HZ,
				maxHz: BAND_GAIN_MAX_HZ,
				minGainTenthsDb: BAND_GAIN_MIN_TENTHS_DB,
				maxGainTenthsDb: BAND_GAIN_MAX_TENTHS_DB,
				labelMaxLength: BAND_GAIN_LABEL_MAX_LENGTH,
			},
		}
	}

	/**
	 * Validates and persists a whole replacement, then applies it. Serialised; a failed
	 * write leaves the previous settings in force (and the file as it was).
	 */
	put(body: unknown): Promise<BandGainSettingsView> {
		const parsed = BandGainSettingsSchema.safeParse(body)
		if (!parsed.success)
			return Promise.reject(
				new BandGainSettingsError(
					bandGainValidationMessage(parsed.error),
					"BAND_GAIN_INVALID",
					400,
				),
			)
		const next = freezeSettings(normalise(parsed.data))
		const run = this.chain.then(async () => {
			const text = JSON.stringify(
				{ version: FILE_VERSION, settings: next },
				null,
				"\t",
			)
			try {
				await this.fs.atomicWrite(this.file, text)
			} catch {
				this.log.warn("Writing the band gain settings failed; not applied")
				throw new BandGainSettingsError(
					"Saving the band gain settings failed",
					"BAND_GAIN_WRITE_FAILED",
					500,
				)
			}
			this.current = next
			this.provenance = "runtime"
			return this.view()
		})
		this.chain = run.catch(() => undefined)
		return run
	}
}
