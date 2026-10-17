/**
 * Evidence store (spec § 6.5 Recording, § 8): probe recordings, PSD and IQ evidence, retention.
 *
 * Layout under the scanner storage dir: `recordings/dv/<discoveryId>/*.wav` (dsd-fme per-call WAVs
 * moved in from a probe's `recordings/dv/probe-<probeId>/`), `recordings/analog/<discoveryId>/`
 * (post-channelizer), `evidence/<discoveryId>/psd.json` and `iq-<ms>.cu8` (+ `.json` metadata).
 * Retention deletes expired files first, then the oldest per category until under its cap; files
 * from the last 10 s and files of `keep` discoveries are never deleted. Writes stop while free disk
 * is below `minFreeDiskMb`.
 */
import {
	constants as fsConstants,
	existsSync,
	lstatSync,
	realpathSync,
} from "node:fs"
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	statfs,
	unlink,
} from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { z } from "zod"
import { SCANNER_DISCOVERY_HOLDS_KEPT_CODE } from "@wavekit/api-types"
import type { RecordingProtection } from "../../recordings/contract.js"
import { RecordingKeepError } from "../../recordings/contract.js"
import {
	RECORDING_BUSY_TEXT,
	RECORDING_DELETE_UNSUPPORTED_TEXT,
	verifiedUnlink,
} from "../../recordings/verified-unlink.js"
import type { RecordingDeleteFs } from "../../recordings/verified-unlink.js"
import { RECORDING_IN_PROGRESS_MS } from "../../../decoders/builtin/call-recordings.js"
import { ScannerApiError } from "../errors.js"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger } from "../../../utils/logger.js"
import type { Logger } from "../../../utils/logger.js"
import { atomicWrite } from "./persistence.js"
import { holdsKeptWithAliases, withAliasFolders } from "../recording-aliases.js"
import type { DiscoveryAliasLookup } from "../recording-aliases.js"
import {
	AnalogOperations,
	type AnalogHandle,
	type AnalogInput,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogReconciliation,
} from "./analog-operations.js"

export interface StorageCaps {
	maxRecordingsMb: number
	maxEvidenceMb: number
	maxAgeDays: number
	minFreeDiskMb: number
}

/** `${discoveryId}~${fileName}`; the file lives in recordings/{dv,analog}/<discoveryId>/. */
export const RECORDING_ID = /^(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]+\.wav)$/
export const DISCOVERY_ID = /^d_[0-9A-Za-z]+$/
/** `recordings/dv/probe-<probeId>/`: a live probe's recording folder (probes are never persisted). */
const PROBE_DIR = /^probe-[0-9A-Za-z._-]+$/
const EVIDENCE_NAME = /^(?:psd\.json|iq-\d+\.(?:cu8|json))$/
/** dsd-fme close_and_rename_wav_file (call-recordings.ts, dsd-fme.ts searchForWavFile). */
const CALL_WAV =
	/^(\d{8})_(\d{6})_\d{5}_.+_(?:GROUP|PRIVATE|UNIT)_TGT_([^_]+)_SRC_([^_.]+)\.wav$/
/** dsd-fme open_wav_file, left behind when the call is cut. */
const TEMP_WAV = /^TEMP_(\d{8})_(\d{6})_[0-9A-F]{4}\.wav$/
const RECORDING_KINDS = ["dv", "analog"] as const
const MATCH_SLACK_MS = 2_000
const MIB = 1024 * 1024
const DAY_MS = 86_400_000

export interface LinkCandidate {
	observationId: string
	discoveryId: string
	talkgroup?: string
	source?: string
	startedAt: number
	endedAt: number
	encrypted: boolean
}

interface StoredFile {
	path: string
	rel: string
	category: "recordings" | "evidence"
	/** The discovery folder, or the `probe-*` folder for a probe's not-yet-linked files. */
	discoveryId: string
	/** In a live probe's folder: counted against the cap, never deleted (linking moves or drops it). */
	probe: boolean
	bytes: number
	mtimeMs: number
	/** WG9 req 2.5 (protection port only): each directory `collect()` walked to the file, with its lstat identity. */
	chain?: DirIdentity[]
}

interface DirIdentity {
	path: string
	dev: number
	ino: number
}

/** WG9 req 2.5: true when every directory in the chain is still the real one first listed. */
async function chainIntact(chain: readonly DirIdentity[]): Promise<boolean> {
	for (const d of chain) {
		const now = await realDirectory(d.path)
		if (now === null || now.dev !== d.dev || now.ino !== d.ino) return false
	}
	return true
}

const PsdFileSchema = z.object({ snrDb: z.number() }).passthrough()

/** dsd-fme stamps are local time (dsd-fme.ts parseFilenameTimestamp). */
function localStampMs(date: string, time: string): number | null {
	const d = /^(\d{4})(\d{2})(\d{2})$/.exec(date)
	const t = /^(\d{2})(\d{2})(\d{2})$/.exec(time)
	if (d === null || t === null) return null
	const ms = new Date(
		Number(d[1]),
		Number(d[2]) - 1,
		Number(d[3]),
		Number(t[1]),
		Number(t[2]),
		Number(t[3]),
	).getTime()
	return Number.isFinite(ms) ? ms : null
}

