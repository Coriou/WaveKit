import { z } from "zod"
import type { IdentifyRequest } from "./identify-state.js"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"

/** Zod v3 array.max still traverses elements. Abort before entering the array parser. */
function boundedArray<T extends z.ZodType<unknown>>(
	element: T,
	maximum: number,
) {
	return z
		.custom<
			unknown[]
		>(value => Array.isArray(value) && value.length <= maximum, { message: "Scan collection cardinality exceeded", fatal: true })
		.pipe(z.array(element))
}

const text = z.string().max(512)
const id = z.string().min(1).max(128)
const num = z.number().finite()
const hz = num.nonnegative()
const positive = num.positive()
const count = num.int().nonnegative()
const trust = z.enum(["commanded", "relay", "unverified"])
// Spectrum coordinates can cross zero; physical scanner/request frequencies stay nonnegative.
const spectrumRange = z
	.object({ startHz: num, endHz: num })
	.refine(v => v.endHz >= v.startHz)
const profile = z.object({
	key: id,
	hz: positive.max(25),
	bins: count.min(128).max(2048),
})
const frameSchema = z
	.object({
		sourceId: id,
		profile: id,
		epoch: count,
		tuningTrust: trust,
		centerHz: num,
		sampleRateHz: positive,
		binHz: positive,
		nativeBinHz: positive,
		startHz: num,
		binCount: count.min(1).max(2048),
		bins: z.string().max(2732),
		binEncoding: z.literal("u8-halfdb-127.5"),
		floorDbfs: num,
		thresholdDb: num,
		tracks: boundedArray(
			z
				.object({
					startHz: num,
					endHz: num,
					flags: z.object({
						burst: z.boolean(),
						iqImage: z.boolean(),
						edge: z.boolean(),
					}),
				})
				.refine(v => v.endHz >= v.startHz),
			256,
		),
		masks: z.object({
			dcHz: num,
			dcGuardHz: hz,
			spurRanges: boundedArray(spectrumRange, 128),
		}),
		snapshot: z.literal(true).optional(),
		at: text,
	})
	.superRefine((v, ctx) => {
		const expected = Math.ceil(v.binCount / 3) * 4
		if (
			v.bins.length !== expected ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				v.bins,
			) ||
			Buffer.from(v.bins, "base64").length !== v.binCount
		)
			ctx.addIssue({ code: "custom", message: "invalid spectrum bins" })
		const size = Number(v.profile.split(":")[1])
		if (
			!/^\d+(?:\.\d+)?:\d+$/.test(v.profile) ||
			!Number.isInteger(size) ||
			size < v.binCount ||
			size > 2048 ||
			v.nativeBinHz > v.binHz ||
			!Number.isFinite(v.startHz + v.binCount * v.binHz) ||
			!Number.isFinite(Date.parse(v.at))
		)
			ctx.addIssue({ code: "custom", message: "invalid spectrum axis" })
	})
const profileSchema = z
	.object({
		selection: z.enum(["none", "default", "source"]),
		sourceId: id.nullable(),
		profile: profile.nullable(),
		effectiveHz: positive.nullable(),
		outcome: z.enum(["default", "exact", "nearest", "rejected", "removed"]),
		adjusted: boundedArray(z.enum(["hz", "bins", "profile-limit"]), 3),
		removedSourceId: id.optional(),
		code: z
			.enum([
				"SPECTRUM_OPTIONS_INVALID",
				"SPECTRUM_SOURCE_NOT_FOUND",
				"SPECTRUM_SOURCE_NOT_IQ",
				"SPECTRUM_SOURCE_REMOVED",
				"SPECTRUM_ENGINE_ERROR",
			])
			.optional(),
		message: text.optional(),
	})
	.refine(v =>
		v.selection === "none"
			? v.profile === null && v.sourceId === null
			: v.profile !== null && (v.selection !== "source" || v.sourceId !== null),
	)
export function guardSpectrumFrame(
	v: unknown,
): SpectrumFrameEventData | undefined {
	const p = frameSchema.safeParse(v)
	if (!p.success) return undefined
	const { snapshot, ...frame } = p.data
	return { ...frame, ...(snapshot ? { snapshot } : {}) }
}
export function guardSpectrumProfile(
	v: unknown,
): SpectrumProfileEventData | undefined {
	const p = profileSchema.safeParse(v)
	if (!p.success) return undefined
	const { code, message, removedSourceId, ...profile } = p.data
	return {
		...profile,
		...(code ? { code } : {}),
		...(message !== undefined ? { message } : {}),
		...(removedSourceId ? { removedSourceId } : {}),
	}
}

