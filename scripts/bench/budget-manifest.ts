/**
 * The main-thread budget manifest: its Zod schema, the timing-validity rule, summary maths, the
 * parsers of the collected process listings and the before/after comparison. Pure (no I/O),
 * shared by the tier A runner, the tier B post-processing and `budget-compare.ts`.
 */
import { z } from "zod"
import { WaveKitError } from "../../src/utils/errors.js"

// === process listings (children CPU, by PID) ===

export interface PsRow {
	pid: number
	ppid: number
	cpuMs: number
	comm: string
}

/** `ps -o time=` as ms: Linux `[dd-]hh:mm:ss`, macOS `[hh:]m:ss.cc`; null when it does not parse. */
export function parsePsTime(text: string): number | null {
	const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
	if (!m) return null
	const [, d, h, mi, s] = m
	return (
		((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 +
			Number(mi) * 60 +
			Number(s)) *
		1000
	)
}

function lastSegment(path: string): string {
	const i = path.lastIndexOf("/")
	return i >= 0 ? path.slice(i + 1) : path
}

/** `pid ppid time comm` lines (tier A `ps`). */
export function parsePs(text: string): PsRow[] {
	const rows: PsRow[] = []
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
		if (!m) continue
		const cpuMs = parsePsTime(m[3] ?? "")
		if (cpuMs === null) continue
		rows.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			cpuMs,
			comm: lastSegment((m[4] ?? "").trim()),
		})
	}
	return rows
}

/** Linux clock tick (USER_HZ 100). */
export const PROC_TICK_MS = 10

/** `pid ppid comm ticks` lines (tier B: `budget-preload.mjs procstat`, utime + stime ticks). */
export function parseProcLines(text: string): PsRow[] {
	const rows: PsRow[] = []
	for (const line of text.split("\n")) {
		const m = /^(\d+) (\d+) (.*) (\d+)$/.exec(line.trim())
		if (!m) continue
		rows.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			comm: m[3] ?? "",
			cpuMs: Number(m[4]) * PROC_TICK_MS,
		})
	}
	return rows
}

/** Every PID under `rootPid` by parent links (never by name). */
export function descendantsOf(
	rows: readonly { pid: number; ppid: number }[],
	rootPid: number,
): Set<number> {
	const kids = new Map<number, number[]>()
	for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
	const out = new Set<number>()
	const queue = [rootPid]
	while (queue.length > 0) {
		const p = queue.shift()
		if (p === undefined) break
		for (const c of kids.get(p) ?? [])
			if (!out.has(c) && c !== rootPid) {
				out.add(c)
				queue.push(c)
			}
	}
	return out
}

// === listeners (lsof) ===

export interface Listener {
	address: string
	port: number
}

/** The TCP listeners in `lsof -nP -iTCP -sTCP:LISTEN` output (`ADDRESS:PORT (LISTEN)` names). */
export function parseLsofListeners(text: string): Listener[] {
	const out: Listener[] = []
	for (const line of text.split("\n")) {
		const m = /\s(\S+):(\d+|\*) \(LISTEN\)\s*$/.exec(line)
		if (m) out.push({ address: m[1] ?? "", port: Number(m[2]) })
	}
	return out
}

/** Listeners not bound to 127.0.0.1 or [::1] (`*` is every interface). */
export function nonLoopbackListeners(list: readonly Listener[]): Listener[] {
	return list.filter(l => l.address !== "127.0.0.1" && l.address !== "[::1]")
}

// === window length ===

/**
 * The measured window as a whole number of scene periods, so every run covers the same scene
 * phases: `requested` rounded UP to the next multiple of `periodSeconds`.
 */
export function roundWindowUp(
	requested: number,
	periodSeconds: number,
): { seconds: number; rounded: boolean } {
	if (!(periodSeconds > 0) || !(requested > 0))
		return { seconds: requested, rounded: false }
	const k = Math.ceil(requested / periodSeconds - 1e-9)
	const seconds = Math.max(1, k) * periodSeconds
	return { seconds, rounded: seconds !== requested }
}

// === IQ seconds ===

/** CU8: one byte of I and one of Q per sample. */
export const CU8_BYTES_PER_SAMPLE = 2
/** Above this relative difference between the core's and the fake's IQ seconds, warn. */
export const IQ_DISAGREEMENT_MAX = 0.01

export interface IqSecondsResult {
	/** The denominator: bytes the core received on the source socket in the window. */
	iqSeconds: number
	/** The fake's own count between its two marks (cross-check), or null. */
	iqSecondsFake: number | null
	/** |core − fake| / fake, or null when either side is missing. */
	iqSecondsDisagreement: number | null
	warnings: string[]
}

export function iqSecondsOf(inputs: {
	sourceBytes: number | null
	rateHz: number
	fakeIqSeconds: number | null
	bytesPerSample?: number
}): IqSecondsResult {
	const warnings: string[] = []
	const per = (inputs.bytesPerSample ?? CU8_BYTES_PER_SAMPLE) * inputs.rateHz
	const fake =
		inputs.fakeIqSeconds !== null && Number.isFinite(inputs.fakeIqSeconds)
			? inputs.fakeIqSeconds
			: null
	const core =
		inputs.sourceBytes !== null &&
		Number.isFinite(inputs.sourceBytes) &&
		per > 0
			? inputs.sourceBytes / per
			: null
	let iqSeconds = core
	if (iqSeconds === null) {
		iqSeconds = fake ?? 0
		warnings.push(
			fake === null
				? "no IQ byte count from the core or the fake: no per-IQ-second figure"
				: "no IQ byte count from the core: IQ seconds come from the fake",
		)
	}
	const disagreement =
		core !== null && fake !== null && fake > 0
			? Math.abs(core - fake) / fake
			: null
	if (disagreement !== null && disagreement > IQ_DISAGREEMENT_MAX)
		warnings.push("IQ seconds disagree by more than 1 %")
	return {
		iqSeconds,
		iqSecondsFake: fake,
		iqSecondsDisagreement: disagreement,
		warnings,
	}
}

// === summary maths ===

/** Nearest-rank percentile of finite values (p in [0, 100]); null without any. */
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
	if (v.length === 0 || !Number.isFinite(p)) return null
	const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * v.length)
	return v[Math.min(v.length - 1, Math.max(0, rank - 1))] ?? null
}

export interface Spread {
	p50: number | null
	p95: number | null
	max: number | null
}

export function spread(values: readonly number[]): Spread {
	const finite = values.filter(x => Number.isFinite(x))
	return {
		p50: percentile(finite, 50),
		p95: percentile(finite, 95),
		max: finite.length > 0 ? Math.max(...finite) : null,
	}
}

/** `value` per second of IQ, or null when either side is unknown or there was no IQ. */
export function perIqSecond(
	value: number | null | undefined,
	iqSeconds: number | null | undefined,
): number | null {
	if (value === null || value === undefined || !Number.isFinite(value))
		return null
	if (
		iqSeconds === null ||
		iqSeconds === undefined ||
		!Number.isFinite(iqSeconds) ||
		iqSeconds <= 0
	)
		return null
	return value / iqSeconds
}

// === timing validity ===

/** Above this 1-min load average (p95 over the run) no timing figure is trusted. */
export const LOAD_P95_MAX = 30
/** Run-queue wait above this share of wall time (p95 of the 10 s lines) means a starved thread. */
export const RUN_QUEUE_WAIT_P95_MAX = 0.05
/**
 * Without a run-queue figure (macOS has no schedstat), only a load below the logical CPU count of
 * the reference host is trusted: below it a runnable thread normally finds a free core.
 */
export const REFERENCE_HOST_CPUS = 8

export interface TimingInputs {
	/** 1-min load average samples taken every 10 s over the run. */
	loadSamples: unknown
	/** Run-queue wait share p95 over the 10 s lines, or null when the platform has none. */
	runQueueWaitP95: unknown
	/** "B" requires the outer host's samples; default "A". */
	tier?: "A" | "B"
	/**
	 * Tier B: the outer host's 1-min load samples (`uptime` every 10 s while the container ran);
	 * their p95 must also be below LOAD_P95_MAX. Ignored in tier A.
	 */
	outerLoadSamples?: unknown
}

/** The p95 of a set of load samples, or null when the set is missing, empty or malformed. */
function loadP95Of(value: unknown): number | null {
	if (!Array.isArray(value)) return null
	const samples = value as unknown[]
	if (
		!samples.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
	)
		return null
	return percentile(samples as number[], 95)
}

export interface TimingVerdict {
	timingValid: boolean
	timingInvalidReasons: string[]
}

