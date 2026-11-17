/**
 * Post-processing for the main-thread budget harness: pure functions over a V8 CPU profile, a
 * precise-coverage result and the text of the bundle that ran (no I/O here).
 *
 * The core bundle (`dist/index.js`) carries one `// src/...`, `// node_modules/...` or
 * `// packages/...` marker comment before each bundled module. A frame or function in the bundle
 * belongs to the module of the last marker at or before its line; a frame outside the bundle keeps
 * its URL (`nm/<path>` for an unbundled node_modules file, `native` without a URL).
 */
import { z } from "zod"

// === boundary schemas ===

export const CpuProfileSchema = z.object({
	nodes: z.array(
		z.object({
			id: z.number().int(),
			callFrame: z.object({
				functionName: z.string(),
				url: z.string(),
				lineNumber: z.number().int(),
				columnNumber: z.number().int().optional(),
				scriptId: z.union([z.string(), z.number()]).optional(),
			}),
			children: z.array(z.number().int()).optional(),
		}),
	),
	startTime: z.number(),
	endTime: z.number(),
	samples: z.array(z.number().int()),
	timeDeltas: z.array(z.number()),
})
export type CpuProfile = z.infer<typeof CpuProfileSchema>

export const PreciseCoverageSchema = z.array(
	z.object({
		scriptId: z.string().optional(),
		url: z.string(),
		functions: z.array(
			z.object({
				functionName: z.string(),
				ranges: z.array(
					z.object({
						startOffset: z.number().int(),
						endOffset: z.number().int(),
						count: z.number(),
					}),
				),
				isBlockCoverage: z.boolean().optional(),
			}),
		),
	}),
)
export type PreciseCoverage = z.infer<typeof PreciseCoverageSchema>

// === module mapping ===

/** How a profile or coverage result is tied to the bundle text. */
export interface BundleContext {
	/** The bundle's source text ("" when unknown: frames then keep their URL). */
	bundleText?: string
	/** True for the URL the bundle ran from. Default: any URL ending in `/dist/index.js`. */
	isBundleUrl?: (url: string) => boolean
}

const MARKER = /^\/\/ (src\/|node_modules\/|packages\/)/

export interface ModuleMapper {
	/** The owning module of a 0-based line of `url`. */
	moduleOf(url: string, line: number): string
	/** The 0-based line of a character offset into the bundle text. */
	lineOfOffset(offset: number): number
	isBundleUrl(url: string): boolean
}

/** Last index i with sorted[i] <= value, or -1. */
function lastAtOrBefore(sorted: readonly number[], value: number): number {
	let lo = 0
	let hi = sorted.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if ((sorted[mid] ?? Number.POSITIVE_INFINITY) <= value) lo = mid + 1
		else hi = mid
	}
	return lo - 1
}

export function createModuleMapper(ctx: BundleContext = {}): ModuleMapper {
	const text = ctx.bundleText ?? ""
	const isBundleUrl =
		ctx.isBundleUrl ?? ((url: string) => url.endsWith("/dist/index.js"))
	const markerLines: number[] = []
	const markerNames: string[] = []
	const lineStarts: number[] = [0]
	let line = 0
	let start = 0
	while (start <= text.length && text.length > 0) {
		const nl = text.indexOf("\n", start)
		const end = nl < 0 ? text.length : nl
		const lineText = text.slice(start, end)
		if (MARKER.test(lineText)) {
			markerLines.push(line)
			markerNames.push(lineText.slice(3).trim())
		}
		if (nl < 0) break
		start = nl + 1
		line++
		lineStarts.push(start)
	}
	return {
		isBundleUrl,
		lineOfOffset: offset => Math.max(0, lastAtOrBefore(lineStarts, offset)),
		moduleOf(url, ln) {
			if (url === "") return "native"
			if (isBundleUrl(url)) {
				const k = lastAtOrBefore(markerLines, ln)
				return k >= 0 ? (markerNames[k] ?? "prelude") : "prelude"
			}
			const nm = url.lastIndexOf("node_modules/")
			if (nm >= 0) return `nm/${url.slice(nm + "node_modules/".length)}`
			return url
		},
	}
}

// === buckets ===

/**
 * Disjoint buckets in priority order: a sample's self time goes to the first rule whose regex
 * matches any frame on its stack, a frame rendered as "<functionName> <module>". `idle` is not
 * busy time; every share below is of busy time (total minus idle).
 */
