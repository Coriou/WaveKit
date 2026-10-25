/**
 * Scanner REST API (spec § 12.1). All additive; errors use the repo's flat
 * `{ error, code, message, details? }` body.
 *
 * Error codes (a ScannerApiError answers with its own status):
 * - 400 `VALIDATION_ERROR` (schema or settings PATCH), `SCANNER_PLAN_INVALID` `{issues}`,
 *   `SCANNER_MONITOR_UNAVAILABLE`, `SCANNER_SETTINGS_INVALID` `{issues}`, `SCANNER_IDENTIFY_VIA_JOBS`
 * - 404 `SCANNER_NOT_FOUND`, `SCANNER_JOB_NOT_FOUND`, `SCANNER_DISCOVERY_NOT_FOUND`
 * - 409 `SCANNER_TAKEOVER_REQUIRED` `{impact}`, `SCANNER_SOURCE_BUSY` (the message carries the
 *   arbiter's detail: "holder is starting", "releasing", "recovery pending", …),
 *   `SCANNER_NO_TUNER_CONTROL`, `SCANNER_JOB_TERMINAL`, `SCANNER_JOB_NOT_TERMINAL`,
 *   `SCANNER_INVALID_TRANSITION`, `SCANNER_DISCOVERY_LOCKED_OUT`, `OUT_OF_WINDOW` `{window}`,
 *   `LIVE_AUDIO_UNAVAILABLE`, `SCANNER_IDENTIFY_NOT_PAUSABLE`, `SCANNER_IDENTIFY_NOT_EDITABLE`
 * - 500 `SCANNER_SETTINGS_WRITE_FAILED`
 * - 503 `SCANNER_DISABLED`, `SCANNER_STATE_UNAVAILABLE`
 */
import type { ReadStream } from "node:fs"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"
import {
	deriveLegacyAudioUrlFromBase,
	requestHostHeader,
} from "./legacy-audio-host.js"
import { createReadStream } from "node:fs"
import type { ScannerIdentifyRequest } from "@wavekit/api-types"
import type {
	FastifyInstance,
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
} from "fastify"
import { ZodError, ZodIssueCode } from "zod"
import { ScannerApiError } from "../../core/scanner/errors.js"
import type { ScannerService } from "../../core/scanner/scanner-service.js"
import { ScannerSettingsPatchSchema } from "../../core/scanner/settings.js"
import type { DiscoveryFilter } from "../../core/scanner/store/discovery-store.js"
import type {
	Discovery,
	Identity,
	IdentityKind,
	ScanExclusion,
	ScanJobSpec,
	ScanRange,
	ScannerConfidence,
	ScannerProtocol,
} from "../../core/scanner/types.js"
import { RECORDING_ID } from "../../core/scanner/store/evidence-store.js"
import { CAPTURE_ID } from "../../core/scanner/evidence/capture-store.js"
import { JOB_HITS_LIMIT_DEFAULT } from "../../core/scanner/job-hits.js"
import { ConfigValidationError } from "../../utils/errors.js"
import { withCoverage } from "../../core/scanner/discovery-coverage.js"
import type { CoverageIndex } from "../../core/scanner/discovery-coverage.js"
import {
	captureIdParamsSchema,
	discoveryIdParamsSchema,
	discoveryPatchSchema,
	discoveryQuerySchema,
	errorResponseSchema,
	IDENTITY_QUERY,
	identifyBodySchema,
	jobIdParamsSchema,
	looseObjectSchema,
	observationsQuerySchema,
	jobHitsQuerySchema,
	jobHitsResponseSchema,
	resumeBodySchema,
	scanJobSpecSchema,
} from "./scanner-schemas.js"

/** Band inspection UX req 3.3: on a successful DELETE of a discovery (204, no body). */
export const DISCOVERY_EPOCH_HEADER = "x-wavekit-store-epoch"
export const DISCOVERY_REVISION_HEADER = "x-wavekit-store-revision"

