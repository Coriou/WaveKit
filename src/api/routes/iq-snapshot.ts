import { randomUUID } from "node:crypto"
import type { EventEmitter } from "node:events"
import type { FastifyPluginAsync } from "fastify"
import { z } from "zod"
import type { SourceManager } from "../../core/source-manager.js"
import type { FanoutManager } from "../../core/fanout-manager.js"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"

// 10 seconds × 2,400,000 complex samples/second × 2 CU8 bytes = 48 MB.
export const IQ_SNAPSHOT_MAX_BYTES = 10 * 2_400_000 * 2
// Capture windows are 1/10 second through 10 seconds, inclusive.
const bodySchema = z
	.object({
		seconds: z.number().finite().min(0.1).max(10),
		centerHz: z.number().int().nonnegative().optional(),
		format: z.literal("cu8"),
	})
	.strict()

// A module-wide slot covers all plugin instances in this process: 1 capture at a time.
let capturing = false

export interface IqSnapshotOptions {
	sourceManager: Pick<SourceManager, "getStatus"> &
		Pick<EventEmitter, "on" | "off">
	fanoutFor: (
		sourceId: string,
	) => Pick<FanoutManager, "addBranch" | "removeBranch" | "on" | "off">
	access: Pick<
		FastifyAccessController,
		"authorizeMetadataMutation" | "leaseDownload"
	>
}

