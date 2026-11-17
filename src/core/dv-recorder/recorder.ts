/**
 * The digital-voice call recorder: one WAV per clear call, fed by the digital-voice service's
 * per-call PCM tap (src/core/dv-tap/types.ts).
 *
 * One record per (decoderId, callId, slot), in one of these phases:
 * - PENDING: started, no audio yet (no file);
 * - WRITING: a `TEMP_dv_*.wav` is open on its own FileHandle (first block, held or not);
 * - CLOSED: finalized (renamed, or dropped as too short) and waiting for the tap's `end`, after
 *   the max-call cap cut it;
 * - ABANDONED: encrypted, ended while not clear, or a write failed: the TEMP is unlinked.
 * IDLE is the absence of a record. The tap sends exactly one `end` per call, so the recorder adds
 * no timer. Nothing on a tap event is awaited or sync: file work runs on each writer's chain.
 *
 * Bounds (the arithmetic of each):
 * - 8 000 samples/s × 2 B = 16 000 B/s of PCM.
 * - minVoiceMs (1 000 ms default) of non-zero samples: 8 000 voiced samples = 16 000 B. Every
 *   sample is scanned; a block of zeros is silence.
 * - maxCallMs (300 000 ms default): 2 400 000 samples = 4 800 000 B per file (+ 44 B header).
 * - Free disk: a call starts only while the free figure (statfs at the last prune pass, less
 *   what was written since) is at least DV_RECORDER_FREE_FLOOR_BYTES (512 MiB).
 * - The directory total: a call starts only while the in-memory byte total is below
 *   retentionBytes (2 GiB default ≈ 37.3 h of voice: 2 147 483 648 / 16 000 / 3 600). Calls in
 *   flight finish, so the total can pass the cap by at most (concurrent calls × 4.8 MB) before the
 *   prune pass that follows a rename brings it back.
 * - Retention deletes only while the recording protection port is installed
 *   (`protectionInstalled`): without it a pass only measures the directory, so a Kept recording
 *   is never deleted by a recorder wired before the keep service.
 * - The directory must be a real directory (lstat at start): a symlinked one is refused, since
 *   retention would follow it and could delete outside the recorder's own files.
 */

import { promises as nodeFs } from "node:fs"
import * as path from "node:path"
import {
	DSD_FME_CALL_WAV,
	DSD_FME_TEMP_WAV,
	pruneCallRecordings,
} from "../../decoders/builtin/call-recordings.js"
import type {
	CallRecordingRetention,
	PruneResult,
} from "../../decoders/builtin/call-recordings.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import type {
	DvCallTap,
	DvCallTapSource,
	DvTapCallEnd,
	DvTapCallRef,
	DvTapCallStart,
	DvTapCallState,
	DvTapCallStateChange,
	DvTapDrop,
	DvTapEndReason,
	DvTapPcm,
} from "../dv-tap/types.js"
import { DV_TAP_SAMPLE_RATE_HZ } from "../dv-tap/types.js"
import { DV_TEMP_WAV, dvCallFileName, dvTempFileName } from "./names.js"
import type { DvCallNameInfo } from "./names.js"
import { DvWavWriter, WAV_HEADER_BYTES } from "./wav-writer.js"
import type { DvWavFs, DvWavHandle } from "./wav-writer.js"

/** Free space below which no call starts: 512 MiB = 536 870 912 B (about 9.3 h of voice). */
export const DV_RECORDER_FREE_FLOOR_BYTES = 512 * 1024 * 1024
/**
 * While the free figure is under the floor (or zeroed by a write error), a refused start runs a
 * fresh prune pass (which re-reads statfs) at most once per this interval: 60 000 ms.
 */
export const DV_RECORDER_PRUNE_RETRY_MS = 60_000
/**
 * Final-name attempts when a name is taken (link() fails EEXIST; five random digits each): with
 * n final names of one second, decoder and call fields on disk, all five draws collide with
 * probability (n / 100 000)^5, so 10^-15 even at n = 100.
 */
export const DV_RECORDER_NAME_ATTEMPTS = 5
/** Samples per millisecond at the tap rate: 8. */
const SAMPLES_PER_MS = DV_TAP_SAMPLE_RATE_HZ / 1000

