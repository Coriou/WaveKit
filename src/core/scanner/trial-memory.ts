/**
 * (Goal 0 "remembers what worked"): the per-discovery replay trial-outcome memory.
 * For each discovery it keeps, per trial (protocol + decoder), how often the trial ran, how often
 * it decoded, its consecutive failures and the last outcome and time. The replay planner orders a
 * discovery's trials from it (`orderTrialsByMemory`): remembered success first, then the class and
 * band-plan prior order, then untried trials, then remembered failures with backoff.
 *
 * Bounds (stated arithmetic):
 * - TRIAL_MEMORY_MAX_TRIALS = 16 trials per discovery: twice IQ_REPLAY_MAX_TRIALS (8), so two full
 *   plans of distinct trials fit; at the cap the least recently updated trial is dropped.
 * - TRIAL_MEMORY_MAX_DISCOVERIES = 2 048 discoveries; at the cap the least recently updated
 *   discovery is dropped. One serialised trial is at most about 160 B (protocol ≤ 15 chars,
 *   decoder ≤ 32 chars, outcome ≤ 13 chars, four integers ≤ 16 digits, keys), one discovery id at
 *   most 128 B, so the file is at most 2 048 × (128 + 16 × 160) B = 5 505 024 B ≈ 5.3 MiB; the
 *   loader refuses a file above TRIAL_MEMORY_FILE_MAX_BYTES = 8 MiB without parsing it.
 * - Counters saturate at TRIAL_MEMORY_COUNT_MAX = 1 000 000 (no overflow, still "many").
 * - Backoff after k consecutive failures: TRIAL_BACKOFF_BASE_MS × 2^(k−1), capped at
 *   TRIAL_BACKOFF_MAX_MS: 60 s, 120 s, 240 s, …, 3 840 s → 3 600 s from k = 7 on.
 *
 * Persistence: one JSON file, written atomically (tmp + fsync + rename) at most once per
 * TRIAL_MEMORY_WRITE_DELAY_MS after a change, and on `flush`. Loading validates with Zod; a
 * missing, oversized, unparsable or wrongly shaped file is ignored (empty memory), and a single
 * malformed discovery or trial is dropped while the rest loads. Nothing is logged with ids,
 * protocols or frequencies.
 */
import { readFile, stat } from "node:fs/promises"
import { z } from "zod"
import type { Logger } from "../../utils/logger.js"
import { atomicWrite } from "./store/atomic-write.js"
import { KNOWN_PROTOCOL_MAX_MISSES } from "./known-protocol-contract.js"
import type { ScannerProtocol } from "./types.js"

export const TRIAL_MEMORY_MAX_TRIALS = 16
export const TRIAL_MEMORY_MAX_DISCOVERIES = 2048
export const TRIAL_MEMORY_COUNT_MAX = 1_000_000
export const TRIAL_MEMORY_FILE_MAX_BYTES = 8 * 1024 * 1024
export const TRIAL_MEMORY_WRITE_DELAY_MS = 5_000
export const TRIAL_BACKOFF_BASE_MS = 60_000
export const TRIAL_BACKOFF_MAX_MS = 3_600_000
export const TRIAL_MEMORY_FILE = "trial-memory.json"
const ID_MAX = 128
const DECODER_MAX = 32
const PROTOCOL_MAX = 32

/** What one replay trial ended with, as the memory counts it. */
export type TrialMemoryOutcome =
	| "decoded"
	| "heard"
	| "no-sync"
	| "crc-errors"
	| "timeout"
	| "data-like"
	| "carrier-only"

/** Outcomes that count as a success of the trial (it identified the signal). */
const SUCCESS: ReadonlySet<string> = new Set(["decoded", "heard"])
/** Outcomes that count as a full failed attempt. Others (cancelled, budget, unsupported) are not attempts. */
const FAILURE: ReadonlySet<string> = new Set([
	"no-sync",
	"crc-errors",
	"timeout",
	"data-like",
	"carrier-only",
])