/** Candidates whose TG/SRC and time window match, nearest `startedAt` first (stable for ties). */
function matchingCandidates(
	candidates: readonly LinkCandidate[],
	at: number,
	tg?: string,
	src?: string,
): LinkCandidate[] {
	return candidates
		.filter(
			c =>
				at >= c.startedAt - MATCH_SLACK_MS &&
				at <= c.endedAt + MATCH_SLACK_MS &&
				(tg === undefined || c.talkgroup === undefined || c.talkgroup === tg) &&
				(src === undefined || c.source === undefined || c.source === src),
		)
		.sort((a, b) => Math.abs(at - a.startedAt) - Math.abs(at - b.startedAt))
}

function errorCode(err: unknown): string | undefined {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir)
	} catch (err) {
		if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return []
		throw err
	}
}

/**
 * WG9 req 2.5 (protection port only): the lstat identity of a real directory, or null when
 * the path is missing, a symlink or not a directory. Retention and guarded removal never
 * descend through an alias, so a protection answer always names the file it unlinks.
 */
async function realDirectory(
	path: string,
): Promise<{ dev: number; ino: number } | null> {
	try {
		const info = await lstat(path)
		return info.isDirectory() && !info.isSymbolicLink()
			? { dev: info.dev, ino: info.ino }
			: null
	} catch (err) {
		if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return null
		throw err
	}
}

/**
 * WG9 R2: the configured storage root when it is itself a symlink, resolved by realpath once
 * at construction (operator config is trusted): its real directory and identity. Null when
 * the root is missing, a real directory or a dangling link, which keeps today's behaviour.
 */
function pinStorageRoot(
	abs: string,
): { real: string; dev: number; ino: number } | null {
	try {
		if (!lstatSync(abs).isSymbolicLink()) return null
		const real = realpathSync(abs)
		const info = lstatSync(real)
		if (info.isSymbolicLink() || !info.isDirectory()) return null
		return { real, dev: info.dev, ino: info.ino }
	} catch {
		return null
	}
}

/** `<dir>`, `<dir>/WAV`, `<dir>/wav` (as `findWavFileAsync`), deduplicated by real path; missing ones are skipped. */
async function wavDirs(dir: string): Promise<string[]> {
	const seen = new Set<string>()
	const out: string[] = []
	for (const d of [dir, join(dir, "WAV"), join(dir, "wav")]) {
		let real: string
		try {
			real = await realpath(d)
		} catch (err) {
			if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") continue
			throw err
		}
		if (seen.has(real)) continue
		seen.add(real)
		out.push(d)
	}
	return out
}

async function moveFile(from: string, to: string): Promise<void> {
	try {
		await rename(from, to)
	} catch (err) {
		if (errorCode(err) !== "EXDEV") throw err
		await copyFile(from, to)
		await rm(from, { force: true })
	}
}

function assertDiscoveryId(id: string): void {
	if (!DISCOVERY_ID.test(id))
		throw new WaveKitError(`Invalid discovery id: ${id}`, "SCANNER_INVALID_ID")
}

async function defaultStatfs(p: string): Promise<{ freeBytes: number }> {
	const s = await statfs(p)
	return { freeBytes: s.bavail * s.bsize }
}

export class EvidenceStore {
	private readonly root: string
	private readonly log: Logger
	private readonly now: () => number
	private readonly statfs: (p: string) => Promise<{ freeBytes: number }>
	private caps: StorageCaps
	/** Per-discovery tail of pending evidence writes (`serialise`); never rejects. */
	private readonly writeChains = new Map<string, Promise<void>>()
	/** Only in-flight removals are retained; the discovery store supplies lasting authority. */
	private readonly removals = new Map<string, Promise<void>>()
	private readonly isDiscoveryLive: (id: string) => boolean
	private analog: AnalogOperations | null = null
	private readonly analogIo: AnalogOperationIo | undefined
	/** WG9 req 2.5: the deletion decision; absent keeps today's behaviour. */
	private readonly protection: RecordingProtection | undefined
	private readonly keepLog: Logger
	/** WG9 R2: the identity of a symlinked configured root's real directory; null otherwise. */
	private readonly rootPin: { dev: number; ino: number } | null
	/** WG10 req 1.1: test seam of the scanner delete's verified unlink. */
	private readonly recordingDeleteFs: RecordingDeleteFs | undefined
	/** WG10 req 1.5: merge aliases (none without the lookup). */
	private readonly aliases: DiscoveryAliasLookup | undefined

