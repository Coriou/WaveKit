/**
 * Named IQ captures (protected mode only): POST records whole seconds of the current tuning
 * as CU8 into a private directory under the state directory; GET lists, GET by name
 * downloads, DELETE removes. Authorization matches the IQ snapshot: mutation admission on
 * every route (browser CSRF included) and a revocable lease for the capture and the download.
 *
 * Data streams chunk by chunk to `<name>.cu8.partial`, renamed to `<name>.cu8` when complete;
 * the metadata (`<name>.json`, through `<name>.json.partial`) is written last, so a listed
 * capture is always whole. Partial files are removed on any failure, abort or shutdown; at
 * the first use after a crash only the exact names the store writes are removed: those two
 * partial files and data without metadata beside it. Any other file is never touched.
 * Admission and commit are serialized, so the quota and the free-space floor count every
 * stored and running capture from one consistent state.
 * Bodies and logs carry fixed text: never a submitted name, a path or a parser message.
 */
import { randomUUID } from "node:crypto"
import type { EventEmitter } from "node:events"
import { constants, createWriteStream } from "node:fs"
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	statfs,
	writeFile,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import {
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_MAX_SAMPLE_RATE,
	IQ_CAPTURE_NAME,
	IQ_CAPTURE_ROUTE,
	IQ_CAPTURE_SECONDS_MAX,
	IQ_CAPTURE_SECONDS_MIN,
	IQ_CAPTURES_MAX_COUNT,
	IQ_CAPTURES_MIN_FREE_BYTES,
	IQ_CAPTURES_QUOTA_BYTES,
	IQ_CAPTURES_ROUTE,
} from "@wavekit/api-types"
import type {
	IqCapture,
	IqCaptureErrorBody,
	IqCaptureErrorCode,
	IqCaptureList,
	TunerState,
} from "@wavekit/api-types"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"
import type { DeniedAdmission } from "../../access/types.js"
import type { FanoutManager } from "../../core/fanout-manager.js"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../utils/errors.js"
import { validationErrorBody, zodValidationBody } from "../validation-errors.js"

/**
 * Bytes the file stream may hold before the disk counts as too slow: 4,000,000 /
 * (3,200,000 × 2 CU8 bytes/s) = 625 ms of IQ at the top rate. The source is never paused.
 */
export const IQ_CAPTURE_MAX_BUFFERED_BYTES = 4_000_000
/** A metadata file is about 300 bytes; 4096 bounds what a listing reads per entry. */
const META_MAX_BYTES = 4096
/** Capture names a listing reads: 32 captures with room for 992 unreadable metadata files. */
const LIST_MAX_ENTRIES = 1024

const DATA = ".cu8"
const META = ".json"
const PARTIAL = ".partial"

const ERRORS: Record<number, string> = {
	404: "Not Found",
	409: "Conflict",
	503: "Service Unavailable",
	507: "Insufficient Storage",
}
const MESSAGES: Record<IqCaptureErrorCode, string> = {
	IQ_CAPTURE_NOT_FOUND: "IQ capture not found",
	IQ_CAPTURE_EXISTS: "An IQ capture with this name exists; choose another name",
	IQ_CAPTURE_BUSY:
		"An IQ capture is running on this source; wait for it to finish",
	IQ_CAPTURE_UNSUPPORTED: `The source must deliver U8 IQ with a known center frequency at up to ${IQ_CAPTURE_MAX_SAMPLE_RATE} samples per second`,
	IQ_CAPTURE_QUOTA: `IQ captures are limited to ${IQ_CAPTURES_QUOTA_BYTES} bytes and ${IQ_CAPTURES_MAX_COUNT} captures; delete one first`,
	IQ_CAPTURE_DISK_FULL: `The disk must keep ${IQ_CAPTURES_MIN_FREE_BYTES} bytes free after the capture`,
	IQ_CAPTURE_SOURCE_CHANGED:
		"The source changed (retune, rate change or disconnect) before the capture started; nothing was stored; try again",
	IQ_CAPTURE_INTERRUPTED:
		"The capture stopped before it was complete (source change, disconnect, slow disk or shutdown); nothing was stored",
	IQ_CAPTURES_UNAVAILABLE: "IQ captures are unavailable",
	SOURCE_NOT_FOUND: "Source not found",
	SOURCE_DISCONNECTED: "Source is disconnected",
}

