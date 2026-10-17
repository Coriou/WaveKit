/**
 * Main-thread side of the snapshot worker (WG11 req 3.5, design "Snapshot worker"). Feeds the
 * worker's mirror with the journal lines and `mirror-removal` events, posts snapshot requests at
 * the caller's point in the line stream and commits them when their turn on the persistence chain
 * comes. Everything it posts is bounded:
 *
 * - lines, removals and requests are charged 2 bytes per UTF-16 unit plus `MESSAGE_OVERHEAD_BYTES`
 *   and acknowledged by the worker in order (`applied`); past `maxQueuedBytes` (default 16 MiB)
 *   nothing more is posted, the mirror goes stale and the next snapshot is written on the main
 *   thread, which resets the mirror. So at most 16 MiB of charged messages, plus
 * - one reset text (the main path's own snapshot text, already built) not yet acknowledged, and
 * - one commit (the persistence chain runs one snapshot at a time).
 *
 * The worker holds the mirror (about one snapshot text of record JSON) plus at most one built
 * text, so its heap is about 2 x the snapshot text; `status()` reports the heap it last measured.
 * A failed or misbehaving worker fails over: that snapshot is written on the main thread (warned
 * at most once an hour, counted), the worker is restarted once, and after a second failure the
 * main thread writes every snapshot for the life of the process (warned once).
 */
import { rename, rm } from "node:fs/promises"
import { totalmem } from "node:os"
import { Worker } from "node:worker_threads"
import { safeErrorFields } from "../../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../../utils/errors.js"
import type { Logger } from "../../../utils/logger.js"
import type { MirrorCounts, SnapshotHead } from "./snapshot-mirror.js"
import { isSnapshotWorkerResponse } from "./snapshot-protocol.js"
import type {
	SnapshotFailReason,
	SnapshotWorkerRequest,
	SnapshotWorkerResponse,
} from "./snapshot-protocol.js"

/** Charged per posted message besides its text: structured-clone envelope, array slot, FIFO entry. */
export const MESSAGE_OVERHEAD_BYTES = 256
/** Charged bytes of unacknowledged messages past which the mirror goes stale (not queued further). */
export const DEFAULT_SNAPSHOT_QUEUE_BYTES = 16 * 1024 * 1024
/** Floor of the commit timeout (review m4): small snapshots get a minute. */
export const DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS = 60_000
/** The slowest disk the commit timeout allows for: 1 MiB/s of snapshot text. */
export const SNAPSHOT_COMMIT_BYTES_PER_SECOND = 1024 * 1024
/** Ceiling of the scaled commit timeout: a commit never holds the persistence queue past 10 min. */
export const MAX_SNAPSHOT_COMMIT_TIMEOUT_MS = 600_000

/**
 * Review m4: the commit timeout scales with the expected text size, `max(base, ceil(bytes /
 * 1 MiB/s) s)`, capped at `max(base, 10 min)`. `bytes` is the larger of the last written text and
 * the last reset text (the main path's snapshot), so a store that grows between commits is judged
 * against its recent size; a timeout fails over to the main thread, which then writes that one.
 */
export function snapshotCommitTimeoutMs(baseMs: number, bytes: number): number {
	const scaled =
		Number.isFinite(bytes) && bytes > 0
			? Math.ceil(bytes / SNAPSHOT_COMMIT_BYTES_PER_SECOND) * 1000
			: 0
	return Math.max(baseMs, Math.min(MAX_SNAPSHOT_COMMIT_TIMEOUT_MS, scaled))
}

/**
 * A failed worker's snapshot waits for the worker to exit before the fallback writes, but at most
 * this long: a worker that never exits must not stall the persistence queue. Past it the worker is
 * abandoned and snapshots stay on the main thread for good. An abandoned worker can at worst write
 * its own tmp file late: only the main thread renames, and only for its live, current commit. The
 * abandoned commit's tmp path is remembered and removed again when the worker finally exits, at
 * every later main-thread snapshot (`sweepAbandoned`) and at close.
 */
export const DEFAULT_SNAPSHOT_TERMINATE_WAIT_MS = 10_000
export const MIN_SNAPSHOT_WORKER_HEAP_MB = 256
export const MAX_SNAPSHOT_WORKER_HEAP_MB = 2048

