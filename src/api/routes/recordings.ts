/**
 * WG8 recordings inventory routes (protected mode only; Main mounts them). The list is
 * authorized per request; the file download leases first, exactly as the scanner download.
 * Bodies and logs carry fixed text: never an id, a path or a file name.
 */
import type { Readable } from "node:stream"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
	RECORDING_INVENTORY_ID,
	RECORDINGS_FILE_ROUTE,
	RECORDING_DELETE_ROUTE,
	RECORDING_ERROR_STATUS,
	RECORDING_KEEP_ROUTE,
	RECORDINGS_ROUTE,
} from "@wavekit/api-types"
import type {
	RecordingInventoryErrorBody,
	RecordingInventoryErrorCode,
	RecordingKeepErrorBody,
	RecordingKeepErrorCode,
} from "@wavekit/api-types"
import { RecordingKeepError } from "../../core/recordings/contract.js"
import type { RecordingKeepService } from "../../core/recordings/contract.js"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"
import type { DeniedAdmission } from "../../access/types.js"
import {
	RECORDINGS_ID_MAX_LENGTH,
	RecordingInventoryError,
} from "../../core/recordings/inventory.js"
import type {
	RecordingFileHandle,
	RecordingInventory,
} from "../../core/recordings/inventory.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"

export interface RecordingRoutesOptions {
	inventory: RecordingInventory
	authorize: (request: FastifyRequest) => DeniedAdmission | undefined
	access: Pick<FastifyAccessController, "leaseDownload">
	/** WG9: Keep and delete routes are registered only when both of these are present. */
	keeps?: RecordingKeepService
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined
}

type FailedCode = "RECORDING_KEEP_FAILED" | "RECORDING_DELETE_FAILED"
type MutationErrorCode =
	| Exclude<RecordingKeepErrorCode, FailedCode>
	| "RECORDING_NOT_FOUND"
const MUTATION_MESSAGES: Record<MutationErrorCode, string> = {
	RECORDING_NOT_FOUND: "Recording not found",
	RECORDING_KEPT: "Recording is kept; unkeep it first",
	RECORDING_BUSY: "Recording is busy; try again",
	RECORDING_KEEP_LIMIT: "Keep limit reached",
	RECORDING_DELETE_UNSUPPORTED: "This recording cannot be deleted",
	RECORDING_KEEPS_UNAVAILABLE: "Keeping recordings is unavailable",
}
const MUTATION_ERRORS: Record<number, string> = {
	404: "Not Found",
	409: "Conflict",
	503: "Service Unavailable",
}
type MutationOp = "keep" | "unkeep" | "remove"
/**
 * 500 bodies, fixed text per operation: `RECORDING_KEEP_FAILED` (Keep and unkeep) and
 * `RECORDING_DELETE_FAILED` (delete), both in the WG9 contract (amendment).
 */
const FAILED_BODIES: Record<
	MutationOp,
	RecordingKeepErrorBody & { code: FailedCode }
> = {
	keep: {
		error: "Internal Server Error",
		code: "RECORDING_KEEP_FAILED",
		message: "Recording could not be kept",
	},
	unkeep: {
		error: "Internal Server Error",
		code: "RECORDING_KEEP_FAILED",
		message: "Recording could not be unkept",
	},
	remove: {
		error: "Internal Server Error",
		code: "RECORDING_DELETE_FAILED",
		message: "Recording could not be deleted",
	},
}
const FAILED_LOGS: Record<MutationOp, string> = {
	keep: "Recording keep failed",
	unkeep: "Recording unkeep failed",
	remove: "Recording delete failed",
}
const TOO_LARGE_BODY = {
	error: "Payload Too Large",
	code: "FST_ERR_CTP_BODY_TOO_LARGE",
	message: "Request body is too large",
}
const MUTATION_BODY_LIMIT = 1024

const SAFE_BASENAME = /^[A-Za-z0-9_.-]+$/

const MESSAGES: Record<RecordingInventoryErrorCode, string> = {
	RECORDINGS_QUERY_INVALID: "The recordings query is invalid",
	RECORDING_NOT_FOUND: "Recording not found",
	RECORDINGS_UNAVAILABLE: "Recordings are unavailable",
}
const ERRORS: Record<RecordingInventoryErrorCode, string> = {
	RECORDINGS_QUERY_INVALID: "Bad Request",
	RECORDING_NOT_FOUND: "Not Found",
	RECORDINGS_UNAVAILABLE: "Service Unavailable",
}

function sendError(
	reply: FastifyReply,
	status: number,
	code: RecordingInventoryErrorCode,
): FastifyReply {
	const body: RecordingInventoryErrorBody = {
		error: ERRORS[code],
		code,
		message: MESSAGES[code],
	}
	return reply.code(status).header("Cache-Control", "no-store").send(body)
}

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