/** Timing figures (ELU, loop delay, long tasks) are valid only on a host that did not starve the core. */
export function timingValidity(inputs: TimingInputs): TimingVerdict {
	const reasons: string[] = []
	const loadP95 = loadP95Of(inputs.loadSamples)
	if (loadP95 === null)
		reasons.push("no valid load average samples (timing cannot be judged)")
	else if (!(loadP95 < LOAD_P95_MAX))
		reasons.push(
			`load average p95 ${loadP95.toFixed(2)} is not below ${LOAD_P95_MAX}`,
		)
	const rq = inputs.runQueueWaitP95
	if (rq === null || rq === undefined) {
		if (loadP95 !== null && !(loadP95 < REFERENCE_HOST_CPUS))
			reasons.push(
				`no run-queue wait figure and load average p95 ${loadP95.toFixed(2)} is not below ${REFERENCE_HOST_CPUS} (the reference host's logical CPUs)`,
			)
	} else if (typeof rq !== "number" || !Number.isFinite(rq) || rq < 0)
		reasons.push("run-queue wait share is malformed")
	else if (!(rq < RUN_QUEUE_WAIT_P95_MAX))
		reasons.push(
			`run-queue wait share p95 ${rq.toFixed(4)} is not below ${RUN_QUEUE_WAIT_P95_MAX}`,
		)
	if (inputs.tier === "B") {
		const outerP95 = loadP95Of(inputs.outerLoadSamples)
		if (outerP95 === null)
			reasons.push(
				"tier B: no valid outer host load samples (uptime; timing cannot be judged)",
			)
		else if (!(outerP95 < LOAD_P95_MAX))
			reasons.push(
				`tier B: outer host load average p95 ${outerP95.toFixed(2)} is not below ${LOAD_P95_MAX}`,
			)
	}
	return { timingValid: reasons.length === 0, timingInvalidReasons: reasons }
}

// === CPU hog (starvation runs) ===

/** One hog child as the pool sees it; the runner wraps a ChildProcess, the tests a fake. */
export interface HogHandle {
	pid: number | undefined
	/** Sends `signal` to this child only (by its own handle, never by name). */
	kill(signal: NodeJS.Signals): void
	isAlive(): boolean
	/** Settles when the child has exited. */
	exited: Promise<unknown>
}

export type HogSpawner = (index: number) => HogHandle

export interface HogRecord {
	count: number
	/** PIDs started, in start order. */
	startedPids: number[]
	/** PIDs seen exited after the stop (SIGTERM or SIGKILL). */
	stoppedPids: number[]
	/** PIDs that ignored SIGTERM for the grace time and got SIGKILL. */
	killedPids: number[]
	/** PIDs still alive after SIGKILL and its wait (should stay empty). */
	survivorPids: number[]
	/** PIDs already exited when checked just before the window's close signal (they did not load it). */
	exitedEarlyPids: number[]
	/** Hogs alive at that check; null until `checkAlive` ran. */
	effectiveCount: number | null
}

export interface HogPoolOptions {
	/** SIGTERM to SIGKILL. */
	graceMs?: number
	/** Wait after SIGKILL before a child counts as a survivor. */
	killWaitMs?: number
	/** Resolves after `ms`; an abort clears its timer and resolves at once. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/** A sleep whose timer an AbortSignal clears (so no race timer outlives its race). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) {
			resolve()
			return
		}
		const done = (): void => {
			clearTimeout(timer)
			signal.removeEventListener("abort", done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		signal.addEventListener("abort", done, { once: true })
	})
}

/**
 * N busy-loop children, started and stopped by the PIDs this pool recorded (never by pattern).
 * `start` stops what it already started when a spawn throws; `stop` is idempotent and safe on
 * every exit path; `stopNow` is the synchronous last resort (process `exit`): SIGKILL by handle.
 */
export class HogPool {
	private readonly handles: HogHandle[] = []
	private readonly rec: HogRecord = {
		count: 0,
		startedPids: [],
		stoppedPids: [],
		killedPids: [],
		survivorPids: [],
		exitedEarlyPids: [],
		effectiveCount: null,
	}
	private stopping: Promise<HogRecord> | null = null
	private readonly graceMs: number
	private readonly killWaitMs: number

	constructor(
		private readonly spawner: HogSpawner,
		private readonly options: HogPoolOptions,
	) {
		this.graceMs = options.graceMs ?? 2000
		this.killWaitMs = options.killWaitMs ?? 5000
	}

	get record(): HogRecord {
		return {
			count: this.rec.count,
			startedPids: [...this.rec.startedPids],
			stoppedPids: [...this.rec.stoppedPids],
			killedPids: [...this.rec.killedPids],
			survivorPids: [...this.rec.survivorPids],
			exitedEarlyPids: [...this.rec.exitedEarlyPids],
			effectiveCount: this.rec.effectiveCount,
		}
	}

	/**
	 * Just before the window's close signal: which hogs had already exited (a crash, the hard
	 * lifetime), and how many still loaded the host. Repeated calls replace the last check.
	 */
	checkAlive(): HogRecord {
		const exited = this.handles.filter(h => !h.isAlive())
		this.rec.exitedEarlyPids = exited.flatMap(h =>
			h.pid === undefined ? [] : [h.pid],
		)
		this.rec.effectiveCount = this.handles.length - exited.length
		return this.record
	}

	/** Spawns `n` children; on a spawn error stops those already started, then rethrows. */
	async start(n: number): Promise<HogRecord> {
		if (this.handles.length > 0 || this.stopping !== null)
			throw new WaveKitError("hog pool already used", "BUDGET_HOG")
		try {
			for (let i = 0; i < n; i++) {
				const h = this.spawner(i)
				this.handles.push(h)
				if (h.pid === undefined)
					throw new WaveKitError(`hog ${i} has no PID`, "BUDGET_HOG")
				this.rec.startedPids.push(h.pid)
				this.rec.count++
			}
		} catch (err) {
			await this.stop()
			throw err
		}
		return this.record
	}

	stop(): Promise<HogRecord> {
		this.stopping ??= this.stopAll()
		return this.stopping
	}

	/** Synchronous SIGKILL of every live child by its handle (for `process.on("exit")`). */
	stopNow(): void {
		for (const h of this.handles)
			if (h.isAlive())
				try {
					h.kill("SIGKILL")
				} catch {
					// already gone
				}
	}

	private async stopAll(): Promise<HogRecord> {
		await Promise.all(this.handles.map(h => this.stopOne(h)))
		return this.record
	}

