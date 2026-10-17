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

type MutationErrorCode = RecordingKeepErrorCode | "RECORDING_NOT_FOUND"
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
const DELETE_FAILED_BODY = {
	error: "Internal Server Error",
	code: "RECORDING_DELETE_FAILED",
	message: "Recording could not be deleted",
}
const KEEP_FAILED_BODY = {
	error: "Internal Server Error",
	code: "RECORDING_KEEP_FAILED",
	message: "Recording could not be kept",
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
		const mutate =
			(op: "keep" | "unkeep" | "remove", deletes: boolean) =>
			async (
				request: FastifyRequest<{ Params: { id: string } }>,
				reply: FastifyReply,
			) => {
				const denied = authorizeMutation(request)
				if (denied) return sendDenial(reply, denied)
				const id = request.params.id
				if (
					typeof id !== "string" ||
					id.length > RECORDINGS_ID_MAX_LENGTH ||
					!RECORDING_INVENTORY_ID.test(id)
				)
					return sendError(reply, 404, "RECORDING_NOT_FOUND")
				try {
					const result = await keeps[op](id)
					return await reply.header("Cache-Control", "no-store").send(result)
				} catch (err) {
					reply.header("Cache-Control", "no-store")
					if (err instanceof RecordingKeepError) {
						const code = err.code
						const status = RECORDING_ERROR_STATUS[code] ?? err.status
						const body: RecordingKeepErrorBody = {
							error: MUTATION_ERRORS[status] ?? "Error",
							code: code as RecordingKeepErrorCode,
							message: MUTATION_MESSAGES[code],
						}
						return reply.code(status).send(body)
					}
					request.log.warn(
						{ err: safeErrorFields(err) },
						deletes ? "Recording delete failed" : "Recording keep failed",
					)
					return reply
						.code(500)
						.send(deletes ? DELETE_FAILED_BODY : KEEP_FAILED_BODY)
				}
			}
		fastify.put<{ Params: { id: string } }>(
			RECORDING_KEEP_ROUTE,
			{ bodyLimit: MUTATION_BODY_LIMIT },
			mutate("keep", false),
		)
		fastify.delete<{ Params: { id: string } }>(
			RECORDING_KEEP_ROUTE,
			{ bodyLimit: MUTATION_BODY_LIMIT },
			mutate("unkeep", false),
		)
		fastify.delete<{ Params: { id: string } }>(
			RECORDING_DELETE_ROUTE,
			{ bodyLimit: MUTATION_BODY_LIMIT },
			mutate("remove", true),
		)
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
