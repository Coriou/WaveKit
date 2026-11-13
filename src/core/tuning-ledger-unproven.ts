/**
 * One user-facing reason per source while its centre or sample rate is not proven by the tuning
 * ledger (GET /api/sources `tuningUnproven`, agent status `tuning`): the cause, a fixed message
 * and fix, when the cause began, and the refusals it caused since (snapshots the recorder refused,
 * snapshots classified on it). The ledger alone names doubts, missing sessions and missing frames;
 * the tuner controller adds why the core writes nothing (setBlockResolver). Re-evaluated on every
 * ledger change, controller state change and read, so a read never shows a cause that ended (a
 * refusal re-reads only while no period is open). Bounded: one entry per source the ledger knows.
 */
import {
	TUNING_DOUBT_REASON_PATTERN,
	TUNING_UNPROVEN_CAUSES,
	type SourceTuningUnproven,
	type TuningUnprovenCause,
} from "@wavekit/api-types"
import type {
	FieldState,
	GatedField,
	LedgerListener,
	TuningLedger,
} from "./tuning-ledger.js"

/** A cause code, or `doubt:<reason>` (SourceTuningUnproven.cause). */
export type UnprovenCause =
	| Exclude<TuningUnprovenCause, "doubt">
	| `doubt:${string}`

export interface UnprovenReading {
	cause: UnprovenCause
	fields: GatedField[]
}

/**
 * Why the core writes nothing for an unproven field (TunerController: `proof.blocked`), or null.
 * Only TUNING_UNPROVEN_CAUSES codes are taken; anything else reads as no block.
 */
export type UnprovenBlockResolver = (
	sourceId: string,
	field: GatedField,
) => string | null

export type RefusalKind = "recording" | "identification"

/** Gated fields in the order a reason is read from: the centre first. */
const FIELDS: readonly GatedField[] = ["frequency", "sampleRate"]
const DOUBT_REASON = new RegExp(TUNING_DOUBT_REASON_PATTERN)
const BLOCK_CAUSES: ReadonlySet<string> = new Set(
	TUNING_UNPROVEN_CAUSES.filter(
		c => c !== "doubt" && c !== "no-session" && c !== "no-receipt",
	),
)

/** The message and fix of each cause: fixed text, never a value from the receiver or a client. */
const TEXT: Readonly<
	Record<TuningUnprovenCause, { message: string; fix: string }>
> = Object.freeze({
	"plain-resume": {
		message:
			"Tuning not proven since a resume without restore: recordings and identification are paused until the tuning is set or restored",
		fix: "Set the tuning (POST /api/tuner/:sourceId/tune), or pause the source and resume it with restoreTuning: true",
	},
	"relay-attached": {
		message:
			"Tuning not proven: a relay client is attached and sent no tuning on this connection, and the core does not write over it; recordings and identification are paused",
		fix: "Tune from the relay client, or detach it (the core then writes its held tuning)",
	},
	"external-control": {
		message:
			"Tuning not proven: the tuner is under external control and the core writes nothing; recordings and identification are paused",
		fix: "Tune from the controlling client, or return the tuner to the core",
	},
	"scanner-lease": {
		message:
			"Tuning not proven: a scanner job holds the tuner and its hop has not settled; recordings and identification of its signals are paused",
		fix: "Usually clears by itself once the job's hop settles; otherwise pause or stop the job",
	},
	"lost-ownership": {
		message:
			"Tuning not proven: another core owns the receiver and this one writes nothing; recordings and identification are paused",
		fix: "Stop the other core, or point this source at a receiver of its own",
	},
	"declared-write-off": {
		message:
			"Tuning not proven: the configured tuning is not written on connect (tuner.writeDeclaredTuningOnConnect is false) and nothing was set since; recordings and identification are paused",
		fix: "Set the tuning (POST /api/tuner/:sourceId/tune), or set tuner.writeDeclaredTuningOnConnect to true",
	},
	"reset-policy": {
		message:
			"Tuning not proven: with tuner.reconnectPolicy reset only tuning set on this connection is written, and none was; recordings and identification are paused",
		fix: "Set the tuning (POST /api/tuner/:sourceId/tune)",
	},
	doubt: {
		message:
			"Tuning not proven: the receiver may have moved without a frame from the core; recordings and identification are paused until the tuning is written again",
		fix: "Usually clears by itself within a second; if it keeps coming back, something else retunes the receiver (a client past the core's relay)",
	},
	"no-session": {
		message:
			"Tuning not proven: the receiver is not connected; recordings and identification are paused",
		fix: "Check the source's connection (verdict on GET /api/sources)",
	},
	"no-receipt": {
		message:
			"Tuning not proven: no tuning frame reached the receiver on this connection yet; recordings and identification are paused",
		fix: "Set the tuning (POST /api/tuner/:sourceId/tune)",
	},
})