const state = z.enum([
	"pending",
	"starting",
	"running",
	"holding",
	"paused",
	"completed",
	"cancelled",
	"failed",
])
const confidence = z.enum(["activity", "candidate", "classified", "decoded"])
const identity = z.object({ kind: text, value: text })
const levels = z.object({
	peakDbfs: num,
	meanDbfs: num,
	snrDb: num,
	floorDbfs: num,
})
const metadata = z.object({
	talkgroups: boundedArray(text, 64),
	sources: boundedArray(text, 64),
	slots: boundedArray(count, 64),
	callsigns: boundedArray(text, 64),
	capcodes: boundedArray(text, 64),
	ismModels: boundedArray(text, 64),
})
const trial = z.object({
	protocol: text,
	decoder: text.nullable(),
	mode: text.nullable(),
	transport: z.enum(["offset", "channel"]).nullable(),
	outcome: z.enum([
		"pending",
		"running",
		"decoded",
		"no-sync",
		"crc-errors",
		"timeout",
		"skipped-budget",
		"unsupported",
		"not-needed",
		"cancelled",
	]),
	reason: text.optional(),
})
const result = z.object({
	protocol: text.optional(),
	confidence,
	identity: identity.optional(),
	metadata,
	discoveryId: id.optional(),
	observationId: id.optional(),
	artefact: z.enum(["dc", "spur", "image", "rfi"]).optional(),
	ended: z.literal("window-moved").optional(),
	measurements: z.object({
		source: z.enum(["track", "spectrum"]),
		centreHz: hz,
		obwHz: hz.nullable(),
		peakDbfs: num.nullable(),
		snrDb: num.nullable(),
		floorDbfs: num.nullable(),
		dutyCycle: num.min(0).max(1).nullable(),
		class: text,
	}),
})
const identifyTarget = z.object({
	jobId: id,
	targetHz: hz,
	state: z.enum([
		"waiting-for-signal",
		"trying",
		"identified",
		"candidate",
		"unidentified",
	]),
	trials: boundedArray(trial, 128),
	result: result.optional(),
})
const job = z.object({
	id,
	name: text.nullable(),
	state,
	reason: text.optional(),
	passive: z.boolean(),
	spec: z.object({
		sourceId: id,
		mode: z.enum(["in-window", "sweep"]),
		kind: z.enum(["discover", "monitor", "identify"]),
	}),
	unrestorable: boundedArray(text, 64),
	createdAt: text,
	updatedAt: text,
	progress: z.object({
		sweepIndex: count,
		hopIndex: count,
		hopCount: count,
		coverage: num.min(0).max(1),
		probes: boundedArray(
			z.object({
				probeId: id,
				decoderId: id,
				targetHz: hz,
				protocol: text,
				transport: z.enum(["offset", "channel"]),
				state: text,
			}),
			128,
		),
	}),
	identify: z
		.object({
			target: z
				.union([
					z.object({
						frequencyHz: positive,
						bandwidthHz: positive.max(1_000_000).optional(),
					}),
					z.object({ all: z.literal(true) }),
				])
				.optional(),
			timeoutMs: positive.int().optional(),
			protocols: boundedArray(text, 128).optional(),
			exhaustive: z.boolean().optional(),
			record: z.boolean().optional(),
			targets: boundedArray(identifyTarget, 256),
		})
		.optional(),
})
const discovery = z.object({
	id,
	frequencyHz: hz,
	bandwidthHz: hz,
	protocol: text,
	confidence,
	confidenceCap: text.optional(),
	identity: identity.optional(),
	encrypted: z.boolean(),
	tuningTrust: trust,
	undecodedReason: text.optional(),
	lastSeenAt: text,
	observationCount: count,
	airtimeMs: hz,
	sourceIds: boundedArray(id, 64),
	jobIds: boundedArray(id, 256),
	signal: z.object({ best: levels, last: levels }),
	metadata,
	evidence: z.object({ recordings: count, psd: z.boolean(), iq: z.boolean() }),
	operator: z.object({ lockout: z.boolean().optional() }).optional(),
})
const observation = z.object({
	id,
	sourceId: id,
	jobIds: boundedArray(id, 256),
})
const scanner = z.object({
	enabled: z.boolean(),
	channelizerAvailable: z.boolean(),
	disk: z.enum(["ok", "disk-low"]),
	jobs: z.object({ active: count, total: count }),
	budgets: z.object({
		cpuBudgetCores: hz,
		cpuCoresInUse: hz,
		maxProbes: z.object({ offset: count, channel: count }),
		probesInUse: z.object({ offset: count, channel: count }),
	}),
	cpuGuard: z.object({
		percent: hz.nullable(),
		limitPercent: hz,
		source: z.enum(["os", "cgroup"]),
	}),
	engines: boundedArray(
		z.object({
			sourceId: id,
			state: z.enum(["idle", "running", "stopped", "error"]),
			passive: z.object({
				enabled: z.boolean(),
				disabledReason: text.optional(),
			}),
			lastError: text.optional(),
			blankedFrames: count,
			broadbandRfi: z.object({ periodMs: hz }).nullable(),
		}),
		128,
	),
})
const spectrum = z.object({
	defaultProfile: profile,
	sources: boundedArray(
		z.object({
			sourceId: id,
			eligible: z.boolean(),
			reason: z.enum(["source-not-iq", "source-removed"]).optional(),
			engine: z.enum(["running", "idle", "error"]),
			lastError: text.optional(),
			tuningTrust: trust.nullable(),
		}),
		128,
	),
})
export const scanSchemas = {
	status: scanner,
	spectrum,
	jobs: boundedArray(job, 10000),
	discoveries: z.object({
		items: boundedArray(discovery, 50),
		nextCursor: z.string().max(2048).nullable(),
	}),
	job,
	discovery,
	observations: z.object({
		items: boundedArray(observation, 50),
		nextCursor: z.string().max(2048).nullable(),
	}),
}
export type ScanRead = keyof typeof scanSchemas
export type ScanValues = { [K in ScanRead]: z.infer<(typeof scanSchemas)[K]> }
export type ScanJob = ScanValues["job"]
export type ScanDiscovery = ScanValues["discovery"]
/** Older reduced jobs remain inspectable; only this complete projection attributes a POST. */
export function guardIdentifyJob(
	v: unknown,
	request: IdentifyRequest,
): ScanJob | undefined {
	const p = job.safeParse(v)
	if (!p.success) return undefined
	const j = p.data
	const i = j.identify
	if (
		j.spec.sourceId !== request.sourceId ||
		j.spec.kind !== "identify" ||
		j.spec.mode !== "in-window" ||
		!i ||
		!i.target ||
		!("frequencyHz" in i.target) ||
		i.target.frequencyHz !== request.target.frequencyHz ||
		i.target.bandwidthHz !== request.target.bandwidthHz ||
		i.timeoutMs !== request.timeoutMs ||
		i.exhaustive !== request.exhaustive ||
		i.record !== request.record ||
		!i.protocols ||
		i.protocols.length !== 0 ||
		i.targets.some(t => t.jobId !== j.id)
	)
		return undefined
	return j
}
export function guardScan<K extends ScanRead>(
	key: K,
	v: unknown,
): ScanValues[K] | undefined {
	const p = scanSchemas[key].safeParse(v)
	return p.success ? (p.data as ScanValues[K]) : undefined
}

