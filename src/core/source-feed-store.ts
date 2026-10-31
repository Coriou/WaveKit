/**
 * Paused receiver feeds, persisted in `<stateDir>/source-feed.json` (tmp + fsync + rename, as
 * the band gain settings) so a pause survives a core restart: on boot a paused source registers
 * without connecting. Only the ids of paused sources are stored; a missing file means every
 * feed is live. An unreadable, oversized or invalid file is ignored with a warning (every feed
 * live, the safe default that matches a core without the file) and is replaced by the next write.
 */
import { join } from "node:path"
import { z } from "zod"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { readFileBounded } from "./band-gain.js"
import { atomicWrite } from "./scanner/store/atomic-write.js"

export const SOURCE_FEED_FILE_NAME = "source-feed.json"
const FILE_VERSION = 1
/** One core runs far fewer sources; past this the oldest pauses are not persisted (save reports false). */
export const SOURCE_FEED_MAX_SOURCES = 16
export const SOURCE_FEED_ID_MAX_LENGTH = 128
/**
 * 16 ids x (128 characters x up to 6 bytes JSON-escaped + quotes, comma and tab indentation)
 * is about 12.4 KiB; 16 KiB bounds the read before parse. A write is bounded by its serialised
 * bytes too: past the bound the oldest ids are dropped.
 */
export const SOURCE_FEED_FILE_MAX_BYTES = 16 * 1024

const FileSchema = z
	.object({
		version: z.literal(FILE_VERSION),
		paused: z
			.array(z.string().min(1).max(SOURCE_FEED_ID_MAX_LENGTH))
			.max(SOURCE_FEED_MAX_SOURCES),
	})
	.strict()

export interface SourceFeedFs {
	/** May reject with code "EFBIG" past `maxBytes`. */
	readFile: (path: string, maxBytes: number) => Promise<Buffer>
	atomicWrite: (path: string, data: string) => Promise<void>
}

/** What SourceManager needs to remember paused feeds across restarts. */
export interface SourceFeedPersistence {
	/** The paused source ids; never rejects (a bad file reads as none paused). */
	load(): Promise<ReadonlySet<string>>
	/** Persists `paused`; serialised, never rejects: false when the write failed or an id was dropped. */
	save(paused: ReadonlySet<string>): Promise<boolean>
}

export interface SourceFeedStoreOptions {
	stateDir: string
	logger: Logger
	fs?: SourceFeedFs
}

function errorCode(err: unknown): string {
	const code =
		typeof err === "object" && err !== null
			? (err as { code?: unknown }).code
			: undefined
	return typeof code === "string" && /^E[A-Z]{1,15}$/.test(code)
		? code
		: "unknown"
}

export class SourceFeedStore implements SourceFeedPersistence {
	private readonly log: Logger
	private readonly file: string
	private readonly fs: SourceFeedFs
	private chain: Promise<unknown> = Promise.resolve()

	constructor(options: SourceFeedStoreOptions) {
		this.log = createComponentLogger(options.logger, "SourceFeedStore")
		this.file = join(options.stateDir, SOURCE_FEED_FILE_NAME)
		this.fs = options.fs ?? {
			readFile: (path, maxBytes) => readFileBounded(path, maxBytes),
			atomicWrite: (path, data) => atomicWrite(path, data),
		}
	}

	async load(): Promise<ReadonlySet<string>> {
		let raw: Buffer
		try {
			raw = await this.fs.readFile(this.file, SOURCE_FEED_FILE_MAX_BYTES)
		} catch (err) {
			const code = errorCode(err)
			if (code === "EFBIG")
				this.log.warn(
					{ maxBytes: SOURCE_FEED_FILE_MAX_BYTES },
					"Paused feed file is too large; every feed is live",
				)
			else if (code !== "ENOENT")
				this.log.warn(
					{ code },
					"Reading the paused feed file failed; every feed is live",
				)
			return new Set()
		}
		if (raw.byteLength > SOURCE_FEED_FILE_MAX_BYTES) {
			this.log.warn(
				{ maxBytes: SOURCE_FEED_FILE_MAX_BYTES },
				"Paused feed file is too large; every feed is live",
			)
			return new Set()
		}
		let json: unknown
		try {
			json = JSON.parse(raw.toString("utf8"))
		} catch {
			this.log.warn("Paused feed file is not JSON; every feed is live")
			return new Set()
		}
		const parsed = FileSchema.safeParse(json)
		if (!parsed.success) {
			this.log.warn("Paused feed file is invalid; every feed is live")
			return new Set()
		}
		return new Set(parsed.data.paused)
	}

	save(paused: ReadonlySet<string>): Promise<boolean> {
		const ids = [...paused]
			.filter(id => id.length > 0 && id.length <= SOURCE_FEED_ID_MAX_LENGTH)
			.slice(-SOURCE_FEED_MAX_SOURCES)
		const serialise = () =>
			JSON.stringify({ version: FILE_VERSION, paused: ids }, null, "\t")
		let text = serialise()
		// One id serialises to under 1 KiB (128 characters x 6 bytes), so this always ends.
		while (
			Buffer.byteLength(text, "utf8") > SOURCE_FEED_FILE_MAX_BYTES &&
			ids.length > 0
		) {
			ids.shift()
			text = serialise()
		}
		// A dropped id is a pause that will not survive a restart: report the save as failed.
		const complete = ids.length === paused.size
		if (!complete)
			this.log.warn(
				{ kept: ids.length, paused: paused.size },
				"Paused feeds past the file bound; the oldest were not persisted",
			)
		const run = this.chain.then(() =>
			this.fs.atomicWrite(this.file, text).then(
				() => complete,
				(err: unknown) => {
					this.log.warn(
						{ code: errorCode(err) },
						"Writing the paused feed file failed",
					)
					return false
				},
			),
		)
		this.chain = run
		return run
	}
}
