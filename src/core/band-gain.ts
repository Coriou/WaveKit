/**
 * Runtime band gain settings: the YAML `tuner.bandGain` section, replaced as a whole by a
 * PUT /api/tuner-band-gain override persisted in `<stateDir>/tuner-band-gain.json` (tmp +
 * fsync + rename, as the scanner's settings.json). A change is kept in memory only after
 * it was written, so the next boot sees what the API answered.
 */
import { readFile } from "node:fs/promises"
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
	readFile: (path: string) => Promise<Buffer>
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

	constructor(options: BandGainSettingsServiceOptions) {
		this.log = createComponentLogger(options.logger, "BandGainSettings")
		this.file = join(options.stateDir, BAND_GAIN_FILE_NAME)
		this.fs = options.fs ?? {
			readFile: path => readFile(path),
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
	 * Loads the persisted override. A missing file keeps the config; an unreadable,
	 * oversized or invalid one is ignored with a warning (the config applies) and is
	 * replaced by the next PUT.
	 */
	async load(): Promise<void> {
		let raw: Buffer
		try {
			raw = await this.fs.readFile(this.file)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT")
				this.log.warn(
					{ code: (err as NodeJS.ErrnoException).code ?? "unknown" },
					"Reading the band gain settings failed; using the configured table",
				)
			return
		}
		if (raw.byteLength > BAND_GAIN_FILE_MAX_BYTES) {
			this.log.warn(
				{ bytes: raw.byteLength, maxBytes: BAND_GAIN_FILE_MAX_BYTES },
				"Band gain settings file is too large; using the configured table",
			)
			return
		}
		let json: unknown
		try {
			json = JSON.parse(raw.toString("utf8"))
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