export type ScanEvent =
	| { type: "spectrum:profile"; profile: SpectrumProfileEventData }
	| { type: "spectrum:frame"; frame: SpectrumFrameEventData }
	| { type: "scanner:invalidate"; key: string }
	| { type: "scanner:status"; status: ScanValues["status"] }
export function parseScanEvent(
	type: string,
	data: unknown,
): ScanEvent | undefined {
	if (type === "spectrum:profile") {
		const p = guardSpectrumProfile(data)
		return p ? { type, profile: p } : undefined
	}
	if (type === "spectrum:frame") {
		const f = guardSpectrumFrame(data)
		return f ? { type, frame: f } : undefined
	}
	if (type === "scanner:status") {
		const s = guardScan("status", data)
		return s ? { type, status: s } : undefined
	}
	if (type === "scanner:job") {
		const j = guardScan("job", data)
		return j ? { type: "scanner:invalidate", key: `job:${j.id}` } : undefined
	}
	if (type === "scanner:identify") {
		const p = identifyTarget.safeParse(data)
		return p.success
			? { type: "scanner:invalidate", key: `job:${p.data.jobId}` }
			: undefined
	}
	if (type === "scanner:discovery") {
		const p = z
			.object({
				change: z.enum(["created", "updated", "upgraded", "merged", "deleted"]),
				discovery,
			})
			.safeParse(data)
		return p.success
			? { type: "scanner:invalidate", key: `discovery:${p.data.discovery.id}` }
			: undefined
	}
	if (type === "scanner:progress") {
		const p = z
			.object({
				jobId: id,
				state,
				sweepIndex: count,
				hopIndex: count,
				hopCount: count,
				centerHz: hz,
				probes: count,
				coverage: num.min(0).max(1),
			})
			.safeParse(data)
		return p.success
			? { type: "scanner:invalidate", key: `job:${p.data.jobId}` }
			: undefined
	}
	if (type === "scanner:activity") {
		const p = z
			.object({
				sourceId: id,
				observationId: id,
				frequencyHz: hz,
				active: z.boolean(),
			})
			.safeParse(data)
		return p.success
			? { type: "scanner:invalidate", key: `source:${p.data.sourceId}` }
			: undefined
	}
	return undefined
}