/** Protected, current-window CU8 capture. Never tunes or pauses the upstream source. */
export const iqSnapshotRoutes: FastifyPluginAsync<IqSnapshotOptions> = async (
	app,
	options,
) => {
	const active = new Set<() => void>()
	app.addHook("preClose", async () => {
		for (const abort of active) abort()
	})
	app.post<{ Params: { sourceId: string } }>(
		"/api/sources/:sourceId/iq-snapshot",
		async (request, reply) => {
			const denied = options.access.authorizeMetadataMutation(request)
			if (denied) {
				for (const [name, value] of Object.entries(denied.headers))
					reply.header(name, value)
				return reply.code(denied.status).send({ code: denied.code })
			}
			const parsed = bodySchema.safeParse(request.body)
			if (!parsed.success)
				return reply.code(400).send({ code: "VALIDATION_ERROR" })
			const { sourceId } = request.params
			const source = options.sourceManager.getStatus(sourceId)
			if (!source) return reply.code(404).send({ code: "SOURCE_NOT_FOUND" })
			const { caps } = source
			if (!source.connected)
				return reply.code(503).send({ code: "SOURCE_DISCONNECTED" })
			if (
				caps.kind !== "iq" ||
				caps.format !== "U8_IQ" ||
				!Number.isSafeInteger(caps.sampleRate) ||
				caps.sampleRate <= 0 ||
				caps.centerFreq === undefined
			)
				return reply.code(409).send({ code: "IQ_SNAPSHOT_UNSUPPORTED" })
			if (
				parsed.data.centerHz !== undefined &&
				parsed.data.centerHz !== caps.centerFreq
			)
				return reply.code(409).send({ code: "IQ_SNAPSHOT_CENTER_MISMATCH" })
			if (capturing) return reply.code(429).send({ code: "IQ_SNAPSHOT_BUSY" })
			capturing = true
			let cancel = () => {}
			const lease = options.access.leaseDownload(request, reply.raw, () =>
				cancel(),
			)
			if (lease.kind === "rejected") {
				capturing = false
				const status =
					lease.reason === "capacity"
						? 429
						: lease.reason === "invalidated"
							? 401
							: 503
				return reply.code(status).send({
					code:
						status === 401
							? "AUTH_REQUIRED"
							: status === 429
								? "ACCESS_CAPACITY"
								: "ACCESS_UNAVAILABLE",
				})
			}
			const bytes = Math.min(
				Math.round(parsed.data.seconds * caps.sampleRate) * 2,
				IQ_SNAPSHOT_MAX_BYTES,
			)
			let slotReleased = false
			const releaseSlot = () => {
				if (slotReleased) return
				slotReleased = true
				capturing = false
				reply.raw.off("finish", releaseSlot)
				reply.raw.off("close", releaseSlot)
			}
			reply.raw.once("finish", releaseSlot)
			reply.raw.once("close", releaseSlot)
			let cleanup = releaseSlot
			try {
				const fanout = options.fanoutFor(sourceId)
				const id = `iq-snapshot:${randomUUID()}`
				// 1 byte = the smallest positive watermark: any retained chunk reaches it.
				// Flowing reads
				// consume synchronously. No second chunk can queue behind a slow download.
				const branch = fanout.addBranch({ id, sourceId, highWaterMark: 1 })
				let remaining = bytes
				let finished = false
				let started = false
				let waitingForDrain = false
				let drainTimer: ReturnType<typeof setTimeout> | undefined
				const complete = () => {
					cleanup()
					// A stalled tail keeps the slot for at most one more requested
					// duration (seconds × 1000 ms, at most 10 s), then the transport goes.
					const tail = setTimeout(() => {
						releaseSlot()
						lease.release()
						reply.raw.destroy()
					}, parsed.data.seconds * 1000)
					tail.unref()
					const settled = () => clearTimeout(tail)
					reply.raw.once("finish", settled)
					reply.raw.once("close", settled)
					reply.raw.end()
				}
				const drained = () => {
					waitingForDrain = false
					clearTimeout(drainTimer)
					if (remaining === 0) complete()
				}
				const closed = () => abort()
				const changed = (id: string) => {
					if (id === sourceId) abort()
				}
				const congestion = (branchId: string) => {
					if (branchId === id) abort()
				}
				const onData = (chunk: Buffer) => {
					if (finished) return
					if (waitingForDrain) return abort()
					if (!started) {
						started = true
						reply.raw.setHeader(
							"X-WaveKit-Start-Time",
							new Date().toISOString(),
						)
					}
					const output = chunk.subarray(0, remaining)
					remaining -= output.length
					const accepted = reply.raw.write(output)
					// The last chunk detaches from the source at once; end() lets the
					// buffered tail drain without later source chunks aborting it.
					if (remaining === 0) return complete()
					if (!accepted) {
						waitingForDrain = true
						reply.raw.once("drain", drained)
						// Allow 2 chunk durations: bytes / (sampleRate × 2 CU8 bytes)
						// × 2 × 1000 ms, rounded up to at least 1 ms. The capture
						// deadline still caps the entire request at 2 × seconds.
						const drainMs = Math.max(
							1,
							Math.ceil((output.length * 2 * 1000) / (caps.sampleRate * 2)),
						)
						drainTimer = setTimeout(abort, drainMs)
						drainTimer.unref()
						return
					}
					if (remaining === 0) complete()
				}
				cleanup = () => {
					if (finished) return
					finished = true
					clearTimeout(timer)
					clearTimeout(drainTimer)
					reply.raw.off("drain", drained)
					active.delete(abort)
					branch.off("data", onData)
					fanout.off("backpressure", congestion)
					options.sourceManager.off("disconnected", changed)
					options.sourceManager.off("removed", changed)
					options.sourceManager.off("caps-changed", changed)
					reply.raw.off("close", closed)
					reply.raw.off("error", closed)
					fanout.removeBranch(id)
					// Response finish releases the lease; explicit release aborts the transport.
				}
				const abort = () => {
					if (finished) return
					cleanup()
					releaseSlot()
					lease.release()
					reply.raw.destroy()
				}
				cancel = abort
				active.add(abort)
				// A silent source gets at most the requested duration plus one equally
				// long grace window: 2 × seconds (at most 20 s), then detaches.
				const timer = setTimeout(abort, parsed.data.seconds * 2 * 1000)
				timer.unref()
				branch.on("error", abort)
				branch.on("end", abort)
				fanout.on("backpressure", congestion)
				options.sourceManager.on("disconnected", changed)
				options.sourceManager.on("removed", changed)
				options.sourceManager.on("caps-changed", changed)
				reply.raw.on("close", closed)
				reply.raw.on("error", closed)
				if (!lease.active()) {
					cleanup()
					return reply.code(401).send({ code: "AUTH_REQUIRED" })
				}
				for (const [name, value] of Object.entries(reply.getHeaders())) {
					if (value !== undefined) reply.raw.setHeader(name, value)
				}
				reply.hijack()
				reply.raw.setHeader("Content-Type", "application/octet-stream")
				reply.raw.setHeader(
					"Content-Disposition",
					'attachment; filename="snapshot.cu8"',
				)
				reply.raw.setHeader("Content-Length", bytes)
				reply.raw.setHeader("Cache-Control", "no-store")
				reply.raw.setHeader("X-WaveKit-Center-Hz", caps.centerFreq)
				reply.raw.setHeader("X-WaveKit-Sample-Rate", caps.sampleRate)
				branch.on("data", onData)
				return reply
			} catch {
				cleanup()
				if (reply.raw.headersSent) reply.raw.destroy()
				else return reply.code(503).send({ code: "IQ_SNAPSHOT_UNAVAILABLE" })
			}
		},
	)
}
