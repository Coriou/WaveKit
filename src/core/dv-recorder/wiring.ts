/**
 * The digital-voice call recorder as the core composes it: the recorder on the service's per-call
 * tap, the call's name fields from the decoder's own call events, the recordings catalogue told
 * of each new file, and the file linked to its Activity `call_end` row once the call's end was
 * seen.
 *
 * Order per recording: the tap's `end` (or the max-call cap), the rename, then
 * `inventory.touchCallRecordings` first (so the catalogue lists the file before the link sweep
 * could miss it), then `ingress.linkRecording`. A file cut by the cap finalizes before its call
 * ends: its link waits for the tap's `end` of that call (CLOSED, pendingLink).
 *
 * No timer: every bound below is checked on the next event.
 */

import { join, resolve } from "node:path"
import type { DvRecordCallsConfigSchema } from "../../config.js"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import { CALL_LINK_END_KEEP_MS } from "../activity/ingress.js"
import type { CallRecordingLinker } from "../activity/ingress.js"
import type { RecordingDsdSourceConfig } from "../recordings/inventory.js"
import type {
	DvCallTap,
	DvCallTapSource,
	DvTapCallEnd,
	DvTapCallRef,
} from "../dv-tap/types.js"
import type { DvCallNameInfo } from "./names.js"
import { createDvCallRecorder } from "./recorder.js"
import type {
	DvCallRecorder,
	DvCallRecorderOptions,
	DvRecordingFinalized,
} from "./recorder.js"

type RecordCallsConfig = ReturnType<(typeof DvRecordCallsConfigSchema)["parse"]>

/** The catalogue label of the recorder's directory (its items carry their own decoder). */
export const DV_CALL_SOURCE_LABEL = "dv-calls"

/** `digitalVoice.recordCalls.dir`, or `<stateDir>/recordings/dv-calls`, absolute. */
export function dvCallRecordingDir(
	config: Pick<RecordCallsConfig, "dir">,
	stateDir: string,
): string {
	return resolve(config.dir ?? join(stateDir, "recordings", "dv-calls"))
}

/** The recorder's directory as one more dsd source of the catalogue (kind `dv-call`). */
export function dvCallRecordingSource(dir: string): RecordingDsdSourceConfig {
	return { decoderId: DV_CALL_SOURCE_LABEL, dir, kind: "dv-call" }
}

/**
 * The service's call tap, or null when this service has none (a core built without the tap):
 * the recorder then stays off, never half wired.
 */
export function dvCallTapSourceOf(service: object): DvCallTapSource | null {
	const add = (service as { addCallTap?: unknown }).addCallTap
	if (typeof add !== "function") return null
	return { addCallTap: tap => add.call(service, tap) as () => void }
}

/** What the decoder ids are read from (DecoderManager, structurally). */
export interface DvCallDecoderSource {
	getConfiguredDecoderConfigs(): readonly { id: string; type: string }[]
	getAllDecoders(): readonly { id: string; type: string }[]
}

/**
 * The decoders a recording can belong to: the configured and the active dsd-fme decoders,
 * scanner probes included, sorted and unique (the catalogue maps a file name's decoder field
 * back to one of them by an exact match only).
 */
export function dvCallDecoderIds(manager: DvCallDecoderSource): string[] {
	const ids = new Set<string>()
	for (const c of manager.getConfiguredDecoderConfigs())
		if (c.type === "dsd-fme") ids.add(c.id)
	for (const d of manager.getAllDecoders())
		if (d.type === "dsd-fme") ids.add(d.id)
	return [...ids].sort()
}

/**
 * Open calls the name book holds: 256, the oldest evicted past it. Two slots per decoder, so 128
 * two-slot decoders each with both slots busy; an entry is a few short strings.
 */
export const DV_CALL_INFO_MAX = 256

/** Name fields of a call: a talkgroup and a source, or a D-STAR UR and MY. */
export interface DvCallInfoBook {
	/** A decoder output: `call_start` and `call_end` feed the book, everything else is ignored. */
	noteOutput(decoderId: string, output: DecoderOutput): void
	lookup(ref: DvTapCallRef): DvCallNameInfo | null
	/** The recorder is done with the call. */
	forget(ref: Pick<DvTapCallRef, "decoderId" | "callId">): void
	size(): number
}

interface InfoEntry {
	info: DvCallNameInfo
	/** When the decoder's `call_end` was seen, or null while the call runs. */
	endedAt: number | null
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/** A non-negative integer id, as text; 0 (dsd-fme's placeholder) is unknown. */
function idText(value: unknown): string | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? String(value)
		: null
}

