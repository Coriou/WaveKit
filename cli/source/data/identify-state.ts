import type { SpectrumFrameEventData } from "@wavekit/api-types"
import type { ScanDiscovery, ScanJob, ScanValues } from "./scanner-guards.js"
import type { ScanState } from "./scan-state.js"
import type { SourceRow } from "./types.js"

export const IDENTIFY_FRESH_MS = 15_000
export interface IdentifyRequest {
	sourceId: string
	target: { frequencyHz: number; bandwidthHz: number }
	timeoutMs: 15000
	exhaustive: false
	record: false
}
export interface IdentifyContext {
	sourceId: string | null
	discoveryId: string | null
	/** Opaque identity of the visible Scan detail/context, including help state. */
	key: string
	active: boolean
	columns: number
	rows: number
	contentRows: number
}
export interface IdentifyEvidence {
	destination: string | null
	session: number
	revision: number
	context: IdentifyContext
	connected: boolean
	authBlocked: boolean
	source: SourceRow | null
	sourceAt: number | null
	sourceDirty: boolean
	scan: ScanState
	frame: { frame: SpectrumFrameEventData; receivedAt: number } | null
	detail: ScanDiscovery | null
	detailAt: number | null
	detailDirty: boolean
	status: ScanValues["status"] | null
	statusAt: number | null
	statusDirty: boolean
	profileGeneration: number
}
export interface IdentifyConsentLayout {
	fits: boolean
	lines: string[]
	reason: string | null
	columns: number
	rows: number
}
export interface IdentifyPrompt {
	token: number
	destination: string
	session: number
	revision: number
	profileGeneration: number
	contextKey: string
	discoveryId: string
	request: IdentifyRequest
	frameKey: string
	layout: IdentifyConsentLayout
}
export interface IdentifySafeDetails {
	reason?:
		| "held"
		| "relay"
		| "holder-starting"
		| "releasing"
		| "recovery-pending"
	holderJobId?: string
	window?: { startHz: number; endHz: number }
	issues?: Array<{ code: string; severity: "error" | "warning" }>
}
export interface IdentifyRefusedOutcome {
	kind: "refused"
	status: number
	code: string
	details?: IdentifySafeDetails
}
export interface IdentifyUnresolvedOutcome {
	kind: "unresolved"
	status: number | null
	acceptedResponse: boolean
	code?: string
	details?: IdentifySafeDetails
}
export type IdentifyOutcome =
	| { kind: "accepted"; status: 201; job: ScanJob }
	| IdentifyRefusedOutcome
	| IdentifyUnresolvedOutcome
	| { kind: "unsent"; status: null; reason: string }
export interface IdentifyReceipt {
	phase:
		| "preparing"
		| "possibly-sent"
		| "unsent"
		| "refused"
		| "unresolved"
		| "known"
		| "terminal-confirmed"
	destination: string
	session: number
	request: IdentifyRequest
	status: number | null
	code?: string
	details?: IdentifySafeDetails
	acceptedResponse?: boolean
	jobId: string | null
	job: ScanJob | null
	error: string | null
	terminalAt: number | null
	readGeneration: number
}
export interface IdentifyReadiness {
	ready: boolean
	reason: string | null
	request: IdentifyRequest | null
	layout: IdentifyConsentLayout | null
}
export interface IdentifySnapshot {
	prompt: IdentifyPrompt | null
	receipt: IdentifyReceipt | null
	readiness: IdentifyReadiness
	inspection: boolean
}

const fresh = (at: number | null, now: number) =>
	at !== null &&
	Number.isFinite(at) &&
	Number.isFinite(now) &&
	now >= at &&
	now - at <= IDENTIFY_FRESH_MS