export type ScannerRouteService = Pick<
	ScannerService,
	| "status"
	| "settingsView"
	| "patchSettings"
	| "bandplans"
	| "preview"
	| "createJob"
	| "listJobs"
	| "getJob"
	| "jobHits"
	| "patchJob"
	| "pauseJob"
	| "resumeJob"
	| "cancelJob"
	| "deleteJob"
	| "listDiscoveries"
	| "getDiscovery"
	| "discoveryObservations"
	| "patchDiscovery"
	| "deleteDiscovery"
	| "recordingPath"
	| "evidencePath"
	| "listen"
	| "identify"
	| "listCaptures"
	| "capturePath"
	| "deleteCapture"
> &
	// Band inspection UX req 1.4 / 3.1: optional so an older service shape still serves.
	Partial<
		Pick<ScannerService, "resolveDiscovery" | "discoveryCoverage" | "storeMeta">
	>

export interface ScannerRoutesOptions {
	scanner: ScannerRouteService
	access?: FastifyAccessController
	/**
	 * Legacy mode only (WG9 5.5): the listen answer's localhost fallback stream URLs
	 * follow the request's own Host, per response. Absent: the stored URLs.
	 */
	legacyAudioHost?: boolean
}

interface DiscoveryQuery {
	jobId?: string
	sourceId?: string
	protocol?: ScannerProtocol
	minConfidence?: ScannerConfidence
	freqMinHz?: number
	freqMaxHz?: number
	since?: string
	encrypted?: boolean
	q?: string
	identity?: string
	sort?: "lastSeen" | "frequency" | "confidence"
	cursor?: string
	limit?: number
	evidence?: "proven" | "weak" | "all"
	nearHz?: number
	toleranceHz?: number
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
	if (err instanceof ScannerApiError) {
		return reply.code(err.statusCode).send({
			error: err.name,
			code: err.code,
			message: err.message,
			...(err.details ? { details: err.details } : {}),
		})
	}
	if (err instanceof ZodError) {
		return reply.code(400).send({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message: ConfigValidationError.formatZodError(err),
		})
	}
	throw err
}

/** Wire form of a range: § 5.1 also allows the `spacingHz`/`firstChannelHz` shorthand for one raster. */
interface ScanRangeBody extends ScanRange {
	spacingHz?: number
	firstChannelHz?: number
}

/** Wire form of an exclusion: `{startHz, endHz}` or a frequency with a width (§ 5.1); the schema requires one pair. */
interface ScanExclusionBody {
	startHz?: number
	endHz?: number
	frequencyHz?: number
	widthHz?: number
	reason?: string
}

type ScanJobSpecBody = Omit<ScanJobSpec, "ranges" | "exclusions"> & {
	ranges?: ScanRangeBody[]
	exclusions?: ScanExclusionBody[]
}

/**
 * Converts the § 5.1 shorthands into the core types. A missing firstChannelHz puts the first
 * channel half a step inside startHz (the PMR446 / land-mobile convention of the built-in plans).
 */
function toRange({
	spacingHz,
	firstChannelHz,
	...range
}: ScanRangeBody): ScanRange {
	if (spacingHz === undefined) return range
	return {
		...range,
		rasters: [
			{
				spacingHz,
				firstChannelHz: firstChannelHz ?? range.startHz + spacingHz / 2,
			},
		],
	}
}

function toExclusion(x: ScanExclusionBody): ScanExclusion {
	const reason = x.reason !== undefined ? { reason: x.reason } : {}
	if (x.startHz !== undefined && x.endHz !== undefined)
		return { startHz: x.startHz, endHz: x.endHz, ...reason }
	// The schema's oneOf guarantees frequencyHz and widthHz here.
	const centre = x.frequencyHz ?? 0
	const half = (x.widthHz ?? 0) / 2
	return { startHz: centre - half, endHz: centre + half, ...reason }
}