export interface TrialMemoryEntry {
	protocol: ScannerProtocol
	decoder: string
	attempts: number
	decoded: number
	/** Failures since the last success. */
	consecutiveFailures: number
	lastOutcome: TrialMemoryOutcome
	lastAt: number
	/** Time of the last success; absent when it never succeeded. */
	lastDecodedAt?: number
}

const count = z.number().int().min(0).max(TRIAL_MEMORY_COUNT_MAX)
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const EntrySchema = z
	.object({
		protocol: z.string().min(1).max(PROTOCOL_MAX),
		decoder: z.string().min(1).max(DECODER_MAX),
		attempts: count,
		decoded: count,
		consecutiveFailures: count,
		lastOutcome: z.enum([
			"decoded",
			"heard",
			"no-sync",
			"crc-errors",
			"timeout",
			"data-like",
			"carrier-only",
		]),
		lastAt: time,
		lastDecodedAt: time.optional(),
	})
	.strict()
	.refine(e => e.decoded <= e.attempts && e.consecutiveFailures <= e.attempts)
const FileSchema = z
	.object({
		version: z.literal(1),
		discoveries: z.record(z.string().min(1).max(ID_MAX), z.array(z.unknown())),
	})
	.strict()

/** Trial key: protocol and decoder (analog trials use the decoder `analog-demod`). */
export function trialKey(protocol: string, decoder: string): string {
	return `${protocol}|${decoder}`
}

/** Backoff after `failures` consecutive failures (0 for none). */
export function trialBackoffMs(failures: number): number {
	if (!Number.isFinite(failures) || failures <= 0) return 0
	const k = Math.min(Math.floor(failures), 32)
	return Math.min(TRIAL_BACKOFF_BASE_MS * 2 ** (k - 1), TRIAL_BACKOFF_MAX_MS)
}

function sat(n: number): number {
	return Math.min(n, TRIAL_MEMORY_COUNT_MAX)
}

/** Parse a persisted file body; unknown or malformed parts are dropped (never throws). */
export function parseTrialMemory(
	raw: unknown,
): Map<string, TrialMemoryEntry[]> {
	const out = new Map<string, TrialMemoryEntry[]>()
	const file = FileSchema.safeParse(raw)
	if (!file.success) return out
	for (const [id, rows] of Object.entries(file.data.discoveries)) {
		if (out.size >= TRIAL_MEMORY_MAX_DISCOVERIES) break
		const entries: TrialMemoryEntry[] = []
		const seen = new Set<string>()
		for (const row of rows) {
			if (entries.length >= TRIAL_MEMORY_MAX_TRIALS) break
			const e = EntrySchema.safeParse(row)
			if (!e.success) continue
			const key = trialKey(e.data.protocol, e.data.decoder)
			if (seen.has(key)) continue
			seen.add(key)
			const { lastDecodedAt, ...rest } = e.data
			entries.push({
				...rest,
				protocol: rest.protocol as ScannerProtocol,
				...(lastDecodedAt !== undefined ? { lastDecodedAt } : {}),
			})
		}
		if (entries.length > 0) out.set(id, entries)
	}
	return out
}

export interface TrialMemoryDeps {
	/** Directory of the file; absent = in memory only (tests). */
	dir?: string
	logger?: Logger
	now: () => number
	/** Debounce timer (tests inject). */
	setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
	clearTimer?: (handle: unknown) => void
}

export class TrialMemory {
	/** Insertion order = least recently updated first. */
	private readonly byDiscovery = new Map<string, TrialMemoryEntry[]>()
	private timer: unknown = null
	private writing: Promise<void> = Promise.resolve()
	private loaded = false

	constructor(private readonly deps: TrialMemoryDeps) {}

	get size(): number {
		return this.byDiscovery.size
	}

	/** A copy of the discovery's remembered trials (most recently updated last); empty when none. */
	view(discoveryId: string): readonly TrialMemoryEntry[] {
		return (this.byDiscovery.get(discoveryId) ?? []).map(e => ({ ...e }))
	}

