import type { Logger } from "../../../utils/logger.js"
import type {
	ActivityReplayFrame,
	ActivityReplayHandle,
	ActivityReplayRequest,
	ActivityReplayResetFrame,
	ActivityReplaySink,
	StoreIdentity,
} from "../storage/contract.js"
import { issueCursor, verifyCursor } from "./cursor.js"
import {
	ActivityCursorGapError,
	ActivityCursorInvalidError,
	ActivityQueryBusyError,
	ActivityQueryError,
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
	ActivitySnapshotResetError,
} from "./errors.js"
import { assembleSummaries, type ReadRequest, type ReadResult } from "./read.js"
import {
	cursorBehindWatermark,
	formatSeq,
	higherWatermark,
	parseSeq,
} from "./seq.js"
import { hashQuery, normaliseQuery, type QueryLimits } from "./validate.js"
interface ReplayStore {
	identity(): StoreIdentity
	cursorKey(): Buffer
	onCommit(listener: (identity: StoreIdentity) => void): () => void
}

export interface ReplayDeps {
	store: ReplayStore
	now: () => number
	limits: QueryLimits & { pageBytes: number; snapshotTtlMs: number; replayPage: number }
	log: Logger
	clientKey: string
	read: (clientKey: string, request: ReadRequest) => Promise<ReadResult>
	register: (stop: () => void) => void
	unregister: (stop: () => void) => void
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms)
		timer.unref()
	})
}

function resetReason(
	error: unknown,
): ActivityReplayResetFrame["reason"] | undefined {
	if (error instanceof ActivityCursorGapError) return "cursor-gap"
	if (error instanceof ActivityCursorInvalidError) return "invalid-cursor"
	if (error instanceof ActivitySnapshotResetError) {
		if (error.reason === "snapshot-reset") return "cursor-gap"
		if (
			error.reason === "cursor-expired" ||
			error.reason === "store-changed" ||
			error.reason === "query-changed"
		) {
			return error.reason
		}
	}
	return undefined
}

/**
 * Catch-up then live follow. Commit notifications are wakeups: every pass
 * re-reads the committed maximum so a lost wakeup cannot drop a row.
 * `sink.send` returning false accepts the frame and pauses until `resume`.
 */