	constructor(opts: {
		dir: string
		caps: StorageCaps
		logger: Logger
		now: () => number
		statfs?: (p: string) => Promise<{ freeBytes: number }>
		/** Required by production producers; standalone stores may own admission themselves. */
		isDiscoveryLive?: (id: string) => boolean
		analogIo?: AnalogOperationIo
		/** WG9 req 2.5: kept recordings survive retention and block discovery removal. */
		protection?: RecordingProtection
		/** WG10 req 1.1: test seam of the scanner delete's verified unlink. */
		recordingDeleteFs?: RecordingDeleteFs
		/** WG10 req 1.5: the discovery store's merge aliases. */
		aliases?: DiscoveryAliasLookup
	}) {
		// WG9 R2: a symlinked configured root is followed once; its real directory is the base,
		// so symlinks below it stay refused and a later re-pointed link has no effect.
		const configured = resolve(opts.dir)
		const pin = pinStorageRoot(configured)
		this.root = pin?.real ?? configured
		this.rootPin = pin === null ? null : { dev: pin.dev, ino: pin.ino }
		this.caps = { ...opts.caps }
		this.log = createComponentLogger(opts.logger, "EvidenceStore")
		this.keepLog = createComponentLogger(opts.logger, "RecordingKeeps")
		this.now = opts.now
		this.statfs = opts.statfs ?? defaultStatfs
		this.isDiscoveryLive = opts.isDiscoveryLive ?? (() => true)
		this.analogIo = opts.analogIo
		this.protection = opts.protection
		this.recordingDeleteFs = opts.recordingDeleteFs
		this.aliases = opts.aliases
	}

	/** WG10 req 1.5: fail closed (a throwing lookup answers no owner / no aliases). */
	private aliasOwner(id: string): string | undefined {
		try {
			return this.aliases?.aliasOwner(id)
		} catch {
			return undefined
		}
	}
	private readonly aliasesOf = (id: string): readonly string[] =>
		this.aliases?.aliasesOf(id) ?? []

	/**
	 * WG9 R2 (pinned root only): true while the real root is still the directory first resolved.
	 * A changed identity refuses every deleter (fail closed) and logs a count.
	 */
	private async rootIntact(): Promise<boolean> {
		const pin = this.rootPin
		if (pin === null) return true
		const now = await realDirectory(this.root).catch(() => null)
		if (now !== null && now.dev === pin.dev && now.ino === pin.ino) return true
		this.log.warn(
			{ rootChanged: 1 },
			"Scanner storage root changed; deletion refused",
		)
		return false
	}

	/** Fail closed: a throwing port answers protected. WG10 req 1.5: any alias holding counts. */
	private holdsKept(discoveryId: string): boolean {
		if (!this.protection) return false
		return holdsKeptWithAliases(this.protection, this.aliasesOf, discoveryId)
	}

	private keptFile(f: StoredFile): boolean {
		if (!this.protection || f.category !== "recordings" || f.probe) return false
		try {
			return (
				this.protection.isScannerFileProtected(
					f.discoveryId,
					f.path.split("/").at(-1) ?? "",
				) !== false
			)
		} catch {
			return true
		}
	}

	configureAnalog(adapter: AnalogMetadataAdapter): void {
		if (this.analog)
			throw new WaveKitError(
				"Analog adapter already configured",
				"SCANNER_ANALOG_ADMISSION_DENIED",
			)
		this.analog = new AnalogOperations({
			root: this.root,
			adapter,
			admits: id => this.admits(id),
			serialise: (id, job) => this.serialise(id, job),
			legacyBytes: async () =>
				(await this.collect())
					.filter(file => file.category === "recordings")
					.reduce((sum, file) => sum + file.bytes, 0),
			limits: () => ({
				maxBytes: this.caps.maxRecordingsMb * MIB,
				minFreeBytes: this.caps.minFreeDiskMb * MIB,
			}),
			freeBytes: async () => (await this.statfs(this.root)).freeBytes,
			...(this.analogIo ? { io: this.analogIo } : {}),
			...(this.protection
				? {
						protection: this.protection,
						keptSkipped: (count: number) =>
							this.keepLog.info(
								{ count },
								"Kept scanner recordings left in place",
							),
					}
				: {}),
		})
	}
	get analogAuthorityReady(): boolean {
		return this.analog?.ready ?? false
	}
	beginAnalog(input: AnalogInput): AnalogHandle {
		if (!this.analog)
			throw new WaveKitError(
				"Analog metadata authority not configured",
				"SCANNER_ANALOG_ADMISSION_DENIED",
			)
		return this.analog.begin(input)
	}
	recoverAnalog(): Promise<AnalogReconciliation[]> {
		return this.analog?.recover() ?? Promise.resolve([])
	}
	hasAnalogCleanup(id: string): Promise<boolean> {
		assertDiscoveryId(id)
		return this.analog?.hasCleanup(id) ?? Promise.resolve(false)
	}
	stopAnalog(): Promise<void> {
		return this.analog?.stop() ?? Promise.resolve()
	}

	private admits(id: string): boolean {
		if (this.removals.has(id)) return false
		if (this.isDiscoveryLive(id)) return true
		// WG10 req 1.5: an alias folder is admitted while its owner is live and not being removed.
		const owner = this.aliasOwner(id)
		return (
			owner !== undefined &&
			owner !== id &&
			!this.removals.has(owner) &&
			this.isDiscoveryLive(owner)
		)
	}

