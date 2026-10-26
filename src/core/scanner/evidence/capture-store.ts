/**
 * <storage.dir>/captures: <id>.cu8, <id>.json (manifest v2 entry, exactly),
 * <id>.scanner.json (ScannerCapture extras). Atomic JSON writes (tmp + fsync +
 * rename, the BandOverrideStore pattern); oldest-first retention.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
} from "node:fs/promises"
import { join } from "node:path"
import type { ScannerCapture } from "@wavekit/api-types"
import { z } from "zod"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import type { Fixture } from "../../fixtures/manifest-schema.js"
import type { Assert, SchemaMatches } from "../../spectrum/types.js"
import { ScannerProtocolSchema } from "../store/schemas.js"

/** `cap_` + lower-case ULID; the only form a capture id reaching the filesystem may take. */
export const CAPTURE_ID = /^cap_[a-z0-9]+$/
const CAPTURE_FILE = /^(cap_[a-z0-9]+)\.(?:cu8|json)$/
const KEEP_RECENT_MS = 10_000
const SEAL_CHUNK_BYTES = 1024 * 1024

const ExtrasSchema = z.object({
	id: z.string().regex(CAPTURE_ID),
	createdAt: z.string().datetime(),
	jobId: z.string(),
	sourceId: z.string(),
	observationId: z.string(),
	discoveryId: z.string().nullable(),
	mode: z.enum(["wideband", "channel"]),
	role: z.enum(["channelizer-golden", "tail-golden"]),
	protocol: ScannerProtocolSchema,
	identity: z
		.object({
			kind: z.enum([
				"dmr-cc",
				"p25-nac",
				"nxdn-ran",
				"ysf-dgid",
				"dstar-call",
				"dpmr-cc",
				"pocsag-capcode",
				"aprs-call",
				"ism-model",
				"ais-mmsi",
				"acars-reg",
				"vdl2-addr",
				"lora-node",
				"icao",
			]),
			value: z.string(),
		})
		.optional(),
	decoded: z.boolean(),
	encrypted: z.boolean(),
	tuningTrust: z.enum(["commanded", "relay", "unverified"]),
	sampleRateHz: z.number().positive(),
	centreHz: z.number(),
	targetHz: z.number(),
	stream: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	startSample: z.number().int().nonnegative(),
	endSample: z.number().int().nonnegative(),
	preRollClippedMs: z.number().nonnegative(),
	postTruncated: z.boolean(),
	durationS: z.number().positive(),
	bytes: z.number().int().nonnegative(),
	files: z.object({ iq: z.string(), manifest: z.string() }),
})
export type CaptureExtrasCheck = Assert<
	SchemaMatches<ScannerCapture, typeof ExtrasSchema>