export interface DvRecorderSettings {
	enabled: boolean
	/** Absolute directory (flat; created at start). */
	dir: string
	minVoiceMs: number
	maxCallMs: number
	retentionBytes: number
	retentionDays: number
}

export interface DvRecorderStatfs {
	bavail: number | bigint
	bsize: number | bigint
}

export interface DvRecorderStats {
	isFile(): boolean
	isDirectory(): boolean
	isSymbolicLink(): boolean
	size: number
}

/** The filesystem calls the recorder makes. A test seam. */
export interface DvRecorderFs extends DvWavFs {
	/** A hard link; rejects EEXIST when `to` exists (never replaces a file). */
	link(from: string, to: string): Promise<void>
	lstat(p: string): Promise<DvRecorderStats>
	readdir(dir: string): Promise<string[]>
	mkdir(dir: string): Promise<void>
	statfs(dir: string): Promise<DvRecorderStatfs>
}

export const nodeDvRecorderFs: DvRecorderFs = {
	open: async (p, flags) => {
		const h = await nodeFs.open(p, flags, 0o644)
		const handle: DvWavHandle = {
			write: (b, o, l, pos) => h.write(b, o, l, pos),
			close: () => h.close(),
		}
		return handle
	},
	unlink: p => nodeFs.unlink(p),
	link: (a, b) => nodeFs.link(a, b),
	lstat: p => nodeFs.lstat(p),
	readdir: d => nodeFs.readdir(d),
	mkdir: async d => {
		await nodeFs.mkdir(d, { recursive: true })
	},
	statfs: d => nodeFs.statfs(d),
}

/** What the recorder reports once a call's file is in place (round 2 links it to Activity). */
export interface DvRecordingFinalized {
	decoderId: string
	callId: string
	slot: 1 | 2 | null
	/** The final file name (a basename); its keep key is `dsd~<fileName>`. */
	fileName: string
	/** Written audio: samples / 8. */
	durationMs: number
	/** Samples the tap delivered for the call (the tap's end figure when the call ended). */
	deliveredSamples: number
	/** Clear samples dropped before the tap (gaps in the file). */
	lostSamples: number
	/** True when the file holds audio released by the service as held (pre-call or while unknown). */
	held: boolean
	/** True when the max-call cap cut the file. */
	truncated: boolean
	/** The tap's end reason, or null when the cap finalized the file before the end. */
	reason: DvTapEndReason | null
	bytes: number
}

export interface DvRecorderCounters {
	recorded: number
	tooShort: number
	encryptedDiscarded: number
	notClearDiscarded: number
	writeErrors: number
	truncated: number
	refusedFloor: number
	refusedCap: number
	outOfOrder: number
	pruneErrors: number
	/** Passes that only measured: no protection port installed, so nothing was deleted. */
	pruneUnprotected: number
	/** start() refused the directory (a symlink, not a directory, or not creatable). */
	refusedDir: number
	/** Calls dropped because every final-name attempt was taken. */
	nameExhausted: number
	active: number
}

export interface DvCallRecorderOptions {
	settings: DvRecorderSettings
	source: DvCallTapSource
	logger: Logger
	/** The call's name fields (talkgroup, source, type), read when the file is named. */
	callInfo?: (ref: DvTapCallRef) => DvCallNameInfo | null
	onFinalized?: (r: DvRecordingFinalized) => void
	/**
	 * Whether the recording protection port is installed (setCallRecordingProtection). Retention
	 * deletes only while this returns true. Absent: never true (fail closed: no deletion until the
	 * core wires the keep service's state here).
	 */
	protectionInstalled?: () => boolean
	fs?: DvRecorderFs
	/** Test seam for the retention pass (pruneCallRecordings on the recorder directory). */
	prune?: (
		dir: string,
		retention: CallRecordingRetention,
		nowMs: number,
	) => Promise<PruneResult>
	now?: () => number
	random?: () => number
}