function fromSpecBody({
	ranges,
	exclusions,
	...rest
}: ScanJobSpecBody): ScanJobSpec {
	return {
		...rest,
		...(ranges !== undefined ? { ranges: ranges.map(toRange) } : {}),
		...(exclusions !== undefined
			? { exclusions: exclusions.map(toExclusion) }
			: {}),
	}
}

interface IdentifyBody {
	sourceId?: string
	target: { frequencyHz?: number; bandwidthHz?: number; all?: boolean }
	timeoutMs?: number
	protocols?: ScannerProtocol[]
	exhaustive?: boolean
	record?: boolean
}

/** The schema admits exactly one of `all: true` or `frequencyHz`; a bandwidth only means something with a frequency. */
function toIdentifyRequest({
	target,
	...rest
}: IdentifyBody): ScannerIdentifyRequest {
	return {
		...rest,
		target:
			target.all === true
				? { all: true }
				: {
						frequencyHz: target.frequencyHz ?? 0,
						...(target.bandwidthHz !== undefined
							? { bandwidthHz: target.bandwidthHz }
							: {}),
					},
	}
}

function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
	return reply.code(404).send({
		error: "NotFound",
		code: "SCANNER_NOT_FOUND",
		message: `${what} ${id} not found`,
	})
}

/** Kinds named by `IDENTITY_QUERY`. A kind cannot contain a colon. */
function isIdentityKind(value: string): value is IdentityKind {
	return !value.includes(":") && IDENTITY_QUERY.test(`${value}:x`)
}

function identityQueryError(message: string): ZodError {
	return new ZodError([
		{
			code: ZodIssueCode.custom,
			path: ["identity"],
			message,
		},
	])
}

/** Splits `kind:value` on the first colon and trims the value. */
function identityFromQuery(raw: string): Identity {
	const colon = raw.indexOf(":")
	const kind = colon < 0 ? "" : raw.slice(0, colon)
	const value = colon < 0 ? "" : raw.slice(colon + 1).trim()
	if (value.length === 0) throw identityQueryError("Identity value is empty")
	if (!isIdentityKind(kind))
		throw identityQueryError("Identity kind is unknown")
	return { kind, value }
}

/**
 * Ajv skips numeric bounds once coercion has produced a non-finite value
 * (`Infinity`, `-Infinity`, `1e999`). Those queries are still invalid. Returns
 * the 400 message for the query parameters, naming each one and never its
 * value, or null when the query is fine.
 */
function nonFiniteDiscoveryQuery(q: DiscoveryQuery): string | null {
	const problems: string[] = []
	if (q.nearHz !== undefined && !Number.isFinite(q.nearHz))
		problems.push("nearHz must be a finite number")
	if (q.toleranceHz !== undefined && !Number.isFinite(q.toleranceHz))
		problems.push("toleranceHz must be a finite number")
	if (q.toleranceHz !== undefined && q.nearHz === undefined)
		problems.push("toleranceHz requires nearHz")
	if (problems.length === 0) return null
	return `Invalid query parameter: ${problems.join("; ")}`
}

function toFilter(q: DiscoveryQuery): DiscoveryFilter {
	return {
		...(q.jobId !== undefined ? { jobId: q.jobId } : {}),
		...(q.sourceId !== undefined ? { sourceId: q.sourceId } : {}),
		...(q.protocol !== undefined ? { protocol: q.protocol } : {}),
		...(q.minConfidence !== undefined
			? { minConfidence: q.minConfidence }
			: {}),
		...(q.freqMinHz !== undefined ? { freqMinHz: q.freqMinHz } : {}),
		...(q.freqMaxHz !== undefined ? { freqMaxHz: q.freqMaxHz } : {}),
		...(q.since !== undefined ? { since: Date.parse(q.since) } : {}),
		...(q.encrypted !== undefined ? { encrypted: q.encrypted } : {}),
		...(q.q !== undefined ? { q: q.q } : {}),
		...(q.identity !== undefined
			? { identity: identityFromQuery(q.identity) }
			: {}),
		...(q.sort !== undefined ? { sort: q.sort } : {}),
		...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
		...(q.limit !== undefined ? { limit: q.limit } : {}),
		...(q.evidence !== undefined ? { evidence: q.evidence } : {}),
		...(q.nearHz !== undefined ? { nearHz: q.nearHz } : {}),
		...(q.toleranceHz !== undefined ? { toleranceHz: q.toleranceHz } : {}),
	}
}

