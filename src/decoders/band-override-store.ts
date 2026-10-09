/**
 * Persisted API band overrides (band defaults spec §5.3).
 *
 * File `<stateDir>/decoder-band-overrides.json`:
 * `{ "version": 1, "overrides": { "<decoderId>": DecoderBandOverride } }`.
 * Every write serializes the whole in-memory map through a promise chain
 * (mkdir -p, write `<file>.<pid>.tmp`, fsync, rename). A broken or unwritable
 * file never stops the core: overrides then live in memory only and writes
 * report `persisted: false`.
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import type { DecoderBandOverride } from "@wavekit/api-types"
import { DecoderBandOverrideSchema } from "../config.js"
import { normalizeBandOverride } from "./band-defaults.js"
import { createComponentLogger, type Logger } from "../utils/logger.js"

export const BAND_OVERRIDE_FILE_NAME = "decoder-band-overrides.json"
const FILE_VERSION = 1

const VersionProbe = z.object({ version: z.unknown() }).passthrough()
const StateFileSchema = z.object({
	version: z.literal(FILE_VERSION),
	overrides: z.record(DecoderBandOverrideSchema),
})

export interface BandOverrideWriteResult {
	persisted: boolean
}

export interface BandOverrideStoreOptions {
	/** Directory holding the state file; omit for an in-memory store. */
	stateDir?: string | undefined
	logger: Logger
}

function errorCode(err: unknown): string | undefined {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

export class BandOverrideStore {
	private readonly log: Logger
	private readonly filePath: string | null
	private readonly overrides = new Map<string, DecoderBandOverride>()
	/** A newer core's file: read as empty and never overwritten. */
	private readOnly = false
	/** Whether the in-memory map matches the file. */
	private persistedState: boolean
	private writeChain: Promise<unknown> = Promise.resolve()

	constructor(options: BandOverrideStoreOptions) {
		this.log = createComponentLogger(options.logger, "BandOverrideStore")
		this.filePath =
			options.stateDir === undefined
				? null
				: join(resolve(options.stateDir), BAND_OVERRIDE_FILE_NAME)
		this.persistedState = this.filePath !== null
	}

	/** A store that never touches the disk (unit tests, no stateDir). */
	static inMemory(logger: Logger): BandOverrideStore {
		return new BandOverrideStore({ logger })
	}

	/** Path of the state file; null for an in-memory store. */
	getFilePath(): string | null {
		return this.filePath
	}

	/** false while the API layer lives only in memory. */
	isPersisted(): boolean {
		return this.persistedState
	}

	async load(): Promise<void> {
		this.overrides.clear()
		this.readOnly = false
		if (!this.filePath) return
		let text: string
		try {
			text = await readFile(this.filePath, "utf8")
		} catch (err) {
			if (errorCode(err) === "ENOENT") {
				this.log.debug(
					{ file: this.filePath },
					"No band override file; starting empty",
				)
				this.persistedState = true
				return
			}
			this.log.warn(
				{ err, file: this.filePath },
				"Band override file unreadable; starting empty",
			)
			this.persistedState = true
			return
		}
		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch (err) {
			this.log.warn(
				{ err, file: this.filePath },
				"Band override file is not valid JSON; starting empty",
			)
			this.persistedState = true
			return
		}
		const probe = VersionProbe.safeParse(raw)
		const version = probe.success ? probe.data["version"] : undefined
		if (version !== undefined && version !== FILE_VERSION) {
			this.readOnly = true
			this.persistedState = false
			this.log.warn(
				{ file: this.filePath, version },
				"Band override file has an unknown version; ignoring it and keeping API overrides in memory only",
			)
			return
		}
		const parsed = StateFileSchema.safeParse(raw)
		if (!parsed.success) {
			this.log.warn(
				{ file: this.filePath, issues: parsed.error.issues },
				"Band override file is invalid; starting empty",
			)
			this.persistedState = true
			return
		}
		for (const [id, override] of Object.entries(parsed.data.overrides))
			this.overrides.set(id, normalizeBandOverride(override))
		this.persistedState = true
		this.log.info(
			{ file: this.filePath, count: this.overrides.size },
			"Loaded band overrides",
		)
	}

	get(id: string): DecoderBandOverride | undefined {
		const override = this.overrides.get(id)
		return override ? normalizeBandOverride(override) : undefined
	}

	set(
		id: string,
		override: DecoderBandOverride,
	): Promise<BandOverrideWriteResult> {
		this.overrides.set(id, normalizeBandOverride(override))
		return this.persist()
	}

	delete(id: string): Promise<BandOverrideWriteResult> {
		this.overrides.delete(id)
		return this.persist()
	}

	/** Serializes the whole map; writes run one at a time, in call order. */
	private persist(): Promise<BandOverrideWriteResult> {
		const snapshot = {
			version: FILE_VERSION,
			overrides: Object.fromEntries(this.overrides),
		}
		const next = this.writeChain.then(() => this.write(snapshot))
		this.writeChain = next.catch(() => undefined)
		return next
	}

	private async write(snapshot: unknown): Promise<BandOverrideWriteResult> {
		const file = this.filePath
		if (!file || this.readOnly) {
			this.persistedState = false
			return { persisted: false }
		}
		const tmp = `${file}.${process.pid}.tmp`
		try {
			await mkdir(dirname(file), { recursive: true })
			const handle = await open(tmp, "w")
			try {
				await handle.writeFile(`${JSON.stringify(snapshot, null, "\t")}\n`)
				await handle.sync()
			} finally {
				await handle.close()
			}
			await rename(tmp, file)
			this.persistedState = true
			return { persisted: true }
		} catch (err) {
			this.log.warn(
				{ err, file },
				"Could not persist band overrides; applied in memory only",
			)
			await rm(tmp, { force: true }).catch(() => undefined)
			this.persistedState = false
			return { persisted: false }
		}
	}
}