>

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.tmp`
	const handle = await open(tmp, "w")
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
		await handle.sync()
	} finally {
		await handle.close()
	}
	await rename(tmp, path)
}

export class CaptureStore {
	private readonly log: Logger
	private readonly index = new Map<string, ScannerCapture>()

	constructor(
		private readonly opts: { dir: string; logger: Logger; now: () => number },
	) {
		this.log = createComponentLogger(opts.logger, "CaptureStore")
	}

	/**
	 * Indexes the sidecars. Crash leftovers go: in-flight IQ (`.tmp/`), torn JSON writes
	 * (`*.tmp`) and capture files without a readable sidecar (never listed, never retained).
	 */
	async init(): Promise<void> {
		const tmpDir = join(this.opts.dir, ".tmp")
		// A non-directory `.tmp` makes mkdir fail; sweepStaging then refuses it (req 1.10).
		await mkdir(tmpDir, { recursive: true }).catch(() => undefined)
		await this.sweepStaging(tmpDir)
		const files = await readdir(this.opts.dir)
		for (const f of files) {
			if (!f.endsWith(".scanner.json")) continue
			const capture = await this.readExtras(join(this.opts.dir, f))
			if (capture && f === `${capture.id}.scanner.json`)
				this.index.set(capture.id, capture)
			else this.log.warn({ file: f }, "Ignoring an unreadable capture sidecar")
		}
		for (const f of files) {
			const id = CAPTURE_FILE.exec(f)?.[1]
			const torn = f !== ".tmp" && f.endsWith(".tmp")
			const orphan = id !== undefined && !this.index.has(id)
			if (!torn && !orphan) continue
			// WG10 req 1.10: only regular files are leftovers (the staging directory is not).
			const st = await lstat(join(this.opts.dir, f)).catch(() => null)
			if (!st?.isFile()) continue
			await rm(join(this.opts.dir, f), { force: true }).catch((err: unknown) =>
				this.log.warn({ err, file: f }, "Removing a capture leftover failed"),
			)
		}
	}

	/**
	 * WG10 req 1.10: unlinks the regular files left in the staging directory. A staging
	 * directory that is a symbolic link or not a directory is not swept; entries that are not
	 * regular files stay and are counted (no name in the log).
	 */
	private async sweepStaging(tmpDir: string): Promise<void> {
		const st = await lstat(tmpDir).catch(() => null)
		if (!st?.isDirectory()) {
			this.log.warn(
				"Capture staging directory is not a plain directory; not swept",
			)
			return
		}
		let left = 0
		for (const f of await readdir(tmpDir)) {
			const p = join(tmpDir, f)
			const e = await lstat(p).catch(() => null)
			if (!e) continue
			if (!e.isFile()) {
				left += 1
				continue
			}
			await unlink(p).catch(() => {
				left += 1
			})
		}
		if (left > 0)
			this.log.warn({ left }, "Capture staging entries that are not files left")
	}

	/** Once per capture open: staging may have been removed since startup. */
	ensureStaging(): void {
		mkdirSync(join(this.opts.dir, ".tmp"), { recursive: true })
	}

	tempPath(id: string): string {
		return join(this.opts.dir, ".tmp", `${id}.cu8`)
	}

	/**
	 * Cuts the finished temp IQ to `bytes`, fsyncs it and returns its sha256 (of what is on
	 * disk), so a committed sidecar never points at a short file after a power loss.
	 */
	async seal(id: string, bytes: number): Promise<string> {
		const handle = await open(this.tempPath(id), "r+")
		try {
			if ((await handle.stat()).size > bytes) await handle.truncate(bytes)
			const hash = createHash("sha256")
			const buf = Buffer.alloc(Math.min(SEAL_CHUNK_BYTES, Math.max(1, bytes)))
			for (let pos = 0; pos < bytes; ) {
				const { bytesRead } = await handle.read(
					buf,
					0,
					Math.min(buf.length, bytes - pos),
					pos,
				)
				if (bytesRead === 0)
					throw new WaveKitError(
						`Capture ${id} is shorter than ${bytes} bytes`,
						"SCANNER_CAPTURE_SHORT",
					)
				hash.update(buf.subarray(0, bytesRead))
				pos += bytesRead
			}
			await handle.sync()
			return hash.digest("hex")
		} finally {
			await handle.close()
		}
	}

	/** IQ first, then the manifest entry; the sidecar last, so an indexed capture is always complete. */
	async commit(entry: Fixture, extras: ScannerCapture): Promise<void> {
		const id = extras.id
		await rename(this.tempPath(id), join(this.opts.dir, `${id}.cu8`))
		await writeJsonAtomic(join(this.opts.dir, `${id}.json`), entry)
		await writeJsonAtomic(join(this.opts.dir, `${id}.scanner.json`), extras)
		this.index.set(id, extras)
	}

	/** Drops an uncommitted capture, including a partial commit. */
	async discard(id: string): Promise<void> {
		await rm(this.tempPath(id), { force: true })
		if (this.index.has(id)) return
		for (const suffix of [".cu8", ".json", ".json.tmp", ".scanner.json.tmp"])
			await rm(join(this.opts.dir, `${id}${suffix}`), { force: true })
	}

	list(): ScannerCapture[] {
		return [...this.index.values()].sort((a, b) =>
			b.createdAt.localeCompare(a.createdAt),
		)
	}

	countSince(jobId: string, sinceMs: number): number {
		let n = 0
		for (const c of this.index.values())
			if (c.jobId === jobId && Date.parse(c.createdAt) >= sinceMs) n += 1
		return n
	}

	path(id: string, kind: "cu8" | "json"): string | null {
		if (!CAPTURE_ID.test(id) || !this.index.has(id)) return null
		const p = join(this.opts.dir, `${id}.${kind}`)
		return existsSync(p) ? p : null
	}

	async delete(id: string): Promise<boolean> {
		if (!CAPTURE_ID.test(id) || !this.index.has(id)) return false
		this.index.delete(id)
		for (const suffix of [".cu8", ".json", ".scanner.json"])
			await rm(join(this.opts.dir, `${id}${suffix}`), { force: true })
		return true
	}

	/** Deletes oldest captures until the IQ total is ≤ maxBytes; never ones younger than 10 s. */
	async retention(maxBytes: number): Promise<string[]> {
		const now = this.opts.now()
		let total = [...this.index.values()].reduce((sum, c) => sum + c.bytes, 0)
		const deleted: string[] = []
		for (const c of [...this.index.values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		)) {
			if (total <= maxBytes) break
			if (now - Date.parse(c.createdAt) < KEEP_RECENT_MS) continue
			if (!(await this.delete(c.id))) continue
			total -= c.bytes
			deleted.push(c.id)
		}
		if (deleted.length > 0)
			this.log.info({ deleted: deleted.length }, "Capture retention ran")
		return deleted
	}

	private async readExtras(path: string): Promise<ScannerCapture | null> {
		try {
			const parsed = ExtrasSchema.safeParse(
				JSON.parse(await readFile(path, "utf8")),
			)
			if (!parsed.success) return null
			const { identity, ...rest } = parsed.data
			return identity ? { ...rest, identity } : rest
		} catch {
			return null
		}
	}
}
