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
import { createReadStream } from "node:fs"
import type { ScannerIdentifyRequest } from "@wavekit/api-types"
import type {
	FastifyInstance,
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
} from "fastify"
import { ZodError } from "zod"
import { ScannerApiError } from "../../core/scanner/errors.js"
import type { ScannerService } from "../../core/scanner/scanner-service.js"
import { ScannerSettingsPatchSchema } from "../../core/scanner/settings.js"
import type { DiscoveryFilter } from "../../core/scanner/store/discovery-store.js"
import type {
	Discovery,
	ScanExclusion,
	ScanJobSpec,
	ScanRange,
	ScannerConfidence,
	ScannerProtocol,
} from "../../core/scanner/types.js"
import { RECORDING_ID } from "../../core/scanner/store/evidence-store.js"
import { CAPTURE_ID } from "../../core/scanner/evidence/capture-store.js"
import { ConfigValidationError } from "../../utils/errors.js"
import {
	captureIdParamsSchema,
	discoveryIdParamsSchema,
	discoveryPatchSchema,
	discoveryQuerySchema,
	errorResponseSchema,
	identifyBodySchema,
	jobIdParamsSchema,
	looseObjectSchema,
	observationsQuerySchema,
	resumeBodySchema,
	scanJobSpecSchema,
} from "./scanner-schemas.js"

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
>

export interface ScannerRoutesOptions {
	scanner: ScannerRouteService
	access?: FastifyAccessController
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
	sort?: "lastSeen" | "frequency" | "confidence"
	cursor?: string
	limit?: number
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
		...(q.sort !== undefined ? { sort: q.sort } : {}),
		...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
		...(q.limit !== undefined ? { limit: q.limit } : {}),
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
		return reply
			.code(status)
			.send({
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
		if (!access) throw err
		if (lease && !lease.active()) return reply
		request.log.warn("Scanner download unavailable")
		// The adapter's response-finish callback releases the lease after denial flush.
		return reply.code(503).send({ code: "ACCESS_UNAVAILABLE" })
	}
}

const tags = ["scanner"]
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
				response: { 400: errorResponseSchema },
			},
		},
		async request => scanner.listDiscoveries(toFilter(request.query)),
	)

	fastify.get<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id",
		{
			schema: {
				tags,
				summary: "Discovery detail",
				params: jobIdParamsSchema,
				response: { 404: errorResponseSchema },
			},
		},
		async (request, reply) =>
			scanner.getDiscovery(request.params.id) ??
			notFound(reply, "Discovery", request.params.id),
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
					request.params.id,
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
		async (request, reply) =>
			(await scanner.deleteDiscovery(request.params.id))
				? reply.code(204).send()
				: notFound(reply, "Discovery", request.params.id),
	)

	fastify.get<{ Params: { recordingId: string } }>(
		"/api/scanner/recordings/:recordingId",
		{
			schema: {
				tags,
				summary: "Download a recording (audio/wav)",
				response: { 404: errorResponseSchema },
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
					() => scanner.evidencePath(request.params.id, kind),
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
				return await scanner.listen(request.params.id)
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