export interface DvCallRecorder {
	/** Creates the dir, sweeps TEMP leftovers, runs one prune pass, then adds the tap. */
	start(): Promise<void>
	/** Removes the tap, finalizes every open call and waits for every close and rename. */
	stop(): Promise<void>
	counters(): DvRecorderCounters
	/** The in-memory byte total of final recordings in the directory. */
	bytesTotal(): number
}

type Phase = "pending" | "writing" | "closed" | "abandoned"

interface Rec {
	ref: DvTapCallRef
	startedAtMs: number
	phase: Phase
	state: DvTapCallState
	writer: DvWavWriter | null
	/** Samples received from the tap (contiguity: the next block's firstSample). */
	received: number
	written: number
	voiced: number
	lost: number
	held: boolean
	work: Promise<void> | null
}

function recKey(ref: DvTapCallRef): string {
	return `${ref.decoderId}\u0000${ref.callId}\u0000${ref.slot ?? 0}`
}

/** The errno code of a rejection, or null (never assumes the shape). */
function errCode(err: unknown): string | null {
	if (err instanceof Error && "code" in err) {
		const code = (err as { code?: unknown }).code
		return typeof code === "string" ? code : null
	}
	return null
}

function bytesOfStatfs(s: DvRecorderStatfs): number {
	const v = Number(s.bavail) * Number(s.bsize)
	return Number.isFinite(v) && v >= 0 ? v : 0
}

const MIB = 1024 * 1024