/**
 * Old-space limit of the worker (review m2): a quarter of the host memory, clamped to
 * [256 MiB, 2 GiB]. The worker holds the mirror (about one snapshot text of record JSON) plus one
 * capture of references, and during a reset the reset text and its parse besides; an
 * out-of-memory worker exits and fails over to the main thread, so the limit only bounds the
 * worker, never correctness.
 */
export function defaultSnapshotWorkerHeapMb(
	totalBytes: number = totalmem(),
): number {
	const quarterMb = Math.floor(totalBytes / 4 / (1024 * 1024))
	if (!Number.isFinite(quarterMb)) return MIN_SNAPSHOT_WORKER_HEAP_MB
	return Math.min(
		MAX_SNAPSHOT_WORKER_HEAP_MB,
		Math.max(MIN_SNAPSHOT_WORKER_HEAP_MB, quarterMb),
	)
}
const WARN_INTERVAL_MS = 3_600_000

/** Worker entry after esbuild flattens this module into dist/index.js (dist/snapshot-worker.js). */
export function defaultSnapshotWorkerUrl(): URL {
	return new URL("./snapshot-worker.js", import.meta.url)
}

/** The worker surface the writer uses; the factory seam for tests. */
export interface SnapshotWorkerPort {
	postMessage(message: SnapshotWorkerRequest): void
	onMessage(listener: (value: unknown) => void): void
	onError(listener: (err: unknown) => void): void
	onExit(listener: (code: number) => void): void
	terminate(): Promise<unknown>
}

export type SnapshotWorkerFactory = (opts: {
	url: URL
	heapMb: number
}) => SnapshotWorkerPort

export const defaultSnapshotWorkerFactory: SnapshotWorkerFactory = ({
	url,
	heapMb,
}) => {
	const worker = new Worker(url, {
		name: "scanner-snapshot",
		resourceLimits: { maxOldGenerationSizeMb: heapMb },
	})
	worker.unref()
	return {
		postMessage: message => worker.postMessage(message),
		onMessage: listener => worker.on("message", listener),
		onError: listener => {
			worker.on("error", listener)
			worker.on("messageerror", listener)
		},
		onExit: listener => worker.on("exit", listener),
		terminate: () => worker.terminate(),
	}
}

export interface SnapshotWriterOptions {
	logger: Logger
	now: () => number
	url?: URL
	factory?: SnapshotWorkerFactory
	maxQueuedBytes?: number
	commitTimeoutMs?: number
	terminateWaitMs?: number
	heapMb?: number
}

export interface CommitWritten {
	ok: true
	bytes: number
	buildMs: number
	writeMs: number
}
export type CommitResult =
	| CommitWritten
	| { ok: false; reason: SnapshotFailReason | "worker-failed" }

export interface SnapshotWorkerStatus {
	state: "idle" | "stale" | "live" | "disabled"
	failures: number
	fallbacks: number
	divergences: number
	overflows: number
	queuedBytes: number
	heapUsedBytes: number | null
	lastTextBytes: number | null
	lastBuildMs: number | null
	lastWriteMs: number | null
}

type Posted =
	| { kind: "charged"; charged: number }
	| { kind: "reset"; charged: number }

interface PendingCommit {
	id: number
	file: string
	/** The worker writes only this file; the main thread renames it or removes it. */
	tmp: string
	resolve: (r: CommitResult) => void
	timer: ReturnType<typeof setTimeout>
}

/** Tmp file the worker writes for commit `id`, off the main thread's `<file>.<pid>.tmp`. */
export function snapshotWorkerTmp(file: string, id: number): string {
	return `${file}.${process.pid}.worker-${id}.tmp`
}

/** Removes a commit's tmp file (never published), then reports the outcome. */
function discard(commit: PendingCommit, result: CommitResult): void {
	void rm(commit.tmp, { force: true })
		.catch(() => undefined)
		.then(() => commit.resolve(result))
}