export const BUCKET_RULES: readonly {
	id: string
	label: string
	rx: RegExp
}[] = [
	{ id: "idle", label: "idle", rx: /^\(idle\) / },
	{ id: "GC", label: "garbage collector", rx: /^\(garbage collector\) / },
	{ id: "A1", label: "recorder: wasm NFM chain", rx: /wideband-nfm/ },
	{
		id: "A2",
		label: "recorder: judge/tones/ring read/turn",
		rx: /wideband-analog-recorder|speech-content|tone-class|voice-meter|voice-activity/,
	},
	{
		id: "A3",
		label: "recorder: wav + analog store io",
		rx: /wav-writer|analog-operations/,
	},
	{ id: "B1", label: "ws: spectrum frames", rx: /spectrum-broadcast/ },
	{
		id: "B2",
		label: "ws: scanner broadcast/limiter",
		rx: /scanner-broadcast|ws-limiter/,
	},
	{
		id: "B3",
		label: "ws: other broadcast/send",
		rx: /api\/websocket\/|nm\/ws\//,
	},
	{
		id: "C1",
		label: "control: reconcile pass",
		rx: /^reconcilePlacementsPass |^reconcilePlacements /,
	},
	{
		id: "C2",
		label: "control: caps change/evaluateRate",
		rx: /^handleCapsChange |^runPendingCapsChanges |^evaluateRate /,
	},
	{
		id: "C3",
		label: "control: efficiency/probation/other manager",
		rx: /efficiency-|decoders\/manager\.ts|placement-lifecycle|decoders\/enablement/,
	},
	{
		id: "D1",
		label: "scanner: track/discovery on spectrum events",
		rx: /^onPipelineEvent |^onSpectrumPipeline /,
	},
	{
		id: "D2",
		label: "spectrum-service frames/occupancy (non-ws)",
		rx: /spectrum-service/,
	},
	{
		id: "D3",
		label: "spectrum engine events decode/label",
		rx: /^onEvents |^emitLabelled |pipeline-host|summary-wire/,
	},
	{
		id: "D4",
		label: "scanner tick + other scanner",
		rx: /core\/scanner\/|bandplans\/scanner-feed/,
	},
	{ id: "E1", label: "iq: capture tool feed (tap)", rx: /iq-capture/ },
	{
		id: "E2",
		label: "iq: spectrum ingest (ring+batch+post)",
		rx: /spectrum-engine|iq-ring/,
	},
	{
		id: "E3",
		label: "iq: live demod squelch transform + audio",
		rx: /live-demod|channel-squelch|noise-squelch|audio-stream|analog-transmission|evidence-squelch|auto-listen|live-audio/,
	},
	{ id: "E4", label: "iq: channelizer mgmt/events", rx: /channelizer/ },
	{
		id: "E5",
		label: "iq: source ingest + fanout + absorber",
		rx: /source-manager|fanout|link-burst|signal-level/,
	},
	{
		id: "F",
		label: "decoders: output parse/observe",
		rx: /decoders\/|digital-voice|core\/activity/,
	},
	{
		id: "G",
		label: "api/log/resource",
		rx: /src\/api\/|pino|sonic-boom|resource-aggregator|container-monitor/,
	},
	{ id: "H", label: "zod (unattributed)", rx: /nm\/zod/ },
	{
		id: "I",
		label: "pipe relay w/o app frame (stream internals)",
		rx: /^onStreamRead |^onWriteComplete |streams\//,
	},
	{
		id: "J",
		label: "timers/microtasks w/o app frame",
		rx: /timers|task_queues/,
	},
	{ id: "K", label: "(program)", rx: /^\(program\) / },
]
export const OTHER_BUCKET = { id: "Z", label: "other" } as const

/** Native socket write calls whose self time each bucket also reports. */
export const NATIVE_WRITES: ReadonlySet<string> = new Set([
	"writeBuffer",
	"writev",
	"writeUtf8String",
	"writeLatin1String",
])

export interface BucketShare {
	id: string
	label: string
	/** Self time in the bucket (µs). */
	us: number
	/** Share of busy time. */
	share: number
	/** Share of busy time spent in native write calls inside this bucket. */
	nativeWriteShare: number
}

export interface BucketReport {
	totalUs: number
	idleUs: number
	busyUs: number
	/** Busy buckets in rule order, then Z; idle is reported only as `idleUs`. */
	buckets: BucketShare[]
}

interface Indexed {
	nodes: Map<number, CpuProfile["nodes"][number]>
	parent: Map<number, number>
	mapper: ModuleMapper
	bucketOf: Map<number, string>
}

function index(profile: CpuProfile, ctx: BundleContext): Indexed {
	const nodes = new Map<number, CpuProfile["nodes"][number]>()
	const parent = new Map<number, number>()
	for (const n of profile.nodes) {
		nodes.set(n.id, n)
		for (const c of n.children ?? []) parent.set(c, n.id)
	}
	return { nodes, parent, mapper: createModuleMapper(ctx), bucketOf: new Map() }
}

