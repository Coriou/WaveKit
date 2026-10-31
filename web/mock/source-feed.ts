/**
 * Receiver feed pause / resume for the mock core, kept apart from server.ts:
 * POST /api/sources/:id/pause and /resume as src/api/routes/sources.ts answers them (200 with
 * `{ id, feed, changed }`, idempotent `changed: false`, 404 `SOURCE_NOT_FOUND`, 503
 * `SOURCE_RESUME_FAILED` with the feed in `error`, `persisted: false` when saving failed). Like SourceManager: pause from `paused` is a
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
	/** More sources with their own feed (the opt-in second receiver); resume failures and saves are shared. */
	extraSourceIds?: readonly string[]
	/** How long a resume dials before it answers (ms; default 400, as a real reconnect). */
	resumeMs?: number
	/** The next this many resumes fail (WAVEKIT_MOCK_RESUME_FAILURES), to try the retry. */
	resumeFailures?: number
	/**
	 * The next this many 200 answers say `persisted: false` (WAVEKIT_MOCK_PERSIST_FAILURES): the change holds
	 * but its save failed; a repeated call retries the save, as SourceManager.persistFeeds.
	 */
	persistFailures?: number
	/** After every feed change: re-send the source and decoder statuses. */
	onChange: (sourceId: string) => void
}

export interface SourceFeedMock {
	/** The feed of `sourceId` (default: the main source). */
	feed(sourceId?: string): SourceFeed
	/** Anything but live: the source is held back. */
	paused(sourceId?: string): boolean
	/** Makes the next `n` resumes fail (tests). */
	failNextResumes(n: number): void
	/** Makes the next `n` saves fail: those answers say `persisted: false` (tests). */
	failNextSaves(n: number): void
}

export function registerSourceFeedMock(
	app: FastifyInstance,
	options: SourceFeedMockOptions,
): SourceFeedMock {
	const resumeMs = options.resumeMs ?? 400
	let failures = Math.max(0, options.resumeFailures ?? 0)
	let saveFailures = Math.max(0, options.persistFailures ?? 0)
	interface Machine {
		feed: SourceFeed
		busy: Promise<unknown>
	}
	const machines = new Map<string, Machine>()
	for (const id of [options.sourceId, ...(options.extraSourceIds ?? [])])
		machines.set(id, {
			feed: { state: "live", since: new Date().toISOString() },
			busy: Promise.resolve(),
		})

	const set = (id: string, m: Machine, state: SourceFeedState) => {
		m.feed = {
			state,
			since: new Date().toISOString(),
			...(state === "error" ? { error: SOURCE_RESUME_FAILED_MESSAGE } : {}),
		}
		options.onChange(id)
	}

	/** One feed call at a time per source, as SourceManager.serialFeed. */
	const serial = <T>(m: Machine, fn: () => Promise<T>): Promise<T> => {
		const next = m.busy.then(fn, fn)
		m.busy = next.catch(() => undefined)
		return next
	}

	const pause = (
		id: string,
		m: Machine,
	): Promise<{ feed: SourceFeed; changed: boolean }> =>
		serial(m, async () => {
			const changed = m.feed.state !== "paused"
			if (changed) set(id, m, "paused")
			return { feed: m.feed, changed }
		})

	const resume = (
		id: string,
		m: Machine,
	): Promise<{ feed: SourceFeed; changed: boolean }> =>
		serial(m, async () => {
			if (m.feed.state === "live") return { feed: m.feed, changed: false }
			set(id, m, "resuming")
			if (resumeMs > 0) await new Promise(r => setTimeout(r, resumeMs))
			if (failures > 0) {
				failures -= 1
				set(id, m, "error")
			} else set(id, m, "live")
			return { feed: m.feed, changed: true }
		})

	for (const action of ["pause", "resume"] as const)
		app.post<{ Params: { id: string } }>(
			`/api/sources/:id/${action}`,
			async (request, reply) => {
				const { id } = request.params
				const m = machines.get(id)
				if (!m)
					return reply.code(404).send({
						error: "NotFound",
						code: "SOURCE_NOT_FOUND",
						message: `Source with id '${id}' not found`,
					})
				const result =
					action === "pause" ? await pause(id, m) : await resume(id, m)
				if (result.feed.state === "error")
					return reply.code(503).send({
						error: "ServiceUnavailable",
						code: "SOURCE_RESUME_FAILED",
						message: SOURCE_RESUME_FAILED_MESSAGE,
						id,
						feed: result.feed,
					})
				let persisted = true
				if (saveFailures > 0) {
					saveFailures -= 1
					persisted = false
				}
				const body: SourceFeedResponse = { id, ...result, persisted }
				return body
			},
		)

	const machine = (id = options.sourceId): Machine => {
		const m = machines.get(id)
		if (!m) throw new Error(`No feed for source ${id}`)
		return m
	}
	return {
		feed: id => machine(id).feed,
		paused: id => machine(id).feed.state !== "live",
		failNextResumes: n => {
			failures = Math.max(0, n)
		},
		failNextSaves: n => {
			saveFailures = Math.max(0, n)
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
