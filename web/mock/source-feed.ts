/**
 * Receiver feed pause / resume for the mock core, kept apart from server.ts:
 * POST /api/sources/:id/pause and /resume as src/api/routes/sources.ts answers them (200 with
 * `{ id, feed, changed }`, idempotent `changed: false`, 404 `SOURCE_NOT_FOUND`, 503
 * `SOURCE_RESUME_FAILED` with the feed in `error`). Like SourceManager: pause from `paused` is a
 * no-op, pause from `error` changes to `paused`, resume reads `resuming` while it dials, then `live`
 * or `error`. server.ts reads `feed()` into every source status, suspends the source's decoders with
 * reason `source-paused` and sends no spectrum frames while it is not live.
 * Type stripping only: no enums, parameter properties or namespaces.
 */
import type { FastifyInstance } from "fastify"
import { SOURCE_RESUME_FAILED_MESSAGE } from "@wavekit/api-types"
import type {
	DecoderInfo,
	SourceFeed,
	SourceFeedResponse,
	SourceFeedState,
} from "@wavekit/api-types"

export interface SourceFeedMockOptions {
	sourceId: string
	/** How long a resume dials before it answers (ms; default 400, as a real reconnect). */
	resumeMs?: number
	/** The next this many resumes fail (WAVEKIT_MOCK_RESUME_FAILURES), to try the retry. */
	resumeFailures?: number
	/** After every feed change: re-send the source and decoder statuses. */
	onChange: () => void
}

export interface SourceFeedMock {
	feed(): SourceFeed
	/** Anything but live: the source is held back. */
	paused(): boolean
	/** Makes the next `n` resumes fail (tests). */
	failNextResumes(n: number): void
}

export function registerSourceFeedMock(
	app: FastifyInstance,
	options: SourceFeedMockOptions,
): SourceFeedMock {
	const resumeMs = options.resumeMs ?? 400
	let failures = Math.max(0, options.resumeFailures ?? 0)
	let feed: SourceFeed = { state: "live", since: new Date().toISOString() }
	let busy: Promise<unknown> = Promise.resolve()

	const set = (state: SourceFeedState) => {
		feed = {
			state,
			since: new Date().toISOString(),
			...(state === "error" ? { error: SOURCE_RESUME_FAILED_MESSAGE } : {}),
		}
		options.onChange()
	}

	/** One feed call at a time per source, as SourceManager.serialFeed. */
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = busy.then(fn, fn)
		busy = next.catch(() => undefined)
		return next
	}

	const pause = (): Promise<{ feed: SourceFeed; changed: boolean }> =>
		serial(async () => {
			const changed = feed.state !== "paused"
			if (changed) set("paused")
			return { feed, changed }
		})

	const resume = (): Promise<{ feed: SourceFeed; changed: boolean }> =>
		serial(async () => {
			if (feed.state === "live") return { feed, changed: false }
			set("resuming")
			if (resumeMs > 0) await new Promise(r => setTimeout(r, resumeMs))
			if (failures > 0) {
				failures -= 1
				set("error")
			} else set("live")
			return { feed, changed: true }
		})

	for (const action of ["pause", "resume"] as const)
		app.post<{ Params: { id: string } }>(
			`/api/sources/:id/${action}`,
			async (request, reply) => {
				const { id } = request.params
				if (id !== options.sourceId)
					return reply.code(404).send({
						error: "NotFound",
						code: "SOURCE_NOT_FOUND",
						message: `Source with id '${id}' not found`,
					})
				const result = action === "pause" ? await pause() : await resume()
				if (result.feed.state === "error")
					return reply.code(503).send({
						error: "ServiceUnavailable",
						code: "SOURCE_RESUME_FAILED",
						message: SOURCE_RESUME_FAILED_MESSAGE,
						id,
						feed: result.feed,
					})
				const body: SourceFeedResponse = { id, ...result }
				return body
			},
		)

	return {
		feed: () => feed,
		paused: () => feed.state !== "live",
		failNextResumes: n => {
			failures = Math.max(0, n)
		},
	}
}

/**
 * Decoders on `sourceId` while its feed is held back, as DecoderManager reports them: every wanted one is
 * suspended with reason "source-paused" (it outranks every other reason), not running, no pid.
 */
export function withSourcePaused(
	list: DecoderInfo[],
	sourceId: string,
	feed: SourceFeed,
): DecoderInfo[] {
	if (feed.state === "live") return list
	return list.map(d => {
		if (d.sourceId !== sourceId || d.desiredRunning === false) return d
		if (d.mode === "off") return d
		const paused: DecoderInfo = {
			...d,
			running: false,
			suspended: true,
			uptime: 0,
			suspension: { reasonCode: "source-paused", since: feed.since },
		}
		delete paused.pid
		delete paused.efficiency
		return paused
	})
}