function frameText(ix: Indexed, id: number): string {
	const cf = ix.nodes.get(id)?.callFrame
	if (!cf) return "(anon) native"
	return `${cf.functionName || "(anon)"} ${ix.mapper.moduleOf(cf.url, cf.lineNumber)}`
}

/** The bucket of a profile node: first rule matching any frame from the node up to the root. */
function bucketOfNode(ix: Indexed, id: number): string {
	const known = ix.bucketOf.get(id)
	if (known !== undefined) return known
	const stack: string[] = []
	const seen = new Set<number>()
	for (
		let k: number | undefined = id;
		k !== undefined && !seen.has(k);
		k = ix.parent.get(k)
	) {
		seen.add(k)
		stack.push(frameText(ix, k))
	}
	let bucket: string = OTHER_BUCKET.id
	for (const rule of BUCKET_RULES)
		if (stack.some(f => rule.rx.test(f))) {
			bucket = rule.id
			break
		}
	ix.bucketOf.set(id, bucket)
	return bucket
}

/** Sample i's self time: the delta to the next sample (the last sample gets 0), never negative. */
function sampleUs(profile: CpuProfile, i: number): number {
	return Math.max(0, profile.timeDeltas[i + 1] ?? 0)
}

function isIdleNode(ix: Indexed, id: number): boolean {
	return ix.nodes.get(id)?.callFrame.functionName === "(idle)"
}

export function bucketShares(
	profile: CpuProfile,
	bundleText = "",
	ctx: Omit<BundleContext, "bundleText"> = {},
): BucketReport {
	const ix = index(profile, { ...ctx, bundleText })
	const us = new Map<string, number>()
	const writeUs = new Map<string, number>()
	let total = 0
	for (let i = 0; i < profile.samples.length; i++) {
		const id = profile.samples[i]
		if (id === undefined) continue
		const d = sampleUs(profile, i)
		if (d === 0) continue
		total += d
		const b = bucketOfNode(ix, id)
		us.set(b, (us.get(b) ?? 0) + d)
		const fn = ix.nodes.get(id)?.callFrame.functionName ?? ""
		if (NATIVE_WRITES.has(fn)) writeUs.set(b, (writeUs.get(b) ?? 0) + d)
	}
	const idleUs = us.get("idle") ?? 0
	const busyUs = total - idleUs
	const rows = [...BUCKET_RULES.filter(r => r.id !== "idle"), OTHER_BUCKET].map(
		(r): BucketShare => ({
			id: r.id,
			label: r.label,
			us: us.get(r.id) ?? 0,
			share: busyUs > 0 ? (us.get(r.id) ?? 0) / busyUs : 0,
			nativeWriteShare: busyUs > 0 ? (writeUs.get(r.id) ?? 0) / busyUs : 0,
		}),
	)
	return { totalUs: total, idleUs, busyUs, buckets: rows }
}

// === long tasks ===

export interface LongTask {
	/** Start, ms from the profile's start. */
	startMs: number
	durationMs: number
	/** Share of the task's time per bucket id (only buckets present). */
	buckets: Record<string, number>
}

export interface LongTaskReport {
	thresholdMs: number
	count: number
	totalMs: number
	/** At most 10, longest first. */
	top: LongTask[]
}

/**
 * Maximal runs of consecutive non-idle samples whose summed time reaches `thresholdMs`. An idle
 * sample ends a run; a run below the threshold is not a long task.
 */
export function longTasks(
	profile: CpuProfile,
	thresholdMs = 50,
	ctx: BundleContext = {},
): LongTaskReport {
	const ix = index(profile, ctx)
	const tasks: LongTask[] = []
	let at = 0
	let runStart = -1
	let runUs = 0
	let mix = new Map<string, number>()
	const close = (): void => {
		if (runStart >= 0 && runUs >= thresholdMs * 1000) {
			const buckets: Record<string, number> = {}
			for (const [b, v] of mix) buckets[b] = v / runUs
			tasks.push({
				startMs: runStart / 1000,
				durationMs: runUs / 1000,
				buckets,
			})
		}
		runStart = -1
		runUs = 0
		mix = new Map()
	}
	for (let i = 0; i < profile.samples.length; i++) {
		at += Math.max(0, profile.timeDeltas[i] ?? 0)
		const id = profile.samples[i]
		if (id === undefined) continue
		if (isIdleNode(ix, id)) {
			close()
			continue
		}
		const d = sampleUs(profile, i)
		if (runStart < 0) runStart = at
		runUs += d
		const b = bucketOfNode(ix, id)
		mix.set(b, (mix.get(b) ?? 0) + d)
	}
	close()
	tasks.sort((a, b) => b.durationMs - a.durationMs)
	return {
		thresholdMs,
		count: tasks.length,
		totalMs: tasks.reduce((s, t) => s + t.durationMs, 0),
		top: tasks.slice(0, 10),
	}
}