/** ASCII and reversible, including whitespace, backslashes and lone UTF-16 surrogates. */
export function identifySourceIdentity(sourceId: string): string {
	let value = ""
	for (let i = 0; i < sourceId.length; i++) {
		const code = sourceId.charCodeAt(i)
		value +=
			code === 92
				? "\\\\"
				: code >= 32 && code <= 126
					? sourceId[i]
					: `\\u${code.toString(16).padStart(4, "0")}`
		// No unbounded output allocation for identities that cannot fit.
		if (value.length > 512) return value
	}
	return value
}
export function identifyConsentLayout(
	request: IdentifyRequest,
	context: IdentifyContext,
): IdentifyConsentLayout {
	const identity = identifySourceIdentity(request.sourceId)
	const width = Math.floor(context.columns) - 3
	const denied = (): IdentifyConsentLayout => ({
		fits: false,
		lines: [],
		reason: "Confirmation cannot fit; widen terminal",
		columns: context.columns,
		rows: context.rows,
	})
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(context.rows) ||
		!Number.isInteger(context.columns) ||
		!Number.isInteger(context.rows) ||
		context.columns < 60 ||
		context.rows < 16 ||
		identity.length > 512 ||
		!Number.isInteger(context.contentRows) ||
		context.contentRows <= 0
	)
		return denied()
	const fields = [
		"Identify this frequency",
		`Source: ${identity}`,
		`Frequency: ${String(request.target.frequencyHz)} Hz`,
		`Width: ${String(request.target.bandwidthHz)} Hz`,
		"Wait up to 15s for signal; trials may take longer.",
		"May preempt scanner probes.",
		"Updates scanner discoveries and observations.",
		"No trial recordings; other scanner activity may record.",
	]
	const lines: string[] = []
	for (const field of fields)
		for (let i = 0; i < field.length; i += width)
			lines.push(field.slice(i, i + width))
	if (lines.length > Math.min(12, context.contentRows)) return denied()
	return {
		fits: true,
		lines,
		reason: null,
		columns: context.columns,
		rows: context.rows,
	}
}
export function identifyFrameKey(frame: SpectrumFrameEventData): string {
	return JSON.stringify([
		frame.sourceId,
		frame.profile,
		frame.epoch,
		frame.startHz,
		frame.binHz,
		frame.binCount,
		frame.sampleRateHz,
		frame.nativeBinHz,
		frame.centerHz,
		frame.tuningTrust,
	])
}
export function identifyReceiptCanPrepare(
	receipt: IdentifyReceipt | null,
	destination: string | null,
	session: number,
	now: number,
): boolean {
	if (!receipt || receipt.phase === "unsent" || receipt.phase === "refused")
		return true
	return (
		receipt.phase === "terminal-confirmed" &&
		receipt.destination === destination &&
		receipt.session === session &&
		fresh(receipt.terminalAt, now)
	)
}
export function identifyReadiness(
	e: IdentifyEvidence,
	receipt: IdentifyReceipt | null,
	now: number,
): IdentifyReadiness {
	const deny = (reason: string): IdentifyReadiness => ({
		ready: false,
		reason,
		request: null,
		layout: null,
	})
	const c = e.context
	if (!c.active || !c.sourceId || !c.discoveryId)
		return deny("Open a discovery detail to identify")
	if (!e.destination || !e.connected || e.authBlocked)
		return deny("API connection unavailable")
	if (!identifyReceiptCanPrepare(receipt, e.destination, e.session, now))
		return deny(
			receipt?.phase === "unresolved"
				? "Submission outcome unknown; inspection only for this session"
				: "Inspect the previous identify receipt",
		)
	const d = e.detail
	if (
		e.detailDirty ||
		!fresh(e.detailAt, now) ||
		!d ||
		d.id !== c.discoveryId ||
		!d.sourceIds.includes(c.sourceId)
	)
		return deny("Reinspect a fresh discovery detail")
	if (d.operator?.lockout === true) return deny("Discovery is locked out")
	if (d.tuningTrust === "unverified")
		return deny("Discovery tuning is unverified")
	if (
		!Number.isFinite(d.frequencyHz) ||
		d.frequencyHz <= 0 ||
		!Number.isFinite(d.bandwidthHz) ||
		d.bandwidthHz <= 0 ||
		d.bandwidthHz > 1_000_000
	)
		return deny("Discovery frequency or width is invalid")
	const source = e.source
	if (
		e.sourceDirty ||
		!fresh(e.sourceAt, now) ||
		!source ||
		source.id !== c.sourceId ||
		!source.connected ||
		source.activityUnrecognised ||
		source.activity?.state !== "streaming"
	)
		return deny("Fresh streaming source required")
	if (source.caps.kind !== "iq" || source.caps.format !== "U8_IQ")
		return deny("Identify requires live U8 IQ")
	const status = e.status
	if (e.statusDirty || !fresh(e.statusAt, now) || !status?.enabled)
		return deny("Fresh enabled scanner status required")
	const engine = status.engines.find(x => x.sourceId === c.sourceId)
	if (!engine || engine.state === "error" || engine.state === "stopped")
		return deny("Scanner engine is unavailable")
	const p = e.scan.profile
	const row = e.frame
	if (
		e.scan.sourceId !== c.sourceId ||
		e.scan.phase !== "waiting" ||
		!p ||
		p.selection !== "source" ||
		p.sourceId !== c.sourceId ||
		!p.profile ||
		p.outcome === "removed" ||
		p.outcome === "rejected" ||
		!row ||
		!fresh(row.receivedAt, now)
	)
		return deny("Fresh admitted spectrum required")
	const f = row.frame
	if (
		f.sourceId !== c.sourceId ||
		f.profile !== p.profile.key ||
		f.tuningTrust === "unverified" ||
		!Number.isFinite(source.caps.centerFreq) ||
		!Number.isFinite(source.caps.sampleRate) ||
		source.caps.sampleRate <= 0 ||
		f.centerHz !== source.caps.centerFreq ||
		f.sampleRateHz !== source.caps.sampleRate
	)
		return deny("Spectrum and source caps do not match")
	if (
		Math.abs(d.frequencyHz - f.centerHz) + d.bandwidthHz / 2 >
		(f.sampleRateHz * 0.8) / 2
	)
		return deny("Full discovery width is outside the usable window")
	const request: IdentifyRequest = {
		sourceId: c.sourceId,
		target: { frequencyHz: d.frequencyHz, bandwidthHz: d.bandwidthHz },
		timeoutMs: 15000,
		exhaustive: false,
		record: false,
	}
	const layout = identifyConsentLayout(request, c)
	return { ready: layout.fits, reason: layout.reason, request, layout }
}
/** Runtime checks this against synchronous evidence at y and again after credentials. */
export function identifyPromptMatches(
	prompt: IdentifyPrompt,
	e: IdentifyEvidence,
	receipt: IdentifyReceipt | null,
	now: number,
): boolean {
	// A preparing receipt is the token owner's latch, not a previous operation.
	const readiness = identifyReadiness(
		e,
		receipt?.phase === "preparing" ? null : receipt,
		now,
	)
	return (
		readiness.ready &&
		prompt.destination === e.destination &&
		prompt.session === e.session &&
		prompt.revision === e.revision &&
		prompt.profileGeneration === e.profileGeneration &&
		prompt.contextKey === e.context.key &&
		prompt.discoveryId === e.context.discoveryId &&
		prompt.layout.columns === e.context.columns &&
		prompt.layout.rows === e.context.rows &&
		JSON.stringify(prompt.layout.lines) ===
			JSON.stringify(readiness.layout?.lines) &&
		JSON.stringify(prompt.request) === JSON.stringify(readiness.request) &&
		e.frame !== null &&
		prompt.frameKey === identifyFrameKey(e.frame.frame)
	)
}
export function identifyReceiptOutcome(
	receipt: IdentifyReceipt,
	outcome: IdentifyOutcome,
): IdentifyReceipt {
	if (receipt.phase !== "preparing" && receipt.phase !== "possibly-sent")
		return receipt
	if (outcome.kind === "accepted")
		return {
			...receipt,
			phase: "known",
			status: 201,
			jobId: outcome.job.id,
			job: outcome.job,
			error: null,
			terminalAt: null,
		}
	if (outcome.kind === "unsent")
		return {
			...receipt,
			phase: "unsent",
			status: null,
			error: "Identify was not sent",
			terminalAt: null,
		}
	return {
		...receipt,
		phase: outcome.kind,
		status: outcome.status,
		...(outcome.code ? { code: outcome.code } : {}),
		...(outcome.details ? { details: outcome.details } : {}),
		...(outcome.kind === "unresolved"
			? { acceptedResponse: outcome.acceptedResponse }
			: {}),
		error:
			outcome.kind === "refused"
				? "Identify refused; reinspect before a new confirmation"
				: "Submission outcome unknown; inspection only for this session",
		terminalAt: null,
	}
}
export interface IdentifyReceiptReadContext {
	destination: string | null
	session: number
	readGeneration: number
	now: number
}
/** Call only for the independent exact-ID direct GET, never lists, WS or POST. */
export function identifyReceiptRead(
	receipt: IdentifyReceipt,
	job: ScanJob | null,
	error: string | null,
	c: IdentifyReceiptReadContext,
): IdentifyReceipt {
	if (
		!receipt.jobId ||
		(receipt.phase !== "known" && receipt.phase !== "terminal-confirmed") ||
		receipt.destination !== c.destination ||
		receipt.session !== c.session ||
		receipt.readGeneration !== c.readGeneration
	)
		return receipt
	const valid =
		job &&
		job.id === receipt.jobId &&
		job.spec.sourceId === receipt.request.sourceId &&
		job.spec.kind === "identify" &&
		job.spec.mode === "in-window"
	if (error || !valid)
		return {
			...receipt,
			phase: "known",
			terminalAt: null,
			error: error
				? "Identify receipt unavailable"
				: "Invalid identify receipt",
		}
	const terminal =
		job.state === "completed" ||
		job.state === "cancelled" ||
		job.state === "failed"
	return {
		...receipt,
		phase: terminal ? "terminal-confirmed" : "known",
		job,
		error: null,
		terminalAt: terminal ? c.now : null,
	}
}
/** Reconnect preserves attribution but revokes all terminal permission and old reads. */
export function identifyReceiptReconnect(
	receipt: IdentifyReceipt,
	session: number,
): IdentifyReceipt {
	return {
		...receipt,
		session,
		readGeneration: receipt.readGeneration + 1,
		terminalAt: null,
		phase: receipt.phase === "terminal-confirmed" ? "known" : receipt.phase,
	}
}
