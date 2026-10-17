/**
 * Adapter from the replay queue's `IqReplayProbes` onto the probe pool (WG11 req 6.4, 6.5). The pool is
 * typed structurally (Main passes the real `ProbePool`), so this file needs no pool change to compile.
 *
 * One probe per request: `request` asks the pool for a `replay` probe on the replay transport; the run's
 * `result` settles when the probe stopped. Outcome: an accepted identity → `decoded`; the decoder reached
 * its clean end (pool event `replay-end`) → `no-sync` (no output), `crc-errors` (CRC failures) or
 * `timeout` (output, no identity); anything else (cancel, failure, preemption, a decoder that never
 * exited within its hold plus grace) → `cancelled`.
 * A request the pool could not start is withdrawn from the pool's own queue (the replay queue retries).
 */
import type { EventEmitter } from "node:events"
import type {
	IqReplayProbeAnswer,
	IqReplayProbeRequest,
	IqReplayProbeRun,
	IqReplayProbes,
} from "./replay-queue.js"
import type {
	DecodeEvidence,
	ScannerClass,
	ScannerProtocol,
} from "../scanner/types.js"
import type { ProbeMode } from "../scanner/probes/probe-pool.js"

/** The `ProbeRequest` fields a replay probe sets. */
export interface ReplayPoolRequest {
	jobId: string
	priority: number
	sourceId: string
	trackId: string
	observationId: string
	discoveryId: string | null
	targetHz: number
	epoch: number
	cls: ScannerClass
	protocols: ScannerProtocol[]
	preRollFromSample: number | null
	holdMs: number
	record: boolean
	admission: { kind: "undecoded"; snrDb: number }
	modes: ProbeMode[]
	replay: { captureId: string }
}

/** `ProbePool` as the adapter uses it. */
export interface ReplayPool extends EventEmitter {
	request(req: ReplayPoolRequest): { started: string } | { deferred: string }
	release(probeId: string): Promise<void>
	dequeue(req: ReplayPoolRequest): boolean
}

export interface ReplayPoolAdapterOptions {
	/** `REPLAY_PROBE_PRIORITY`. */
	priority: number
	/** The job id the probes run under (`IQ_REPLAY_QUEUE_HOLDER`). */
	jobId: string
	/** Slack past a mode's hold before the adapter ends a probe that never exited (default 5 s). */
	graceMs?: number
	timers?: {
		setTimeout(fn: () => void, ms: number): unknown
		clearTimeout(handle: unknown): void
	}
}

interface Active {
	req: ReplayPoolRequest
	probeId: string | null
	output: boolean
	crcFailures: number
	decoded: IqReplayProbeAnswer["decoded"]
	complete: boolean
	timer: unknown
	settle: (a: IqReplayProbeAnswer) => void
}

const defaultTimers = {
	setTimeout: (fn: () => void, ms: number): unknown => {
		const t = setTimeout(fn, ms)
		t.unref()
		return t
	},
	clearTimeout: (h: unknown): void => clearTimeout(h as NodeJS.Timeout),
}

export interface ReplayPoolAdapter extends IqReplayProbes {
	/** Unsubscribes from the pool and cancels every active run. */
	dispose(): void
}