/** Reserve protected downloads before asynchronous lookup or producer creation. */
async function sendDownload(
	request: FastifyRequest,
	reply: FastifyReply,
	access: FastifyAccessController | undefined,
	lookup: () => string | null | Promise<string | null>,
	contentType: string,
	missing: () => FastifyReply,
	{ mapScannerErrors = false }: { mapScannerErrors?: boolean } = {},
): Promise<FastifyReply> {
	let stream: ReadStream | undefined
	const lease = access?.leaseDownload(request, reply.raw, () =>
		stream?.destroy(),
	)
	if (lease?.kind === "rejected") {
		const status =
			lease.reason === "capacity"
				? 429
				: lease.reason === "invalidated"
					? 401
					: 503
		return reply.code(status).send({
			code:
				status === 429
					? "ACCESS_CAPACITY"
					: status === 401
						? "AUTH_REQUIRED"
						: "ACCESS_UNAVAILABLE",
		})
	}
	try {
		const path = await lookup()
		if (lease && !lease.active()) return reply
		if (!path) return missing()
		stream = createReadStream(path)
		stream.on("error", () => {
			request.log.warn("Scanner download stream error")
			lease?.release()
		})
		// A synchronous invalidation during producer construction owns late cleanup.
		if (lease && !lease.active()) {
			stream.destroy()
			return reply
		}
		return reply.type(contentType).send(stream)
	} catch (err) {
		stream?.destroy()
		if (lease && !lease.active()) return reply
		if (mapScannerErrors && err instanceof ScannerApiError)
			return sendError(reply, err)
		if (!access) throw err
		request.log.warn("Scanner download unavailable")
		// The adapter's response-finish callback releases the lease after denial flush.
		return reply.code(503).send({ code: "ACCESS_UNAVAILABLE" })
	}
}

const tags = ["scanner"]
/** Band inspection UX req 1.4: one entry of `Discovery.coverage`. */
const discoveryCoverageSchema = {
	type: "array",
	maxItems: 3,
	items: {
		type: "object",
		properties: {
			decoderId: { type: "string", minLength: 1, maxLength: 64 },
			state: { type: "string" },
			suspensionReason: { type: "string" },
		},
		required: ["decoderId", "state"],
	},
} as const

/**
 * A discovery record. Only the band inspection UX fields are listed (all optional); every other
 * field passes through unchanged (`additionalProperties`).
 */
const discoveryResponseSchema = {
	type: "object",
	additionalProperties: true,
	properties: {
		coverage: discoveryCoverageSchema,
		absorbedInto: { type: "string" },
		requestedId: { type: "string" },
		revision: { type: "integer" },
		storeEpoch: { type: "string" },
		storeRevision: { type: "integer" },
	},
} as const

const discoveryListResponseSchema = {
	type: "object",
	additionalProperties: true,
	properties: {
		items: { type: "array", items: discoveryResponseSchema },
		nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
		storeEpoch: { type: "string" },
		storeRevision: { type: "integer" },
	},
} as const

/** Band inspection UX req 1.4: decoder status read once per request; null when unavailable. */
function coverageIndexOf(scanner: ScannerRouteService): CoverageIndex | null {
	return typeof scanner.discoveryCoverage === "function"
		? scanner.discoveryCoverage()
		: null
}