	/**
	 * One replay trial outcome of the discovery. Outcomes that are no attempt (pending, running,
	 * cancelled, skipped-budget, unsupported, not-needed) and malformed input change nothing.
	 */
	record(
		discoveryId: string,
		protocol: ScannerProtocol,
		decoder: string,
		outcome: string,
	): boolean {
		if (
			typeof discoveryId !== "string" ||
			discoveryId.length === 0 ||
			discoveryId.length > ID_MAX ||
			typeof protocol !== "string" ||
			protocol.length === 0 ||
			protocol.length > PROTOCOL_MAX ||
			typeof decoder !== "string" ||
			decoder.length === 0 ||
			decoder.length > DECODER_MAX
		)
			return false
		const success = SUCCESS.has(outcome)
		if (!success && !FAILURE.has(outcome)) return false
		const at = Math.max(0, Math.floor(this.deps.now()))
		const list = this.byDiscovery.get(discoveryId) ?? []
		this.byDiscovery.delete(discoveryId)
		const key = trialKey(protocol, decoder)
		const index = list.findIndex(e => trialKey(e.protocol, e.decoder) === key)
		const prev = index >= 0 ? list.splice(index, 1)[0] : undefined
		const next: TrialMemoryEntry = {
			protocol,
			decoder,
			attempts: sat((prev?.attempts ?? 0) + 1),
			decoded: sat((prev?.decoded ?? 0) + (success ? 1 : 0)),
			consecutiveFailures: success
				? 0
				: sat((prev?.consecutiveFailures ?? 0) + 1),
			lastOutcome: outcome as TrialMemoryOutcome,
			lastAt: at,
			...(success
				? { lastDecodedAt: at }
				: prev?.lastDecodedAt !== undefined
					? { lastDecodedAt: prev.lastDecodedAt }
					: {}),
		}
		list.push(next)
		while (list.length > TRIAL_MEMORY_MAX_TRIALS) list.shift()
		this.byDiscovery.set(discoveryId, list)
		while (this.byDiscovery.size > TRIAL_MEMORY_MAX_DISCOVERIES) {
			const oldest = this.byDiscovery.keys().next()
			if (oldest.done === true) break
			this.byDiscovery.delete(oldest.value)
		}
		this.schedule()
		return true
	}

	forget(discoveryId: string): void {
		if (this.byDiscovery.delete(discoveryId)) this.schedule()
	}

	/** Loads the file; corrupt or missing state leaves the memory empty. Never throws. */
	async load(): Promise<void> {
		this.loaded = true
		const dir = this.deps.dir
		if (dir === undefined) return
		const file = `${dir}/${TRIAL_MEMORY_FILE}`
		try {
			const info = await stat(file)
			if (info.size > TRIAL_MEMORY_FILE_MAX_BYTES) {
				this.deps.logger?.warn("Trial memory file too large; ignored")
				return
			}
			const parsed = parseTrialMemory(JSON.parse(await readFile(file, "utf8")))
			// Entries recorded before the load finished win over the file's.
			for (const [id, entries] of parsed)
				if (!this.byDiscovery.has(id)) this.byDiscovery.set(id, entries)
			while (this.byDiscovery.size > TRIAL_MEMORY_MAX_DISCOVERIES) {
				const oldest = this.byDiscovery.keys().next()
				if (oldest.done === true) break
				this.byDiscovery.delete(oldest.value)
			}
		} catch (err: unknown) {
			const code =
				typeof err === "object" && err !== null && "code" in err
					? (err as { code?: unknown }).code
					: undefined
			if (code !== "ENOENT")
				this.deps.logger?.warn("Trial memory file unreadable; ignored")
		}
	}

	serialize(): string {
		return JSON.stringify({
			version: 1,
			discoveries: Object.fromEntries(this.byDiscovery),
		})
	}

	/** Writes pending changes now. Never throws. */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			;(this.deps.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout)))(
				this.timer,
			)
			this.timer = null
			this.write()
		}
		await this.writing
	}

	private schedule(): void {
		if (this.deps.dir === undefined || this.timer !== null) return
		const set =
			this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
		const handle = set(() => {
			this.timer = null
			this.write()
		}, TRIAL_MEMORY_WRITE_DELAY_MS)
		handle.unref?.()
		this.timer = handle
	}

	private write(): void {
		const dir = this.deps.dir
		// Never overwrite the file before it was read (it would lose the remembered outcomes).
		if (dir === undefined || !this.loaded) return
		const body = this.serialize()
		this.writing = this.writing
			.then(() => atomicWrite(`${dir}/${TRIAL_MEMORY_FILE}`, body))
			.catch(() => {
				this.deps.logger?.warn("Writing the trial memory failed")
			})
	}
}

