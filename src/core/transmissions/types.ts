/**
 * Transmission identity (txId): the shapes of the in-memory registry (registry.ts). One txId names
 * one transmission on one channel or lane, minted when it is detected and copied, never minted
 * again, into everything derived from it. Additive everywhere: an artefact without one stays valid.
 */
import type { RecordingTone } from "@wavekit/api-types"

/** `tx_` and a 26-character Crockford base32 ULID (ids.ts). */
export const TX_ID = /^tx_[0-9A-HJKMNP-TV-Z]{26}$/

export function isTxId(value: unknown): value is string {
	return typeof value === "string" && TX_ID.test(value)
}

/** Who claims: the live demodulator, a scanner observation, a digital-voice call. */
export type TxOrigin = "live-demod" | "scanner-observation" | "dv-call"
export type TxKind = "voice-analog" | "voice-digital"

/** The artefact kinds an id is indexed under: recording key, Activity event, observation, call. */
export type TxAliasKind = "rec" | "evt" | "obs" | "call"
export type TxAlias = `${TxAliasKind}:${string}`

export interface TxClaim {
	origin: TxOrigin
	kind: TxKind
	sourceId: string | null
	/** Analog only: the channel centre and half width (Hz). */
	hz?: number
	halfWidthHz?: number
	/** Scanner only: the spectrum epoch and stream of the track (TrackSnapshot). */
	epoch?: number
	stream?: number
	sample?: number
	/** Digital voice only: the decoder key, the TDMA lane (0: none) and the decoder run. */
	dvKey?: string
	lane?: 0 | 1 | 2
	run?: string
	/** A rollover successor: the predecessor's txId (joined while it is held, no geometry). */
	continues?: string
	/** A producer split (a new over the producer itself detected): never joins this txId. */
	splitFrom?: string
	atMs: number
	/** The claimant artefact's own alias (indexed under the resulting id). */
	alias: TxAlias
}

export interface TxClaimResult {
	txId: string
	claimant: number
}

/** Why a claimant ended. `stopped`: an operator stop (closes `ended`, never complete). */
export type TxEndReason =
	| "ended"
	| "stopped"
	| "max-duration"
	| "hop"
	| "retune"
	| "source-lost"
	| "decoder-restart"

export type TxCloseReason =
	| "ended"
	| "hop"
	| "retune"
	| "source-lost"
	| "max-duration"
	| "restart"
	| "decoder-restart"
	| "evicted"

/** What kept a transmission from being recorded (the first one noted wins). */
export type TxRefusalCode =
	| "refused:slots"
	| "refused:cpu"
	| "encrypted"
	| "unclean"
	| "noise"

export interface TxLiveTone {
	ctcssHz: number | null
	dcs: { code: string; polarity: "normal" | "inverted" } | null
}

export interface TxIdentity {
	protocol: string | null
	talkgroup: string | null
	source: string | null
}

export type TxState = "open" | "hang" | "closed"

/** A transmission's tone as read (derived, never stored: tone.ts). */
export interface TxToneReading {
	state: "heard" | "none" | "not-measured"
	ctcssHz: number | null
	dcs: string | null
	/** Who measured the value read: the recorder's file or the live demodulator. */
	source: "recorder" | "live-demod" | null
	/** Two different tones were heard: the recorder's is read. */
	ambiguous: boolean
	/** The live demodulator reported (it alone measures DCS). */
	dcsChecked: boolean
}

export interface TxView {
	id: string
	groupId: string
	kind: TxKind
	origin: TxOrigin
	protocol: string | null
	sourceId: string | null
	hz: number | null
	state: TxState
	startedAtMs: number
	endedAtMs: number | null
	closedAtMs: number | null
	close: TxCloseReason | null
	/** Closed `ended` with no claimant still active. */
	complete: boolean
	/** Opened when a claim matched two or more transmissions (never merged). */
	ambiguous: boolean
	refusal: TxRefusalCode | null
	liveTone: TxLiveTone | null
	identity: TxIdentity | null
	aliases: Readonly<Record<TxAliasKind, readonly string[]>>
	/** Derived: no recording alias and a refusal noted. */
	noAudioReason: TxRefusalCode | null
	/** Derived from the live tone and the recorder tones given to the read. */
	tone: TxToneReading
}

export interface TxReadOptions {
	/** The facts tone of each of the transmission's recordings (recording-facts.ts). */
	recorderTones?: readonly (RecordingTone | null | undefined)[]
}

export interface TxCounters {
	/** Claims refused at a per-source or total open cap (the artefact carries no id). */
	refusedCap: number
	/** Claims and ends of a retired decoder run. */
	retiredRun: number
	/** Writes to a closed or unknown transmission or claimant (ignored). */
	lateWrites: number
	/** Aliases not indexed past a per-entry, per-alias or global cap. */
	aliasOverflow: number
	/** Closed transmissions dropped from a ring (overflow or TTL). */
	evicted: number
	/** Recording files started while their transmission was already closed (no id). */
	fileNoTx: number
	/** Transmissions opened by a claim matching two or more. */
	ambiguous: number
}

/** The scanner analog chain's view of the registry (an optional, injected port). */
export interface TxScannerPort {
	claim(c: TxClaim): TxClaimResult | null
	end(claimant: number, atMs: number, reason?: TxEndReason): void
	attach(txId: string, alias: TxAlias): boolean
	/** The txId of an alias or id while that transmission is open (or held); null once closed. */
	openTxOf(ref: string): string | null
	noteRefusal(ref: string, code: TxRefusalCode): void
	noteFileWithoutTx(): void
}

/** The live demodulator's view of the registry (AnalogTransmissionTracker `transmissions`). */
export interface TxLiveDemodPort {
	claim(c: TxClaim): TxClaimResult | null
	end(claimant: number, atMs: number, reason?: TxEndReason): void
	attach(txId: string, alias: TxAlias): boolean
	noteLiveTone(claimant: number, tone: TxLiveTone): void
}

/** A digital-voice decoder's view of the registry (dsd-fme options `transmissions`). */
export interface TxDvPort {
	claim(c: TxClaim): TxClaimResult | null
	end(claimant: number, atMs: number, reason?: TxEndReason): void
	noteIdentity(claimant: number, identity: TxIdentity): void
	noteRefusal(ref: string, code: TxRefusalCode): void
	retireRun(run: string, atMs?: number): void
}