/** Band inspection UX req 3.1: the live id an absorbed id resolves to (itself otherwise). */
function liveIdOf(scanner: ScannerRouteService, id: string): string {
	if (typeof scanner.resolveDiscovery !== "function") return id
	return scanner.resolveDiscovery(id)?.absorbedInto ?? id
}

const errors = {
	400: errorResponseSchema,
	404: errorResponseSchema,
	409: errorResponseSchema,
	500: errorResponseSchema,
	503: errorResponseSchema,
}

export const scannerRoutes: FastifyPluginAsync<ScannerRoutesOptions> = async (
	fastify: FastifyInstance,
	options: ScannerRoutesOptions,
) => {
	const { scanner } = options

	fastify.get(
		"/api/scanner",
		{
			schema: {
				tags,
				summary: "Scanner status",
				response: { 200: looseObjectSchema },
			},
		},
		async () => scanner.status(),
	)

	fastify.get(
		"/api/scanner/settings",
		{
			schema: {
				tags,
				summary: "Effective runtime settings with provenance and bounds",
			},
		},
		async () => scanner.settingsView(),
	)

	fastify.patch<{ Body: unknown }>(
		"/api/scanner/settings",
		{
			schema: {
				tags,
				summary: "Update runtime-safe settings (persisted)",
				body: { type: "object" },
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				const patch = ScannerSettingsPatchSchema.parse(request.body)
				return await scanner.patchSettings(patch)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.get(
		"/api/scanner/bandplans",
		{
			schema: { tags, summary: "Built-in bandplans for the effective region" },
		},
		async () => scanner.bandplans(),
	)

	fastify.post<{ Body: ScanJobSpecBody }>(
		"/api/scanner/plan",
		{
			schema: {
				tags,
				summary: "Pure plan preview (no side effects)",
				body: scanJobSpecSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				return scanner.preview(fromSpecBody(request.body))
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.post<{ Body: ScanJobSpecBody }>(
		"/api/scanner/jobs",
		{
			schema: {
				tags,
				summary: "Create a scan job",
				body: scanJobSpecSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				const job = await scanner.createJob(fromSpecBody(request.body))
				return reply.code(201).send(job)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.get(
		"/api/scanner/jobs",
		{ schema: { tags, summary: "List scan jobs" } },
		async () => scanner.listJobs(),
	)

	fastify.get<{ Params: { id: string } }>(
		"/api/scanner/jobs/:id",
		{
			schema: {
				tags,
				summary: "Scan job detail",
				params: jobIdParamsSchema,
				response: { 404: errorResponseSchema },
			},
		},
		async (request, reply) =>
			scanner.getJob(request.params.id) ??
			notFound(reply, "Job", request.params.id),
	)

	fastify.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
		"/api/scanner/jobs/:id/hits",
		{
			schema: {
				tags,
				summary:
					"Per-discovery hit statistics of a job, most recent first (in memory)",
				params: jobIdParamsSchema,
				querystring: jobHitsQuerySchema,
				response: { 200: jobHitsResponseSchema, ...errors },
			},
		},
		async (request, reply) => {
			try {
				return scanner.jobHits(
					request.params.id,
					request.query.limit ?? JOB_HITS_LIMIT_DEFAULT,
				)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.patch<{ Params: { id: string }; Body: ScanJobSpecBody }>(
		"/api/scanner/jobs/:id",
		{
			schema: {
				tags,
				summary: "Live edit (applied at the next hop)",
				params: jobIdParamsSchema,
				body: scanJobSpecSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				return await scanner.patchJob(
					request.params.id,
					fromSpecBody(request.body),
				)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	for (const action of ["pause", "resume", "cancel"] as const) {
		fastify.post<{
			Params: { id: string }
			Body: { takeover?: boolean } | null
		}>(
			`/api/scanner/jobs/:id/${action}`,
			{
				schema: {
					tags,
					summary: `${action} a scan job`,
					params: jobIdParamsSchema,
					...(action === "resume" ? { body: resumeBodySchema } : {}),
					response: errors,
				},
			},
			async (request, reply) => {
				try {
					const id = request.params.id
					if (action === "pause") return await scanner.pauseJob(id)
					if (action === "cancel") return await scanner.cancelJob(id)
					return await scanner.resumeJob(id, {
						takeover: request.body?.takeover === true,
					})
				} catch (err) {
					return sendError(reply, err)
				}
			},
		)
	}

	fastify.delete<{ Params: { id: string } }>(
		"/api/scanner/jobs/:id",
		{
			schema: {
				tags,
				summary: "Delete an ended job (discoveries stay)",
				params: jobIdParamsSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				scanner.deleteJob(request.params.id)
				return reply.code(204).send()
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.get<{ Querystring: DiscoveryQuery }>(
		"/api/scanner/discoveries",
		{
			schema: {
				tags,
				summary: "List discoveries",
				querystring: discoveryQuerySchema,
				response: {
					200: discoveryListResponseSchema,
					400: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const invalid = nonFiniteDiscoveryQuery(request.query)
			if (invalid !== null)
				return reply.code(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: invalid,
				})
			try {
				const page = scanner.listDiscoveries(toFilter(request.query))
				const index = coverageIndexOf(scanner)
				return index === null
					? page
					: { ...page, items: page.items.map(d => withCoverage(d, index)) }
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.get<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id",
		{
			schema: {
				tags,
				summary: "Discovery detail",
				params: jobIdParamsSchema,
				response: { 200: discoveryResponseSchema, 404: errorResponseSchema },
			},
		},
		async (request, reply) => {
			const { id } = request.params
			const found =
				typeof scanner.resolveDiscovery === "function"
					? scanner.resolveDiscovery(id)
					: scanner.getDiscovery(id)
			return found
				? withCoverage(found, coverageIndexOf(scanner))
				: notFound(reply, "Discovery", id)
		},
	)

	fastify.get<{
		Params: { id: string }
		Querystring: { cursor?: string; limit?: number }
	}>(
		"/api/scanner/discoveries/:id/observations",
		{
			schema: {
				tags,
				summary: "Observations of a discovery",
				params: jobIdParamsSchema,
				querystring: observationsQuerySchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				return scanner.discoveryObservations(
					liveIdOf(scanner, request.params.id),
					request.query.cursor ?? null,
					request.query.limit ?? 100,
				)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.patch<{
		Params: { id: string }
		Body: Partial<NonNullable<Discovery["operator"]>>
	}>(
		"/api/scanner/discoveries/:id",
		{
			schema: {
				tags,
				summary: "Label, notes, lockout, keep",
				params: jobIdParamsSchema,
				body: discoveryPatchSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				return await scanner.patchDiscovery(request.params.id, request.body)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.delete<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id",
		{
			schema: {
				tags,
				summary: "Delete a discovery and its evidence",
				params: discoveryIdParamsSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				if (!(await scanner.deleteDiscovery(request.params.id)))
					return notFound(reply, "Discovery", request.params.id)
				// band inspection UX req 3.3: the store revision as the answer leaves (at or after the removal)
				const meta = scanner.storeMeta?.()
				if (meta)
					void reply
						.header(DISCOVERY_EPOCH_HEADER, meta.storeEpoch)
						.header(DISCOVERY_REVISION_HEADER, String(meta.storeRevision))
				return reply.code(204).send()
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.get<{ Params: { recordingId: string } }>(
		"/api/scanner/recordings/:recordingId",
		{
			schema: {
				tags,
				summary: "Download a recording (audio/wav)",
				response: {
					404: errorResponseSchema,
					503: {
						anyOf: [
							errorResponseSchema,
							{
								type: "object",
								properties: { code: { const: "ACCESS_UNAVAILABLE" } },
								required: ["code"],
								additionalProperties: false,
							},
						],
					},
				},
			},
		},
		async (request, reply) => {
			const { recordingId } = request.params
			return sendDownload(
				request,
				reply,
				options.access,
				// Malformed ids never reach the filesystem lookup.
				() =>
					RECORDING_ID.test(recordingId)
						? scanner.recordingPath(recordingId)
						: null,
				"audio/wav",
				() => notFound(reply, "Recording", recordingId),
				{ mapScannerErrors: true },
			)
		},
	)

	for (const kind of ["psd", "iq"] as const) {
		fastify.get<{ Params: { id: string } }>(
			`/api/scanner/discoveries/:id/evidence/${kind}`,
			{
				schema: {
					tags,
					summary: `Download ${kind} evidence`,
					params: discoveryIdParamsSchema,
					response: { 404: errorResponseSchema },
				},
			},
			async (request, reply) => {
				return sendDownload(
					request,
					reply,
					options.access,
					() =>
						scanner.evidencePath(liveIdOf(scanner, request.params.id), kind),
					kind === "psd" ? "application/json" : "application/octet-stream",
					() =>
						notFound(reply, `${kind} evidence of discovery`, request.params.id),
				)
			},
		)
	}

	fastify.get(
		"/api/scanner/captures",
		{ schema: { tags, summary: "Burst IQ captures (newest first)" } },
		async () => scanner.listCaptures(),
	)

	fastify.get<{ Params: { file: string } }>(
		"/api/scanner/captures/:file",
		{
			schema: {
				tags,
				summary: "Download <id>.cu8 or its manifest entry <id>.json",
				response: { 404: errorResponseSchema },
			},
		},
		async (request, reply) => {
			const { file } = request.params
			const dot = file.lastIndexOf(".")
			const id = file.slice(0, dot)
			const kind = file.slice(dot + 1)
			return sendDownload(
				request,
				reply,
				options.access,
				// Malformed ids never reach the filesystem lookup.
				() =>
					dot > 0 && CAPTURE_ID.test(id) && (kind === "cu8" || kind === "json")
						? scanner.capturePath(id, kind)
						: null,
				kind === "cu8" ? "application/octet-stream" : "application/json",
				() => notFound(reply, "Capture file", file),
			)
		},
	)

	fastify.delete<{ Params: { id: string } }>(
		"/api/scanner/captures/:id",
		{
			schema: {
				tags,
				summary: "Delete a capture",
				params: captureIdParamsSchema,
				response: { 404: errorResponseSchema },
			},
		},
		async (request, reply) =>
			(await scanner.deleteCapture(request.params.id))
				? reply.code(204).send()
				: notFound(reply, "Capture", request.params.id),
	)

	fastify.post<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id/listen",
		{
			schema: {
				tags,
				summary: "Listen to a discovery in the current window",
				params: jobIdParamsSchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				const result = await scanner.listen(request.params.id)
				if (options.legacyAudioHost !== true) return result
				// Per response only: never stored, logged or broadcast.
				const host = requestHostHeader(request)
				const httpUrl = deriveLegacyAudioUrlFromBase(result.httpUrl, host)
				const wavUrl = deriveLegacyAudioUrlFromBase(result.wavUrl, host)
				if (httpUrl === result.httpUrl && wavUrl === result.wavUrl)
					return result
				void reply.header("Cache-Control", "no-store")
				return { ...result, httpUrl, wavUrl }
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	fastify.post<{ Body: IdentifyBody }>(
		"/api/scanner/identify",
		{
			schema: {
				tags,
				summary:
					"Identify a signal in the current window (every plausible decoder tries it)",
				body: identifyBodySchema,
				response: errors,
			},
		},
		async (request, reply) => {
			try {
				const job = await scanner.identify(toIdentifyRequest(request.body))
				return reply.code(201).send(job)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)
}