export function createPoolReplayProbes(
	pool: ReplayPool,
	opts: ReplayPoolAdapterOptions,
): ReplayPoolAdapter {
	const timers = opts.timers ?? defaultTimers
	const graceMs = opts.graceMs ?? 5_000
	const byReq = new Map<ReplayPoolRequest, Active>()
	const byProbe = new Map<string, Active>()
	const releaseListeners = new Set<() => void>()

	const outcomeOf = (a: Active): IqReplayProbeAnswer => {
		if (a.decoded) return { outcome: "decoded", decoded: a.decoded }
		if (!a.complete) return { outcome: "cancelled", decoded: null }
		return {
			outcome: !a.output
				? "no-sync"
				: a.crcFailures > 0
					? "crc-errors"
					: "timeout",
			decoded: null,
		}
	}
	const finish = (a: Active): void => {
		timers.clearTimeout(a.timer)
		byReq.delete(a.req)
		if (a.probeId) byProbe.delete(a.probeId)
		a.settle(outcomeOf(a))
	}
	const release = (a: Active): void => {
		if (a.probeId) void pool.release(a.probeId).catch(() => undefined)
	}

	const onState = (
		probeId: string,
		state: string,
		req: ReplayPoolRequest,
	): void => {
		if (state === "starting") {
			const a = byReq.get(req)
			if (a) {
				a.probeId = probeId
				byProbe.set(probeId, a)
			}
			return
		}
		if (state !== "stopped") return
		const a = byProbe.get(probeId)
		if (a) finish(a)
		for (const l of [...releaseListeners]) {
			try {
				l()
			} catch {
				// a listener failure never blocks the pool
			}
		}
	}
	const onEvidence = (
		probeId: string,
		_req: unknown,
		ev: DecodeEvidence,
	): void => {
		const a = byProbe.get(probeId)
		if (!a) return
		a.output = true
		if (!ev.crcClean) a.crcFailures += 1
		if (ev.identity)
			a.decoded ??= { protocol: ev.protocol, identity: ev.identity }
	}
	const onReplayEnd = (probeId: string): void => {
		const a = byProbe.get(probeId)
		if (a) a.complete = true
	}
	pool.on("probe-state", onState)
	pool.on("evidence", onEvidence)
	pool.on("replay-end", onReplayEnd)

	return {
		request(
			r: IqReplayProbeRequest,
		): { run: IqReplayProbeRun } | { deferred: string } {
			const req: ReplayPoolRequest = {
				jobId: opts.jobId,
				priority: opts.priority,
				sourceId: r.sourceId,
				trackId: `replay-${r.captureId}`,
				observationId: r.observationId ?? "",
				discoveryId: null,
				targetHz: r.rfHz,
				epoch: r.epoch,
				cls: "unknown",
				protocols: [r.protocol],
				preRollFromSample: null,
				holdMs: r.mode.holdMs,
				record: false,
				admission: { kind: "undecoded", snrDb: 0 },
				modes: [r.mode],
				replay: { captureId: r.captureId },
			}
			let settle!: (a: IqReplayProbeAnswer) => void
			const result = new Promise<IqReplayProbeAnswer>(resolve => {
				settle = resolve
			})
			const a: Active = {
				req,
				probeId: null,
				output: false,
				crcFailures: 0,
				decoded: null,
				complete: false,
				timer: null,
				settle,
			}
			byReq.set(req, a)
			let res: ReturnType<ReplayPool["request"]>
			try {
				res = pool.request(req)
			} catch (err) {
				byReq.delete(req)
				throw err
			}
			if (!("started" in res)) {
				byReq.delete(req)
				// The pool may have queued it: the replay queue retries, so withdraw this copy.
				pool.dequeue(req)
				return { deferred: res.deferred }
			}
			a.probeId ??= res.started
			byProbe.set(res.started, a)
			// A decoder that never exits: released after its hold plus grace. Only a clean replay-end
			// is a verdict (Astra MAJOR 1: the input may have failed): otherwise `cancelled`.
			a.timer = timers.setTimeout(() => release(a), r.mode.holdMs + graceMs)
			return {
				run: {
					result,
					cancel: () => {
						a.complete = false
						release(a)
					},
				},
			}
		},
		onSlotRelease(listener: () => void): () => void {
			releaseListeners.add(listener)
			return () => releaseListeners.delete(listener)
		},
		dispose(): void {
			pool.off("probe-state", onState)
			pool.off("evidence", onEvidence)
			pool.off("replay-end", onReplayEnd)
			for (const a of [...byReq.values()]) {
				a.complete = false
				release(a)
				finish(a)
			}
			releaseListeners.clear()
		},
	}
}