const NAME_EXPECTED = `string, 1 to 64 characters: a-z, 0-9, "-" and "_", starting with a letter or digit; unique`
const bodySchema = z
	.object({
		name: z.string().regex(IQ_CAPTURE_NAME),
		seconds: z
			.number()
			.int()
			.min(IQ_CAPTURE_SECONDS_MIN)
			.max(IQ_CAPTURE_SECONDS_MAX),
		sourceId: z.string().min(1).max(128).optional(),
	})
	.strict()
const BODY_EXPECTED: Readonly<Record<string, string>> = Object.freeze({
	name: NAME_EXPECTED,
	seconds: `integer, seconds (${IQ_CAPTURE_SECONDS_MIN} to ${IQ_CAPTURE_SECONDS_MAX})`,
	sourceId: "string, a source id from GET /api/sources",
})

const metaSchema = z
	.object({
		name: z.string().regex(IQ_CAPTURE_NAME),
		sourceId: z.string().min(1).max(128),
		format: z.literal("cu8"),
		centerHz: z.number().int().nonnegative(),
		sampleRate: z.number().int().positive().max(IQ_CAPTURE_MAX_SAMPLE_RATE),
		gain: z.number().int().nullable(),
		startedAt: z.string().datetime(),
		durationS: z
			.number()
			.int()
			.min(IQ_CAPTURE_SECONDS_MIN)
			.max(IQ_CAPTURE_SECONDS_MAX),
		bytes: z.number().int().positive().max(IQ_CAPTURE_MAX_BYTES),
	})
	.strict()

function missing(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENOENT"
	)
}

/** The capture name of `entry` when it is exactly `<name><suffix>` with a valid name. */
function captureName(entry: string, suffix: string): string | null {
	if (!entry.endsWith(suffix)) return null
	const name = entry.slice(0, -suffix.length)
	return IQ_CAPTURE_NAME.test(name) ? name : null
}

/** The private capture directory. Every path it builds comes from a checked name. */
export class IqCaptureStore {
	#ready: Promise<void> | undefined

	constructor(readonly dir: string) {}