	setCaps(caps: StorageCaps): void {
		this.caps = { ...caps }
	}

	async linkProbeRecordings(
		probeDir: string,
		candidates: LinkCandidate[],
	): Promise<{
		linked: { observationId: string; recordingId: string }[]
		cut: string[]
		droppedEncrypted: string[]
	}> {
		for (const c of candidates) assertDiscoveryId(c.discoveryId)
		const linked: { observationId: string; recordingId: string }[] = []
		const cut: string[] = []
		const droppedEncrypted: string[] = []
		const low = (await this.diskState()) === "disk-low"
		const files: { path: string; name: string }[] = []
		// WAV and wav are one directory on case-insensitive disks (APFS, macOS bind mounts): list each real directory once
		for (const dir of await wavDirs(probeDir))
			for (const name of await listDir(dir))
				if (name.endsWith(".wav")) files.push({ path: join(dir, name), name })
		files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		try {
			await this.linkFiles(files, candidates, low, {
				linked,
				cut,
				droppedEncrypted,
			})
		} finally {
			// never leave a probe folder behind, even when a move fails part-way
			await rm(probeDir, { recursive: true, force: true })
		}
		if (files.length > 0)
			this.log.debug(
				{
					probeDir,
					files: files.length,
					linked: linked.length,
					cut: cut.length,
					droppedEncrypted: droppedEncrypted.length,
					low,
				},
				"Processed probe recordings",
			)
		return { linked, cut, droppedEncrypted }
	}

	/**
	 * Probes are never persisted, so at start every `recordings/dv/probe-*` folder is a crash
	 * leftover. Call once before the probe pool starts; returns the removed folder names.
	 */
	async removeOrphanProbeDirs(): Promise<string[]> {
		const base = join(this.root, "recordings", "dv")
		const removed: string[] = []
		for (const name of await listDir(base)) {
			if (!PROBE_DIR.test(name)) continue
			await rm(join(base, name), { recursive: true, force: true })
			removed.push(name)
		}
		if (removed.length > 0)
			this.log.info(
				{ removed: removed.length },
				"Removed orphaned probe recording folders",
			)
		return removed
	}

	private async linkFiles(
		files: readonly { path: string; name: string }[],
		candidates: readonly LinkCandidate[],
		low: boolean,
		out: {
			linked: { observationId: string; recordingId: string }[]
			cut: string[]
			droppedEncrypted: string[]
		},
	): Promise<void> {
		const { linked, cut, droppedEncrypted } = out
		for (const f of files) {
			const temp = TEMP_WAV.exec(f.name)
			if (temp !== null) {
				const at = localStampMs(temp[1] ?? "", temp[2] ?? "")
				const c =
					at === null ? undefined : matchingCandidates(candidates, at)[0]
				if (c !== undefined && !cut.includes(c.observationId))
					cut.push(c.observationId)
				await rm(f.path, { force: true })
				continue
			}
			const call = CALL_WAV.exec(f.name)
			const at =
				call === null ? null : localStampMs(call[1] ?? "", call[2] ?? "")
			const matches =
				call === null || at === null
					? []
					: matchingCandidates(candidates, at, call[3], call[4])
			// encrypted → no audio kept: any encrypted match wins over a nearer clear one, and is reported even while the disk is low
			const encrypted = matches.find(m => m.encrypted)
			if (encrypted !== undefined) {
				await rm(f.path, { force: true })
				if (!droppedEncrypted.includes(encrypted.observationId))
					droppedEncrypted.push(encrypted.observationId)
				continue
			}
			const c = matches[0]
			if (c === undefined || low) {
				await rm(f.path, { force: true })
				continue
			}
			if (!this.admits(c.discoveryId)) {
				await rm(f.path, { force: true })
				continue
			}
			// Reserve before any await: DELETE drains this accepted move before acknowledging.
			await this.serialise(c.discoveryId, async () => {
				if (!this.admits(c.discoveryId)) return
				const target = join(this.root, "recordings", "dv", c.discoveryId)
				await mkdir(target, { recursive: true })
				try {
					await moveFile(f.path, join(target, f.name))
				} catch (err) {
					if (errorCode(err) === "ENOENT") return
					throw err
				}
				linked.push({
					observationId: c.observationId,
					recordingId: `${c.discoveryId}~${f.name}`,
				})
			})
		}
	}

	/**
	 * Runs `task` after every earlier evidence task of the same discovery has settled. Overlapping
	 * writes would otherwise share `atomicWrite`'s `<file>.<pid>.tmp` and race the PSD's
	 * read-compare-write. A failed task rejects its own caller only; the chain carries on.
	 */
	private serialise<T>(
		discoveryId: string,
		task: () => Promise<T>,
	): Promise<T> {
		const run = (this.writeChains.get(discoveryId) ?? Promise.resolve()).then(
			task,
		)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.writeChains.set(discoveryId, tail)
		void tail.then(() => {
			if (this.writeChains.get(discoveryId) === tail)
				this.writeChains.delete(discoveryId)
		})
		return run
	}

