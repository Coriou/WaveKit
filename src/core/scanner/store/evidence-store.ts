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
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
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
import { FolderIndex } from "./folder-index.js"
import {
	AnalogOperations,
	type AnalogHandle,
	type AnalogInput,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogQuarantine,
	type AnalogReconciliation,
	type AnalogSetAsideStatus,
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

/** The recordings quota left exceeded after retention removed every file its rules allow. */
export interface RecordingsQuotaExceeded {
	capBytes: number
	usedBytes: number
	overBytes: number
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

/**
 * Call candidates kept per probe link: 256 reported calls. Matching is
 * files × candidates comparisons, so a probe's few dozen call files cost a few thousand.
 */
export const MAX_PROBE_CALL_CANDIDATES = 256

/** One dsd-fme call a probe reported (its `call_end`). */
export interface ProbeLinkCall {
	talkgroup?: string
	source?: string
	startedAt: number
	endedAt: number
	encrypted: boolean
}

/**
 * Link candidates for a probe's call files: each observation as it stands (its latest talkgroup
 * and source, encrypted if any decode was), plus one per call the probe reported inside the
 * observation's window, with that call's own time and encryption. An observation keeps only its
 * latest pair, so without the calls every earlier over of a conversation (another radio, another
 * talkgroup) would match nothing and be deleted. Each call keeps its own window so a clear call
 * never claims the file of an encrypted call of the same pair, and a file matching any encrypted
 * candidate is dropped (linkFiles). At most MAX_PROBE_CALL_CANDIDATES are added, encrypted calls
 * first: a missing clear candidate only loses audio, a missing encrypted one could keep it. Past
 * the cap with encrypted calls alone, every file of the probe is dropped (fail closed). Every
 * encrypted call is a candidate whatever the observations' windows; only a clear call must
 * overlap an observation, and only a clear call of an observation's own pair is skipped.
 */
export function probeLinkCandidates(
	observations: readonly LinkCandidate[],
	calls: readonly ProbeLinkCall[],
): LinkCandidate[] {
	const encrypted: LinkCandidate[] = []
	const clear: LinkCandidate[] = []
	const seen = new Set<string>()
	const candidate = (o: LinkCandidate, call: ProbeLinkCall): void => {
		const key = JSON.stringify([
			o.observationId,
			call.talkgroup ?? null,
			call.source ?? null,
			call.startedAt,
			call.endedAt,
			call.encrypted,
		])
		if (seen.has(key)) return
		seen.add(key)
		;(call.encrypted ? encrypted : clear).push({
			observationId: o.observationId,
			discoveryId: o.discoveryId,
			...(call.talkgroup !== undefined ? { talkgroup: call.talkgroup } : {}),
			...(call.source !== undefined ? { source: call.source } : {}),
			startedAt: call.startedAt,
			endedAt: call.endedAt,
			encrypted: call.encrypted,
		})
	}
	const overlaps = (o: LinkCandidate, call: ProbeLinkCall): boolean =>
		call.endedAt >= o.startedAt - MATCH_SLACK_MS &&
		call.startedAt <= o.endedAt + MATCH_SLACK_MS
	for (const call of calls) {
		if (call.encrypted) {
			// Every encrypted call vetoes its own window, whatever the observations' windows: a
			// clear call's window may reach past its observation (dsd-fme's call_end lags RF), so
			// a veto filtered by observation overlap could leave an encrypted file to a clear call.
			// It is reported on the observation it overlaps, else the nearest one.
			const o =
				observations.find(x => overlaps(x, call)) ??
				[...observations].sort(
					(a, b) =>
						Math.abs(a.startedAt - call.startedAt) -
						Math.abs(b.startedAt - call.startedAt),
				)[0]
			if (o !== undefined) candidate(o, call)
			continue
		}
		// A clear call with no ids claims nothing.
		if (call.talkgroup === undefined && call.source === undefined) continue
		for (const o of observations) {
			if (!overlaps(o, call)) continue
			// The observation's own candidate already covers a clear call of its pair (wider window).
			if (
				(call.talkgroup ?? null) === (o.talkgroup ?? null) &&
				(call.source ?? null) === (o.source ?? null)
			)
				continue
			candidate(o, call)
		}
	}
	// More encrypted calls than the cap: a dropped veto could keep an encrypted file, so fail
	// closed and treat every observation of this probe as encrypted (all its files are dropped).
	if (encrypted.length > MAX_PROBE_CALL_CANDIDATES)
		return observations.map(o => ({ ...o, encrypted: true }))
	return [...observations, ...encrypted, ...clear].slice(
		0,
		observations.length + MAX_PROBE_CALL_CANDIDATES,
	)
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

/** Names a probe publication tries before it refuses (the first is the file's own name). */
export const PUBLISH_NAME_TRIES = 16
/** link() errors that mean "no hard link here" (another device, or a filesystem without them). */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"])
const CALL_STEM = /^(\d{8}_\d{6}_\d{5})_/

/**
 * The `n`-th fresh name for a probe recording whose own name is taken: `_dup<n>` after the call
 * stamp, so the name still parses as the same call (time, talkgroup, source). Undefined for a
 * name without the stamp (never published).
 */
function freshName(name: string, n: number): string | undefined {
	return CALL_STEM.test(name)
		? name.replace(CALL_STEM, `$1_dup${n}_`)
		: undefined
}

/**
 * Publishes the probe file `from` into the recording folder `dir` without ever replacing a file
 * there (one another discovery may list): link() fails with EEXIST on a taken name, and on
 * another device (or a filesystem without hard links) copyFile with COPYFILE_EXCL does too. A
 * taken name moves on to a fresh one (`freshName`); the source goes only once the new file
 * exists. Returns the name published, or undefined when every name tried was taken (the probe
 * file is then dropped with its probe folder; the existing files stay untouched). A copy that
 * fails part-way may leave its own new, unlisted file behind (never one it did not create).
 */
async function publishFile(
	from: string,
	dir: string,
	name: string,
): Promise<string | undefined> {
	for (let n = 0; n < PUBLISH_NAME_TRIES; n++) {
		const candidate = n === 0 ? name : freshName(name, n)
		if (candidate === undefined) return undefined
		const to = join(dir, candidate)
		try {
			await link(from, to)
		} catch (err) {
			const code = errorCode(err)
			if (code === "EEXIST") continue
			if (code === undefined || !NO_LINK.has(code)) throw err
			try {
				await copyFile(from, to, fsConstants.COPYFILE_EXCL)
			} catch (copyErr) {
				if (errorCode(copyErr) === "EEXIST") continue
				throw copyErr
			}
		}
		await rm(from, { force: true })
		return candidate
	}
	return undefined
}

/** Unlinks one entry as itself (never followed); one already gone is harmless. */
async function unlinkGone(path: string): Promise<void> {
	try {
		await unlink(path)
	} catch (err) {
		if (errorCode(err) !== "ENOENT") throw err
	}
}

/** Removes a folder only when empty: one a kept file (or anything left) holds stays, harmlessly. */
async function rmdirIfEmpty(dir: string): Promise<void> {
	try {
		await rmdir(dir)
	} catch (err) {
		const code = errorCode(err)
		if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return
		throw err
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
	/** The ids owning a folder on disk; merge aliases never release one (recording-aliases.ts). */
	readonly folders = new FolderIndex()
	/** Folders the last retention pass kept because no live discovery owns them. */
	private unresolvedFolders = 0
	/** Recording files the last retention pass kept because their owner is unknown (table full). */
	private unknownHeldFiles = 0
	/** The recordings quota the last retention pass left exceeded; null within it. */
	private quotaExceeded: RecordingsQuotaExceeded | null = null

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
	 * The deleters' answer for the recording file `name` of `folderId`, asked in the same
	 * synchronous turn as its unlink: every live discovery the ownership table records as listing
	 * it (the folder's own discovery included when it lists the file itself and another listing
	 * exists); empty when the table holds no listing (the file follows its folder's owner). Null,
	 * fail closed, when the folder is marked (its listers are unknown) or a lookup throws.
	 */
	private listers(folderId: string, name: string): readonly string[] | null {
		try {
			if (this.heldFolderUnknown(folderId)) return null
			const lookup = this.aliases
			const id = `${folderId}~${name}`
			if (lookup?.heldRecordingListers !== undefined)
				return lookup.heldRecordingListers(id)
			// A lookup with the single answer only (one listing discovery other than the owner).
			const owner = lookup?.heldRecordingOwner?.(id)
			if (owner === null) return null
			return owner === undefined ? [] : [owner]
		} catch {
			return null
		}
	}

	/**
	 * Playback only: the live discoveries the table records as listing the file, whatever its
	 * folder's mark (admission, never a delete decision). A throwing lookup admits nothing.
	 */
	private holders(folderId: string, name: string): readonly string[] {
		try {
			const lookup = this.aliases
			const id = `${folderId}~${name}`
			if (lookup?.heldRecordingHolders !== undefined)
				return lookup.heldRecordingHolders(id)
			const holder =
				lookup?.heldRecordingHolder !== undefined
					? lookup.heldRecordingHolder(id)
					: lookup?.heldRecordingOwner?.(id)
			return typeof holder === "string" ? [holder] : []
		} catch {
			return []
		}
	}

	/** Fail closed: a throwing lookup answers "unknown" (every recording file kept). */
	private heldFolderUnknown(folderId: string): boolean {
		try {
			return this.aliases?.heldFolderUnknown?.(folderId) ?? false
		} catch {
			return true
		}
	}

	/**
	 * The removal's per-file answer, asked in the same synchronous turn as that file's unlink and
	 * never carried across an await: true when the recording file `name` of `folderId` must stay
	 * because its folder is marked (the ownership table was full, so every recording file there
	 * counts as listed by an unknown live discovery), or because any live discovery outside
	 * `removing` lists it (every lister counts, any kind; an analog file through its association
	 * too). Fails closed: a throwing lookup keeps the file.
	 */
	private removalKeeps(
		folderId: string,
		name: string,
		removing: readonly string[],
	): boolean {
		try {
			const listers = this.listers(folderId, name)
			if (listers === null) return true
			if (listers.some(id => !removing.includes(id))) return true
			// A lookup without every lister: its per-folder names answer too.
			if (
				this.aliases?.heldRecordingListers === undefined &&
				this.aliases?.heldFileNames?.(folderId, removing).has(name) === true
			)
				return true
			return this.analog?.heldArtifact(folderId, name, removing) ?? false
		} catch {
			return true
		}
	}

	/**
	 * A folder whose owner nothing resolves (not live, no live alias owner): retention keeps it.
	 * A throwing lookup answers unresolved (kept).
	 */
	private folderResolved(folderId: string): boolean {
		try {
			if (this.isDiscoveryLive(folderId)) return true
			const owner = this.aliases?.aliasOwner(folderId)
			return owner !== undefined && this.isDiscoveryLive(owner)
		} catch {
			return false
		}
	}

	/** Folders the last retention pass left in place because no live discovery owns them. */
	get unresolvedFolderCount(): number {
		return this.unresolvedFolders
	}

	/**
	 * Analog recordings the last retention pass kept because recovery quarantined them (pending
	 * re-admission at a later start; only an explicit delete under strict ownership removes them).
	 */
	get quarantinedRecordingCount(): number {
		return this.analog?.quarantinedRetained ?? 0
	}

	/** The last recovery's quarantined analog operations, with their closed reasons. */
	analogQuarantine(): AnalogQuarantine[] {
		return this.analog?.quarantined() ?? []
	}

	/** Incomplete analog operation folders set aside at load (crash residue); null: none held. */
	analogOperationsStatus(): AnalogSetAsideStatus | null {
		return this.analog?.setAsideStatus() ?? null
	}

	/** Recording files the last retention pass kept because their owner is unknown (table full). */
	get unknownHeldFileCount(): number {
		return this.unknownHeldFiles + (this.analog?.unknownHeldRetained ?? 0)
	}

	/**
	 * The recordings quota the last retention pass left exceeded after removing every file its
	 * rules allow (everything left is protected: kept, recent, unresolved or held); null within
	 * the quota. Analog admission then refuses with `storage-cap`; other writes rely on the free
	 * disk threshold.
	 */
	get recordingsQuotaExceeded(): RecordingsQuotaExceeded | null {
		return this.quotaExceeded === null ? null : { ...this.quotaExceeded }
	}

	/**
	 * Lists the folder ids on disk into `folders` (evidence, dv and analog recordings). Ids
	 * marked while it runs stay. A failed listing leaves the index as it was.
	 */
	async loadFolderIndex(): Promise<string[]> {
		const token = this.folders.beginListing()
		try {
			const ids = new Set<string>()
			for (const base of [
				...RECORDING_KINDS.map(k => join(this.root, "recordings", k)),
				join(this.root, "evidence"),
			])
				for (const name of await listDir(base))
					if (DISCOVERY_ID.test(name)) ids.add(name)
			this.folders.finishListing(token, ids)
			return [...ids]
		} catch (err) {
			this.folders.abandonListing(token)
			throw err
		}
	}

	/** Whether a recording file named by `recordingId` exists in a dv or analog folder. */
	recordingFileExists(recordingId: string): boolean {
		const m = RECORDING_ID.exec(recordingId)
		const discoveryId = m?.[1]
		const file = m?.[2]
		if (discoveryId === undefined || file === undefined || file.includes(".."))
			return false
		return RECORDING_KINDS.some(kind => {
			try {
				lstatSync(join(this.root, "recordings", kind, discoveryId, file))
				return true
			} catch (err) {
				const code = errorCode(err)
				return code !== "ENOENT" && code !== "ENOTDIR"
			}
		})
	}

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
			heldUnknown: id => this.heldFolderUnknown(id),
			listers: (id, name) => this.listers(id, name),
			legacyBytes: async () =>
				(await this.collect())
					.filter(file => file.category === "recordings")
					.reduce((sum, file) => sum + file.bytes, 0),
			limits: () => ({
				maxBytes: this.caps.maxRecordingsMb * MIB,
				minFreeBytes: this.caps.minFreeDiskMb * MIB,
			}),
			freeBytes: async () => (await this.statfs(this.root)).freeBytes,
			setAsideLogged: counts =>
				this.log.warn(
					counts,
					"Set aside incomplete analog operation folders (crash residue)",
				),
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
		// The folder mark lasts until the operation settled (a listing meanwhile keeps it).
		const settled = this.folders.mark(input.discoveryId)
		let handle: AnalogHandle
		try {
			handle = this.analog.begin(input)
		} catch (err) {
			settled()
			throw err
		}
		void handle.settled.then(settled, settled)
		return handle
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
			const moved = this.folders.mark(c.discoveryId)
			// Reserve before any await: DELETE drains this accepted move before acknowledging.
			await this.serialise(c.discoveryId, async () => {
				if (!this.admits(c.discoveryId)) return
				const target = join(this.root, "recordings", "dv", c.discoveryId)
				await mkdir(target, { recursive: true })
				// Never over a file already there: another discovery may list it.
				let name: string | undefined
				try {
					name = await publishFile(f.path, target, f.name)
				} catch (err) {
					if (errorCode(err) === "ENOENT") return
					throw err
				}
				if (name === undefined) {
					this.log.warn(
						{ discoveryId: c.discoveryId, file: f.name },
						"Dropped a probe recording: every name tried is taken",
					)
					return
				}
				linked.push({
					observationId: c.observationId,
					recordingId: `${c.discoveryId}~${name}`,
				})
			}).finally(moved)
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
		const written = this.folders.mark(discoveryId)
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
		}).finally(written)
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
		const written = this.folders.mark(discoveryId)
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
		}).finally(written)
	}

	recordingPath(recordingId: string): string | null {
		const m = RECORDING_ID.exec(recordingId)
		const discoveryId = m?.[1]
		const file = m?.[2]
		if (discoveryId === undefined || file === undefined || file.includes(".."))
			return null
		// An analog file is admitted per file: through its folder, or through the live discovery
		// owning it after a split (AnalogOperations.path).
		if (/^analog-[0-9a-f-]{36}\.wav$/i.test(file))
			return this.analog?.path(recordingId) ?? null
		// A recording another live discovery lists here (a split): admitted through it.
		if (
			!this.admits(discoveryId) &&
			!this.holders(discoveryId, file).some(id => this.admits(id))
		)
			return null
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
				const removing = [discoveryId, ...aliases]
				if (this.analog) {
					await this.analog.deleteDiscovery(discoveryId, removing)
					for (const alias of aliases)
						await this.analog.deleteDiscovery(alias, removing)
				}
				const removeFolders = async (id: string): Promise<void> => {
					if (!(await this.rootIntact()))
						throw new WaveKitError(
							"Scanner storage root changed",
							"SCANNER_EVIDENCE_CLEANUP_PENDING",
						)
					// Files in this folder another live discovery lists (a split twin's recording, of
					// any kind, however old its observation) or of a marked folder: they and the folder
					// stay; never a delete path to them. Asked again before each unlink, never cached.
					const keeps = (name: string): boolean =>
						this.removalKeeps(id, name, removing)
					if (this.protection) {
						await this.removeGuarded(id, keeps)
						return
					}
					await this.removeFolder(join(this.root, "evidence", id), () => false)
					for (const kind of RECORDING_KINDS) {
						const kept = await this.removeFolder(
							join(this.root, "recordings", kind, id),
							(name, top) => (top ? keeps(name) : this.heldFolderUnknown(id)),
						)
						this.noteKeptUnknown(id, kept)
					}
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
	 * Without a protection port: one folder of a removal (a recording or an evidence folder),
	 * walked file by file and never removed recursively (removeTree). A symlinked or
	 * non-directory discovery entry is unlinked as itself, never its target. The folder goes only
	 * once empty. Returns the entries kept.
	 */
	private async removeFolder(
		dir: string,
		keeps: (name: string, top: boolean) => boolean,
	): Promise<number> {
		const top = await realDirectory(dir)
		if (top === null) {
			await unlinkGone(dir).catch((err: unknown) => {
				// A real directory now (made since): left for the next removal.
				const code = errorCode(err)
				if (code !== "EISDIR" && code !== "EPERM" && code !== "ENOTDIR")
					throw err
			})
			return 0
		}
		const kept = await this.removeTree(
			dir,
			[{ path: dir, ...top }],
			keeps,
			true,
		)
		await rmdirIfEmpty(dir)
		return kept
	}

	/**
	 * One directory of a removal, depth first and never recursively, so no entry is reached
	 * without its own decision. Each entry is unlinked as itself (a symlink is never followed) in
	 * the same synchronous turn as `keeps(name, top)` (`top`: directly in the discovery folder,
	 * where a recording id names a file; deeper ones no id names), after every directory of
	 * `chain` (the listed real directories down to this one) is verified again, so a swap for an
	 * alias stops the removal (pending). A nested directory is descended only when lstat shows a
	 * real one, and removed (rmdir) only once empty: a kept file, or anything written since,
	 * keeps it. Returns the entries kept.
	 */
	private async removeTree(
		dir: string,
		chain: readonly DirIdentity[],
		keeps: (name: string, top: boolean) => boolean,
		top: boolean,
	): Promise<number> {
		const pending = (): never => {
			throw new WaveKitError(
				"Scanner evidence cleanup remains pending",
				"SCANNER_EVIDENCE_CLEANUP_PENDING",
			)
		}
		let entries
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch (err) {
			if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return 0
			throw err
		}
		let kept = 0
		for (const entry of entries) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) {
				const id = await realDirectory(path)
				if (id !== null) {
					const inner = [...chain, { path, ...id }]
					kept += await this.removeTree(path, inner, keeps, false)
					if (!(await chainIntact(inner))) pending()
					await rmdirIfEmpty(path)
					continue
				}
				// No real directory any more (a link or a file now): unlinked as itself below.
			}
			if (!(await chainIntact(chain))) pending()
			// From here to the unlink nothing awaits: the decision and the unlink share one turn.
			if (keeps(entry.name, top)) {
				kept++
				continue
			}
			await unlinkGone(path)
		}
		return kept
	}

	/** One log line when a removal kept files of a marked folder (numbers only). */
	private noteKeptUnknown(folderId: string, kept: number): void {
		if (kept > 0 && this.heldFolderUnknown(folderId))
			this.log.warn(
				{ kept },
				"Scanner removal kept recordings whose owner is unknown (ownership table full)",
			)
	}

	/**
	 * WG9 req 2.6 with a protection port: each recording file is unlinked only in the same
	 * synchronous turn as its protection answer and its keep answer (`keeps`: listed by any live
	 * discovery outside the removal, or a marked folder; a nested file by the mark alone), so a
	 * Keep, a listing or a mark that commits during the drain survives. A protected file stops the
	 * removal and leaves the folders in place; a kept one leaves its directories in place. Never a
	 * recursive removal, at any depth (removeTree).
	 */
	private async removeGuarded(
		discoveryId: string,
		keeps: (name: string) => boolean,
	): Promise<void> {
		const refuse = (): never => {
			throw new ScannerApiError(
				"Discovery holds kept recordings",
				SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
				409,
			)
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
			// Every entry at any depth through its own decision, in its unlink's turn: a file directly
			// in the folder by its keep answer (listed by another live discovery, or a marked
			// folder) and then the protection port (a protected file stops the removal); a deeper
			// one (no recording id names it) by the folder's mark alone.
			const kept = await this.removeTree(
				dir,
				chain,
				(name, atTop) => {
					if (!atTop) return this.heldFolderUnknown(discoveryId)
					if (keeps(name)) return true
					let protectedFile = true
					try {
						protectedFile =
							this.protection?.isScannerFileProtected(discoveryId, name) !==
							false
					} catch {
						protectedFile = true
					}
					if (protectedFile) refuse()
					return false
				},
				true,
			)
			this.noteKeptUnknown(discoveryId, kept)
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
			// Only an empty folder goes; one a kept file (or anything left) holds fails harmlessly.
			await rmdirIfEmpty(dir)
		}
		if (this.holdsKept(discoveryId)) refuse()
		const evidence = join(this.root, "evidence")
		if (refused || !(await safeAncestor(evidence))) pending()
		// The evidence folder holds no recording file (a recording id names one under recordings/
		// only), but it is walked the same way: nothing is removed recursively.
		const evidenceId = await realDirectory(evidence)
		const evidenceDir = join(evidence, discoveryId)
		const top = evidenceId === null ? null : await realDirectory(evidenceDir)
		if (evidenceId === null || top === null) {
			await unlinkGone(evidenceDir).catch((err: unknown) => {
				const code = errorCode(err)
				if (code !== "EISDIR" && code !== "EPERM" && code !== "ENOTDIR")
					throw err
			})
			return
		}
		await this.removeTree(
			evidenceDir,
			[
				{ path: evidence, ...evidenceId },
				{ path: evidenceDir, ...top },
			],
			() => false,
			true,
		)
		await rmdirIfEmpty(evidenceDir)
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
		const keep = keepDiscoveryIds
		const unresolved = new Set<string>()
		const unknownHeld = new Set<string>()
		/**
		 * One recording file's policy, asked again in its unlink's own turn: true keeps it. A
		 * marked folder or an unknown lister keeps it (counted), before anything else; so does a
		 * folder whose owner nothing resolves (counted). A file the ownership table records
		 * listers for follows them, the folder's own discovery only when it is one of them: kept
		 * while any lister is kept, otherwise aged and quota-removed like their own files. Any
		 * other file follows its folder's owner (an alias folder's survivor included).
		 */
		const recordingKept = (f: StoredFile): boolean => {
			const listers = this.listers(
				f.discoveryId,
				f.path.split("/").at(-1) ?? "",
			)
			if (listers === null) {
				unknownHeld.add(f.path)
				return true
			}
			if (!this.folderResolved(f.discoveryId)) {
				unresolved.add(f.discoveryId)
				return true
			}
			if (listers.length === 0) return keep.has(f.discoveryId)
			return listers.some(id => keep.has(id) || !this.folderResolved(id))
		}
		/** An evidence file follows its folder's owner; an unresolved folder keeps it (counted). */
		const evidenceKept = (f: StoredFile): boolean => {
			if (this.folderResolved(f.discoveryId)) return keep.has(f.discoveryId)
			unresolved.add(f.discoveryId)
			return true
		}
		const isProtected = (f: StoredFile): boolean =>
			f.probe ||
			now - f.mtimeMs < RECORDING_IN_PROGRESS_MS ||
			(f.category === "recordings" ? recordingKept(f) : evidenceKept(f)) ||
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
			// WG9 req 2.5: every listed directory is re-verified first (a swapped one skips the file).
			if (this.protection && !(await chainIntact(f.chain ?? []))) return false
			// The whole decision again, then a single-syscall unlink in the same turn (rm lstats
			// first): a listing, a folder mark, a split or a Keep that landed during an await of
			// this pass keeps the file.
			if (isProtected(f)) return false
			await unlinkGone(f.path)
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
		let recordingsLeft = 0
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
			if (category === "recordings") recordingsLeft = total
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
		// The folders left on disk: an alias whose folder retention emptied may be released again.
		await this.loadFolderIndex().catch((err: unknown) =>
			this.log.debug({ err }, "Scanner folder listing failed"),
		)
		this.unresolvedFolders = unresolved.size
		this.unknownHeldFiles = unknownHeld.size
		this.noteQuota(recordingsLeft + (this.analog?.managedBytes ?? 0))
		if (unknownHeld.size > 0)
			this.log.debug(
				{ kept: unknownHeld.size },
				"Scanner retention kept recordings whose owner is unknown",
			)
		if (unresolved.size > 0)
			this.log.debug(
				{ unresolved: unresolved.size },
				"Scanner retention kept folders without an owner",
			)
		if (this.quarantinedRecordingCount > 0)
			this.log.debug(
				{ quarantined: this.quarantinedRecordingCount },
				"Scanner retention kept quarantined recordings",
			)
		if (deleted.length > 0)
			this.log.info(
				{ deleted: deleted.length },
				"Scanner retention removed files",
			)
		return { deleted }
	}

	/**
	 * The recordings left after a retention pass against the quota: entering or leaving the
	 * exceeded state logs once (numbers only).
	 */
	private noteQuota(usedBytes: number): void {
		const capBytes = this.caps.maxRecordingsMb * MIB
		const next =
			Number.isFinite(usedBytes) && usedBytes > capBytes
				? {
						capBytes,
						usedBytes,
						overBytes: usedBytes - capBytes,
					}
				: null
		if (next !== null && this.quotaExceeded === null)
			this.log.warn(
				{
					reason: "storage-cap",
					capBytes: next.capBytes,
					usedBytes: next.usedBytes,
					overBytes: next.overBytes,
				},
				"Scanner recordings quota exceeded and retention may remove nothing more; analog recordings are refused (storage-cap)",
			)
		else if (next === null && this.quotaExceeded !== null)
			this.log.info(
				{ reason: "storage-cap", capBytes },
				"Scanner recordings quota no longer exceeded; analog recordings are admitted again",
			)
		this.quotaExceeded = next
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