export async function recordingRoutes(
	fastify: FastifyInstance,
	options: RecordingRoutesOptions,
): Promise<void> {
	const { inventory, authorize, access, keeps, authorizeMutation } = options

	if (keeps && authorizeMutation) {
		const svc = keeps
		const authorizeM = authorizeMutation
		// An encapsulated child: its hooks and its body parser apply to these three routes only.
		await fastify.register(async child => {
			// Authorize, then the id check, then the size check: all before any body is read, so a
			// denial wins over a malformed or oversized body.
			child.addHook(
				"onRequest",
				async (request: FastifyRequest, reply: FastifyReply) => {
					const denied = authorizeM(request)
					if (denied) return sendDenial(reply, denied)
					const id = (request.params as { id?: unknown } | undefined)?.id
					if (
						typeof id !== "string" ||
						id.length > RECORDINGS_ID_MAX_LENGTH ||
						!RECORDING_INVENTORY_ID.test(id)
					)
						return sendError(reply, 404, "RECORDING_NOT_FOUND")
					const length = Number(request.headers["content-length"] ?? 0)
					if (!Number.isFinite(length) || length > MUTATION_BODY_LIMIT)
						return reply
							.code(413)
							.header("Cache-Control", "no-store")
							.send(TOO_LARGE_BODY)
					return undefined
				},
			)
			// The body is never parsed: any content type is read up to the limit (413 past it,
			// chunked included) and discarded.
			child.removeAllContentTypeParsers()
			child.addContentTypeParser(
				"*",
				{ parseAs: "buffer", bodyLimit: MUTATION_BODY_LIMIT },
				(_request, _body, done) => {
					done(null, undefined)
				},
			)
			const mutate =
				(op: MutationOp) =>
				async (
					request: FastifyRequest<{ Params: { id: string } }>,
					reply: FastifyReply,
				) => {
					const id = request.params.id
					try {
						const result = await svc[op](id)
						return await reply.header("Cache-Control", "no-store").send(result)
					} catch (err) {
						reply.header("Cache-Control", "no-store")
						if (err instanceof RecordingKeepError) {
							const code = err.code
							if (
								code !== "RECORDING_KEEP_FAILED" &&
								code !== "RECORDING_DELETE_FAILED"
							) {
								const status = RECORDING_ERROR_STATUS[code] ?? err.status
								const body: RecordingKeepErrorBody = {
									error: MUTATION_ERRORS[status] ?? "Error",
									code: code as RecordingKeepErrorCode,
									message: MUTATION_MESSAGES[code],
								}
								return reply.code(status).send(body)
							}
						}
						request.log.warn({ err: safeErrorFields(err) }, FAILED_LOGS[op])
						return reply.code(500).send(FAILED_BODIES[op])
					}
				}
			const opts = { bodyLimit: MUTATION_BODY_LIMIT }
			child.put<{ Params: { id: string } }>(
				RECORDING_KEEP_ROUTE,
				opts,
				mutate("keep"),
			)
			child.delete<{ Params: { id: string } }>(
				RECORDING_KEEP_ROUTE,
				opts,
				mutate("unkeep"),
			)
			child.delete<{ Params: { id: string } }>(
				RECORDING_DELETE_ROUTE,
				opts,
				mutate("remove"),
			)
		})
	}

	fastify.get(RECORDINGS_ROUTE, async (request, reply) => {
		const denied = authorize(request)
		if (denied) return sendDenial(reply, denied)
		try {
			const page = await inventory.list(request.query)
			return await reply.header("Cache-Control", "no-store").send(page)
		} catch (err) {
			if (err instanceof RecordingInventoryError)
				return sendError(reply, 400, "RECORDINGS_QUERY_INVALID")
			request.log.warn({ err: safeErrorFields(err) }, "Recordings list failed")
			return sendError(reply, 503, "RECORDINGS_UNAVAILABLE")
		}
	})

	fastify.get<{ Params: { id: string } }>(
		RECORDINGS_FILE_ROUTE,
		async (request, reply) => {
			let stream: Readable | undefined
			let handle: RecordingFileHandle | undefined
			const lease = access.leaseDownload(request, reply.raw, () => {
				if (stream) stream.destroy()
				else void handle?.close().catch(() => {})
			})
			if (lease.kind === "rejected") {
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
				const id = request.params.id
				if (
					id.length > RECORDINGS_ID_MAX_LENGTH ||
					!RECORDING_INVENTORY_ID.test(id)
				)
					return sendError(reply, 404, "RECORDING_NOT_FOUND")
				// The inventory opens and verifies the handle (fstat, realpath, inode, directories).
				const opened = await inventory.open(id)
				if (opened) handle = opened.handle
				if (!lease.active()) {
					await handle?.close().catch(() => {})
					return reply
				}
				if (!opened) return sendError(reply, 404, "RECORDING_NOT_FOUND")
				const name = opened.name
				if (!SAFE_BASENAME.test(name)) {
					await opened.handle.close().catch(() => {})
					handle = undefined
					return sendError(reply, 404, "RECORDING_NOT_FOUND")
				}
				stream = opened.handle.createReadStream({ autoClose: true })
				// As the scanner download: the reply already carries audio/wav, so a JSON error body
				// cannot be sent here. Releasing the lease destroys the transport; the errored
				// stream (autoClose) closes the handle.
				const s = stream
				s.on("error", () => {
					request.log.warn("Recording download stream error")
					lease.release()
					s.destroy()
				})
				return await reply
					.type("audio/wav")
					.header("Content-Disposition", `attachment; filename="${name}"`)
					.header("Accept-Ranges", "none")
					.header("Cache-Control", "no-store")
					.send(stream)
			} catch (err) {
				if (stream) stream.destroy()
				else await handle?.close().catch(() => {})
				if (!lease.active()) return reply
				request.log.warn(
					{ err: safeErrorFields(err) },
					"Recording download unavailable",
				)
				return sendError(reply, 503, "RECORDINGS_UNAVAILABLE")
			}
		},
	)
}