// === profile summary ===

export interface ProfileSummary {
	/** Null when the profile holds no idle time (see `warning`). */
	buckets: BucketShare[] | null
	busyShare: number | null
	longTasks: LongTaskReport | null
	/** Why buckets and long tasks are missing, or null. */
	warning: string | null
}

/**
 * Buckets, busy share and long tasks of one profile. A profile without any `(idle)` time cannot
 * tell a busy thread from one the sampler did not see idle (a profile of a loaded or a stalled
 * process), so it reports neither buckets nor long tasks rather than "100 % busy".
 */
export function summariseProfile(
	profile: CpuProfile,
	bundleText: string,
	ctx: Omit<BundleContext, "bundleText"> = {},
	thresholdMs = 50,
): ProfileSummary {
	const b = bucketShares(profile, bundleText, ctx)
	if (b.idleUs <= 0)
		return {
			buckets: null,
			busyShare: null,
			longTasks: null,
			warning:
				"the CPU profile holds no (idle) time: buckets and long tasks are not reported",
		}
	return {
		buckets: b.buckets,
		busyShare: b.totalUs > 0 ? b.busyUs / b.totalUs : null,
		longTasks: longTasks(profile, thresholdMs, { ...ctx, bundleText }),
		warning: null,
	}
}

// === call counts ===

export interface CountedFunction {
	name: string
	/** Owning module: a path suffix (`decoders/manager.ts`) or a package name (`zod`). */
	module: string
}

/** The functions whose call rate the counts window reports. */
export const COUNTED_FUNCTIONS: readonly CountedFunction[] = [
	{ name: "reconcilePlacementsPass", module: "decoders/manager.ts" },
	{ name: "planPlacements", module: "decoders/enablement/placement.ts" },
	{ name: "handleCapsChange", module: "decoders/manager.ts" },
	{ name: "runTurn", module: "scanner/channel/wideband-analog-recorder.ts" },
	{ name: "readSlice", module: "scanner/channel/wideband-analog-recorder.ts" },
	{ name: "onPipelineEvent", module: "scanner/scanner-service.ts" },
	{ name: "onTrack", module: "scanner/scanner-service.ts" },
	{ name: "tick", module: "scanner/scanner-service.ts" },
	{ name: "clone", module: "scanner/store/discovery-store.ts" },
	{ name: "get", module: "scanner/store/discovery-store.ts" },
	{ name: "distributeData", module: "fanout-manager.ts" },
	{ name: "forwardData", module: "source-manager.ts" },
	{ name: "ingest", module: "spectrum/spectrum-engine.ts" },
	{ name: "sendToClients", module: "api/websocket/events.ts" },
	{ name: "broadcast", module: "api/websocket/events.ts" },
	{ name: "flushClient", module: "api/websocket/events.ts" },
	{ name: "safeParse", module: "zod" },
]

/** A module path matches a path suffix, or a package name as a node_modules directory. */
export function moduleMatches(modulePath: string, wanted: string): boolean {
	if (wanted.includes("/") || wanted.includes("."))
		return modulePath === wanted || modulePath.endsWith(`/${wanted}`)
	return (
		modulePath.startsWith(`node_modules/${wanted}/`) ||
		modulePath.startsWith(`nm/${wanted}/`) ||
		modulePath.includes(`/node_modules/${wanted}/`)
	)
}

/**
 * Calls per listed function in a coverage window (V8 precise coverage with call counts: the
 * first range of a function holds its invocation count). Same-named functions of one module are
 * summed. A listed function the coverage never shows is `null`, not 0.
 */
export function callCounts(
	coverage: PreciseCoverage,
	bundleText: string,
	list: readonly CountedFunction[] = COUNTED_FUNCTIONS,
	ctx: Omit<BundleContext, "bundleText"> = {},
): Record<string, number | null> {
	const mapper = createModuleMapper({ ...ctx, bundleText })
	const out: Record<string, number | null> = {}
	for (const f of list) out[f.name] = null
	const byName = new Map<string, CountedFunction[]>()
	for (const f of list) byName.set(f.name, [...(byName.get(f.name) ?? []), f])
	for (const script of coverage) {
		const inBundle = mapper.isBundleUrl(script.url)
		for (const fn of script.functions) {
			const wanted = byName.get(fn.functionName)
			const first = fn.ranges[0]
			if (!wanted || !first) continue
			const mod = inBundle
				? mapper.moduleOf(script.url, mapper.lineOfOffset(first.startOffset))
				: mapper.moduleOf(script.url, 0)
			for (const w of wanted)
				if (moduleMatches(mod, w.module))
					out[w.name] = (out[w.name] ?? 0) + first.count
		}
	}
	return out
}
