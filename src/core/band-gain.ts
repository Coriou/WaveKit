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
/** One saved gain per tuner source; 16 is far above the sources one core runs. */
export const BAND_GAIN_SAVED_MAX_SOURCES = 16
const SAVED_SOURCE_ID_MAX_LENGTH = 128
/**
 * 16 records x about 190 bytes each (a 128-char source id, the mode, a 3-digit gain, keys
 * and tab indentation) is about 3 KiB; 8 KiB leaves room and bounds the read before parse.
 */
export const BAND_GAIN_SAVED_FILE_MAX_BYTES = 8 * 1024

/** The operator's gain from before a band gain (null gain: an AGC gain that was unknown). */
export interface SavedOperatorGain {
	gainMode: TunerGainMode
	gain: number | null
}

const SavedFileSchema = z
	.object({
		version: z.literal(FILE_VERSION),
		sources: z
			.array(
				z
					.object({
						sourceId: z.string().min(1).max(SAVED_SOURCE_ID_MAX_LENGTH),
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
	private saved: ReadonlyMap<string, SavedOperatorGain | null> = new Map()
	private savedChain: Promise<void> = Promise.resolve()

	constructor(options: BandGainSettingsServiceOptions) {
		this.log = createComponentLogger(options.logger, "BandGainSettings")
		this.file = join(options.stateDir, BAND_GAIN_FILE_NAME)
		this.savedFile = join(options.stateDir, BAND_GAIN_SAVED_FILE_NAME)
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
		const text = await this.readBounded(
			this.savedFile,
			BAND_GAIN_SAVED_FILE_MAX_BYTES,
			"Saved pre-band gain",
		)
		if (text === null) return
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			this.log.warn("Saved pre-band gain file is not JSON; ignored")
			return
		}
		const parsed = SavedFileSchema.safeParse(json)
		if (!parsed.success) {
			this.log.warn("Saved pre-band gain file is invalid; ignored")
			return
		}
		const saved = new Map<string, SavedOperatorGain | null>()
		for (const record of parsed.data.sources)
			saved.set(
				record.sourceId,
				record.saved === null
					? null
					: { gainMode: record.saved.gainMode, gain: record.saved.gain },
			)
		this.saved = saved
	}

	/** The pre-band gains saved before the last shutdown (read by the controller at wiring). */
	savedOperatorGains(): ReadonlyMap<string, SavedOperatorGain | null> {
		return this.saved
	}

	/**
	 * Persists the controller's saved pre-band gains (a copy, taken now). Serialised; never
	 * rejects: a failed write is logged and the next change writes again. Past
	 * BAND_GAIN_SAVED_MAX_SOURCES the oldest records are dropped.
	 */
	saveOperatorGains(
		gains: ReadonlyMap<string, SavedOperatorGain | null>,
	): Promise<void> {
		const records = [...gains]
			.filter(([sourceId]) => sourceId.length <= SAVED_SOURCE_ID_MAX_LENGTH)
			.slice(-BAND_GAIN_SAVED_MAX_SOURCES)
			.map(([sourceId, saved]) => ({
				sourceId,
				saved: saved === null ? null : { ...saved },
			}))
		this.saved = new Map(records.map(r => [r.sourceId, r.saved] as const))
		const text = JSON.stringify(
			{ version: FILE_VERSION, sources: records },
			null,
			"\t",
		)
		const run = this.savedChain.then(() =>
			this.fs.atomicWrite(this.savedFile, text).catch(() => {
				this.log.warn("Writing the saved pre-band gain failed")
			}),
		)
		this.savedChain = run
		return run
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