	/** Creates the private directory once and removes what a crash left behind. */
	ready(): Promise<void> {
		this.#ready ??= this.#prepare().catch((err: unknown) => {
			this.#ready = undefined
			throw err
		})
		return this.#ready
	}

	async #prepare(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 })
		const st = await lstat(this.dir)
		if (
			!st.isDirectory() ||
			(typeof process.getuid === "function" && st.uid !== process.getuid())
		)
			throw new WaveKitError(
				"IQ capture directory unavailable",
				"IQ_CAPTURES_UNAVAILABLE",
			)
		// The directory is dedicated to captures: make it private if it is not.
		if ((st.mode & 0o077) !== 0) await chmod(this.dir, 0o700)
		// No capture can be in progress before the first one starts, and every route waits for
		// this step. Only names the store itself writes are leftovers: `<name>.cu8.partial` and
		// `<name>.json.partial`, and `<name>.cu8` with no `<name>.json` beside it (a crash
		// between the data rename and the metadata publication). Every other file is left
		// alone, a metadata file that fails validation included: it is not listed, its name
		// stays taken and its data counts toward the quota (see usage()).
		const entries = await readdir(this.dir)
		const present = new Set(entries)
		for (const entry of entries) {
			const name =
				captureName(entry, `${DATA}${PARTIAL}`) ??
				captureName(entry, `${META}${PARTIAL}`)
			if (name !== null) await this.#removeFile(entry)
			else {
				const dataName = captureName(entry, DATA)
				if (dataName !== null && !present.has(`${dataName}${META}`))
					await this.#removeFile(entry)
			}
		}
	}

	/** Removes a leftover file or link; a directory under a capture name is left alone. */
	async #removeFile(entry: string): Promise<void> {
		const path = join(this.dir, entry)
		try {
			if ((await lstat(path)).isDirectory()) return
		} catch (err) {
			if (missing(err)) return
			throw err
		}
		await rm(path, { force: true })
	}

	data(name: string): string {
		return join(this.dir, `${name}${DATA}`)
	}

	partial(name: string): string {
		return join(this.dir, `${name}${DATA}${PARTIAL}`)
	}

	meta(name: string): string {
		return join(this.dir, `${name}${META}`)
	}

	metaPartial(name: string): string {
		return join(this.dir, `${name}${META}${PARTIAL}`)
	}

	async exists(name: string): Promise<boolean> {
		for (const path of [this.data(name), this.meta(name)]) {
			try {
				await lstat(path)
				return true
			} catch (err) {
				if (!missing(err)) throw err
			}
		}
		return false
	}

	/** Metadata of a whole capture: both files regular, the data exactly `bytes` long. */
	async read(name: string): Promise<IqCapture | null> {
		try {
			const metaStat = await lstat(this.meta(name))
			if (!metaStat.isFile() || metaStat.size > META_MAX_BYTES) return null
			const parsed = metaSchema.safeParse(
				JSON.parse(await readFile(this.meta(name), "utf8")),
			)
			if (!parsed.success || parsed.data.name !== name) return null
			const dataStat = await lstat(this.data(name))
			if (!dataStat.isFile() || dataStat.size !== parsed.data.bytes) return null
			return parsed.data
		} catch (err) {
			if (missing(err) || err instanceof SyntaxError) return null
			throw err
		}
	}

	/**
	 * Whole captures, newest first (at most IQ_CAPTURES_MAX_COUNT listed), and `unlistedBytes`:
	 * every capture-named data file on the disk that is not listed, either beside metadata
	 * that fails validation (the store never writes such a pair, so it is not removed, but
	 * its bytes sit under a taken name) or a whole capture past the listed count. Every
	 * directory entry is examined; at most LIST_MAX_ENTRIES capture names are read, and
	 * past that `overflow` is true so admission refuses (refusing more, never less).
	 */
	async usage(): Promise<{
		captures: IqCapture[]
		unlistedBytes: number
		overflow: boolean
	}> {
		const names = (await readdir(this.dir))
			.map(entry => captureName(entry, META))
			.filter(name => name !== null)
			.sort()
		const overflow = names.length > LIST_MAX_ENTRIES
		const captures: IqCapture[] = []
		let unlistedBytes = 0
		for (const name of names.slice(0, LIST_MAX_ENTRIES)) {
			const capture = await this.read(name)
			if (capture) captures.push(capture)
			else unlistedBytes += await this.#dataSize(name)
		}
		captures.sort((a, b) =>
			a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
		)
		for (const extra of captures.splice(IQ_CAPTURES_MAX_COUNT))
			unlistedBytes += extra.bytes
		return { captures, unlistedBytes, overflow }
	}

	/** Size of a regular data file, 0 when there is none. */
	async #dataSize(name: string): Promise<number> {
		try {
			const st = await lstat(this.data(name))
			return st.isFile() ? st.size : 0
		} catch (err) {
			if (missing(err)) return 0
			throw err
		}
	}

	/**
	 * Moves the finished data into place, then publishes the metadata. `wanted` is asked
	 * again after every await: once it answers false nothing is published and the moved
	 * data is removed (false is returned; the caller removes the partial file).
	 */
	async commit(
		capture: IqCapture,
		wanted: () => boolean = () => true,
	): Promise<boolean> {
		const name = capture.name
		if (!wanted()) return false
		await rename(this.partial(name), this.data(name))
		const temp = this.metaPartial(name)
		let published = false
		try {
			if (wanted()) {
				await writeFile(temp, JSON.stringify(capture), {
					mode: 0o600,
					flag: "wx",
					flush: true,
				})
				// The metadata rename is the publication: the last point a revocation can stop.
				if (wanted()) {
					await rename(temp, this.meta(name))
					published = true
				}
			}
		} finally {
			if (!published) {
				await rm(temp, { force: true })
				await rm(this.data(name), { force: true })
			}
		}
		return published
	}

	/** Metadata first, so a half-removed capture is never listed. */
	async remove(name: string): Promise<boolean> {
		if (!(await this.exists(name))) return false
		await rm(this.meta(name), { force: true })
		await rm(this.data(name), { force: true })
		return true
	}

	async openData(
		name: string,
	): Promise<{ capture: IqCapture; handle: FileHandle } | null> {
		const capture = await this.read(name)
		if (!capture) return null
		let handle: FileHandle
		try {
			handle = await open(
				this.data(name),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			)
		} catch (err) {
			if (missing(err)) return null
			throw err
		}
		try {
			const st = await handle.stat()
			if (!st.isFile() || st.size !== capture.bytes) {
				await handle.close()
				return null
			}
		} catch (err) {
			await handle.close().catch(() => {})
			throw err
		}
		return { capture, handle }
	}
}