/** A trial the ordering can place: its protocol, decoder and whether it is the known protocol's. */
export interface OrderableTrial {
	protocol: ScannerProtocol
	decoder: string
	known: boolean
	/**
	 * Protocols the same decoder run also decodes (`ProbeMode.covers`, e.g. dsd-fme auto covers
	 * DMR and P25): their remembered outcomes apply to this trial too, because the run is shared.
	 */
	covers?: readonly string[]
}

/**
 * The memory's trial order (stable within each tier, which keeps the planner's prior order):
 * 0. trials that succeeded before and have fewer than KNOWN_PROTOCOL_MAX_MISSES (2) failures since
 *    (most recent success first; the same decay as the known protocol), then the known
 *    protocol's trial when the memory has no success for it;
 * 1. trials remembered without a failure streak (they ran, never failed in a row), in prior order;
 * 2. untried trials, in prior order;
 * 3. remembered failures out of backoff (fewest consecutive failures first);
 * 4. remembered failures still in backoff. They are dropped unless every trial is in backoff
 *    (the safe answer: a capture is never left with no trial).
 * Without memory the input order is returned unchanged.
 */
function successful(e: TrialMemoryEntry): boolean {
	return e.decoded > 0 && e.consecutiveFailures < KNOWN_PROTOCOL_MAX_MISSES
}

/** The trial's remembered entry: a success of any covered protocol wins, else the worst streak. */
function memoryOf(
	t: OrderableTrial,
	byKey: ReadonlyMap<string, TrialMemoryEntry>,
): TrialMemoryEntry | undefined {
	let best: TrialMemoryEntry | undefined
	for (const protocol of new Set([t.protocol, ...(t.covers ?? [])])) {
		const e = byKey.get(trialKey(protocol, t.decoder))
		if (!e) continue
		if (
			best === undefined ||
			(successful(e) && !successful(best)) ||
			(successful(e) === successful(best) &&
				(successful(e)
					? (e.lastDecodedAt ?? 0) > (best.lastDecodedAt ?? 0)
					: e.consecutiveFailures > best.consecutiveFailures))
		)
			best = e
	}
	return best
}

export function orderTrialsByMemory<T extends OrderableTrial>(
	trials: readonly T[],
	memory: readonly TrialMemoryEntry[] | null | undefined,
	nowMs: number,
	opts: {
		/** Keep trials still in backoff (last) instead of dropping them (paging-range pager group). */
		keepBackoff?: boolean
		/** May return no trial when every one is in backoff (a sub-group of a larger plan). */
		allowEmpty?: boolean
	} = {},
): T[] {
	if (!memory || memory.length === 0) return [...trials]
	const byKey = new Map<string, TrialMemoryEntry>()
	for (const e of memory) byKey.set(trialKey(e.protocol, e.decoder), e)
	const tiers: { t: T; tier: number; sub: number; i: number }[] = trials.map(
		(t, i) => {
			const e = memoryOf(t, byKey)
			if (e && successful(e))
				return { t, tier: 0, sub: -(e.lastDecodedAt ?? 0), i }
			if (t.known) return { t, tier: 0, sub: 0, i }
			if (!e) return { t, tier: 2, sub: 0, i }
			if (e.consecutiveFailures === 0) return { t, tier: 1, sub: 0, i }
			const inBackoff = nowMs - e.lastAt < trialBackoffMs(e.consecutiveFailures)
			return { t, tier: inBackoff ? 4 : 3, sub: e.consecutiveFailures, i }
		},
	)
	tiers.sort((a, b) => a.tier - b.tier || a.sub - b.sub || a.i - b.i)
	if (opts.keepBackoff === true) return tiers.map(x => x.t)
	const ready = tiers.filter(x => x.tier < 4)
	return (ready.length > 0 || opts.allowEmpty === true ? ready : tiers).map(
		x => x.t,
	)
}