/** A D-STAR callsign field, trimmed; empty is unknown. */
function callsignText(value: unknown): string | null {
	if (typeof value !== "string") return null
	const t = value.trim()
	return t.length > 0 && t.length <= 16 ? t : null
}

/**
 * The name fields of a call event. D-STAR has no talkgroup (dsd-fme writes 0 / 0): its UR and MY
 * stand in, but only from a `call_start` (it carries `dstar` only once a checked header was
 * read) or a `call_end` whose `dstar` is not marked unverified.
 */
function infoOf(data: Record<string, unknown>): DvCallNameInfo | null {
	let talkgroup = idText(data["talkgroup"])
	let source = idText(data["source"])
	const dstar = record(data["dstar"])
	if (talkgroup === null && source === null && dstar !== null) {
		if (dstar["verified"] !== false) {
			talkgroup = callsignText(dstar["ur"])
			source = callsignText(dstar["my"])
		}
	}
	if (talkgroup === null && source === null) return null
	return { callType: null, talkgroup, source }
}

export function createDvCallInfoBook(
	now: () => number = Date.now,
): DvCallInfoBook {
	const book = new Map<string, InfoEntry>()
	const keyOf = (decoderId: string, callId: string) =>
		`${decoderId}\u0000${callId}`

	/** Ended entries the recorder never asked for (no file) go after CALL_LINK_END_KEEP_MS. */
	function expire(at: number): void {
		for (const [k, e] of book)
			if (e.endedAt !== null && at - e.endedAt > CALL_LINK_END_KEEP_MS)
				book.delete(k)
	}

	return {
		noteOutput(decoderId, output) {
			if (output.type !== "call_start" && output.type !== "call_end") return
			const data = record(output.data)
			const callId = data?.["callId"]
			if (data === null || typeof callId !== "string" || callId.length === 0)
				return
			const flags = record(data["flags"])
			// A late file notice is no call event of its own.
			if (flags?.["wavFileUpdate"] === true) return
			const at = now()
			const k = keyOf(decoderId, callId)
			const prev = book.get(k)
			const info = infoOf(data) ?? prev?.info ?? null
			const endedAt = output.type === "call_end" ? at : null
			if (output.type === "call_end") expire(at)
			if (info === null) {
				if (prev !== undefined && endedAt !== null) prev.endedAt = endedAt
				return
			}
			book.delete(k)
			book.set(k, { info, endedAt })
			while (book.size > DV_CALL_INFO_MAX) {
				const oldest = book.keys().next()
				if (oldest.done === true) break
				book.delete(oldest.value)
			}
		},
		lookup(ref) {
			return book.get(keyOf(ref.decoderId, ref.callId))?.info ?? null
		},
		forget(ref) {
			book.delete(keyOf(ref.decoderId, ref.callId))
		},
		size: () => book.size,
	}
}

/** Decoder outputs (DecoderManager's `decoder:output`, structurally). */
export interface DvCallOutputSource {
	on(
		event: "decoder:output",
		listener: (decoderId: string, output: DecoderOutput) => void,
	): unknown
	off(
		event: "decoder:output",
		listener: (decoderId: string, output: DecoderOutput) => void,
	): unknown
}

export interface DvCallRecorderWiringOptions {
	/** `digitalVoice.recordCalls`, parsed. */
	config: RecordCallsConfig
	stateDir: string
	/** The service's call tap (dvCallTapSourceOf); null: the recorder stays off. */
	tapSource: DvCallTapSource | null
	inventory: { touchCallRecordings?(decoderId?: string): Promise<void> }
	/** Links a file to its call's row (an Activity call recording linker). */
	ingress: Pick<CallRecordingLinker, "linkRecording"> &
		Partial<Pick<CallRecordingLinker, "noteOutput">>
	/** The decoder ids a file can belong to (dvCallDecoderIds). */
	decoderIds: () => readonly string[]
	/** Decoder outputs: the name book and the linker's end-seen record read them. */
	outputs: DvCallOutputSource | null
	/** True once setCallRecordingProtection has run (retention deletes only then). */
	protectionInstalled: () => boolean
	logger: Logger
	/** Test seams, passed to the recorder. */
	recorder?: Partial<
		Pick<DvCallRecorderOptions, "fs" | "prune" | "now" | "random">
	>
}

export interface DvCallRecorderWiring {
	start(): Promise<void>
	stop(): Promise<void>
	/** The recorder (counters), or null when it is off. */
	readonly recorder: DvCallRecorder | null
	readonly dir: string
	readonly book: DvCallInfoBook
	/** Files waiting for their call's tap `end` before they link (a cap cut). */
	pendingLinks(): number
	/** Files of a decoder not in decoderIds: kept, never linked. */
	unknownDecoder(): number
}