export interface IqCaptureOptions {
	/** The capture directory (`<stateDir>/iq-captures`); created private on first use. */
	dir: string
	sourceManager: Pick<SourceManager, "getStatus" | "getAllStatus"> &
		Pick<EventEmitter, "on" | "off">
	fanoutFor: (
		sourceId: string,
	) => Pick<FanoutManager, "addBranch" | "removeBranch" | "on" | "off">
	/** The tuner state of a source, for the gain recorded with the capture. */
	tunerState?: ((sourceId: string) => TunerState | undefined) | undefined
	access: Pick<
		FastifyAccessController,
		"authorizeMetadataMutation" | "leaseDownload"
	>
	/** Bytes the filesystem holding `dir` has available (tests replace it). */
	availableBytes?: (dir: string) => Promise<number>
	/** Opens the partial file exclusively (tests replace it to fail the flush or close). */
	createPartial?: (path: string) => Writable
}

async function statfsAvailable(dir: string): Promise<number> {
	const st = await statfs(dir)
	return Number(st.bavail) * Number(st.bsize)
}

function createPartialFile(path: string): Writable {
	return createWriteStream(path, { flags: "wx", mode: 0o600, flush: true })
}

function sendError(
	reply: FastifyReply,
	status: number,
	code: IqCaptureErrorCode,
): FastifyReply {
	const body: IqCaptureErrorBody = {
		error: ERRORS[status] ?? "Error",
		code,
		message: MESSAGES[code],
	}
	return reply.code(status).header("Cache-Control", "no-store").send(body)
}

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.code(denied.status)
		.header("Cache-Control", "no-store")
		.send({ code: denied.code })
}

function sendLeaseRejected(
	request: FastifyRequest,
	reply: FastifyReply,
	reason: string,
) {
	if (request.raw.aborted || reply.raw.destroyed)
		return reply.code(499).send({ code: "REQUEST_ABORTED" })
	const status =
		reason === "capacity" ? 429 : reason === "invalidated" ? 401 : 503
	return reply.code(status).send({
		code:
			status === 401
				? "AUTH_REQUIRED"
				: status === 429
					? "ACCESS_CAPACITY"
					: "ACCESS_UNAVAILABLE",
	})
}

/** Manual gain the tuner reports as known; null under AGC or unknown state. */
function knownGain(state: TunerState | undefined): number | null {
	if (!state || state.gainMode !== "manual") return null
	const unknown = state.unknownFields ?? []
	if (unknown.includes("gain") || unknown.includes("gainMode")) return null
	return Number.isSafeInteger(state.gain) ? state.gain : null
}

interface Tuning {
	centerHz: number
	sampleRate: number
}

/** The tuning a capture can record, or undefined when the source cannot be captured. */
function captureTuning(source: SourceStatus | undefined): Tuning | undefined {
	if (!source?.connected) return undefined
	const { caps } = source
	if (
		caps.kind !== "iq" ||
		caps.format !== "U8_IQ" ||
		!Number.isSafeInteger(caps.sampleRate) ||
		caps.sampleRate <= 0 ||
		caps.sampleRate > IQ_CAPTURE_MAX_SAMPLE_RATE ||
		caps.centerFreq === undefined
	)
		return undefined
	return { centerHz: caps.centerFreq, sampleRate: caps.sampleRate }
}

/** Source events that end what a capture records. */
const SOURCE_EVENTS = ["caps-changed", "disconnected", "removed"] as const