export function createDvCallRecorder(
	options: DvCallRecorderOptions,
): DvCallRecorder {
	const settings = options.settings
	const fs = options.fs ?? nodeDvRecorderFs
	const log = createComponentLogger(options.logger, "DvCallRecorder")
	const now = options.now ?? Date.now
	const random = options.random ?? Math.random
	const dir = settings.dir
	const minVoicedSamples = settings.minVoiceMs * SAMPLES_PER_MS
	const maxSamples = settings.maxCallMs * SAMPLES_PER_MS
	const retention: CallRecordingRetention = {
		maxTotalMb: settings.retentionBytes / MIB,
		maxAgeHours: settings.retentionDays * 24,
	}
	const prune =
		options.prune ??
		((d: string, r: CallRecordingRetention, at: number) =>
			pruneCallRecordings([d], r, at))

	const protectionInstalled = options.protectionInstalled ?? (() => false)

	const recs = new Map<string, Rec>()
	const work = new Set<Promise<void>>()
	let removeTap: (() => void) | null = null
	let running = false
	let starting: Promise<void> | null = null
	let stopping: Promise<void> | null = null
	let total = 0
	let addedSincePrune = 0
	let free = 0
	let pruning: Promise<void> | null = null
	let pruneAgain = false
	let lastPruneAt = Number.NEGATIVE_INFINITY
	let warnedWrite = false
	let tempSeq = Math.floor(random() * 0x10000)
	const counts: DvRecorderCounters = {
		recorded: 0,
		tooShort: 0,
		encryptedDiscarded: 0,
		notClearDiscarded: 0,
		writeErrors: 0,
		truncated: 0,
		refusedFloor: 0,
		refusedCap: 0,
		outOfOrder: 0,
		pruneErrors: 0,
		pruneUnprotected: 0,
		refusedDir: 0,
		nameExhausted: 0,
		active: 0,
	}

	function track(p: Promise<void>): Promise<void> {
		const t = p.catch((err: unknown) => {
			log.warn({ err: safeErrorFields(err) }, "Call recording step failed")
		})
		work.add(t)
		void t.finally(() => work.delete(t))
		return t
	}

	/**
	 * Without a protection port nothing is deleted: the pass only sums the final call names
	 * (lstat, regular files only), as the pruner would count them.
	 */
	async function measure(): Promise<number> {
		const names = await fs.readdir(dir)
		let bytes = 0
		for (const name of names) {
			if (!DSD_FME_CALL_WAV.test(name) || DSD_FME_TEMP_WAV.test(name)) continue
			try {
				const st = await fs.lstat(path.join(dir, name))
				if (st.isFile() && !st.isSymbolicLink()) bytes += st.size
			} catch {
				// Gone meanwhile.
			}
		}
		return bytes
	}

	async function prunePass(): Promise<void> {
		lastPruneAt = now()
		// Renames during the pass add here; the listing may or may not have seen them, so they
		// are added once more after it (an overcount of at most those files, fixed next pass).
		addedSincePrune = 0
		try {
			let kept: number
			if (protectionInstalled()) {
				kept = (await prune(dir, retention, now())).keptBytes
			} else {
				counts.pruneUnprotected++
				kept = await measure()
			}
			// Snapshot after the pass, then reset: the next pass counts from here.
			const added = addedSincePrune
			addedSincePrune = 0
			total = kept + added
		} catch (err) {
			counts.pruneErrors++
			log.warn({ err: safeErrorFields(err) }, "Call recording retention failed")
		}
		try {
			free = bytesOfStatfs(await fs.statfs(dir))
		} catch (err) {
			// Fail closed: an unknown free figure records nothing until the next pass.
			free = 0
			log.warn({ err: safeErrorFields(err) }, "Free space unknown")
		}
	}

	/** One pass in flight; a request during a pass runs one more pass after it. */
	function requestPrune(): void {
		if (pruning !== null) {
			pruneAgain = true
			return
		}
		pruning = track(
			(async () => {
				do {
					pruneAgain = false
					await prunePass()
				} while (pruneAgain && running)
			})(),
		).finally(() => {
			pruning = null
		})
	}

	function accept(e: DvTapCallStart): boolean {
		if (e.state === "encrypted") return false
		if (free < DV_RECORDER_FREE_FLOOR_BYTES) {
			counts.refusedFloor++
			if (now() - lastPruneAt >= DV_RECORDER_PRUNE_RETRY_MS) requestPrune()
			return false
		}
		if (total >= settings.retentionBytes) {
			counts.refusedCap++
			return false
		}
		return true
	}

	function onStart(e: DvTapCallStart): void {
		const key = recKey(e)
		const prev = recs.get(key)
		// The tap sends one end per start; a repeated start replaces a stale record.
		if (prev !== undefined) {
			finalize(prev, null, null)
			recs.delete(key)
			counts.active = recs.size
		}
		if (!accept(e)) return
		recs.set(key, {
			ref: { decoderId: e.decoderId, callId: e.callId, slot: e.slot },
			startedAtMs: e.startedAtMs,
			phase: "pending",
			state: e.state,
			writer: null,
			received: 0,
			written: 0,
			voiced: 0,
			lost: 0,
			held: false,
			work: null,
		})
		counts.active = recs.size
	}

	function abandon(rec: Rec): void {
		if (rec.phase === "abandoned" || rec.phase === "closed") return
		rec.phase = "abandoned"
		const w = rec.writer
		rec.writer = null
		if (w !== null) {
			// An abandoned writer's later failures (a close during abort) are not write errors.
			w.onError = null
			rec.work = track(w.abort())
		}
	}

	function onState(e: DvTapCallStateChange): void {
		const rec = recs.get(recKey(e))
		if (rec === undefined) return
		rec.state = e.state
		if (e.state === "encrypted") {
			if (rec.phase === "pending" || rec.phase === "writing")
				counts.encryptedDiscarded++
			abandon(rec)
		}
	}

	/** A8: called once per writer, on its first open, write or close failure. */
	function writeError(rec: Rec, err: unknown): void {
		if (rec.phase === "abandoned") return
		counts.writeErrors++
		// The disk may be full: no call starts until a prune pass reads the free space again.
		free = 0
		if (!warnedWrite) {
			warnedWrite = true
			log.warn(
				{ err: safeErrorFields(err) },
				"Call recording write failed; the call is not kept",
			)
		}
		abandon(rec)
	}

	function openWriter(rec: Rec): DvWavWriter {
		// A counter, not a draw: TEMP names in flight never collide (65 536 before a repeat).
		tempSeq = (tempSeq + 1) & 0xffff
		const name = dvTempFileName(rec.startedAtMs, tempSeq)
		const w = new DvWavWriter(fs, path.join(dir, name))
		w.onError = err => writeError(rec, err)
		return w
	}

	function onPcm(e: DvTapPcm): void {
		const rec = recs.get(recKey(e))
		if (rec === undefined) return
		if (rec.phase !== "pending" && rec.phase !== "writing") return
		if (rec.state !== "clear") return
		const n = e.pcm.length
		if (e.firstSample < rec.received) {
			// An overlap or a repeat: contiguity is the tap's guarantee, never write twice.
			counts.outOfOrder++
			return
		}
		if (e.firstSample > rec.received) {
			counts.outOfOrder++
			rec.lost += e.firstSample - rec.received
		}
		rec.received = e.firstSample + n
		if (n === 0) return
		if (rec.writer === null) {
			rec.writer = openWriter(rec)
			rec.phase = "writing"
		}
		const room = maxSamples - rec.written
		const take = Math.min(n, room)
		if (take > 0) {
			rec.voiced += rec.writer.append(e.pcm, 0, take)
			rec.written += take
			free -= 2 * take
			if (e.held) rec.held = true
		}
		if (take < n || rec.written >= maxSamples) {
			counts.truncated++
			finalize(rec, null, null, true)
		}
	}

	function onDrop(e: DvTapDrop): void {
		const rec = recs.get(recKey(e))
		if (rec === undefined) return
		rec.lost += Math.max(0, e.lostSamples)
	}

	function onEnd(e: DvTapCallEnd): void {
		const key = recKey(e)
		const rec = recs.get(key)
		if (rec === undefined) return
		recs.delete(key)
		counts.active = recs.size
		if (rec.phase === "closed" || rec.phase === "abandoned") return
		if (e.finalState !== "clear") {
			counts.notClearDiscarded++
			abandon(rec)
			return
		}
		finalize(rec, e, e.reason)
	}

	/** A9: flush, patch, close, then rename (or unlink a call under minVoiceMs). */
	function finalize(
		rec: Rec,
		end: DvTapCallEnd | null,
		reason: DvTapEndReason | null,
		truncated = false,
	): void {
		if (rec.phase === "closed" || rec.phase === "abandoned") return
		if (end === null && !truncated) {
			// A stale record replaced by a new start, or stop(): keep it only while known clear.
			if (rec.state !== "clear") {
				abandon(rec)
				return
			}
		}
		rec.phase = "closed"
		const w = rec.writer
		rec.writer = null
		if (w === null) return
		if (rec.voiced < minVoicedSamples) {
			counts.tooShort++
			w.onError = null
			rec.work = track(w.abort())
			return
		}
		const info: Omit<DvRecordingFinalized, "fileName" | "bytes"> = {
			decoderId: rec.ref.decoderId,
			callId: rec.ref.callId,
			slot: rec.ref.slot,
			durationMs: Math.round(rec.written / SAMPLES_PER_MS),
			deliveredSamples: end?.deliveredSamples ?? rec.received,
			lostSamples: Math.max(end?.lostSamples ?? 0, rec.lost),
			held: rec.held,
			truncated,
			reason,
		}
		rec.work = track(commit(rec, w, info))
	}

	async function commit(
		rec: Rec,
		w: DvWavWriter,
		info: Omit<DvRecordingFinalized, "fileName" | "bytes">,
	): Promise<void> {
		let dataBytes: number
		try {
			dataBytes = await w.finish()
		} catch {
			// The writer reported the failure (writeError) already: drop the TEMP.
			await w.abort()
			return
		}
		let lookup: DvCallNameInfo | null = null
		try {
			lookup = options.callInfo?.(rec.ref) ?? null
		} catch {
			lookup = null
		}
		const name = await linkFinal(rec, w.path, lookup)
		// The final name holds the file (or nothing was kept): the TEMP name goes either way.
		await fs.unlink(w.path).catch(() => undefined)
		if (name === null) return
		const bytes = dataBytes + WAV_HEADER_BYTES
		total += bytes
		addedSincePrune += bytes
		counts.recorded++
		warnedWrite = false
		const cb = options.onFinalized
		if (cb !== undefined) {
			try {
				cb({ ...info, fileName: name, bytes })
			} catch (err) {
				log.warn({ err: safeErrorFields(err) }, "Recording listener failed")
			}
		}
		if (total > settings.retentionBytes) requestPrune()
	}

	/**
	 * Links the TEMP file to a free final name: link() never replaces a file, so a taken name
	 * (EEXIST, on disk or linked by another call meanwhile) draws the next one, at most
	 * DV_RECORDER_NAME_ATTEMPTS times. Null when nothing was linked.
	 */
	async function linkFinal(
		rec: Rec,
		temp: string,
		lookup: DvCallNameInfo | null,
	): Promise<string | null> {
		for (let i = 0; i < DV_RECORDER_NAME_ATTEMPTS; i++) {
			const name = dvCallFileName(
				rec.startedAtMs,
				Math.floor(random() * 100_000),
				rec.ref.decoderId,
				lookup,
			)
			try {
				await fs.link(temp, path.join(dir, name))
				return name
			} catch (err) {
				if (errCode(err) === "EEXIST") continue
				counts.writeErrors++
				log.warn({ err: safeErrorFields(err) }, "Call recording rename failed")
				return null
			}
		}
		counts.nameExhausted++
		log.warn(
			{ attempts: DV_RECORDER_NAME_ATTEMPTS },
			"Call recording names all taken; the call is not kept",
		)
		return null
	}

	async function sweepTemps(): Promise<void> {
		let names: string[]
		try {
			names = await fs.readdir(dir)
		} catch (err) {
			log.warn({ err: safeErrorFields(err) }, "Call recording sweep failed")
			return
		}
		let removed = 0
		for (const name of names) {
			if (!DV_TEMP_WAV.test(name)) continue
			const p = path.join(dir, name)
			try {
				const st = await fs.lstat(p)
				if (!st.isFile() || st.isSymbolicLink()) continue
				await fs.unlink(p)
				removed++
			} catch {
				// Gone meanwhile.
			}
		}
		if (removed > 0) log.info({ removed }, "Removed unfinished call recordings")
	}

	const tap: DvCallTap = {
		start: e => {
			if (running) onStart(e)
		},
		state: e => {
			if (running) onState(e)
		},
		pcm: e => {
			if (running) onPcm(e)
		},
		drop: e => {
			if (running) onDrop(e)
		},
		end: e => {
			if (running) onEnd(e)
		},
	}

	/** M2: the directory must be a real directory, never a symlink (retention would follow it). */
	async function dirUsable(): Promise<boolean> {
		try {
			await fs.mkdir(dir)
			const st = await fs.lstat(dir)
			if (!st.isSymbolicLink() && st.isDirectory()) return true
			counts.refusedDir++
			log.warn(
				{ symlink: st.isSymbolicLink() },
				"Call recording directory is not a real directory; recording is off",
			)
		} catch (err) {
			counts.refusedDir++
			log.warn(
				{ err: safeErrorFields(err) },
				"Call recording directory unusable; recording is off",
			)
		}
		return false
	}

	async function doStart(): Promise<void> {
		// A stop in progress finishes its closes and renames first.
		if (stopping !== null) await stopping
		if (!settings.enabled || running) return
		if (!(await dirUsable())) return
		// A12: only here, never while calls are being written.
		await sweepTemps()
		await prunePass()
		running = true
		removeTap = options.source.addCallTap(tap)
	}

	async function doStop(): Promise<void> {
		running = false
		const remove = removeTap
		removeTap = null
		try {
			remove?.()
		} catch {
			// The service is stopping too.
		}
		for (const rec of [...recs.values()]) finalize(rec, null, "shutdown")
		recs.clear()
		counts.active = 0
		while (work.size > 0) await Promise.all([...work])
	}

	return {
		start(): Promise<void> {
			starting ??= doStart().finally(() => {
				starting = null
			})
			return starting
		},
		async stop(): Promise<void> {
			// A start in progress adds its tap first, so this stop removes it.
			if (starting !== null) await starting.catch(() => undefined)
			if (stopping !== null) return stopping
			if (!running) return
			stopping = doStop().finally(() => {
				stopping = null
			})
			return stopping
		},
		counters: () => ({ ...counts }),
		bytesTotal: () => total,
	}
}