interface Entry {
	cause: UnprovenCause
	fields: GatedField[]
	sinceMs: number
	recording: number
	identification: number
}

/** `doubt:<reason>` with a fixed-code reason; anything else is `doubt:other`. */
function doubtCause(reason: string): UnprovenCause {
	return `doubt:${DOUBT_REASON.test(reason) ? reason : "other"}`
}

/** The ledger's own reason a field is unverified, or null when it is proven, settling or queued. */
function ledgerCause(fs: FieldState): UnprovenCause | null {
	// A standing hold reads unverified whatever the receipts say (TuningLedger.setHold).
	if (fs.hold) return doubtCause(fs.hold.reason)
	if (fs.state !== "unverified" || fs.queued !== null) return null
	if (fs.doubtReason !== undefined) return doubtCause(fs.doubtReason)
	if (fs.reason === "no-session" || fs.reason === "session-ended")
		return "no-session"
	return "no-receipt"
}

const CAUSE_CODES: ReadonlySet<string> = new Set(TUNING_UNPROVEN_CAUSES)

/** The cause's code (TUNING_UNPROVEN_CAUSES): a doubt's reason dropped; unknown: `no-receipt`. */
export function causeCode(cause: string): TuningUnprovenCause {
	if (cause.startsWith("doubt:")) return "doubt"
	return CAUSE_CODES.has(cause) ? (cause as TuningUnprovenCause) : "no-receipt"
}

export class TuningUnprovenTracker {
	private blocked: UnprovenBlockResolver | null = null
	private readonly entries = new Map<string, Entry>()

	constructor(
		private readonly ledger: Pick<TuningLedger, "fieldState" | "subscribe">,
		private readonly now: () => number = Date.now,
	) {
		ledger.subscribe(this.onLedgerChange)
	}

	private readonly onLedgerChange: LedgerListener = sourceId => {
		this.refresh(sourceId)
	}

	/** The tuner controller's block reasons (null: the ledger's reasons only). */
	setBlockResolver(resolver: UnprovenBlockResolver | null): void {
		this.blocked = resolver
	}

	/** The source's reason now, or null while its centre and rate are proven or settling. */
	reading(sourceId: string): UnprovenReading | null {
		let states: Record<GatedField | "gain", FieldState>
		try {
			states = this.ledger.fieldState(sourceId)
		} catch {
			return null
		}
		// A source the ledger never saw (a recording, an audio source): nothing to say.
		if (states.frequency.reason === "unknown-source") return null
		let cause: UnprovenCause | null = null
		const fields: GatedField[] = []
		for (const field of FIELDS) {
			const own = ledgerCause(states[field])
			if (own === null) continue
			fields.push(field)
			if (cause !== null) continue
			let block: string | null = null
			try {
				block = this.blocked?.(sourceId, field) ?? null
			} catch {
				block = null
			}
			cause =
				block !== null && BLOCK_CAUSES.has(block)
					? (block as UnprovenCause)
					: own
		}
		return cause === null ? null : { cause, fields }
	}

	/**
	 * Re-reads the source: a new cause starts its period (since now, no refusals), the same one
	 * keeps it (its fields may change), none ends it.
	 */
	refresh(sourceId: string): void {
		const now = this.reading(sourceId)
		if (now === null) {
			this.entries.delete(sourceId)
			return
		}
		const entry = this.entries.get(sourceId)
		if (entry?.cause === now.cause) {
			entry.fields = now.fields
			return
		}
		this.entries.set(sourceId, {
			cause: now.cause,
			fields: now.fields,
			sinceMs: this.now(),
			recording: 0,
			identification: 0,
		})
	}

	/**
	 * A refusal the unproven tuning caused (a snapshot the recorder refused `refused:tuning`, a
	 * snapshot classified on it, spectral evidence only); counted only while a cause stands. Cheap on the track path: one
	 * map read and an add once the period is known (its changes come with ledger and state events).
	 */
	noteRefusal(sourceId: string, kind: RefusalKind): void {
		let entry = this.entries.get(sourceId)
		if (!entry) {
			this.refresh(sourceId)
			entry = this.entries.get(sourceId)
			if (!entry) return
		}
		entry[kind] += 1
	}

	/** GET /api/sources `tuningUnproven`, or null (proven, settling, or not a ledger source). */
	view(sourceId: string): SourceTuningUnproven | null {
		this.refresh(sourceId)
		const entry = this.entries.get(sourceId)
		if (!entry) return null
		const text = TEXT[causeCode(entry.cause)]
		return {
			code: "tuning-unproven",
			cause: entry.cause,
			fields: [...entry.fields],
			message: text.message,
			fix: text.fix,
			since: new Date(entry.sinceMs).toISOString(),
			refusals: {
				recording: entry.recording,
				identification: entry.identification,
			},
		}
	}
}