	async writePsd(
		discoveryId: string,
		psd: { startHz: number; binHz: number; bins: number[]; snrDb: number },
	): Promise<boolean> {
		assertDiscoveryId(discoveryId)
		if (!this.admits(discoveryId)) return false
		return this.serialise(discoveryId, async () => {
			if (!this.admits(discoveryId) || (await this.diskState()) === "disk-low")
				return false
			const file = join(this.root, "evidence", discoveryId, "psd.json")
			try {
				const existing = PsdFileSchema.safeParse(
					JSON.parse(await readFile(file, "utf8")) as unknown,
				)
				if (existing.success && existing.data.snrDb >= psd.snrDb) return false
			} catch (err) {
				if (errorCode(err) !== "ENOENT")
					this.log.debug(
						{ err, file },
						"Replacing an unreadable PSD evidence file",
					)
			}
			await atomicWrite(
				file,
				JSON.stringify({
					version: 1,
					savedAt: new Date(this.now()).toISOString(),
					...psd,
				}),
			)
			return true
		})
	}

	async writeIq(
		discoveryId: string,
		bytes: Uint8Array,
		meta: { sampleRateHz: number; centreHz: number },
	): Promise<string | null> {
		assertDiscoveryId(discoveryId)
		if (
			!Number.isFinite(meta.sampleRateHz) ||
			meta.sampleRateHz <= 0 ||
			!Number.isFinite(meta.centreHz) ||
			meta.centreHz < 0
		)
			throw new WaveKitError(
				"Invalid realized IQ metadata",
				"SCANNER_INVALID_IQ_METADATA",
			)
		if (!this.admits(discoveryId)) return null
		return this.serialise(discoveryId, async () => {
			if (!this.admits(discoveryId) || (await this.diskState()) === "disk-low")
				return null
			const savedAt = this.now()
			const limit = Math.floor(meta.sampleRateHz) * 2
			const length = Math.floor(Math.min(bytes.length, limit) / 2) * 2
			if (length === 0) return null
			const body = bytes.subarray(0, length)
			const dir = join(this.root, "evidence", discoveryId)
			// the name keeps the `iq-<ms>` contract: a snippet saved in an already-used millisecond takes the next free one
			let at = savedAt
			while (
				existsSync(join(dir, `iq-${at}.cu8`)) ||
				existsSync(join(dir, `iq-${at}.json`))
			)
				at++
			const name = `iq-${at}.cu8`
			await atomicWrite(join(dir, name), body)
			await atomicWrite(
				join(dir, `iq-${at}.json`),
				JSON.stringify({
					version: 1,
					sampleRateHz: meta.sampleRateHz,
					centreHz: meta.centreHz,
					savedAt: new Date(savedAt).toISOString(),
					bytes: body.length,
				}),
			)
			return name
		})
	}

	recordingPath(recordingId: string): string | null {
		const m = RECORDING_ID.exec(recordingId)
		const discoveryId = m?.[1]
		const file = m?.[2]
		if (
			discoveryId === undefined ||
			file === undefined ||
			file.includes("..") ||
			!this.admits(discoveryId)
		)
			return null
		if (/^analog-[0-9a-f-]{36}\.wav$/i.test(file))
			return this.analog?.path(recordingId) ?? null
		for (const kind of RECORDING_KINDS) {
			const path = join(this.root, "recordings", kind, discoveryId, file)
			if (existsSync(path)) return path
		}
		return null
	}

	/**
	 * WG10 req 1.1-1.3: deletes one `recordings/dv/<discovery>/<file>` recording, serialised with
	 * the discovery's other evidence work. Refuses an analog name (UNSUPPORTED) and a discovery
	 * being removed (BUSY); a missing or not admitted discovery, a changed pinned root, a symlinked
	 * or non-directory ancestor, or a file that is not the verified one answers `not-found` with
	 * nothing deleted. `stillDeletable()` runs in the unlink's turn (verified unlink helper).
	 */
	async deleteRecording(
		recordingId: string,
		stillDeletable: () => boolean,
	): Promise<"deleted" | "not-found"> {
		const m = RECORDING_ID.exec(recordingId)
		const discoveryId = m?.[1]
		const file = m?.[2]
		if (discoveryId === undefined || file === undefined) return "not-found"
		if (/^analog-[0-9a-f-]{36}\.wav$/i.test(file))
			throw new RecordingKeepError(
				"RECORDING_DELETE_UNSUPPORTED",
				RECORDING_DELETE_UNSUPPORTED_TEXT,
			)
		if (file.includes("..")) return "not-found"
		const busy = (): RecordingKeepError =>
			new RecordingKeepError("RECORDING_BUSY", RECORDING_BUSY_TEXT)
		const removing = (): boolean => {
			if (this.removals.has(discoveryId)) return true
			const owner = this.aliasOwner(discoveryId)
			return owner !== undefined && this.removals.has(owner)
		}
		if (removing()) throw busy()
		return this.serialise(discoveryId, async () => {
			if (removing()) throw busy()
			if (!this.admits(discoveryId)) return "not-found"
			if (!(await this.rootIntact())) return "not-found"
			const recordings = join(this.root, "recordings")
			const kindDir = join(recordings, "dv")
			const dir = join(kindDir, discoveryId)
			const chain: DirIdentity[] = []
			for (const path of [recordings, kindDir, dir]) {
				const id = await realDirectory(path)
				if (id === null) return "not-found"
				chain.push({ path, ...id })
			}
			const filePath = join(dir, file)
			let handle
			try {
				handle = await open(
					filePath,
					fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
				)
			} catch (err) {
				const code = errorCode(err)
				if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
					return "not-found"
				throw err
			}
			try {
				const st = await handle.stat()
				if (!st.isFile()) return "not-found"
				// The open resolved through the listed directories: a swap since answers no file.
				if (!(await chainIntact(chain))) return "not-found"
				const outcome = await verifiedUnlink({
					filePath,
					handleStat: { dev: st.dev, ino: st.ino },
					stillDeletable,
					log: this.keepLog,
					...(this.recordingDeleteFs ? { fs: this.recordingDeleteFs } : {}),
				})
				return outcome === "deleted" ? "deleted" : "not-found"
			} finally {
				await handle.close().catch(() => undefined)
			}
		})
	}