export function startReplay(
	deps: ReplayDeps,
	input: ActivityReplayRequest,
	sink: ActivityReplaySink,
): ActivityReplayHandle {
	const query = normaliseQuery(input.query, deps.limits)
	const queryHash = hashQuery(query)
	let stopped = false
	let paused = false
	let pumping = false
	let rerun = false
	let pauseGeneration = 0
	let position: bigint | null = null
	let announcedHigh: bigint | null = null
	let storeUuid: string | undefined
	let restoreGeneration: number | undefined
	let retryTimer: ReturnType<typeof setTimeout> | undefined

	const unsubscribe = deps.store.onCommit(() => {
		if (stopped) return
		rerun = true
		if (!pumping && !paused) trackPump()
	})

	function stop(): void {
		if (stopped) return
		stopped = true
		if (retryTimer) clearTimeout(retryTimer)
		unsubscribe()
		deps.unregister(stop)
	}

	function onPumpFailure(error: unknown): void {
		if (stopped) return
		if (error instanceof ActivityQueryError) {
			const reason = resetReason(error)
			if (reason) {
				emitReset(reason)
				return
			}
		}
		deps.log.error({ err: error }, "Activity replay failed")
		emitReset("reader-failed")
	}

	function trackPump(): void {
		void pump().catch((error: unknown) => {
			onPumpFailure(error)
		})
	}

	function emitReset(reason: ActivityReplayResetFrame["reason"]): void {
		if (stopped) return
		try {
			sink.send({ type: "reset", reason })
		} catch (error) {
			deps.log.warn({ err: error }, "Activity replay reset was not delivered")
		}
		stop()
	}

	function issue(identity: StoreIdentity, seq: bigint): string {
		return issueCursor({
			key: deps.store.cursorKey(),
			identity,
			queryHash,
			order: "asc",
			lastSeq: seq,
			high: seq,
			expiresAtMs: deps.now() + deps.limits.snapshotTtlMs,
		}).token
	}

	async function pump(): Promise<void> {
		if (stopped) return
		if (pumping) {
			rerun = true
			return
		}
		pumping = true
		let retries = 0
		let failed = false
		try {
			while (!stopped && !paused) {
				if (rerun) rerun = false
				const identity = deps.store.identity()
				if (storeUuid === undefined) {
					storeUuid = identity.storeUuid
					restoreGeneration = identity.restoreGeneration
				} else if (
					identity.storeUuid !== storeUuid ||
					identity.restoreGeneration !== restoreGeneration
				) {
					emitReset("store-changed")
					return
				}
				if (position === null) {
					if (input.cursor !== undefined) {
						try {
							const payload = verifyCursor({
								token: input.cursor,
								key: deps.store.cursorKey(),
								identity,
								queryHash,
								order: "asc",
								now: deps.now(),
								mode: "replay",
							})
							position = parseSeq(payload.lastSeq)
						} catch (error) {
							const reason = resetReason(error)
							if (reason) {
								emitReset(reason)
								return
							}
							throw error
						}
					} else {
						position = parseSeq(identity.committedMax)
					}
				}
				const watermark = parseSeq(identity.pruneWatermark)
				if (cursorBehindWatermark(position, watermark)) {
					emitReset("cursor-gap")
					return
				}
				const high = parseSeq(identity.committedMax)
				if (position >= high) {
					if (announcedHigh !== position) {
						const frame: ActivityReplayFrame = {
							type: "progress",
							scannedThrough: formatSeq(position),
							cursor: issue(identity, position),
						}
						const generation = pauseGeneration
						const accepted = sink.send(frame)
						announcedHigh = position
						if (!accepted && generation === pauseGeneration) {
							paused = true
							return
						}
					}
					const again = deps.store.identity()
					if (parseSeq(again.committedMax) > position || rerun) continue
					return
				}
				const request: ReadRequest = {
					op: "search",
					query,
					order: "asc",
					limit: deps.limits.replayPage + 1,
					low: "0",
					high: formatSeq(high),
					before: null,
					after: formatSeq(position),
				}
				let result: ReadResult
				try {
					result = await deps.read(deps.clientKey, request)
				} catch (error) {
					if (stopped) return
					if (
						error instanceof ActivityQueryBusyError ||
						error instanceof ActivityQueryTimeoutError
					) {
						retries += 1
						deps.log.warn({ err: error }, "Activity replay read delayed")
						if (retries <= 8) {
							await delay(20)
							continue
						}
						retries = 0
						await new Promise<void>(resolve => {
							retryTimer = setTimeout(resolve, 200)
							retryTimer.unref()
						})
						continue
					}
					const reason = resetReason(error)
					if (reason) {
						emitReset(reason)
						return
					}
					throw error
				}
				if (stopped || paused) return
				retries = 0
				if (result.op !== "search") throw new ActivityReaderFailedError()
				const fresh = deps.store.identity()
				if (
					storeUuid === undefined ||
					result.observed.storeUuid !== storeUuid ||
					result.observed.restoreGeneration !== restoreGeneration ||
					fresh.storeUuid !== storeUuid ||
					fresh.restoreGeneration !== restoreGeneration
				) {
					emitReset("store-changed")
					return
				}
				const readWatermark = higherWatermark(
					parseSeq(fresh.pruneWatermark),
					parseSeq(result.observed.pruneWatermark),
				)
				if (cursorBehindWatermark(position, readWatermark)) {
					emitReset("cursor-gap")
					return
				}
				const page = assembleSummaries(
					result.rows,
					deps.limits.replayPage,
					deps.limits.pageBytes,
				)
				const scanned = page.hasMore ? page.lastSeq : formatSeq(high)
				if (scanned === null || parseSeq(scanned) <= position) {
					throw new ActivityReaderFailedError("Activity replay made no progress")
				}
				const frame: ActivityReplayFrame =
					page.items.length > 0
						? {
								type: "records",
								items: page.items,
								scannedThrough: scanned,
								cursor: issue(identity, parseSeq(scanned)),
							}
						: {
								type: "progress",
								scannedThrough: scanned,
								cursor: issue(identity, parseSeq(scanned)),
							}
				const generation = pauseGeneration
				const accepted = sink.send(frame)
				position = parseSeq(scanned)
				if (!page.hasMore) announcedHigh = high
				if (!accepted && generation === pauseGeneration) {
					paused = true
					return
				}
			}
		} catch (error) {
			failed = true
			throw error
		} finally {
			pumping = false
			if (!failed && !stopped && !paused && rerun) {
				rerun = false
				trackPump()
			}
		}
	}

	deps.register(stop)
	trackPump()

	return {
		resume(): void {
			if (stopped) return
			pauseGeneration += 1
			paused = false
			rerun = true
			queueMicrotask(() => {
				if (!stopped && !paused) trackPump()
			})
		},
		stop,
	}
}
