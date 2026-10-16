/**
 * WG8 recordings inventory routes (protected mode only; Main mounts them). The list is
 * authorized per request; the file download leases first, exactly as the scanner download.
 * Bodies and logs carry fixed text: never an id, a path or a file name.
 */
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import type { ReadStream } from "node:fs"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
	RECORDING_INVENTORY_ID,
	RECORDINGS_FILE_ROUTE,
	RECORDINGS_ROUTE,
} from "@wavekit/api-types"
import type {
	RecordingInventoryErrorBody,
	RecordingInventoryErrorCode,
} from "@wavekit/api-types"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"
import type { DeniedAdmission } from "../../access/types.js"
import {
	RecordingInventoryError,
	type RecordingInventory,
} from "../../core/recordings/inventory.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"

export interface RecordingRoutesOptions {
	inventory: RecordingInventory
	authorize: (request: FastifyRequest) => DeniedAdmission | undefined
	access: Pick<FastifyAccessController, "leaseDownload">
}

const SAFE_BASENAME = /^[A-Za-z0-9_.-]+$/
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

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

/** The file part of a validated inventory id (after the first `~`), or null. */
function fileNameOf(id: string): string | null {
	const name = id.slice(id.indexOf("~") + 1)
	return SAFE_BASENAME.test(name) ? name : null
}

export async function recordingRoutes(
	fastify: FastifyInstance,
	options: RecordingRoutesOptions,
): Promise<void> {
	const { inventory, authorize, access } = options

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
			let stream: ReadStream | undefined
			let handle: FileHandle | undefined
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
				if (!RECORDING_INVENTORY_ID.test(id))
					return sendError(reply, 404, "RECORDING_NOT_FOUND")
				const name = fileNameOf(id)
				if (!name) return sendError(reply, 404, "RECORDING_NOT_FOUND")
				const path = await inventory.resolve(id)
				if (!lease.active()) return reply
				if (!path) return sendError(reply, 404, "RECORDING_NOT_FOUND")
				// O_NOFOLLOW closes the lstat -> open symlink swap; fstat rejects non-files.
				// Opening before send keeps open failures a clean 404.
				try {
					handle = await open(path, OPEN_FLAGS)
					if (!(await handle.stat()).isFile()) throw new Error("not a file")
				} catch {
					await handle?.close().catch(() => {})
					handle = undefined
					// The adapter releases the lease when the 404 finishes.
					if (!lease.active()) return reply
					return sendError(reply, 404, "RECORDING_NOT_FOUND")
				}
				if (!lease.active()) {
					await handle.close().catch(() => {})
					return reply
				}
				stream = handle.createReadStream()
				stream.on("error", () => {
					request.log.warn("Recording download stream error")
					lease.release()
					if (!reply.raw.headersSent) {
						void sendError(reply, 404, "RECORDING_NOT_FOUND")
					} else {
						reply.raw.destroy()
					}
				})
				return await reply
					.type("audio/wav")
					.header("Content-Disposition", `attachment; filename="${name}"`)
					.header("Accept-Ranges", "none")
					.header("Cache-Control", "no-store")
					.send(stream)
			} catch (err) {
				stream?.destroy()
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