	evidencePath(discoveryId: string, name: string): string | null {
		if (
			!DISCOVERY_ID.test(discoveryId) ||
			!EVIDENCE_NAME.test(name) ||
			!this.admits(discoveryId)
		)
			return null
		const path = join(this.root, "evidence", discoveryId, name)
		return existsSync(path) ? path : null
	}

	async removeDiscovery(discoveryId: string): Promise<void> {
		assertDiscoveryId(discoveryId)
		const pending = this.removals.get(discoveryId)
		if (pending) return pending
		// WG9 req 2.6: no cascade to kept media (fixed text; the id is not echoed).
		if (this.holdsKept(discoveryId))
			throw new ScannerApiError(
				"Discovery holds kept recordings",
				SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
				409,
			)
		// WG10 req 1.5: the aliases as of the request (a deleted owner's stay listed until released).
		const aliases = this.aliasesOf(discoveryId).filter(
			alias => alias !== discoveryId && DISCOVERY_ID.test(alias),
		)
		// Fence admission synchronously and drain accepted writes/moves before removal.
		const removal = Promise.resolve()
			.then(async () => {
				// WG9 R2: a pinned root whose identity changed stays pending (fail closed).
				if (!(await this.rootIntact()))
					throw new WaveKitError(
						"Scanner storage root changed",
						"SCANNER_EVIDENCE_CLEANUP_PENDING",
					)
				// Long analog settlement drains outside the publication queue it may itself need.
				if (this.analog) {
					await this.analog.deleteDiscovery(discoveryId)
					for (const alias of aliases) await this.analog.deleteDiscovery(alias)
				}
				const removeFolders = async (id: string): Promise<void> => {
					if (!(await this.rootIntact()))
						throw new WaveKitError(
							"Scanner storage root changed",
							"SCANNER_EVIDENCE_CLEANUP_PENDING",
						)
					if (this.protection) {
						await this.removeGuarded(id)
						return
					}
					await rm(join(this.root, "evidence", id), {
						recursive: true,
						force: true,
					})
					for (const kind of RECORDING_KINDS)
						await rm(join(this.root, "recordings", kind, id), {
							recursive: true,
							force: true,
						})
				}
				await this.serialise(discoveryId, async () => {
					await removeFolders(discoveryId)
					// WG10 req 1.5: the alias folders go in the same removal, each through the
					// per-file decision (a kept file refuses); a folder already gone is harmless.
					for (const alias of aliases) {
						await this.serialise(alias, () => removeFolders(alias))
					}
				})
			})
			.catch((cause: unknown) => {
				if (cause instanceof ScannerApiError) throw cause
				throw new WaveKitError(
					"Scanner evidence cleanup remains pending",
					"SCANNER_EVIDENCE_CLEANUP_PENDING",
					cause instanceof Error ? cause : undefined,
				)
			})
		this.removals.set(discoveryId, removal)
		// Fence existing handles before caller can enqueue another PCM chunk.
		const drain = this.analog?.cancelDiscovery(discoveryId)
		if (drain) void drain.catch(() => undefined)
		let removed = false
		try {
			await removal
			removed = true
		} finally {
			if (this.removals.get(discoveryId) === removal) {
				this.removals.delete(discoveryId)
				// WG10 (Main, rk2 review minor 2): the aliases are released only after the owner's
				// removal succeeded; a failed removal keeps them so a retry still reaches the folders.
				if (removed) this.aliases?.releaseAliases?.(discoveryId)
			}
		}
	}