export class SnapshotWriter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly url: URL
	private readonly factory: SnapshotWorkerFactory
	private readonly maxQueuedBytes: number
	private readonly commitTimeoutMs: number
	private readonly terminateWaitMs: number
	private readonly heapMb: number
	private port: SnapshotWorkerPort | null = null
	/** True while the worker's mirror tracks the store (reset applied in order, nothing dropped). */
	private synced = false
	private disabled = false
	private failures = 0
	private readonly posted: Posted[] = []
	private queuedBytes = 0
	private resetInFlight = false
	private lines: string[] = []
	private linesCharge = 0
	private flushScheduled = false
	private nextId = 1
	private commit: PendingCommit | null = null
	private fallbacks = 0
	private divergences = 0
	private overflows = 0
	private lastWarnAt: number | null = null
	private suppressedWarns = 0
	private heapUsedBytes: number | null = null
	private lastTextBytes: number | null = null
	private lastBuildMs: number | null = null
	private lastWriteMs: number | null = null
	private lastResetChars = 0
	/** Tmp files of commits whose worker was abandoned while it could still write them. */
	private readonly abandonedTmps = new Set<string>()

	constructor(opts: SnapshotWriterOptions) {
		this.log = opts.logger
		this.now = opts.now
		this.url = opts.url ?? defaultSnapshotWorkerUrl()
		this.factory = opts.factory ?? defaultSnapshotWorkerFactory
		this.maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_SNAPSHOT_QUEUE_BYTES
		this.commitTimeoutMs =
			opts.commitTimeoutMs ?? DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS
		this.terminateWaitMs =
			opts.terminateWaitMs ?? DEFAULT_SNAPSHOT_TERMINATE_WAIT_MS
		this.heapMb = opts.heapMb ?? defaultSnapshotWorkerHeapMb()
	}

	/** The mirror tracks the store: a snapshot can go to the worker. */
	live(): boolean {
		return this.synced && this.port !== null && !this.disabled
	}

	status(): SnapshotWorkerStatus {
		return {
			state: this.disabled
				? "disabled"
				: this.port === null
					? "idle"
					: this.synced
						? "live"
						: "stale",
			failures: this.failures,
			fallbacks: this.fallbacks,
			divergences: this.divergences,
			overflows: this.overflows,
			queuedBytes: this.queuedBytes + this.linesCharge,
			heapUsedBytes: this.heapUsedBytes,
			lastTextBytes: this.lastTextBytes,
			lastBuildMs: this.lastBuildMs,
			lastWriteMs: this.lastWriteMs,
		}
	}

	/** The mirror no longer matches (another store attached): the next snapshot resets it. */
	markStale(): void {
		this.synced = false
		this.dropLines()
	}

	/** One journal line, in seq order (refused ones included: the mirror tracks the store). */
	feed(line: string): void {
		if (!this.live()) return
		const charge = line.length * 2 + MESSAGE_OVERHEAD_BYTES
		if (!this.admit(charge)) return
		this.lines.push(line)
		this.linesCharge += charge
		if (!this.flushScheduled) {
			this.flushScheduled = true
			setImmediate(() => {
				this.flushScheduled = false
				this.flush()
			})
		}
	}

	/** A store `mirror-removal`, in order with the lines. */
	remove(removal: { discoveries: string[]; observations: string[] }): void {
		if (!this.live()) return
		const discoveries = [...removal.discoveries]
		const observations = [...removal.observations]
		let units = 0
		for (const id of discoveries) units += id.length
		for (const id of observations) units += id.length
		const charged = units * 2 + MESSAGE_OVERHEAD_BYTES
		if (!this.admit(charged)) return
		this.flush()
		this.post({ type: "remove", discoveries, observations, charged }, charged)
	}

	/**
	 * Replaces the worker's mirror with `text` (the main path's snapshot at `seq`), posted now, so
	 * it lands after every line up to `seq` and before any later one. Starts the worker if needed.
	 */
	reset(text: string, seq: number): void {
		if (this.disabled) return
		this.dropLines()
		if (!this.ensurePort()) return
		if (this.resetInFlight) {
			this.synced = false // the previous reset is still queued; try again next snapshot
			return
		}
		const charged = text.length * 2 + MESSAGE_OVERHEAD_BYTES
		this.lastResetChars = text.length
		this.resetInFlight = true
		this.posted.push({ kind: "reset", charged })
		if (!this.send({ type: "reset", text, seq, charged })) return
		this.synced = true
	}

	/**
	 * Posts a snapshot request at this point of the line stream; null when the queue bound or the
	 * worker state does not allow it (write that snapshot on the main thread).
	 */
	request(head: SnapshotHead, counts: MirrorCounts): number | null {
		if (!this.live()) return null
		const charged =
			(head.savedAt.length +
				(head.corrections?.length ?? 0) +
				head.recordingOperations.length +
				(head.aliases?.length ?? 0)) *
				2 +
			MESSAGE_OVERHEAD_BYTES
		if (!this.admit(charged)) return null
		this.flush()
		const id = this.nextId++
		const message: SnapshotWorkerRequest = {
			type: "snapshot",
			id,
			head: { ...head },
			counts: {
				discoveries: counts.discoveries,
				observations: counts.observations,
			},
			charged,
		}
		return this.post(message, charged) ? id : null
	}

	/** The commit timeout for the next commit (`snapshotCommitTimeoutMs`). */
	commitTimeout(): number {
		return snapshotCommitTimeoutMs(
			this.commitTimeoutMs,
			Math.max(this.lastTextBytes ?? 0, this.lastResetChars),
		)
	}

	/**
	 * Writes request `id` to `file`; resolves (never rejects) with the outcome. The worker writes
	 * and fsyncs its own tmp file; this thread renames it over `file` only when the worker answers
	 * this live commit, and removes it on every other outcome.
	 */
	commitTo(id: number, file: string): Promise<CommitResult> {
		const port = this.port
		if (port === null || this.disabled || this.commit !== null)
			return Promise.resolve({ ok: false, reason: "worker-failed" })
		const tmp = snapshotWorkerTmp(file, id)
		return new Promise<CommitResult>(resolve => {
			const timer = setTimeout(() => {
				this.fail(
					new WaveKitError(
						"Snapshot worker commit timed out",
						"SCANNER_SNAPSHOT_WORKER",
					),
				)
			}, this.commitTimeout())
			timer.unref()
			this.commit = { id, file, tmp, resolve, timer }
			this.send({ type: "commit", id, tmp })
		})
	}

	/** A snapshot was written on the main thread instead: counted, warned at most once an hour. */
	noteFallback(reason: string, err?: unknown): void {
		this.fallbacks += 1
		if (reason === "diverged" || reason === "broken") this.divergences += 1
		const at = this.now()
		if (this.lastWarnAt !== null && at - this.lastWarnAt < WARN_INTERVAL_MS) {
			this.suppressedWarns += 1
			return
		}
		this.lastWarnAt = at
		const suppressed = this.suppressedWarns
		this.suppressedWarns = 0
		this.log.warn(
			{
				reason,
				fallbacks: this.fallbacks,
				suppressed,
				...(err === undefined ? {} : { err: safeErrorFields(err) }),
			},
			"Scanner snapshot written on the main thread instead of the snapshot worker",
		)
	}

	async close(): Promise<void> {
		this.disabled = true
		this.synced = false
		this.dropLines()
		const port = this.port
		this.port = null
		this.settleCommit({ ok: false, reason: "worker-failed" })
		if (port !== null) await port.terminate().catch(() => undefined)
		await this.sweepAbandoned()
	}

	/**
	 * Removes again the tmp files an abandoned worker may have written late (never renamed). The
	 * paths stay remembered: a worker that has not exited could still write after this sweep.
	 */
	async sweepAbandoned(): Promise<void> {
		if (this.abandonedTmps.size === 0) return
		await Promise.all(
			[...this.abandonedTmps].map(tmp =>
				rm(tmp, { force: true }).catch(() => undefined),
			),
		)
	}

	private admit(charge: number): boolean {
		if (this.queuedBytes + this.linesCharge + charge <= this.maxQueuedBytes)
			return true
		// The worker fell behind: stop posting rather than grow; the next snapshot resets it.
		this.overflows += 1
		this.synced = false
		this.dropLines()
		return false
	}

	private dropLines(): void {
		this.lines = []
		this.linesCharge = 0
	}

	private flush(): void {
		if (this.lines.length === 0) return
		const lines = this.lines
		const charged = this.linesCharge
		this.dropLines()
		if (!this.live()) return
		this.post({ type: "lines", lines, charged }, charged)
	}

	private post(message: SnapshotWorkerRequest, charged: number): boolean {
		this.posted.push({ kind: "charged", charged })
		this.queuedBytes += charged
		return this.send(message)
	}

	private send(message: SnapshotWorkerRequest): boolean {
		const port = this.port
		if (port === null) return false
		try {
			port.postMessage(message)
			return true
		} catch (err) {
			this.fail(err)
			return false
		}
	}

	private ensurePort(): boolean {
		if (this.port !== null) return true
		if (this.disabled) return false
		let port: SnapshotWorkerPort
		try {
			port = this.factory({ url: this.url, heapMb: this.heapMb })
		} catch (err) {
			this.fail(err)
			return false
		}
		this.port = port
		port.onMessage(value => {
			if (this.port === port) this.onMessage(value)
		})
		port.onError(err => {
			if (this.port === port) this.fail(err)
		})
		port.onExit(code => {
			if (this.port === port)
				this.fail(
					new WaveKitError(
						`Snapshot worker exited (${code})`,
						"SCANNER_SNAPSHOT_WORKER",
					),
				)
		})
		return true
	}

	private onMessage(value: unknown): void {
		if (!isSnapshotWorkerResponse(value)) {
			this.fail(
				new WaveKitError(
					"Invalid snapshot worker message",
					"SCANNER_SNAPSHOT_WORKER",
				),
			)
			return
		}
		this.handle(value)
	}

	private handle(m: SnapshotWorkerResponse): void {
		if (m.type === "applied") {
			const head = this.posted.shift()
			if (head === undefined || head.charged !== m.charged) {
				this.fail(
					new WaveKitError(
						"Unexpected snapshot worker acknowledgement",
						"SCANNER_SNAPSHOT_WORKER",
					),
				)
				return
			}
			if (head.kind === "reset") this.resetInFlight = false
			else this.queuedBytes -= head.charged
			return
		}
		const commit = this.commit
		if (commit === null || commit.id !== m.id) {
			this.fail(
				new WaveKitError(
					"Unexpected snapshot worker result",
					"SCANNER_SNAPSHOT_WORKER",
				),
			)
			return
		}
		this.heapUsedBytes = m.heapUsedBytes
		if (m.type === "written") {
			this.lastTextBytes = m.bytes
			this.lastBuildMs = m.buildMs
			this.lastWriteMs = m.writeMs
			// Detached first: a worker failure from here on cannot settle it or start a fallback
			// while the rename is in flight; the persistence queue waits for this result.
			this.commit = null
			clearTimeout(commit.timer)
			const written: CommitResult = {
				ok: true,
				bytes: m.bytes,
				buildMs: m.buildMs,
				writeMs: m.writeMs,
			}
			void rename(commit.tmp, commit.file).then(
				() => commit.resolve(written),
				() => discard(commit, { ok: false, reason: "io" }),
			)
			return
		}
		// A diverged or broken mirror: the main path writes this one and resets it.
		if (m.reason !== "io") this.synced = false
		this.settleCommit({ ok: false, reason: m.reason })
	}

	private settleCommit(result: CommitResult): void {
		const commit = this.commit
		if (commit === null) return
		this.commit = null
		clearTimeout(commit.timer)
		discard(commit, result)
	}

	/** Worker crash, error, timeout or protocol violation: restart once, then main thread for good. */
	private fail(err: unknown): void {
		const port = this.port
		this.port = null
		this.synced = false
		this.resetInFlight = false
		this.posted.length = 0
		this.queuedBytes = 0
		this.dropLines()
		this.failures += 1
		// The fallback writes only once the worker is gone (or abandoned) and this commit's tmp is
		// removed; the worker never renames, so nothing it writes later can replace the file.
		const commit = this.commit
		this.commit = null
		if (commit !== null) clearTimeout(commit.timer)
		let settled = false
		const settle = (): void => {
			if (settled) return
			settled = true
			if (commit !== null)
				discard(commit, { ok: false, reason: "worker-failed" })
		}
		if (port !== null) {
			let abandoned: string | null = null
			const abandon = setTimeout(() => {
				// Still running: it may yet write its tmp file (never renamed), so never use a worker again.
				this.failures = Math.max(this.failures, 2)
				this.disabled = true
				if (commit !== null) {
					abandoned = commit.tmp
					this.abandonedTmps.add(abandoned)
				}
				settle()
			}, this.terminateWaitMs)
			abandon.unref()
			void port
				.terminate()
				.catch(() => undefined)
				.then(async () => {
					clearTimeout(abandon)
					settle()
					// Gone at last: whatever it wrote late is removed, and it can write no more.
					const tmp = abandoned
					if (tmp === null) return
					await rm(tmp, { force: true }).catch(() => undefined)
					this.abandonedTmps.delete(tmp)
				})
		} else settle()
		if (this.failures >= 2) {
			if (!this.disabled)
				this.log.warn(
					{ failures: this.failures, err: safeErrorFields(err) },
					"Snapshot worker failed again; scanner snapshots stay on the main thread",
				)
			this.disabled = true
			return
		}
		this.log.warn(
			{ failures: this.failures, err: safeErrorFields(err) },
			"Snapshot worker failed; restarting it (this snapshot on the main thread)",
		)
	}
}
