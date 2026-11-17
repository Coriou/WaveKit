/**
 * The main-thread budget manifest: its Zod schema, the timing-validity rule, summary maths, the
 * parsers of the collected process listings and the before/after comparison. Pure (no I/O),
 * shared by the tier A runner, the tier B post-processing and `budget-compare.ts`.
 */
import { z } from "zod"

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

// === manifest schema ===

const Num = z.number().finite()
const NullableNum = Num.nullable()
const PartState = z.enum(["real", "stand-in", "absent", "unknown"])

const SpreadSchema = z.object({
	p50: NullableNum,
	p95: NullableNum,
	max: NullableNum,
})

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
	return { ok: true, rows, timingRows, notes }
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
	parts.push(...result.notes)
	return `${parts.join("\n\n")}\n`
}