	/**
	 * WG9 req 2.6 with a protection port: each recording file is unlinked only in the same
	 * synchronous turn as its protection answer, so a Keep that commits during the drain
	 * survives. A protected file stops the removal and leaves the folders in place.
	 */
	private async removeGuarded(discoveryId: string): Promise<void> {
		const refuse = (): never => {
			throw new ScannerApiError(
				"Discovery holds kept recordings",
				SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
				409,
			)
		}
		const unlinkGone = async (path: string): Promise<void> => {
			try {
				await unlink(path)
			} catch (err) {
				if (errorCode(err) !== "ENOENT") throw err
			}
		}
		const pending = (): never => {
			throw new WaveKitError(
				"Scanner evidence cleanup remains pending",
				"SCANNER_EVIDENCE_CLEANUP_PENDING",
			)
		}
		// A missing ancestor holds nothing; a symlinked or non-directory one is never descended.
		const safeAncestor = async (path: string): Promise<boolean> => {
			try {
				const info = await lstat(path)
				return info.isDirectory() && !info.isSymbolicLink()
			} catch (err) {
				if (errorCode(err) === "ENOENT") return true
				throw err
			}
		}
		const recordings = join(this.root, "recordings")
		let refused = false
		for (const kind of RECORDING_KINDS) {
			const kindDir = join(recordings, kind)
			const kindSafe = async (): Promise<boolean> =>
				(await safeAncestor(recordings)) && (await safeAncestor(kindDir))
			if (!(await kindSafe())) {
				refused = true
				continue
			}
			const dir = join(kindDir, discoveryId)
			let top
			try {
				top = await lstat(dir)
			} catch (err) {
				if (errorCode(err) === "ENOENT") continue
				throw err
			}
			// A symlinked or non-directory discovery entry: remove the entry itself, as rm -rf did, never its target.
			if (!top.isDirectory()) {
				if (this.holdsKept(discoveryId)) refuse()
				await unlinkGone(dir)
				continue
			}
			// WG9 req 2.5: the identities each per-file unlink re-verifies.
			const chain: DirIdentity[] = []
			for (const path of [recordings, kindDir, dir]) {
				const id = (await realDirectory(path)) ?? pending()
				chain.push({ path, ...id })
			}
			if (chain[2]?.dev !== top.dev || chain[2]?.ino !== top.ino) pending()
			let entries
			try {
				entries = await readdir(dir, { withFileTypes: true })
			} catch (err) {
				if (errorCode(err) === "ENOENT") continue
				throw err
			}
			for (const entry of entries) {
				const path = join(dir, entry.name)
				if (entry.isDirectory()) {
					// Retention never lists nested folders, so they hold no inventoried media; rm does not follow links.
					// The folder and its ancestors must still be the real ones listed, or rm would recurse into an alias.
					if (!(await chainIntact(chain))) pending()
					await rm(path, { recursive: true, force: true })
					continue
				}
				// Regular files and symlinks (unlinked as links, never followed); anything else goes with the folder.
				if (!entry.isFile() && !entry.isSymbolicLink()) continue
				// The folder and its ancestors must still be the real ones listed: a swap for an alias stops here.
				if (!(await chainIntact(chain))) pending()
				let kept = true
				try {
					kept =
						this.protection?.isScannerFileProtected(discoveryId, entry.name) !==
						false
				} catch {
					kept = true
				}
				if (kept) refuse()
				await unlinkGone(path)
			}
			if (this.holdsKept(discoveryId)) refuse()
			// The folder and its ancestors must still be the ones first lstat-verified.
			const again = await realDirectory(dir)
			if (
				!(await kindSafe()) ||
				again === null ||
				again.dev !== top.dev ||
				again.ino !== top.ino
			)
				pending()
			// Only non-media entries remain; rm -rf on the lstat-verified folder does not follow links.
			await rm(dir, { recursive: true, force: true })
		}
		if (this.holdsKept(discoveryId)) refuse()
		if (refused || !(await safeAncestor(join(this.root, "evidence")))) pending()
		await rm(join(this.root, "evidence", discoveryId), {
			recursive: true,
			force: true,
		})
	}