type Outcome =
	| { kind: "complete"; startedAt: string }
	| { kind: "interrupted" }
	| { kind: "failed" }
	| { kind: "gone" }

/** A capture between admission and its commit or cleanup. */
interface Running {
	/** Counted against the quota until the capture is stored or removed. */
	bytes: number
	/**
	 * Not yet acknowledged by the file's write callback, so possibly not yet seen by statfs:
	 * counted against the free-space floor. Bytes queued in the stream still count.
	 */
	unwritten: number
}

export const iqCaptureRoutes: FastifyPluginAsync<IqCaptureOptions> = async (
	app,
	options,
) => {
	const store = new IqCaptureStore(options.dir)
	const available = options.availableBytes ?? statfsAvailable
	const createPartial = options.createPartial ?? createPartialFile
	/** Sources with a capture running: one at a time per source. */
	const busySources = new Set<string>()
	/** Names being captured, so two requests cannot claim the same one. */
	const busyNames = new Set<string>()
	/** Every admitted capture until its commit or cleanup ends. */
	const running = new Map<string, Running>()
	/** Each running capture's abort; shutdown calls every one. */
	const active = new Map<string, () => Promise<void>>()
	/** Each capture request's end (after commit or cleanup); shutdown awaits every one. */
	const inflight = new Set<Promise<void>>()
	/** The source watch of each source's capture, from admission until it ends. */
	const watchers = new Map<string, () => void>()
	/** Set when shutdown starts: an admission still pending then never starts its capture. */
	let closing = false

	/**
	 * Admission and commit run one at a time, so the stored listing, the running reservations
	 * and the free space an admission reads are one consistent state: a capture finishing
	 * mid-admission commits before or after it, never between its reads.
	 */
	let lock: Promise<unknown> = Promise.resolve()
	const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = lock.then(fn, fn)
		lock = run.catch(() => {})
		return run
	}

	const onSource = (sourceId: unknown) => {
		if (typeof sourceId === "string") watchers.get(sourceId)?.()
	}
	for (const event of SOURCE_EVENTS) options.sourceManager.on(event, onSource)
	app.addHook("onClose", async () => {
		for (const event of SOURCE_EVENTS)
			options.sourceManager.off(event, onSource)
	})

	app.addHook("preClose", async () => {
		closing = true
		await Promise.all([...active.values()].map(abort => abort()))
		await Promise.all([...inflight])
	})

	const authorize = (request: FastifyRequest, reply: FastifyReply) => {
		const denied = options.access.authorizeMetadataMutation(request)
		if (denied) {
			void sendDenial(reply, denied)
			return false
		}
		return true
	}

	app.get(IQ_CAPTURES_ROUTE, async (request, reply) => {
		if (!authorize(request, reply)) return reply
		try {
			await store.ready()
			const { captures, unlistedBytes } = await store.usage()
			const body: IqCaptureList = {
				captures,
				usedBytes:
					captures.reduce((sum, c) => sum + c.bytes, 0) + unlistedBytes,
				quotaBytes: IQ_CAPTURES_QUOTA_BYTES,
				maxCount: IQ_CAPTURES_MAX_COUNT,
			}
			return await reply.header("Cache-Control", "no-store").send(body)
		} catch (err) {
			request.log.warn({ err: safeErrorFields(err) }, "IQ capture list failed")
			return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
		}
	})

	app.get<{ Params: { name: string } }>(
		IQ_CAPTURE_ROUTE,
		async (request, reply) => {
			if (!authorize(request, reply)) return reply
			let stream: Readable | undefined
			let handle: FileHandle | undefined
			const lease = options.access.leaseDownload(request, reply.raw, () => {
				if (stream) stream.destroy()
				else void handle?.close().catch(() => {})
			})
			if (lease.kind === "rejected")
				return sendLeaseRejected(request, reply, lease.reason)
			try {
				const name = request.params.name
				if (!IQ_CAPTURE_NAME.test(name))
					return sendError(reply, 404, "IQ_CAPTURE_NOT_FOUND")
				await store.ready()
				const opened = await store.openData(name)
				if (opened) handle = opened.handle
				if (!lease.active()) {
					await handle?.close().catch(() => {})
					return reply
				}
				if (!opened) return sendError(reply, 404, "IQ_CAPTURE_NOT_FOUND")
				const { capture } = opened
				stream = opened.handle.createReadStream({ autoClose: true })
				const s = stream
				s.on("error", () => {
					request.log.warn("IQ capture download stream error")
					lease.release()
					s.destroy()
				})
				return await reply
					.type("application/octet-stream")
					.header(
						"Content-Disposition",
						`attachment; filename="${capture.name}${DATA}"`,
					)
					.header("Content-Length", capture.bytes)
					.header("Cache-Control", "no-store")
					.header("X-WaveKit-Center-Hz", capture.centerHz)
					.header("X-WaveKit-Sample-Rate", capture.sampleRate)
					.header("X-WaveKit-Start-Time", capture.startedAt)
					.send(stream)
			} catch (err) {
				if (stream) stream.destroy()
				else await handle?.close().catch(() => {})
				if (!lease.active()) return reply
				request.log.warn(
					{ err: safeErrorFields(err) },
					"IQ capture download unavailable",
				)
				return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
			}
		},
	)

	app.delete<{ Params: { name: string } }>(
		IQ_CAPTURE_ROUTE,
		async (request, reply) => {
			if (!authorize(request, reply)) return reply
			const name = request.params.name
			if (!IQ_CAPTURE_NAME.test(name))
				return sendError(reply, 404, "IQ_CAPTURE_NOT_FOUND")
			if (busyNames.has(name)) return sendError(reply, 409, "IQ_CAPTURE_BUSY")
			try {
				await store.ready()
				if (!(await serialized(() => store.remove(name))))
					return sendError(reply, 404, "IQ_CAPTURE_NOT_FOUND")
				return await reply.code(204).header("Cache-Control", "no-store").send()
			} catch (err) {
				request.log.warn(
					{ err: safeErrorFields(err) },
					"IQ capture delete failed",
				)
				return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
			}
		},
	)

	app.post(IQ_CAPTURES_ROUTE, async (request, reply) => {
		if (!authorize(request, reply)) return reply
		const parsed = bodySchema.safeParse(request.body)
		if (!parsed.success)
			return reply.code(400).send(
				zodValidationBody(parsed.error, bodySchema, {
					expected: BODY_EXPECTED,
				}),
			)
		const { name, seconds } = parsed.data
		let requested = parsed.data.sourceId
		if (requested === undefined) {
			const all = options.sourceManager.getAllStatus()
			if (all.length === 0) return sendError(reply, 404, "SOURCE_NOT_FOUND")
			if (all.length > 1)
				return reply.code(400).send(
					validationErrorBody("body", [
						{
							field: "sourceId",
							expected:
								"required when more than one source is configured; a source id from GET /api/sources",
						},
					]),
				)
			requested = all[0]!.id
		}
		const sourceId = requested
		const source = options.sourceManager.getStatus(sourceId)
		if (!source) return sendError(reply, 404, "SOURCE_NOT_FOUND")
		if (!source.connected) return sendError(reply, 503, "SOURCE_DISCONNECTED")
		const tuning = captureTuning(source)
		if (!tuning) return sendError(reply, 409, "IQ_CAPTURE_UNSUPPORTED")
		const { centerHz, sampleRate } = tuning
		if (busySources.has(sourceId))
			return sendError(reply, 409, "IQ_CAPTURE_BUSY")
		if (busyNames.has(name)) return sendError(reply, 409, "IQ_CAPTURE_EXISTS")
		// Whole seconds at a rate ≤ 3,200,000: at most 10 × 3,200,000 × 2 = IQ_CAPTURE_MAX_BYTES.
		const bytes = seconds * sampleRate * 2
		const id = randomUUID()
		const job: Running = { bytes, unwritten: bytes }
		// Claimed and watched before the first await, so a concurrent request sees this capture
		// and a source change during the disk checks is never missed.
		busySources.add(sourceId)
		busyNames.add(name)
		running.set(id, job)
		let sourceChanged = false
		let interruptCapture: (() => void) | undefined
		watchers.set(sourceId, () => {
			sourceChanged = true
			interruptCapture?.()
		})
		let ended!: () => void
		const end = new Promise<void>(resolve => {
			ended = resolve
		})
		inflight.add(end)
		/** The tuning is still the admitted one: no source event and the same caps. */
		const unchanged = () => {
			const now = captureTuning(options.sourceManager.getStatus(sourceId))
			return (
				!sourceChanged &&
				now?.centerHz === centerHz &&
				now.sampleRate === sampleRate
			)
		}
		try {
			try {
				await store.ready()
				const refusal = await serialized(async () => {
					if (closing) return "closing" as const
					if (await store.exists(name)) return "exists" as const
					const {
						captures: stored,
						unlistedBytes,
						overflow,
					} = await store.usage()
					const reservations = [...running.values()]
					const used =
						stored.reduce((sum, c) => sum + c.bytes, 0) +
						unlistedBytes +
						reservations.reduce((sum, r) => sum + r.bytes, 0)
					if (
						overflow ||
						used > IQ_CAPTURES_QUOTA_BYTES ||
						stored.length + reservations.length > IQ_CAPTURES_MAX_COUNT
					)
						return "quota" as const
					// Every running capture's unwritten bytes, this one's included, must leave the floor.
					const unwritten = reservations.reduce(
						(sum, r) => sum + r.unwritten,
						0,
					)
					if (
						(await available(store.dir)) - unwritten <
						IQ_CAPTURES_MIN_FREE_BYTES
					)
						return "disk" as const
					return null
				})
				if (refusal === "exists")
					return sendError(reply, 409, "IQ_CAPTURE_EXISTS")
				if (refusal === "quota")
					return sendError(reply, 507, "IQ_CAPTURE_QUOTA")
				if (refusal === "disk")
					return sendError(reply, 507, "IQ_CAPTURE_DISK_FULL")
				if (refusal === "closing")
					return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
			} catch (err) {
				request.log.warn(
					{ err: safeErrorFields(err) },
					"IQ capture admission failed",
				)
				return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
			}
			// Nothing is open yet: a retune or rate change during admission is a plain refusal.
			if (!unchanged())
				return sendError(reply, 409, "IQ_CAPTURE_SOURCE_CHANGED")
			// Replaced by the running capture's finish once it exists.
			let stop: (outcome: Outcome) => Promise<void> = async () => {}
			const lease = options.access.leaseDownload(request, reply.raw, () => {
				void stop({ kind: "gone" })
			})
			if (lease.kind === "rejected")
				return sendLeaseRejected(request, reply, lease.reason)
			if (!lease.active()) return reply
			// Checked in the same turn the capture registers its abort, so shutdown's abort
			// snapshot either holds this capture or shutdown began before it and it never starts.
			if (closing) return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
			const outcome = await capture(fn => {
				stop = fn
			})
			// Exactly one of commit or cleanup ends every capture: the partial file is stored
			// only when complete and still wanted, and removed on every other path.
			const result: IqCapture = {
				name,
				sourceId,
				format: "cu8",
				centerHz,
				sampleRate,
				gain: knownGain(options.tunerState?.(sourceId)),
				startedAt: outcome.kind === "complete" ? outcome.startedAt : "",
				durationS: seconds,
				bytes,
			}
			const stored =
				outcome.kind === "complete" && lease.active()
					? await serialized(async () => {
							try {
								// The lease may be revoked while the commit waits for the lock or
								// between its file steps: it is asked again before each one.
								return await store.commit(result, () => lease.active())
							} catch (err) {
								request.log.warn(
									{ err: safeErrorFields(err) },
									"IQ capture could not be stored",
								)
								return false
							} finally {
								// Inside the lock: the next admission sees the stored file or the reservation.
								running.delete(id)
							}
						})
					: false
			if (!stored)
				await rm(store.partial(name), { force: true }).catch((err: unknown) => {
					request.log.warn(
						{ err: safeErrorFields(err) },
						"IQ capture partial file could not be removed",
					)
				})
			if (!lease.active() || outcome.kind === "gone") return reply
			if (stored)
				return await reply
					.code(201)
					.header("Cache-Control", "no-store")
					.send(result)
			if (outcome.kind === "interrupted")
				return sendError(reply, 503, "IQ_CAPTURE_INTERRUPTED")
			return sendError(reply, 503, "IQ_CAPTURES_UNAVAILABLE")
		} finally {
			watchers.delete(sourceId)
			busySources.delete(sourceId)
			busyNames.delete(name)
			running.delete(id)
			active.delete(id)
			inflight.delete(end)
			ended()
		}

		/**
		 * Streams `bytes` from the source branch to the partial file. Resolves once the file
		 * is closed, with "complete" only when every byte was flushed and closed without an
		 * error; never rejects. The caller commits or removes the file.
		 */
		function capture(
			expose: (stop: (outcome: Outcome) => Promise<void>) => void,
		): Promise<Outcome> {
			return new Promise<Outcome>(resolve => {
				const fanout = options.fanoutFor(sourceId)
				const branchId = `iq-capture:${id}`
				let out: Writable
				try {
					out = createPartial(store.partial(name))
				} catch {
					resolve({ kind: "failed" })
					return
				}
				let startedAt: string | undefined
				let remaining = bytes
				let writeError = false
				let settled: Promise<void> | undefined
				let branch: Readable | undefined
				const detach = () => {
					clearTimeout(timer)
					interruptCapture = undefined
					branch?.off("data", onData)
					branch?.off("error", interrupted)
					branch?.off("end", interrupted)
					fanout.off("backpressure", congestion)
					reply.raw.off("close", closed)
					try {
						fanout.removeBranch(branchId)
					} catch {
						/* An already removed branch needs no detach. */
					}
				}
				/** Ends the file (flush and close when keeping, destroy otherwise); waits for 'close'. */
				const finish = (outcome: Outcome): Promise<void> => {
					if (settled) return settled
					detach()
					const keep = outcome.kind === "complete"
					settled = new Promise<void>(done => {
						const closedFile = () => {
							resolve(keep && writeError ? { kind: "failed" } : outcome)
							done()
						}
						if (out.closed) return closedFile()
						out.once("close", closedFile)
						if (keep) out.end()
						else out.destroy()
					})
					return settled
				}
				const interrupted = () => void finish({ kind: "interrupted" })
				const closed = () => {
					if (!reply.raw.writableFinished) void finish({ kind: "gone" })
				}
				const congestion = (changedId: string) => {
					if (changedId === branchId) interrupted()
				}
				const onData = (chunk: Buffer) => {
					if (settled) return
					// The tuning is checked again right before the first stored sample.
					if (startedAt === undefined && !unchanged()) return interrupted()
					startedAt ??= new Date().toISOString()
					const part = chunk.subarray(0, remaining)
					remaining -= part.length
					// Reserved until the file acknowledges the bytes, not when they are queued.
					out.write(part, err => {
						if (!err) job.unwritten -= part.length
					})
					if (remaining === 0)
						return void finish({ kind: "complete", startedAt })
					// A disk slower than the source fails the capture; the source never waits.
					if (out.writableLength > IQ_CAPTURE_MAX_BUFFERED_BYTES) interrupted()
				}
				// Kept until the stream is gone: a flush or close error after end() is still handled.
				out.on("error", () => {
					writeError = true
					void finish({ kind: "failed" })
				})
				// A silent source gets the requested duration plus an equally long grace window:
				// 2 × seconds (at most 20 s), then the capture is interrupted.
				const timer = setTimeout(interrupted, seconds * 2 * 1000)
				timer.unref()
				expose(outcome => finish(outcome))
				active.set(id, () => finish({ kind: "interrupted" }))
				interruptCapture = interrupted
				fanout.on("backpressure", congestion)
				reply.raw.on("close", closed)
				if (!unchanged()) return interrupted()
				try {
					// 1 byte = the smallest positive watermark: flowing reads consume synchronously.
					branch = fanout.addBranch({
						id: branchId,
						sourceId: sourceId,
						highWaterMark: 1,
					})
				} catch {
					void finish({ kind: "failed" })
					return
				}
				branch.on("error", interrupted)
				branch.on("end", interrupted)
				branch.on("data", onData)
			})
		}
	})
}
