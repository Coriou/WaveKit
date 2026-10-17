/**
 * worker_threads entry (built to dist/snapshot-worker.js), WG11 req 3.5. Holds the snapshot
 * mirror, applies journal lines and removals in message order, builds the snapshot text when a
 * request arrives (a capture of the record texts, so it matches the state at that request's
 * lastSeq, holding references to the mirror's strings rather than a copy) and writes it on commit
 * in pieces. At most one capture is held: a newer request replaces it. Must not import the
 * persistence module.
 */
import { getHeapStatistics } from "node:v8"
import { parentPort } from "node:worker_threads"
import { WaveKitError } from "../../../utils/errors.js"
import { atomicWriteChunks } from "./atomic-write.js"
import { SnapshotMirror, snapshotChunks } from "./snapshot-mirror.js"
import type { CapturedSnapshot } from "./snapshot-mirror.js"
import { isSnapshotWorkerRequest } from "./snapshot-protocol.js"
import type {
	SnapshotFailReason,
	SnapshotWorkerRequest,
	SnapshotWorkerResponse,
} from "./snapshot-protocol.js"

const port = parentPort
if (!port)
	throw new WaveKitError(
		"snapshot-worker must run inside a worker thread",
		"SCANNER_SNAPSHOT_WORKER",
	)
const out = port

const mirror = new SnapshotMirror()
/** The one capture waiting for its commit (or the reason there is none). */
let held: {
	id: number
	capture: CapturedSnapshot | null
	reason: SnapshotFailReason | null
	buildMs: number
} | null = null
let chain: Promise<void> = Promise.resolve()

/** Collected first when the worker runs with --expose-gc (benchmarks), so the figure is the live heap. */
const collect = (globalThis as { gc?: () => void }).gc

function heapUsed(): number {
	collect?.()
	return getHeapStatistics().used_heap_size
}

function post(message: SnapshotWorkerResponse): void {
	out.postMessage(message)
}

out.on("message", (raw: unknown) => {
	chain = chain.then(() => dispatch(raw)).catch(() => undefined)
})

async function dispatch(raw: unknown): Promise<void> {
	if (!isSnapshotWorkerRequest(raw)) {
		// Unknown input: the mirror can no longer be trusted; the next commit fails to the main path.
		// Nothing is acknowledged, so the main thread's accounting stops matching and it fails over.
		mirror.markBroken("invalid request")
		return
	}
	await handle(raw)
}

async function handle(m: SnapshotWorkerRequest): Promise<void> {
	switch (m.type) {
		case "lines":
			for (const line of m.lines) mirror.applyLine(line)
			post({ type: "applied", charged: m.charged })
			return
		case "remove":
			mirror.applyRemoval({
				discoveries: m.discoveries,
				observations: m.observations,
			})
			post({ type: "applied", charged: m.charged })
			return
		case "reset":
			mirror.resetFromText(m.text, m.seq)
			post({ type: "applied", charged: m.charged })
			return
		case "snapshot": {
			held = null // drop a superseded text before building the next one
			const started = performance.now()
			const counts = mirror.counts()
			let reason: SnapshotFailReason | null = null
			if (mirror.broken() !== null) reason = "broken"
			else if (
				mirror.lastSeq() !== m.head.lastSeq ||
				counts.discoveries !== m.counts.discoveries ||
				counts.observations !== m.counts.observations
			)
				reason = "diverged"
			const capture = reason === null ? mirror.capture(m.head) : null
			held = { id: m.id, capture, reason, buildMs: performance.now() - started }
			post({ type: "applied", charged: m.charged })
			return
		}
		case "commit": {
			const h = held
			if (h === null || h.id !== m.id) {
				post({
					type: "failed",
					id: m.id,
					reason: "unknown-id",
					heapUsedBytes: heapUsed(),
				})
				return
			}
			held = null
			if (h.capture === null) {
				post({
					type: "failed",
					id: m.id,
					reason: h.reason ?? "broken",
					heapUsedBytes: heapUsed(),
				})
				return
			}
			// Not awaited on the message chain: lines keep applying while the disk is slow. The main
			// thread commits one snapshot at a time, so two writes never share the tmp file.
			void writeHeld(m.id, m.file, h.capture, h.buildMs)
		}
	}
}

async function writeHeld(
	id: number,
	file: string,
	capture: CapturedSnapshot,
	buildMs: number,
): Promise<void> {
	const started = performance.now()
	let bytes: number
	try {
		bytes = await atomicWriteChunks(file, snapshotChunks(capture))
	} catch {
		post({ type: "failed", id, reason: "io", heapUsedBytes: heapUsed() })
		return
	}
	post({
		type: "written",
		id,
		bytes,
		buildMs,
		writeMs: performance.now() - started,
		heapUsedBytes: heapUsed(),
	})
}
