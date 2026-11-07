/**
 * GET /api/diagnostics. One sample at most every `DIAGNOSTICS_LIMITS.cacheMs`, shared by every
 * caller, with these costs per sample:
 * - `process.cpuUsage`, event-loop utilization, the meter and channel rows: O(1) or O(channels)
 *   memory reads on the main thread, no per-sample IQ work;
 * - on Linux: 1 async directory read and at most `threadsMax` async file reads, one at a time, so
 *   at most one file-pool thread is taken; no shell and no child process. One one-shot timer bounds
 *   the wait (`threadReadBudgetMs`); a read that hangs past it is left behind, and no new walk
 *   starts until it settles, so hung reads hold 1 file-pool thread at most however long they last;
 * - the container reading: the cgroup files GET /api/resources/container reads, small and in-memory.
 *   Those reads are synchronous on the main thread, after the walk: no timer can interrupt them, and
 *   were one to hang, the whole core would hang with it. The monitor's own 2 s poll makes the same
 *   reads, so this route adds no new way to hang.
 * The event-loop delay comes from the loop meter the core runs anyway (10 ms resolution, a native
 * timer recording into a fixed histogram): this route adds no meter of its own.
 */
import { readdir, readFile } from "node:fs/promises"
import { performance, type EventLoopUtilization } from "node:perf_hooks"
import {
	DIAGNOSTICS_LIMITS,
	diagnosticsResponseSchema,
	type Diagnostics,
	type DiagnosticsChannel,
	type DiagnosticsThread,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"

/**
 * The kernel's `USER_HZ`, fixed at 100 on the x86 and ARM Linux this image runs on: `/proc` reports
 * CPU in these ticks whatever the kernel's real tick. `getconf` would need a child process.
 */
const TICKS_PER_SECOND = 100

const TASK_DIR = "/proc/self/task"

/**
 * Thread names shown as they are: Node's own and the workers this core names, each as the kernel
 * holds it, cut to 15 bytes. Any program may set a name to anything, so everything else reads
 * `other`: a name is reported only when it could not have carried a value from outside.
 */
const KNOWN_THREAD_NAMES: ReadonlySet<string> = new Set([
	"node",
	"libuv-worker",
	"V8Worker",
	"DelayedTaskSche",
	"SignalInspector",
	"InspectorIo",
	"WorkerThread",
	"activity-writer",
	"scanner-snapsho",
	"aircraft-db-imp",
])
const SPECTRUM_WORKER_PREFIX = "spectrum-"
const OTHER_THREAD = "other"

/** A spectrum worker's name ends in its source id, operator text, so only the kind is kept. */
function safeThreadName(raw: string): string {
	if (KNOWN_THREAD_NAMES.has(raw)) return raw
	return raw.startsWith(SPECTRUM_WORKER_PREFIX)
		? "spectrum-worker"
		: OTHER_THREAD
}

/** A part the runtime supplies; absent or failing, it reads null and the sample still stands. */
function partOrNull<T>(read: (() => T) | undefined): T | null {
	try {
		return read?.() ?? null
	} catch {
		return null
	}
}

interface ThreadRow {
	tid: number
	name: string
	ticks: number
}

interface ThreadRead {
	rows: ThreadRow[]
	truncated: boolean
}

/** One walk of `/proc/self/task`. The deadline reads it as it stands and abandons it. */
interface ThreadWalk extends ThreadRead {
	listed: boolean
	abandoned: boolean
}

export interface DiagnosticsDeps {
	platform: NodeJS.Platform
	listThreads: () => Promise<readonly string[]>
	readThreadStat: (tid: string) => Promise<string>
	cpuUsage: () => NodeJS.CpuUsage
	/** No arguments: the totals so far; two: the difference between two totals. */
	utilization: (
		a?: EventLoopUtilization,
		b?: EventLoopUtilization,
	) => EventLoopUtilization
	monoNow: () => number
	now: () => number
	loopDelay: (() => Diagnostics["eventLoopDelay"]) | undefined
	channels: (() => readonly DiagnosticsChannel[]) | undefined
	containerCpuCores: (() => number | null) | undefined
}

/**
 * `tid (name) state ...` from a task's `stat`. The name may hold spaces and parentheses, so the
 * fields restart after the LAST `)`; utime and stime are fields 14 and 15 of the line, which is 11
 * and 12 after that point. Null when the line is not that shape.
 */
export function parseThreadStat(
	text: string,
): { name: string; ticks: number } | null {
	const open = text.indexOf("(")
	const close = text.lastIndexOf(")")
	if (open < 0 || close < open) return null
	const fields = text.slice(close + 2).split(" ")
	const utime = Number(fields[11])
	const stime = Number(fields[12])
	if (!Number.isSafeInteger(utime) || !Number.isSafeInteger(stime)) return null
	if (utime < 0 || stime < 0) return null
	return {
		name: safeThreadName(text.slice(open + 1, close)),
		ticks: utime + stime,
	}
}

/** Shares one sample between callers; see the file header for what a sample costs. */
export class DiagnosticsSampler {
	private cached: { at: number; value: Diagnostics } | null = null
	private inFlight: Promise<Diagnostics> | null = null
	/** The walk under way; once abandoned it stays here until its hung read settles. */
	private walk: ThreadWalk | null = null
	private previous: {
		at: number
		cpu: NodeJS.CpuUsage
		loop: EventLoopUtilization
		/** Replaced each sample, so it holds at most `threadsMax` entries. */
		ticks: Map<number, number>
	} | null = null

	constructor(private readonly deps: DiagnosticsDeps) {}

	read(): Promise<Diagnostics> {
		if (
			this.cached &&
			this.deps.monoNow() - this.cached.at < DIAGNOSTICS_LIMITS.cacheMs
		)
			return Promise.resolve(this.cached.value)
		this.inFlight ??= this.sample().finally(() => {
			this.inFlight = null
		})
		return this.inFlight
	}

	private async sample(): Promise<Diagnostics> {
		const { deps, previous } = this
		const ticks = new Map<number, number>()
		const { threads: threadRead, timedOut } = await this.readThreads()
		const at = deps.monoNow()
		const cpu = deps.cpuUsage()
		const loop = deps.utilization()
		const windowMs = previous && at > previous.at ? at - previous.at : null
		const coresOver = (seconds: number): number | null =>
			windowMs === null ? null : seconds / (windowMs / 1000)
		const rows: DiagnosticsThread[] = []
		for (const thread of threadRead?.rows ?? []) {
			ticks.set(thread.tid, thread.ticks)
			const before = previous?.ticks.get(thread.tid)
			// A lower count is a reused id, a new thread: it says nothing yet.
			rows.push({
				tid: thread.tid,
				name: thread.name,
				cpuSeconds: thread.ticks / TICKS_PER_SECOND,
				cpuCores:
					before === undefined || before > thread.ticks
						? null
						: coresOver((thread.ticks - before) / TICKS_PER_SECOND),
			})
		}
		// Busiest first, the question this answers; a thread with no figure yet goes last.
		rows.sort(
			(a, b) =>
				(b.cpuCores ?? -1) - (a.cpuCores ?? -1) || b.cpuSeconds - a.cpuSeconds,
		)
		const channels = partOrNull(deps.channels)
		const value: Diagnostics = {
			at: new Date(deps.now()).toISOString(),
			eventLoopUtilization: previous
				? deps.utilization(loop, previous.loop).utilization
				: null,
			eventLoopDelay: partOrNull(deps.loopDelay),
			process: {
				windowMs,
				cpuCores: previous
					? coresOver(
							(cpu.user +
								cpu.system -
								previous.cpu.user -
								previous.cpu.system) /
								1e6,
						)
					: null,
				userSeconds: cpu.user / 1e6,
				systemSeconds: cpu.system / 1e6,
			},
			containerCpuCores: partOrNull(deps.containerCpuCores),
			threads: threadRead && { rows, truncated: threadRead.truncated },
			threadsTimedOut: timedOut,
			channels: channels
				? {
						rows: channels.slice(0, DIAGNOSTICS_LIMITS.channelsMax),
						truncated: channels.length > DIAGNOSTICS_LIMITS.channelsMax,
					}
				: null,
		}
		this.previous = { at, cpu, loop, ticks }
		this.cached = { at, value }
		return value
	}

	/**
	 * Answers within `threadReadBudgetMs` whatever the reads do. Samples never overlap (`inFlight`),
	 * so a walk still here at the start of one was abandoned: at most one is ever outstanding, and
	 * while it hangs this starts no other.
	 */
	private async readThreads(): Promise<{
		threads: ThreadRead | null
		timedOut: boolean
	}> {
		if (this.deps.platform !== "linux")
			return { threads: null, timedOut: false }
		if (this.walk) return { threads: null, timedOut: true }
		const walk: ThreadWalk = {
			rows: [],
			truncated: false,
			listed: false,
			abandoned: false,
		}
		this.walk = walk
		const done = this.walkThreads(walk).finally(() => {
			this.walk = null
		})
		let timer: NodeJS.Timeout | undefined
		const deadline = new Promise<"deadline">(resolve => {
			timer = setTimeout(
				() => resolve("deadline"),
				DIAGNOSTICS_LIMITS.threadReadBudgetMs,
			)
			timer.unref()
		})
		const outcome = await Promise.race([done, deadline])
		clearTimeout(timer)
		if (outcome !== "deadline") return { threads: outcome, timedOut: false }
		walk.abandoned = true
		walk.truncated = true
		return { threads: walk.listed ? walk : null, timedOut: true }
	}

	/** Null when the list cannot be read; an unreadable thread (it ended) is skipped. Never rejects. */
	private async walkThreads(walk: ThreadWalk): Promise<ThreadRead | null> {
		const { deps } = this
		const started = deps.monoNow()
		let names: readonly string[]
		try {
			names = await deps.listThreads()
		} catch {
			return null
		}
		if (walk.abandoned) return null
		walk.listed = true
		const tids = names
			.map(Number)
			.filter(tid => Number.isSafeInteger(tid) && tid > 0)
			.sort((a, b) => a - b)
		walk.truncated = tids.length > DIAGNOSTICS_LIMITS.threadsMax
		for (const tid of tids.slice(0, DIAGNOSTICS_LIMITS.threadsMax)) {
			if (walk.abandoned) break
			if (deps.monoNow() - started > DIAGNOSTICS_LIMITS.threadReadBudgetMs) {
				walk.truncated = true
				break
			}
			try {
				const parsed = parseThreadStat(await deps.readThreadStat(String(tid)))
				if (parsed && !walk.abandoned) walk.rows.push({ tid, ...parsed })
			} catch {
				// It ended between the list and the read.
			}
		}
		return walk
	}
}

export interface DiagnosticsRoutesOptions {
	/** The loop meter's report; absent: `eventLoopDelay` reads null. */
	loopDelay?: (() => Diagnostics["eventLoopDelay"]) | undefined
	/** The channelizer's open channels; absent: `channels` reads null. */
	channels?: (() => readonly DiagnosticsChannel[]) | undefined
	containerCpuCores?: (() => number | null) | undefined
	/** Test seam. */
	deps?: Partial<DiagnosticsDeps> | undefined
}

export const diagnosticsRoutes: FastifyPluginAsync<
	DiagnosticsRoutesOptions
> = async (app, options) => {
	const sampler = new DiagnosticsSampler({
		platform: process.platform,
		listThreads: () => readdir(TASK_DIR),
		readThreadStat: tid => readFile(`${TASK_DIR}/${tid}/stat`, "latin1"),
		cpuUsage: () => process.cpuUsage(),
		utilization: (a, b) => performance.eventLoopUtilization(a, b),
		monoNow: () => performance.now(),
		now: () => Date.now(),
		loopDelay: options.loopDelay,
		channels: options.channels,
		containerCpuCores: options.containerCpuCores,
		...options.deps,
	})
	// Root access admission applies, as for the routes it summarizes.
	app.get(
		"/api/diagnostics",
		{
			schema: {
				summary: "Event-loop delay, CPU by thread, and open channels",
				tags: ["health"],
				response: { 200: diagnosticsResponseSchema },
			},
		},
		() => sampler.read(),
	)
}