	private async stopOne(h: HogHandle): Promise<void> {
		const pid = h.pid
		const exitedWithin = async (ms: number): Promise<boolean> => {
			const ac = new AbortController()
			try {
				return await Promise.race([
					h.exited.then(() => true),
					this.options.sleep(ms, ac.signal).then(() => false),
				])
			} finally {
				// The child exited (or the wait ran out): clear the race's timer.
				ac.abort()
			}
		}
		if (h.isAlive()) {
			try {
				h.kill("SIGTERM")
			} catch {
				// it may have exited between the check and the signal
			}
			if (!(await exitedWithin(this.graceMs)) && h.isAlive()) {
				if (pid !== undefined) this.rec.killedPids.push(pid)
				try {
					h.kill("SIGKILL")
				} catch {
					// as above
				}
				await exitedWithin(this.killWaitMs)
			}
		}
		if (pid === undefined) return
		if (h.isAlive()) this.rec.survivorPids.push(pid)
		else this.rec.stoppedPids.push(pid)
	}
}

/** `--hog N|auto` as a count (auto = the logical CPUs); null when it does not parse. */
export function parseHogCount(
	raw: string | undefined,
	parallelism: number,
): number | null {
	if (raw === undefined) return 0
	if (raw === "auto") return Math.max(1, Math.floor(parallelism))
	if (!/^\d+$/.test(raw)) return null
	const n = Number(raw)
	return n <= 256 ? n : null
}

export const CORE_QOS = ["default", "utility", "background"] as const
export type CoreQos = (typeof CORE_QOS)[number]

/**
 * The macOS `taskpolicy` prefix for `--core-qos` (taskpolicy(8) execs the program, so the PID is
 * kept): utility is a QoS clamp, background is PRIO_DARWIN_BG (`-b`); default runs without one.
 */
export function coreQosPrefix(qos: CoreQos, taskpolicy: string): string[] {
	if (qos === "utility") return [taskpolicy, "-c", "utility"]
	if (qos === "background") return [taskpolicy, "-b"]
	return []
}

export const CORE_QOS_LATE = ["utility", "background"] as const
export type CoreQosLate = (typeof CORE_QOS_LATE)[number]

/**
 * `--core-qos-late`: the taskpolicy(8) arguments (before `-p <pid>`) that move a running core into
 * the class and back out. `-p` takes no `-c` clamp, so utility is its throughput and latency tiers
 * (xnu's utility: throughput tier 2, latency tier 3; `ps -o pri=` does not show them); background
 * is PRIO_DARWIN_BG (`-b`, undone by `-B`). Either applies to the core's process only: children it
 * already spawned keep their policy.
 */
export function coreQosLateArgs(qos: CoreQosLate): {
	apply: string[]
	remove: string[]
} {
	return qos === "background"
		? { apply: ["-b"], remove: ["-B"] }
		: { apply: ["-t", "2", "-l", "3"], remove: ["-t", "0", "-l", "0"] }
}

/** `--core-qos` and `--core-qos-late` together: a WaveKitError (the two would fight). */
export function checkQosOptions(
	coreQos: string | undefined,
	coreQosLate: string | undefined,
): void {
	if (coreQos !== undefined && coreQosLate !== undefined)
		throw new WaveKitError(
			"--core-qos and --core-qos-late are mutually exclusive",
			"BUDGET_ARGS",
		)
}

/** The QoS class a `ps -o pri=` priority implies (darwin bg runs at 4 or below, a utility clamp at 20). */
export function qosOfPri(pri: number | null): CoreQos | null {
	if (pri === null) return null
	if (pri <= 4) return "background"
	if (pri <= 20) return "utility"
	return "default"
}

/** The expected nice of the core: the harness's plus --core-nice, clamped like nice(1) to [-20, 19]. */
export function expectedNice(harness: number, requested: number): number {
	return Math.min(19, Math.max(-20, harness + requested))
}

/** `date -u +%FT%TZ`: UTC to the second. */
export function utcStamp(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** The hog-window line of the coordinator's progress log. */
export function hogWindowLine(inputs: {
	startUtc: string
	stopUtc: string
	count: number
	label: string
	load1Start: number | null
	load1End: number | null
}): string {
	const l = (v: number | null): string => (v === null ? "n/a" : v.toFixed(2))
	return `${inputs.startUtc} .. ${inputs.stopUtc} hog window N=${inputs.count} label=${inputs.label} load1=${l(inputs.load1Start)}/${l(inputs.load1End)}`
}

// === per-stage sample accounting ===

/**
 * One stage of the IQ path over the window. `inSamples` is what the stage was offered, `outSamples`
 * what it passed on, `droppedSamples` an explicit drop counter (exact) when the stage keeps one.
 * Without a drop counter the loss is `in − out`, and `toleranceSamples` absorbs the skew of
 * counters read at slightly different moments (in flight, snapshot cadence). Every count is null
 * when it is not known (an edge read failed, a counter went backwards): unknown never reads as
 * "no loss".
 */
export interface StageCount {
	id: string
	label: string
	/** Position along the path; stages that share an order are parallel consumers. */
	order: number
	inSamples: number | null
	outSamples: number | null
	droppedSamples: number | null
	toleranceSamples: number
	source: string
	/** A cumulative counter of this stage went backwards in the window (a reset): its delta is unknown. */
	reset: boolean
}

export interface StageResult extends StageCount {
	/** The explicit counter when there is one, else `in − out`; null when neither is known. */
	lostSamples: number | null
	/** lost / in; null without an input count. */
	lossShare: number | null
	/** lost > tolerance; null when the loss is unknown. */
	losing: boolean | null
}

export function stageLoss(s: StageCount): StageResult {
	// A counter of this stage reset in the window: none of its figures is a window delta.
	const lost = s.reset
		? null
		: s.droppedSamples !== null
			? s.droppedSamples
			: s.inSamples !== null && s.outSamples !== null
				? s.inSamples - s.outSamples
				: null
	return {
		...s,
		lostSamples: lost,
		lossShare:
			lost !== null && s.inSamples !== null && s.inSamples > 0
				? lost / s.inSamples
				: null,
		losing: lost === null ? null : lost > s.toleranceSamples,
	}
}

export interface StageAccounting {
	stages: StageResult[]
	/** The first stage along the path that lost samples beyond its tolerance, or null. */
	firstLosing: {
		id: string
		label: string
		lostSamples: number
		lossShare: number | null
	} | null
	/**
	 * Stages of unknown loss up to the first losing one (its parallel consumers included, itself
	 * excluded), or every unknown stage when none lost: any of them may have lost first.
	 */
	unknownBefore: string[]
}

export function accountStages(counts: readonly StageCount[]): StageAccounting {
	const stages = counts
		.map(stageLoss)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
	const first = stages.find(s => s.losing === true)
	const limit = first === undefined ? Number.POSITIVE_INFINITY : first.order
	return {
		stages,
		firstLosing:
			first === undefined || first.lostSamples === null
				? null
				: {
						id: first.id,
						label: first.label,
						lostSamples: first.lostSamples,
						lossShare: first.lossShare,
					},
		unknownBefore: stages
			.filter(s => s.losing === null && s.order <= limit && s !== first)
			.map(s => s.id),
	}
}

/** b − a of two cumulative counters; null when either is unknown or b < a (`reset` then). */
export function counterDeltaOf(
	a: number | null | undefined,
	b: number | null | undefined,
): { delta: number | null; reset: boolean } {
	if (a === null || a === undefined || b === null || b === undefined)
		return { delta: null, reset: false }
	if (!Number.isFinite(a) || !Number.isFinite(b))
		return { delta: null, reset: false }
	if (b < a) return { delta: null, reset: true }
	return { delta: b - a, reset: false }
}

/** b − a of two cumulative counters, null when either is unknown or the counter went back. */
export function counterDelta(
	a: number | null | undefined,
	b: number | null | undefined,
): number | null {
	return counterDeltaOf(a, b).delta
}

export interface IdDelta {
	id: string
	/** null when unknown: an edge list did not parse, a value is missing, or the counter reset. */
	delta: number | null
	/** Edge A parsed and lacks this id: it appeared in the window (its B value is the delta). */
	openedInWindow: boolean
	/**
	 * Both edges parsed and B lacks this id: it closed (or restarted under a new id) in the
	 * window, so what it counted after A is unknown (never "no loss").
	 */
	closedInWindow: boolean
	reset: boolean
}

/**
 * b − a of one counter in two edge lists keyed by id. A list is null when its edge read failed:
 * with A null every delta is unknown (a cumulative counter is not a window delta); with B null the
 * ids of A are listed, all unknown. An id missing at a parsed A opened in the window (A = 0); an
 * id of A missing at a parsed B closed in the window (unknown), listed after the ids of B.
 */
export function deltaById<T extends { id: string }>(
	a: readonly T[] | null,
	b: readonly T[] | null,
	value: (x: T) => number | null,
): IdDelta[] {
	const unknown = (id: string, closedInWindow: boolean): IdDelta => ({
		id,
		delta: null,
		openedInWindow: false,
		closedInWindow,
		reset: false,
	})
	if (b === null) return (a ?? []).map(xa => unknown(xa.id, false))
	const seen = b.map(xb => {
		if (a === null) return unknown(xb.id, false)
		const xa = a.find(x => x.id === xb.id)
		const d =
			xa === undefined
				? counterDeltaOf(0, value(xb))
				: counterDeltaOf(value(xa), value(xb))
		return {
			id: xb.id,
			delta: d.delta,
			openedInWindow: xa === undefined,
			closedInWindow: false,
			reset: d.reset,
		}
	})
	const closed = (a ?? [])
		.filter(xa => !b.some(xb => xb.id === xa.id))
		.map(xa => unknown(xa.id, true))
	return [...seen, ...closed]
}

// --- the core's counters at the window edges (as read from its API) ---

export const ApiSourcesSchema = z.array(
	z.object({ id: z.string(), bytesReceived: z.number() }),
)
export const ApiFanoutSchema = z.object({
	branches: z.array(
		z.object({
			id: z.string(),
			decoderId: z.string().optional(),
			sourceId: z.string().optional(),
			droppedBytesTotal: z.number(),
			totalBytesWritten: z.number(),
		}),
	),
})
export const ApiDiagnosticsSchema = z.object({
	channels: z
		.object({
			rows: z.array(
				z.object({
					id: z.string(),
					decoderId: z.string(),
					format: z.string().optional(),
					stats: z
						.object({ outputSamples: z.number(), droppedSamples: z.number() })
						.nullable(),
				}),
			),
		})
		.nullable(),
})
export const ApiDecodersSchema = z.array(
	z.object({ id: z.string(), stats: z.object({ bytesIn: z.number() }) }),
)
export const ApiLiveAudioSchema = z.object({
	autoRoute: z
		.object({
			underruns: z.number(),
			zeroFilledSamples: z.number(),
			droppedMs: z.number(),
			clientCount: z.number(),
		})
		.optional(),
})
export const StandinCountSchema = z.object({
	name: z.string(),
	pid: z.number(),
	bytes: z.number(),
})
export const ApiEdgeSchema = z.object({
	/** When the window signal went out, and when the last read of this edge came back (ms). */
	signalMs: z.number(),
	doneMs: z.number(),
	sources: z.unknown(),
	fanout: z.unknown(),
	diagnostics: z.unknown(),
	decoders: z.unknown(),
	liveAudio: z.unknown(),
	/** Stand-in count files by name; null when the count dir could not be listed. */
	standins: z.record(z.unknown()).nullable(),
})
export type ApiEdge = z.infer<typeof ApiEdgeSchema>

/** Stages with no counter in the core (src/): they cannot be accounted from outside. */
export const STAGE_GAPS = [
	"channelizer process intake: no API counter of the IQ bytes wavekit-chan read from its stdin (only its fanout branch's offered and dropped bytes)",
	"live demod chain: no counter of the IQ the front process read or of the PCM its back process wrote (only its fanout branch)",
	"spectrum worker: no API counter of blocks handed to or dropped by the spectrum worker (only the scanner fanout branch); scanner activity and discovery rates (ws byType) are the only symptom",
	"short-lived channels: /api/diagnostics lists open channels only, so a channel opened and closed inside the window (the scanner's per-frequency dsd-fme channels) is in neither edge; their drops show only as `Channel discontinuity` log lines",
	"passive scanner: no sample counter (it consumes spectrum frames, not IQ)",
	"per-decoder stdin: the stand-ins count bytes per process, but the core reports bytesIn per decoder id; they are matched only as totals",
]

function parsedOr<T>(schema: z.ZodType<T>, v: unknown): T | null {
	const r = schema.safeParse(v)
	return r.success ? r.data : null
}

/** Bytes of CU8 IQ as samples. */
function half(v: number | null): number | null {
	return v === null ? null : v / 2
}

/** A fake rtl_tcp mark: cumulative bytes sent, signal skipped, and its monotonic clock. */
export interface FakeMark {
	bytes?: number | undefined
	skippedSeconds?: number | undefined
	monoMs?: number | undefined
	/** How far the fake's schedule ran ahead of its writes at the mark (ms); absent in older logs. */
	behindMs?: number | null | undefined
	/** Its socket was waiting for a drain at the mark (the core was not reading). */
	blocked?: boolean | null | undefined
	/** Clients the fake has accepted so far (a connect count; a change means a reconnect). */
	clients?: number | undefined
}

/** The fake rtl_tcp skips its whole backlog once it is more than this far behind (budget-fake-rtltcp.mjs). */
export const FAKE_MAX_BEHIND_S = 2

export interface FakeBehind {
	/** Lag at edge A / B in seconds; null when the mark has none (older fake). */
	aS: number | null
	bS: number | null
	blockedA: boolean | null
	blockedB: boolean | null
}

/** The fake's lag at each edge: signal held back by TCP backpressure, reported apart from loss. */
export function fakeBehindOf(
	a: FakeMark | undefined,
	b: FakeMark | undefined,
): FakeBehind {
	const s = (m: FakeMark | undefined): number | null =>
		typeof m?.behindMs === "number" && Number.isFinite(m.behindMs)
			? m.behindMs / 1000
			: null
	const bl = (m: FakeMark | undefined): boolean | null =>
		typeof m?.blocked === "boolean" ? m.blocked : null
	return { aS: s(a), bS: s(b), blockedA: bl(a), blockedB: bl(b) }
}

/** The backlog a lag will lose: past FAKE_MAX_BEHIND_S the fake skips all of it at its next write. */
function pendingSkipS(behindS: number): number {
	return behindS > FAKE_MAX_BEHIND_S ? behindS : 0
}

export interface StageInputs {
	rateHz: number
	windowSeconds: number
	sourceId: string
	/** The preload's IQ bytes on the source socket in the window. */
	socketBytes: number | null
	/** The fake rtl_tcp's marks at the window edges. */
	fakeA: FakeMark | undefined
	fakeB: FakeMark | undefined
	edgeA: ApiEdge | null
	edgeB: ApiEdge | null
	/** The /auto client's marks at the window edges. */
	autoA: { ms: number; bytes: number } | undefined
	autoB: { ms: number; bytes: number } | undefined
}

/** Stand-in bytes per count file; null when the dir was not listed or a listed file did not parse. */
function standinBytes(e: ApiEdge | null): Map<string, number> | null {
	if (e === null || e.standins === null) return null
	const m = new Map<string, number>()
	for (const [f, v] of Object.entries(e.standins)) {
		const r = StandinCountSchema.safeParse(v)
		if (!r.success) return null
		m.set(f, r.data.bytes)
	}
	return m
}

/** The IQ path's stages over the window, in path order (see StageCount). */
export function buildStages(i: StageInputs): StageCount[] {
	const stages: StageCount[] = []
	const rate = i.rateHz
	const skewS =
		i.edgeA && i.edgeB
			? (i.edgeA.doneMs -
					i.edgeA.signalMs +
					(i.edgeB.doneMs - i.edgeB.signalMs)) /
				1000
			: Number.POSITIVE_INFINITY
	const fakeBytes = counterDeltaOf(i.fakeA?.bytes, i.fakeB?.bytes)
	const fakeSent = half(fakeBytes.delta)
	const skippedD = counterDeltaOf(
		i.fakeA?.skippedSeconds,
		i.fakeB?.skippedSeconds,
	)
	const skipped =
		skippedD.delta === null ? null : Math.round(skippedD.delta * rate)
	// What the schedule owed over the marks' own interval. owed − sent − skipped is the change of
	// the fake's lag (behind B − behind A): a core that stops reading blocks the fake's writes (TCP
	// backpressure) and lets it fall behind, but that signal is only late, not lost. Signal is lost
	// only when the fake skips it: the skipped counter, plus a backlog past FAKE_MAX_BEHIND_S at B
	// (skipped at the next write) minus one already pending at A (it falls in this window's skips).
	const mono = counterDeltaOf(i.fakeA?.monoMs, i.fakeB?.monoMs)
	const owed =
		mono.delta === null ? null : Math.round((mono.delta / 1000) * rate)
	const behind = fakeBehindOf(i.fakeA, i.fakeB)
	const behindKnown = behind.aS !== null && behind.bS !== null
	const pending =
		behind.aS !== null && behind.bS !== null
			? Math.round((pendingSkipS(behind.bS) - pendingSkipS(behind.aS)) * rate)
			: 0
	// Marks without a lag (older fake): the lag grew by owed − sent − skipped, so lag B ≥ that
	// growth; past FAKE_MAX_BEHIND_S the fake skips all of lag B at its next write, and at least
	// the growth is this window's (a lower bound). Below it the lag is late signal, not loss.
	const lagGrowth =
		owed === null || fakeSent === null || skipped === null
			? 0
			: owed - fakeSent - skipped
	const growthLost =
		!behindKnown && lagGrowth > FAKE_MAX_BEHIND_S * rate ? lagGrowth : 0
	// A reconnect in the window breaks the lag bookkeeping: a backlog pending at A dies with its
	// socket without being counted as skipped. The stage is then unknown, and so is any negative
	// result, never a known zero loss. Marks without a client count (older logs) rely on the
	// negative guard alone.
	const ca = i.fakeA?.clients
	const cb = i.fakeB?.clients
	const sameClient =
		typeof ca !== "number" || typeof cb !== "number" || ca === cb
	const fakeRaw = skipped === null ? null : skipped + pending + growthLost
	const fakeDropped =
		!sameClient || fakeRaw === null || fakeRaw < 0 ? null : fakeRaw
	const lag = (v: number | null, blocked: boolean | null): string =>
		v === null
			? "n/a"
			: `${v.toFixed(2)} s${blocked === true ? " (blocked)" : ""}`
	stages.push({
		id: "fake-schedule",
		label:
			"fake rtl_tcp schedule (skipped while the core is over 2 s behind; a blocked lag is late signal, not loss)",
		order: 0,
		// Unknown drops leave the input unknown too: in − out here is the lag's change, not loss.
		inSamples:
			fakeDropped === null ? null : (owed ?? (fakeSent ?? 0) + fakeDropped),
		outSamples: fakeSent,
		droppedSamples: fakeDropped,
		toleranceSamples: 0,
		source: `fake marks: bytes, skippedSeconds and behindMs; skipped ${skipped ?? "n/a"} samples${pending !== 0 ? `, backlog past ${FAKE_MAX_BEHIND_S} s at B minus at A ${pending}` : ""}; fake behind at A ${lag(behind.aS, behind.blockedA)}, at B ${lag(behind.bS, behind.blockedB)}${behindKnown ? "" : ` (lag not in these marks; it grew ${(lagGrowth / rate).toFixed(2)} s${growthLost > 0 ? `, past ${FAKE_MAX_BEHIND_S} s: counted as lost, a lower bound` : ""})`}${owed === null ? "" : `; owed ${owed} over ${((mono.delta ?? 0) / 1000).toFixed(2)} s of the fake's clock`}`,
		reset: fakeBytes.reset || skippedD.reset || mono.reset,
	})
	const socket = i.socketBytes === null ? null : i.socketBytes / 2
	stages.push({
		id: "source-socket",
		label: "IQ source socket (TCP into the core)",
		order: 1,
		inSamples: fakeSent,
		outSamples: socket,
		droppedSamples: null,
		toleranceSamples: rate,
		source:
			"fake marks vs the preload's data events on the source socket; TCP does not drop, so a gap is data in flight (tolerance 1 s)",
		reset: fakeBytes.reset,
	})
	const srcA = parsedOr(ApiSourcesSchema, i.edgeA?.sources)
	const srcB = parsedOr(ApiSourcesSchema, i.edgeB?.sources)
	const sm = deltaById(srcA, srcB, x => x.bytesReceived).find(
		x => x.id === i.sourceId,
	)
	stages.push({
		id: "source-manager",
		label: "SourceManager bytesReceived",
		order: 2,
		inSamples: socket,
		outSamples: half(sm?.delta ?? null),
		droppedSamples: null,
		toleranceSamples: Number.isFinite(skewS) ? rate * (skewS + 0.5) : rate,
		source: `api /api/sources at the window edges; tolerance covers the edge skew (${Number.isFinite(skewS) ? skewS.toFixed(2) : "n/a"} s) plus 0.5 s`,
		reset: sm?.reset ?? false,
	})
	const fanA = parsedOr(ApiFanoutSchema, i.edgeA?.fanout)?.branches ?? null
	const fanB = parsedOr(ApiFanoutSchema, i.edgeB?.fanout)?.branches ?? null
	const offered = deltaById(fanA, fanB, x => x.totalBytesWritten)
	const dropped = deltaById(fanA, fanB, x => x.droppedBytesTotal)
	for (const o of offered) {
		const dr = dropped.find(x => x.id === o.id)
		const d = dr?.delta ?? null
		stages.push({
			id: `fanout:${o.id}`,
			label: `FanoutManager branch ${o.id}`,
			order: 3,
			inSamples: half(o.delta),
			outSamples: o.delta === null || d === null ? null : (o.delta - d) / 2,
			droppedSamples: half(d),
			toleranceSamples: 0,
			source: `api /api/telemetry/fanout: totalBytesWritten (offered) and droppedBytesTotal${o.openedInWindow ? "; branch added in the window" : ""}${o.closedInWindow ? "; branch closed in the window (unknown)" : ""}`,
			reset: o.reset || (dr?.reset ?? false),
		})
	}
	const rows = (e: ApiEdge | null) => {
		const d = parsedOr(ApiDiagnosticsSchema, e?.diagnostics)
		// A parsed answer without a channels section lists no channels; a failed read is unknown.
		return d === null ? null : (d.channels?.rows ?? [])
	}
	const chA = rows(i.edgeA)
	const chB = rows(i.edgeB)
	const out = deltaById(chA, chB, x => x.stats?.outputSamples ?? null)
	const drop = deltaById(chA, chB, x => x.stats?.droppedSamples ?? null)
	for (const o of out) {
		const dr = drop.find(x => x.id === o.id)
		const d = dr?.delta ?? null
		const decoder =
			(chB?.find(x => x.id === o.id) ?? chA?.find(x => x.id === o.id))
				?.decoderId ?? "?"
		stages.push({
			id: `channel:${decoder}`,
			label: `channelizer output ${o.id} for ${decoder}`,
			order: 4,
			inSamples: o.delta,
			outSamples: o.delta === null || d === null ? null : o.delta - d,
			droppedSamples: d,
			toleranceSamples: 0,
			source: `api /api/diagnostics channels: the process's 5 s stats line (outputSamples, droppedSamples)${o.openedInWindow ? "; opened in the window" : ""}${o.closedInWindow ? "; closed in the window (unknown)" : ""}`,
			reset: o.reset || (dr?.reset ?? false),
		})
	}
	const decA = parsedOr(ApiDecodersSchema, i.edgeA?.decoders)
	const decB = parsedOr(ApiDecodersSchema, i.edgeB?.decoders)
	// The core counts a channelized decoder's input in the channel's format (cf32 8 bytes, cu8 2);
	// an unchannelized one gets the source's U8 IQ (2 bytes per sample).
	const bytesPerSample = (decoderId: string): number =>
		(chB ?? chA)?.find(x => x.decoderId === decoderId)?.format === "cf32"
			? 8
			: 2
	const decDeltas = deltaById(decA, decB, x => x.stats.bytesIn)
	// Known (zero included) only when both edges parsed and every decoder's delta is known.
	const coreSamples =
		decA === null || decB === null
			? null
			: decDeltas.reduce<number | null>(
					(sum, x) =>
						sum === null || x.delta === null
							? null
							: sum + x.delta / bytesPerSample(x.id),
					0,
				)
	const sa = standinBytes(i.edgeA)
	const sb = standinBytes(i.edgeB)
	let standinSum: number | null = sa === null || sb === null ? null : 0
	let standinReset = false
	const perTool = new Map<string, number>()
	if (sa !== null && sb !== null)
		for (const [f, bytes] of sb) {
			// A count file missing at a listed edge A is a stand-in started in the window.
			const d = counterDeltaOf(sa.get(f) ?? 0, bytes)
			if (d.reset) standinReset = true
			if (d.delta === null || standinSum === null) {
				standinSum = null
				continue
			}
			standinSum += d.delta
			const tool = f.replace(/-\d+\.json$/, "")
			perTool.set(tool, (perTool.get(tool) ?? 0) + d.delta)
		}
	const sampleRate =
		coreSamples !== null && i.windowSeconds > 0
			? coreSamples / i.windowSeconds
			: 0
	stages.push({
		id: "decoder-stdin",
		label: "decoder input, all decoders (samples)",
		order: 5,
		inSamples: coreSamples,
		outSamples:
			standinSum !== null && sb !== null && (sb.size > 0 || coreSamples === 0)
				? standinSum / 2
				: null,
		droppedSamples: null,
		toleranceSamples:
			(3 * 65_536 * Math.max(1, sb?.size ?? 0)) / 2 +
			(Number.isFinite(skewS) ? sampleRate * (skewS + 0.5) : sampleRate),
		source: `api /api/decoders stats.bytesIn (summed, over the channel format's bytes per sample) vs the first stand-in of each decoder chain, stdin bytes / 2 (s16 after the rate-keeping csdr stub, or cu8): ${[...perTool].map(([k, v]) => `${k} ${v} B`).join(", ") || (sa === null || sb === null ? "count files unreadable at an edge" : "none ran")}; tolerance 3 pipes of 64 KiB per stand-in plus the edge skew${
			decDeltas.some(x => x.closedInWindow)
				? `; decoders closed in the window (unknown): ${decDeltas
						.filter(x => x.closedInWindow)
						.map(x => x.id)
						.join(", ")}`
				: ""
		}`,
		reset: standinReset || decDeltas.some(x => x.reset),
	})
	const live = (e: ApiEdge | null) =>
		parsedOr(ApiLiveAudioSchema, e?.liveAudio)?.autoRoute ?? null
	const la = live(i.edgeA)
	const lb = live(i.edgeB)
	const AUTO_RATE = 48_000
	const droppedMs = counterDeltaOf(la?.droppedMs, lb?.droppedMs)
	stages.push({
		id: "auto-route-dropped",
		label: "/auto route dropped input",
		order: 6,
		inSamples: null,
		outSamples: null,
		droppedSamples:
			droppedMs.delta === null
				? null
				: Math.round((droppedMs.delta * AUTO_RATE) / 1000),
		toleranceSamples: 0,
		source: "api /api/live-audio/status autoRoute.droppedMs (48 kHz samples)",
		reset: droppedMs.reset,
	})
	const zero = counterDeltaOf(la?.zeroFilledSamples, lb?.zeroFilledSamples)
	const underruns = counterDeltaOf(la?.underruns, lb?.underruns)
	stages.push({
		id: "auto-route-zero-fill",
		label: `/auto route zero-filled output (underruns ${underruns.delta ?? "n/a"})`,
		order: 7,
		inSamples: null,
		outSamples: null,
		droppedSamples: zero.delta,
		toleranceSamples: 0,
		source:
			"api /api/live-audio/status autoRoute.zeroFilledSamples and underruns (silence the pacer wrote for want of input)",
		reset: zero.reset || underruns.reset,
	})
	const autoMs = counterDeltaOf(i.autoA?.ms, i.autoB?.ms)
	const autoBytes = counterDeltaOf(i.autoA?.bytes, i.autoB?.bytes)
	stages.push({
		id: "auto-client",
		label: "/auto client received (s16le mono 48 kHz)",
		order: 8,
		inSamples:
			autoMs.delta === null
				? null
				: Math.round((autoMs.delta / 1000) * AUTO_RATE),
		outSamples: half(autoBytes.delta),
		droppedSamples: null,
		toleranceSamples: AUTO_RATE,
		source:
			"the /auto client's marks: expected 48 kHz over its own mark interval vs body bytes; tolerance 1 s (pacing and socket buffers)",
		reset: autoMs.reset || autoBytes.reset,
	})
	return stages
}

// === manifest schema ===

const Num = z.number().finite()
const NullableNum = Num.nullable()
const PartState = z.enum(["real", "stand-in", "absent", "unknown"])

const SpreadSchema = z.object({
	p50: NullableNum,
	p95: NullableNum,
	max: NullableNum,
})

const StageSchema = z.object({
	id: z.string(),
	label: z.string(),
	order: Num,
	inSamples: NullableNum,
	outSamples: NullableNum,
	droppedSamples: NullableNum,
	toleranceSamples: Num,
	source: z.string(),
	reset: z.boolean().default(false),
	lostSamples: NullableNum,
	lossShare: NullableNum,
	losing: z.boolean().nullable(),
})

const LoadTriple = z.array(Num).length(3)

/** Starvation runs (`--hog`, `--core-nice`): what loaded the host and what each stage lost. */
export const StarvationSchema = z.object({
	hog: z.object({
		requested: z.string(),
		count: z.number().int().min(0),
		startedPids: z.array(z.number().int()),
		stoppedPids: z.array(z.number().int()),
		killedPids: z.array(z.number().int()),
		survivorPids: z.array(z.number().int()),
		/** Hogs exited before the close signal, and how many were alive then; absent in older manifests. */
		exitedEarlyPids: z.array(z.number().int()).optional(),
		effectiveCount: z.number().int().min(0).nullable().optional(),
		startUtc: z.string().nullable(),
		stopUtc: z.string().nullable(),
		settleSeconds: Num,
		/** Nice of the first hog as ps read it. */
		nice: NullableNum,
	}),
	coreNice: z.object({
		requested: Num,
		/** As ps read it for the core's PID; null when it could not be read. */
		effective: NullableNum,
		harness: Num,
	}),
	/** `--core-qos`: the macOS taskpolicy the core ran under; absent in older manifests. */
	coreQos: z
		.object({
			requested: z.enum(CORE_QOS),
			/** The taskpolicy prefix of the core's command (empty for default). */
			command: z.array(z.string()),
			/** `ps -o pri=` of the core's PID just after its start; null when unreadable. */
			psPri: NullableNum,
			/** The class that priority implies (background ≤ 4, utility ≤ 20); null when unreadable. */
			effective: z.enum(CORE_QOS).nullable(),
		})
		.optional(),
	/** `--core-qos-late`: taskpolicy applied to the running core at the window open; absent otherwise. */
	coreQosLate: z
		.object({
			requested: z.enum(CORE_QOS_LATE),
			applyCommand: z.array(z.string()),
			removeCommand: z.array(z.string()),
			appliedUtc: z.string().nullable(),
			/** null when it was not removed (it then stays until the core exits). */
			removedUtc: z.string().nullable(),
			applyStatus: NullableNum,
			removeStatus: NullableNum,
			/** `ps -o pri=` of the core before the apply, after it, and after the removal. */
			psPriBefore: NullableNum,
			psPriApplied: NullableNum,
			psPriRemoved: NullableNum,
			scope: z.string(),
		})
		.optional(),
	/** The fake's lag at the edges (late signal under backpressure, not loss); absent in older manifests. */
	fakeBehind: z
		.object({
			aS: NullableNum,
			bS: NullableNum,
			blockedA: z.boolean().nullable(),
			blockedB: z.boolean().nullable(),
		})
		.optional(),
	/** How long each edge's API reads took (signal to last answer, ms); absent in older manifests. */
	edgeReads: z.object({ startMs: NullableNum, endMs: NullableNum }).optional(),
	loadavg: z.object({
		windowStart: LoadTriple,
		windowEnd: LoadTriple,
	}),
	loop: z.object({
		elu: NullableNum,
		p50Ms: NullableNum,
		p99Ms: NullableNum,
		p999Ms: NullableNum,
		maxMs: NullableNum,
		stalls: z
			.object({
				resolutionMs: Num,
				thresholdMs: Num,
				count: Num,
				totalMs: Num,
				over100: Num,
				over500: Num,
				over1000: Num,
				top: z.array(z.object({ atUtc: z.string(), ms: Num })),
			})
			.nullable(),
	}),
	stages: z.array(StageSchema),
	firstLosingStage: z
		.object({
			id: z.string(),
			label: z.string(),
			lostSamples: Num,
			lossShare: NullableNum,
		})
		.nullable(),
	unknownBeforeFirstLoss: z.array(z.string()),
	/** Stages that have no counter in the core (src/), so they cannot be accounted. */
	gaps: z.array(z.string()),
})
export type Starvation = z.infer<typeof StarvationSchema>

const CoverageClass = z.object({
	count: NullableNum,
	/** Where the count comes from (an exact count or a presence proxy). */
	source: z.string(),
})

export const ManifestSchema = z.object({
	schema: z.literal(2),
	label: z.string(),
	tier: z.enum(["A", "B"]),
	commit: z.object({ sha: z.string(), dirty: z.boolean() }),
	core: z.object({
		path: z.string(),
		sha256: z.string(),
		imageId: z.string().nullable(),
		/** Tier B: files bind-mounted over /app/dist (BUDGET_DIST_OVERLAY), or null. */
		overlay: z
			.array(z.object({ file: z.string(), sha256: z.string() }))
			.nullable(),
	}),
	scene: z.object({
		id: z.string(),
		sha256: z.string(),
		fixtures: z.enum(["modelled", "recorded"]),
	}),
	/** What ran: each part real, stand-in, absent or unknown, plus the run's knobs. */
	composition: z.object({
		parts: z.record(PartState),
		clients: z.number().int().min(0),
		passive: z.boolean(),
		notes: z.array(z.string()),
		/** Did the harness check, by the core's PID, that every listener is on loopback? */
		listenersChecked: z.boolean(),
	}),
	/** Was the timing window also CPU-profiled (sampling adds a little main-thread CPU)? */
	profiledTimingWindow: z.boolean(),
	coverage: z.object({
		classes: z.record(CoverageClass),
		/** Classes whose count was zero in the window. */
		missing: z.array(z.string()),
		/** Classes this run could not count. */
		unknown: z.array(z.string()),
	}),
	rateHz: Num,
	startUtc: z.string(),
	endUtc: z.string(),
	windowSeconds: Num,
	/** The window asked for: tier A --seconds before rounding up to whole scene periods, tier B BUDGET_SECONDS. */
	windowSecondsRequested: NullableNum,
	warmupSeconds: Num,
	/** Seconds of IQ the core received on its source socket in the window (the denominator). */
	iqSeconds: Num,
	/** The fake's own count between its marks (cross-check). */
	iqSecondsFake: NullableNum,
	/** |iqSeconds − iqSecondsFake| / iqSecondsFake. */
	iqSecondsDisagreement: NullableNum,
	/** Things to read before trusting the figures; they do not change timing validity. */
	warnings: z.array(z.string()),
	host: z.object({
		platform: z.string(),
		cpus: z.number().int(),
		loadSamples: z.array(Num),
		load: SpreadSchema,
		/** Tier B: the outer host's 1-min load (uptime) while the container ran. */
		outerLoad: SpreadSchema.nullable(),
	}),
	runQueueWaitShare: SpreadSchema.nullable(),
	timingValid: z.boolean(),
	timingInvalidReasons: z.array(z.string()),
	results: z.object({
		mainCpuMsPerIqSecond: NullableNum,
		processCpuMsPerIqSecond: NullableNum,
		workers: z.array(
			z.object({
				threadId: z.number().int().nullable(),
				name: z.string().nullable(),
				cpuMsPerIqSecond: NullableNum,
				source: z.string(),
			}),
		),
		workersUnknownReason: z.string().nullable(),
		/** Linux: every non-main thread of the core from /proc/self/task; null elsewhere. */
		threads: z
			.array(
				z.object({
					tid: z.number().int().nullable(),
					name: z.string(),
					cpuMsPerIqSecond: NullableNum,
					source: z.string(),
				}),
			)
			.nullable(),
		children: z.array(
			z.object({
				pid: z.number().int(),
				comm: z.string(),
				cpuMsPerIqSecond: NullableNum,
			}),
		),
		childrenUnknownReason: z.string().nullable(),
		elu: NullableNum,
		loopDelayMs: z.object({
			p50: NullableNum,
			p99: NullableNum,
			max: NullableNum,
		}),
		gc: z.record(z.object({ count: Num, ms: Num })),
		contextSwitches: z.object({
			voluntary: NullableNum,
			involuntary: NullableNum,
		}),
		writesPerSecond: z.record(z.object({ count: Num, bytes: Num })),
		structuredClonePerSecond: NullableNum,
		ws: z.array(
			z.object({
				client: z.string(),
				messagesPerSecond: NullableNum,
				bytesPerSecond: NullableNum,
				byType: z.record(z.object({ messages: Num, bytes: Num })),
			}),
		),
		sourceChunksPerSecond: NullableNum,
		/** Signal time the fake skipped between its marks (the core fell more than 2 s behind). */
		sourceSkippedSeconds: NullableNum,
		buckets: z
			.array(
				z.object({
					id: z.string(),
					label: z.string(),
					share: Num,
					nativeWriteShare: Num,
				}),
			)
			.nullable(),
		profileBusyShare: NullableNum,
		longTasks: z
			.object({
				thresholdMs: Num,
				count: Num,
				totalMs: Num,
				top: z.array(
					z.object({
						startMs: Num,
						durationMs: Num,
						buckets: z.record(Num),
					}),
				),
			})
			.nullable(),
		callsPerSecond: z
			.object({
				perturbed: z.literal(true),
				windowSeconds: Num,
				calls: z.record(NullableNum),
			})
			.nullable(),
	}),
	/** Tier A runs from the starvation harness onwards; absent in older manifests. */
	starvation: StarvationSchema.optional(),
})
export type Manifest = z.infer<typeof ManifestSchema>

// === comparison ===

export interface CompareRow {
	figure: string
	a: number | null
	b: number | null
	/** (b − a) / a × 100, null when a is 0 or either side is unknown. */
	changePct: number | null
}

export interface ComparedManifests {
	ok: true
	rows: CompareRow[]
	/** Present only when both manifests are timing-valid. */
	timingRows: CompareRow[] | null
	/**
	 * Starvation figures (hog, nice, load, ELU, loop delay, stalls, per-stage loss), printed even
	 * when a run is not timing-valid: a starved core is what these runs measure. Null when neither
	 * manifest has a starvation section.
	 */
	starvationRows: CompareRow[] | null
	/** Lines printed after the tables (timing suppression, profiling differences). */
	notes: string[]
}

export type CompareResult = { ok: false; refusal: string } | ComparedManifests

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				k =>
					`${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`
	return JSON.stringify(value)
}

function row(figure: string, a: number | null, b: number | null): CompareRow {
	const changePct =
		a === null || b === null || a === 0 ? null : ((b - a) / Math.abs(a)) * 100
	return { figure, a, b, changePct }
}

/** Which manifest is not timing-valid, and why, in one line. */
function timingLine(a: Manifest, b: Manifest): string {
	const bad: string[] = []
	for (const [name, m] of [
		["A", a],
		["B", b],
	] as const)
		if (!m.timingValid)
			bad.push(
				`${name} (${m.label}): ${m.timingInvalidReasons.join("; ") || "not timing-valid"}`,
			)
	return `Timing figures (ELU, loop delay, long tasks) not compared: ${bad.join(" | ")}`
}

/** Window lengths further apart than this share of the longer one are not compared. */
export const WINDOW_LENGTH_TOLERANCE = 0.02

export interface CompareOptions {
	/** Compare even when the coverage classes missing or unknown differ (noted). */
	allowCoverageDiff?: boolean
}

/** Classes in exactly one of the two lists. */
function symmetricDifference(
	x: readonly string[],
	y: readonly string[],
): string[] {
	const sx = new Set(x)
	const sy = new Set(y)
	return [...x.filter(k => !sy.has(k)), ...y.filter(k => !sx.has(k))].sort()
}

export function compareManifests(
	a: Manifest,
	b: Manifest,
	options: CompareOptions = {},
): CompareResult {
	if (a.tier !== b.tier)
		return { ok: false, refusal: `tier differs: ${a.tier} vs ${b.tier}` }
	if (a.scene.sha256 !== b.scene.sha256)
		return { ok: false, refusal: "scene sha256 differs" }
	if (a.rateHz !== b.rateHz)
		return { ok: false, refusal: `rate differs: ${a.rateHz} vs ${b.rateHz}` }
	if (stable(a.composition) !== stable(b.composition))
		return { ok: false, refusal: "composition differs" }
	const longer = Math.max(a.windowSeconds, b.windowSeconds)
	if (
		longer > 0 &&
		Math.abs(a.windowSeconds - b.windowSeconds) / longer >
			WINDOW_LENGTH_TOLERANCE
	)
		return {
			ok: false,
			refusal: `window length differs by more than ${WINDOW_LENGTH_TOLERANCE * 100} %: ${a.windowSeconds.toFixed(1)} s vs ${b.windowSeconds.toFixed(1)} s`,
		}
	const missingDiff = symmetricDifference(
		a.coverage.missing,
		b.coverage.missing,
	)
	const unknownDiff = symmetricDifference(
		a.coverage.unknown,
		b.coverage.unknown,
	)
	const coverageNote =
		missingDiff.length > 0 || unknownDiff.length > 0
			? `Coverage differs: ${[
					missingDiff.length > 0
						? `missing in one run only: ${missingDiff.join(", ")}`
						: "",
					unknownDiff.length > 0
						? `unknown in one run only: ${unknownDiff.join(", ")}`
						: "",
				]
					.filter(x => x !== "")
					.join("; ")}`
			: null
	if (coverageNote !== null && options.allowCoverageDiff !== true)
		return {
			ok: false,
			refusal: `${coverageNote} (pass --allow-coverage-diff to compare anyway)`,
		}
	const perWindowS = (
		m: Manifest,
		v: number | null | undefined,
	): number | null =>
		v === null || v === undefined || !(m.windowSeconds > 0)
			? null
			: v / m.windowSeconds
	const ra = a.results
	const rb = b.results
	const rows: CompareRow[] = [
		row(
			"main-thread CPU ms per IQ s",
			ra.mainCpuMsPerIqSecond,
			rb.mainCpuMsPerIqSecond,
		),
		row(
			"process CPU ms per IQ s",
			ra.processCpuMsPerIqSecond,
			rb.processCpuMsPerIqSecond,
		),
		row(
			"structuredClone per s",
			ra.structuredClonePerSecond,
			rb.structuredClonePerSecond,
		),
		row(
			"source chunks per s",
			ra.sourceChunksPerSecond,
			rb.sourceChunksPerSecond,
		),
	]
	const sumChildren = (m: Manifest): number | null => {
		if (m.results.childrenUnknownReason !== null) return null
		return m.results.children.reduce((s, c) => s + (c.cpuMsPerIqSecond ?? 0), 0)
	}
	rows.push(
		row("children CPU ms per IQ s (sum)", sumChildren(a), sumChildren(b)),
	)
	const workerKey = (w: Manifest["results"]["workers"][number]): string =>
		`${w.name ?? String(w.threadId)} (${w.source})`
	const workerKeys = new Set([
		...ra.workers.map(workerKey),
		...rb.workers.map(workerKey),
	])
	const workerSum = (m: Manifest, key: string): number | null => {
		const ws = m.results.workers.filter(w => workerKey(w) === key)
		if (ws.length === 0) return null
		return ws.reduce((s, w) => s + (w.cpuMsPerIqSecond ?? 0), 0)
	}
	for (const k of [...workerKeys].sort())
		rows.push(
			row(`worker ${k} CPU ms per IQ s`, workerSum(a, k), workerSum(b, k)),
		)
	const threadNames = new Set([
		...(ra.threads ?? []).map(t => t.name),
		...(rb.threads ?? []).map(t => t.name),
	])
	const threadSum = (m: Manifest, name: string): number | null => {
		const ts = (m.results.threads ?? []).filter(t => t.name === name)
		if (ts.length === 0) return null
		return ts.reduce((s, t) => s + (t.cpuMsPerIqSecond ?? 0), 0)
	}
	for (const n of [...threadNames].sort())
		rows.push(
			row(`thread ${n} CPU ms per IQ s`, threadSum(a, n), threadSum(b, n)),
		)
	const kinds = new Set([
		...Object.keys(ra.writesPerSecond),
		...Object.keys(rb.writesPerSecond),
	])
	for (const k of [...kinds].sort()) {
		rows.push(
			row(
				`${k} writes per s`,
				ra.writesPerSecond[k]?.count ?? null,
				rb.writesPerSecond[k]?.count ?? null,
			),
		)
		rows.push(
			row(
				`${k} write bytes per s`,
				ra.writesPerSecond[k]?.bytes ?? null,
				rb.writesPerSecond[k]?.bytes ?? null,
			),
		)
	}
	const gcKinds = new Set([...Object.keys(ra.gc), ...Object.keys(rb.gc)])
	for (const k of [...gcKinds].sort()) {
		rows.push(
			row(
				`GC ${k} count per window s`,
				perWindowS(a, ra.gc[k]?.count),
				perWindowS(b, rb.gc[k]?.count),
			),
		)
		rows.push(
			row(
				`GC ${k} ms per window s`,
				perWindowS(a, ra.gc[k]?.ms),
				perWindowS(b, rb.gc[k]?.ms),
			),
		)
	}
	const clients = new Set([
		...ra.ws.map(w => w.client),
		...rb.ws.map(w => w.client),
	])
	for (const c of [...clients].sort()) {
		const wa = ra.ws.find(w => w.client === c)
		const wb = rb.ws.find(w => w.client === c)
		rows.push(
			row(
				`ws ${c} messages per s`,
				wa?.messagesPerSecond ?? null,
				wb?.messagesPerSecond ?? null,
			),
		)
		rows.push(
			row(
				`ws ${c} bytes per s`,
				wa?.bytesPerSecond ?? null,
				wb?.bytesPerSecond ?? null,
			),
		)
	}
	if (ra.buckets && rb.buckets)
		for (const bk of ra.buckets) {
			const other = rb.buckets.find(x => x.id === bk.id)
			rows.push(
				row(
					`bucket ${bk.id} share of busy (%)`,
					bk.share * 100,
					other ? other.share * 100 : null,
				),
			)
		}
	if (ra.callsPerSecond && rb.callsPerSecond) {
		const names = new Set([
			...Object.keys(ra.callsPerSecond.calls),
			...Object.keys(rb.callsPerSecond.calls),
		])
		for (const n of [...names].sort())
			rows.push(
				row(
					`${n} calls per s (counts window)`,
					ra.callsPerSecond.calls[n] ?? null,
					rb.callsPerSecond.calls[n] ?? null,
				),
			)
	}
	const notes: string[] = []
	if (coverageNote !== null) notes.push(`${coverageNote}.`)
	if (a.profiledTimingWindow !== b.profiledTimingWindow)
		notes.push(
			"Only one of the two timing windows was CPU-profiled: profiling adds main-thread CPU, so the CPU rows lean against the profiled side.",
		)
	let timingRows: CompareRow[] | null = null
	if (a.timingValid && b.timingValid) {
		timingRows = [
			row("ELU", ra.elu, rb.elu),
			row("loop delay p50 ms", ra.loopDelayMs.p50, rb.loopDelayMs.p50),
			row("loop delay p99 ms", ra.loopDelayMs.p99, rb.loopDelayMs.p99),
			row("loop delay max ms", ra.loopDelayMs.max, rb.loopDelayMs.max),
		]
		if (ra.longTasks && rb.longTasks) {
			timingRows.push(
				row(
					"long tasks per window s",
					perWindowS(a, ra.longTasks.count),
					perWindowS(b, rb.longTasks.count),
				),
			)
			timingRows.push(
				row(
					"long task ms per window s",
					perWindowS(a, ra.longTasks.totalMs),
					perWindowS(b, rb.longTasks.totalMs),
				),
			)
			timingRows.push(
				row(
					"longest task ms",
					ra.longTasks.top[0]?.durationMs ?? 0,
					rb.longTasks.top[0]?.durationMs ?? 0,
				),
			)
		}
	} else notes.push(timingLine(a, b))
	const starvationRows = compareStarvation(a, b, notes)
	return { ok: true, rows, timingRows, starvationRows, notes }
}

/** No stage lost beyond its tolerance: "none" only when every stage is known. */
export function noKnownLoss(unknown: readonly string[]): string {
	return unknown.length === 0
		? "none"
		: `no known stage lost; unknown: ${unknown.join(", ")}`
}

/** The starvation rows, and a note naming each run's first losing stage. */
function compareStarvation(
	a: Manifest,
	b: Manifest,
	notes: string[],
): CompareRow[] | null {
	const sa = a.starvation
	const sb = b.starvation
	if (sa === undefined && sb === undefined) return null
	const rows: CompareRow[] = [
		row("hog children", sa?.hog.count ?? null, sb?.hog.count ?? null),
		row(
			"core nice (effective)",
			sa?.coreNice.effective ?? null,
			sb?.coreNice.effective ?? null,
		),
		row(
			"core ps pri (QoS)",
			sa?.coreQos?.psPri ?? null,
			sb?.coreQos?.psPri ?? null,
		),
		row(
			"edge A read ms",
			sa?.edgeReads?.startMs ?? null,
			sb?.edgeReads?.startMs ?? null,
		),
		row(
			"edge B read ms",
			sa?.edgeReads?.endMs ?? null,
			sb?.edgeReads?.endMs ?? null,
		),
		row(
			"load1 at window start",
			sa?.loadavg.windowStart[0] ?? null,
			sb?.loadavg.windowStart[0] ?? null,
		),
		row(
			"load1 at window end",
			sa?.loadavg.windowEnd[0] ?? null,
			sb?.loadavg.windowEnd[0] ?? null,
		),
		row(
			"load5 at window end",
			sa?.loadavg.windowEnd[1] ?? null,
			sb?.loadavg.windowEnd[1] ?? null,
		),
		row("ELU", sa?.loop.elu ?? null, sb?.loop.elu ?? null),
		row("loop delay p50 ms", sa?.loop.p50Ms ?? null, sb?.loop.p50Ms ?? null),
		row("loop delay p99 ms", sa?.loop.p99Ms ?? null, sb?.loop.p99Ms ?? null),
		row(
			"loop delay p99.9 ms",
			sa?.loop.p999Ms ?? null,
			sb?.loop.p999Ms ?? null,
		),
		row("loop delay max ms", sa?.loop.maxMs ?? null, sb?.loop.maxMs ?? null),
		row(
			"stalls (count)",
			sa?.loop.stalls?.count ?? null,
			sb?.loop.stalls?.count ?? null,
		),
		row(
			"stalls over 1 s",
			sa?.loop.stalls?.over1000 ?? null,
			sb?.loop.stalls?.over1000 ?? null,
		),
		row(
			"longest stall ms",
			sa?.loop.stalls?.top[0]?.ms ?? null,
			sb?.loop.stalls?.top[0]?.ms ?? null,
		),
	]
	const ids = [
		...new Set([
			...(sa?.stages ?? []).map(s => s.id),
			...(sb?.stages ?? []).map(s => s.id),
		]),
	]
	const order = (id: string): number =>
		(sa?.stages.find(s => s.id === id) ?? sb?.stages.find(s => s.id === id))
			?.order ?? 0
	ids.sort((x, y) => order(x) - order(y) || x.localeCompare(y))
	for (const id of ids) {
		const x = sa?.stages.find(s => s.id === id)
		const y = sb?.stages.find(s => s.id === id)
		rows.push(
			row(
				`stage ${id} lost samples`,
				x?.lostSamples ?? null,
				y?.lostSamples ?? null,
			),
		)
		rows.push(
			row(
				`stage ${id} loss (%)`,
				x?.lossShare === null || x?.lossShare === undefined
					? null
					: x.lossShare * 100,
				y?.lossShare === null || y?.lossShare === undefined
					? null
					: y.lossShare * 100,
			),
		)
	}
	const first = (name: string, m: Manifest): string => {
		const s = m.starvation
		if (s === undefined) return `${name} (${m.label}): no starvation section`
		const f = s.firstLosingStage
		const unknown =
			s.unknownBeforeFirstLoss.length > 0
				? ` (unknown before it: ${s.unknownBeforeFirstLoss.join(", ")})`
				: ""
		return f === null
			? `${name} (${m.label}): ${noKnownLoss(s.unknownBeforeFirstLoss)}`
			: `${name} (${m.label}): first losing stage ${f.id} (${f.label}), ${f.lostSamples} samples${f.lossShare === null ? "" : `, ${(f.lossShare * 100).toFixed(3)} %`}${unknown}`
	}
	notes.push(`First losing stage: ${first("A", a)} | ${first("B", b)}`)
	const qos = (m: Manifest): string => {
		const q = m.starvation?.coreQos
		return q === undefined
			? "not recorded"
			: `${q.requested} (effective ${q.effective ?? "unreadable"})`
	}
	notes.push(`Core QoS: A ${qos(a)} | B ${qos(b)}`)
	const behind = (m: Manifest): string => {
		const fb = m.starvation?.fakeBehind
		const v = (x: number | null, bl: boolean | null): string =>
			x === null ? "n/a" : `${x.toFixed(2)} s${bl === true ? " blocked" : ""}`
		return fb === undefined
			? "not recorded"
			: `${v(fb.aS, fb.blockedA)} -> ${v(fb.bS, fb.blockedB)}`
	}
	notes.push(`Fake behind (late, not lost): A ${behind(a)} | B ${behind(b)}`)
	const resets = (m: Manifest): string[] =>
		(m.starvation?.stages ?? []).filter(s => s.reset).map(s => s.id)
	const ra = resets(a)
	const rb = resets(b)
	if (ra.length > 0 || rb.length > 0)
		notes.push(
			`Counter resets (delta unknown): A ${ra.join(", ") || "none"} | B ${rb.join(", ") || "none"}`,
		)
	return rows
}

function cell(v: number | null): string {
	if (v === null) return "n/a"
	const abs = Math.abs(v)
	return abs >= 100 ? v.toFixed(0) : abs >= 1 ? v.toFixed(2) : v.toPrecision(3)
}

function table(rows: readonly CompareRow[], a: string, b: string): string {
	const lines = [
		`| Figure | ${a} | ${b} | Change |`,
		"| --- | --- | --- | --- |",
	]
	for (const r of rows)
		lines.push(
			`| ${r.figure} | ${cell(r.a)} | ${cell(r.b)} | ${
				r.changePct === null
					? "n/a"
					: `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)} %`
			} |`,
		)
	return lines.join("\n")
}

/** The comparison as Markdown (tables, then notes). */
export function formatComparison(
	a: Manifest,
	b: Manifest,
	result: ComparedManifests,
): string {
	const parts = [table(result.rows, `A (${a.label})`, `B (${b.label})`)]
	if (result.timingRows)
		parts.push(table(result.timingRows, `A (${a.label})`, `B (${b.label})`))
	if (result.starvationRows)
		parts.push(table(result.starvationRows, `A (${a.label})`, `B (${b.label})`))
	parts.push(...result.notes)
	return `${parts.join("\n\n")}\n`
}