/**
 * Links a file cut by the cap waits for: at most one per open call, so DV_CALL_INFO_MAX bounds
 * it as well (the oldest dropped past it).
 */
const PENDING_LINKS_MAX = DV_CALL_INFO_MAX

export function createDvCallRecorderWiring(
	options: DvCallRecorderWiringOptions,
): DvCallRecorderWiring {
	const log = createComponentLogger(options.logger, "DvCallRecorderWiring")
	const dir = dvCallRecordingDir(options.config, options.stateDir)
	const book = createDvCallInfoBook(options.recorder?.now ?? Date.now)
	const refKey = (r: DvTapCallRef) =>
		`${r.decoderId}\u0000${r.callId}\u0000${r.slot ?? 0}`
	/** Files finalized before their call's end (cap cut), keyed by the call's ref. */
	const waiting = new Map<string, DvRecordingFinalized>()

	const linking = new Set<Promise<void>>()
	let unknownDecoder = 0

	function known(decoderId: string): boolean {
		try {
			return options.decoderIds().includes(decoderId)
		} catch {
			return false
		}
	}

	function link(r: DvRecordingFinalized): void {
		book.forget(r)
		// The catalogue names a file's decoder only among these ids; any other file stays unlinked.
		if (!known(r.decoderId)) {
			unknownDecoder++
			return
		}
		const key = `dsd~${r.fileName}`
		const step = (async () => {
			try {
				// The catalogue lists the file first, so the link sweep never sees it missing.
				await options.inventory.touchCallRecordings?.(r.decoderId)
			} catch {
				// A failed refresh is retried by the catalogue's own sweep; the link still goes.
			}
			try {
				options.ingress.linkRecording(r.decoderId, r.callId, key, r.durationMs)
			} catch {
				// The linker never throws; a foreign one must not reach the recorder.
			}
		})()
		linking.add(step)
		void step.finally(() => linking.delete(step))
	}

	function finalized(r: DvRecordingFinalized): void {
		if (r.reason !== null) {
			link(r)
			return
		}
		const k = refKey(r)
		waiting.delete(k)
		waiting.set(k, r)
		while (waiting.size > PENDING_LINKS_MAX) {
			const oldest = waiting.keys().next()
			if (oldest.done === true) break
			waiting.delete(oldest.value)
		}
	}

	function ended(e: DvTapCallEnd): void {
		const k = refKey(e)
		const r = waiting.get(k)
		if (r !== undefined) {
			waiting.delete(k)
			link(r)
		}
	}

	const source = options.tapSource
	/** The service's tap, seen through: the recorder's own tap plus the end a cap cut waits for. */
	const observed: DvCallTapSource | null =
		source === null
			? null
			: {
					addCallTap(tap: DvCallTap) {
						return source.addCallTap({
							start: e => tap.start(e),
							state: e => tap.state(e),
							pcm: e => tap.pcm(e),
							drop: e => tap.drop(e),
							end: e => {
								tap.end(e)
								ended(e)
							},
						})
					},
				}

	const s = options.config
	const recorder =
		observed === null || !s.enabled
			? null
			: createDvCallRecorder({
					settings: {
						enabled: s.enabled,
						dir,
						minVoiceMs: s.minVoiceMs,
						maxCallMs: s.maxCallMs,
						retentionBytes: s.retentionBytes,
						retentionDays: s.retentionDays,
					},
					source: observed,
					logger: options.logger,
					callInfo: ref => book.lookup(ref),
					onFinalized: finalized,
					protectionInstalled: options.protectionInstalled,
					...(options.recorder ?? {}),
				})

	const onOutput = (decoderId: string, output: DecoderOutput): void => {
		try {
			book.noteOutput(decoderId, output)
			options.ingress.noteOutput?.(decoderId, output)
		} catch {
			// Never into the decoder path.
		}
	}
	let listening = false

	return {
		async start() {
			if (recorder === null) {
				if (s.enabled && source === null)
					log.info("Call recording is off: the voice service has no call tap")
				return
			}
			if (!listening && options.outputs !== null) {
				options.outputs.on("decoder:output", onOutput)
				listening = true
			}
			await recorder.start()
		},
		async stop() {
			if (recorder !== null) await recorder.stop()
			if (listening && options.outputs !== null) {
				options.outputs.off("decoder:output", onOutput)
				listening = false
			}
			// A cap cut whose call never ended before the stop: its end is the stop.
			for (const r of [...waiting.values()]) link(r)
			waiting.clear()
			while (linking.size > 0) await Promise.all([...linking])
		},
		recorder,
		dir,
		book,
		pendingLinks: () => waiting.size,
		unknownDecoder: () => unknownDecoder,
	}
}