	async retention(
		keepDiscoveryIds: ReadonlySet<string>,
	): Promise<{ deleted: string[] }> {
		// WG9 R2: a pinned root whose identity changed deletes nothing (fail closed).
		if (!(await this.rootIntact())) return { deleted: [] }
		const now = this.now()
		const files = await this.collect()
		// WG10 req 1.5: an operator keep of a survivor protects its alias folders.
		keepDiscoveryIds = withAliasFolders(keepDiscoveryIds, this.aliasesOf)
		const isProtected = (f: StoredFile): boolean =>
			f.probe ||
			now - f.mtimeMs < RECORDING_IN_PROGRESS_MS ||
			keepDiscoveryIds.has(f.discoveryId) ||
			(this.analog?.protectedDiscovery(f.discoveryId) ?? false) ||
			/^analog-[0-9a-f-]{36}\.wav$/i.test(f.path.split("/").at(-1) ?? "") ||
			this.keptFile(f)
		const byAge = [...files].sort(
			(a, b) =>
				a.mtimeMs - b.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
		)
		const gone = new Set<string>()
		const deleted: string[] = []
		const remove = async (f: StoredFile): Promise<boolean> => {
			if (this.protection) {
				// WG9 req 2.5: every listed directory is re-verified first (a swapped one skips the
				// file); then the decision and a single-syscall unlink share one turn (rm lstats first).
				if (!(await chainIntact(f.chain ?? []))) return false
				if (this.keptFile(f)) return false
				try {
					await unlink(f.path)
				} catch (err) {
					if (errorCode(err) !== "ENOENT") throw err
				}
			} else await rm(f.path, { force: true })
			gone.add(f.path)
			deleted.push(f.rel)
			return true
		}
		const maxAgeMs = this.caps.maxAgeDays * DAY_MS
		for (const f of byAge)
			if (!isProtected(f) && now - f.mtimeMs > maxAgeMs) await remove(f)
		const caps: [StoredFile["category"], number][] = [
			["recordings", this.caps.maxRecordingsMb * MIB],
			["evidence", this.caps.maxEvidenceMb * MIB],
		]
		for (const [category, capBytes] of caps) {
			let total = 0
			for (const f of files)
				if (f.category === category && !gone.has(f.path)) total += f.bytes
			for (const f of byAge) {
				if (total <= capBytes) break
				if (f.category !== category || gone.has(f.path) || isProtected(f))
					continue
				if (await remove(f)) total -= f.bytes
			}
		}
		if (this.analog)
			deleted.push(
				...(await this.analog.retained(
					keepDiscoveryIds,
					this.caps.maxAgeDays * DAY_MS,
					now,
				)),
			)
		await this.removeEmptyDirs()
		if (deleted.length > 0)
			this.log.info(
				{ deleted: deleted.length },
				"Scanner retention removed files",
			)
		return { deleted }
	}

	async diskState(): Promise<"ok" | "disk-low"> {
		try {
			await mkdir(this.root, { recursive: true })
			const { freeBytes } = await this.statfs(this.root)
			return freeBytes < this.caps.minFreeDiskMb * MIB ? "disk-low" : "ok"
		} catch (err) {
			this.log.debug(
				{ err, dir: this.root },
				"Free-disk metric unavailable; treating the disk as ok",
			)
			return "ok"
		}
	}

	private async collect(): Promise<StoredFile[]> {
		const out: StoredFile[] = []
		// WG9 req 2.5: with a protection port, never descend an aliased directory or count a symlink.
		const guarded = this.protection !== undefined
		// Unguarded: always descend, no identity chain. Guarded: the real directory's identity or null.
		const descend = async (
			dir: string,
			chain: readonly DirIdentity[],
		): Promise<DirIdentity[] | null> => {
			if (!guarded) return []
			const id = await realDirectory(dir)
			return id === null ? null : [...chain, { path: dir, ...id }]
		}
		const scan = async (
			base: string,
			category: StoredFile["category"],
			parent: readonly DirIdentity[],
		): Promise<void> => {
			const baseChain = await descend(base, parent)
			if (baseChain === null) return
			for (const discoveryId of await listDir(base)) {
				const probe = category === "recordings" && PROBE_DIR.test(discoveryId)
				if (!probe && !DISCOVERY_ID.test(discoveryId)) continue
				const top = join(base, discoveryId)
				// a probe's dsd-fme may write into WAV/ or wav/ (Task 17 linking); those bytes count against the cap too
				const topChain = await descend(top, baseChain)
				if (topChain === null) continue
				for (const dir of probe ? await wavDirs(top) : [top]) {
					const chain = dir === top ? topChain : await descend(dir, topChain)
					if (chain === null) continue
					for (const name of await listDir(dir)) {
						const path = join(dir, name)
						try {
							const s = guarded ? await lstat(path) : await stat(path)
							if (
								s.isFile() &&
								!(this.analog?.ownsArtifact(relative(this.root, path)) ?? false)
							)
								out.push({
									path,
									rel: relative(this.root, path),
									category,
									discoveryId,
									probe,
									bytes: s.size,
									mtimeMs: s.mtimeMs,
									...(guarded ? { chain } : {}),
								})
						} catch (err) {
							if (errorCode(err) !== "ENOENT") throw err
						}
					}
				}
			}
		}
		const recordings = await descend(join(this.root, "recordings"), [])
		if (recordings !== null)
			for (const kind of RECORDING_KINDS)
				await scan(
					join(this.root, "recordings", kind),
					"recordings",
					recordings,
				)
		await scan(join(this.root, "evidence"), "evidence", [])
		return out
	}

	private async removeEmptyDirs(): Promise<void> {
		const bases = [
			...RECORDING_KINDS.map(k => join(this.root, "recordings", k)),
			join(this.root, "evidence"),
		]
		const guarded = this.protection !== undefined
		if (
			guarded &&
			(await realDirectory(join(this.root, "recordings"))) === null
		)
			bases.splice(0, RECORDING_KINDS.length)
		for (const base of bases) {
			if (guarded && (await realDirectory(base)) === null) continue
			for (const discoveryId of await listDir(base)) {
				if (!DISCOVERY_ID.test(discoveryId)) continue
				const dir = join(base, discoveryId)
				if ((await listDir(dir)).length === 0)
					await rmdir(dir).catch(() => undefined)
			}
		}
	}
}
