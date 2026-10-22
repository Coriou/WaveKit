import {
	SCANNER_PROOF_PROTOCOL_LABEL,
	SCANNER_PROOF_SUMMARY_MAX_CHARS,
	SCANNER_PROOF_TRIED_MAX,
} from "@wavekit/api-types"
import type { ScannerProbeDecoderType } from "@wavekit/api-types"
import { z } from "zod"
import {
	MAX_IDENTITY_VALUE_LENGTH,
	decodableProtocol,
	identityFitsProtocol,
	knownProtocol,
	proofFacts,
} from "./classify/label-from-evidence.js"
import type { ProofFacts } from "./classify/label-from-evidence.js"
import type {
	ProofInput,
	ProofTrialInput,
} from "./scanner-redesign-contract.js"
import type {
	Identity,
	ScannerEvidenceLevel,
	ScannerProof,
	ScannerProofKind,
	ScannerProtocol,
} from "./types.js"

const RAN = new Set<string>([
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"heard",
	"data-like",
	"carrier-only",
])

const PROBES = new Set<string>(["direwolf", "dsd-fme", "multimon-ng", "rtl433"])

const RANK: Readonly<Record<ScannerProofKind, number>> = {
	decoded: 5,
	"analog-tone": 4,
	"analog-voice": 3,
	"digital-undecoded": 2,
	"carrier-only": 1,
}

type BareProof = Omit<ScannerProof, "summary">

function isAnalogTrial(decoder: unknown): boolean {
	return decoder === "analog-demod" || decoder === "live-audio"
}

function triedOf(trials: readonly ProofTrialInput[]): ScannerProtocol[] {
	const ranked: { protocol: ScannerProtocol; order: number; index: number }[] =
		[]
	for (let index = 0; index < trials.length; index++) {
		try {
			const row = trials[index]
			if (row === undefined) continue
			const protocol = row.protocol
			const outcome = row.outcome
			const order = row.order
			if (!knownProtocol(protocol) || protocol === "unknown") continue
			if (typeof outcome !== "string" || !RAN.has(outcome)) continue
			if (typeof order !== "number" || !Number.isFinite(order)) continue
			if (isAnalogTrial(row.decoder) && outcome !== "decoded") continue
			ranked.push({ protocol, order, index })
		} catch {
			// One throwing trial proves nothing about that trial.
		}
	}
	ranked.sort((a, b) => a.order - b.order || a.index - b.index)
	const out: ScannerProtocol[] = []
	for (const row of ranked) {
		if (out.includes(row.protocol)) continue
		out.push(row.protocol)
		if (out.length === SCANNER_PROOF_TRIED_MAX) break
	}
	return out
}

function unavailableOf(rows: readonly unknown[]): ScannerProbeDecoderType[] {
	const out: ScannerProbeDecoderType[] = []
	const seen = new Set<string>()
	for (const row of rows) {
		try {
			if (typeof row !== "string" || !PROBES.has(row) || seen.has(row)) continue
			seen.add(row)
			out.push(row as ScannerProbeDecoderType)
		} catch {
			// A throwing entry is not an unavailable decoder.
		}
	}
	out.sort()
	return out
}

function identityPart(identity: Identity): string {
	const value = identity.value
	switch (identity.kind) {
		case "dmr-cc":
		case "dpmr-cc":
			return `CC${value}`
		case "p25-nac":
			return `NAC ${value}`
		case "nxdn-ran":
			return `RAN ${value}`
		case "ysf-dgid":
			return `DG-ID ${value}`
		case "pocsag-capcode":
			return `capcode ${value}`
		case "ais-mmsi":
			return `MMSI ${value}`
		default:
			return value
	}
}

function dedupedLabels(protocols: readonly ScannerProtocol[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const protocol of protocols) {
		if (!knownProtocol(protocol)) continue
		const label = SCANNER_PROOF_PROTOCOL_LABEL[protocol]
		if (seen.has(label)) continue
		seen.add(label)
		out.push(label)
	}
	return out
}

function digitalSentence(
	labels: readonly string[],
	unavailable: readonly string[],
): string {
	// Frozen grammar: nothing tried reads the same whether or not the plan named
	// unavailable decoders.
	if (labels.length === 0) return "Digital, not decoded (no decoder available)"
	const parts: string[] = []
	if (labels.length > 0) parts.push(`tried ${labels.join(", ")}`)
	if (unavailable.length > 0)
		parts.push(`${unavailable.join(", ")} unavailable`)
	return `Digital, not decoded (${parts.join("; ")})`
}

function digitalSummary(
	tried: readonly ScannerProtocol[],
	unavailable: readonly ScannerProbeDecoderType[],
): string {
	const labels = dedupedLabels(tried)
	const missing = unavailableOf(unavailable)
	const full = digitalSentence(labels, missing)
	if (full.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return full
	for (let keep = labels.length - 1; keep >= 0; keep--) {
		const omitted = labels.length - keep
		const kept = labels.slice(0, keep)
		const triedText =
			kept.length === 0
				? `tried +${omitted} more`
				: `tried ${kept.join(", ")}, +${omitted} more`
		const parts = [triedText]
		if (missing.length > 0) parts.push(`${missing.join(", ")} unavailable`)
		const sentence = `Digital, not decoded (${parts.join("; ")})`
		if (sentence.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return sentence
	}
	return `Digital, not decoded (tried +${labels.length} more)`.slice(
		0,
		SCANNER_PROOF_SUMMARY_MAX_CHARS,
	)
}

function decodedSentence(
	head: string,
	identity: string | undefined,
	talk: string | undefined,
	encrypted: boolean,
): string {
	const parts: string[] = []
	if (identity !== undefined && identity.length > 0) parts.push(identity)
	if (talk !== undefined) parts.push(`TG ${talk}`)
	if (encrypted) parts.push("encrypted")
	return parts.length === 0 ? head : `${head} (${parts.join(", ")})`
}

/** Longest talkgroup body that keeps identity and "encrypted" inside the cap. */
function shortenTalk(
	head: string,
	identity: string | undefined,
	talk: string,
	encrypted: boolean,
): string | undefined {
	const room =
		SCANNER_PROOF_SUMMARY_MAX_CHARS -
		decodedSentence(head, identity, "", encrypted).length
	if (room <= 0) return undefined
	const body = talk.slice(0, Math.min(talk.length, room))
	if (body.length === 0) return undefined
	const text = decodedSentence(head, identity, body, encrypted)
	return text.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS ? text : undefined
}

/** Longest identity text that keeps "encrypted" inside the cap. Talkgroup is already gone. */
function shortenIdentity(
	head: string,
	identity: string,
	encrypted: boolean,
): string | undefined {
	const suffix = encrypted ? ", encrypted)" : ")"
	const room =
		SCANNER_PROOF_SUMMARY_MAX_CHARS - `${head} (`.length - suffix.length
	if (room <= 0) return undefined
	const body = identity.slice(0, Math.min(identity.length, room))
	if (body.length === 0) return undefined
	return `${head} (${body}${suffix}`
}

function decodedSummary(proof: BareProof): string {
	const label = knownProtocol(proof.protocol)
		? SCANNER_PROOF_PROTOCOL_LABEL[proof.protocol]
		: "Unknown"
	const head = `${label} decoded`
	const encrypted = proof.encrypted === true
	const identity =
		proof.identity !== undefined ? identityPart(proof.identity) : undefined
	const talk =
		proof.talkgroup !== undefined && proof.talkgroup.length > 0
			? proof.talkgroup
			: undefined
	const full = decodedSentence(head, identity, talk, encrypted)
	if (full.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return full
	if (talk !== undefined) {
		const shortened = shortenTalk(head, identity, talk, encrypted)
		if (shortened !== undefined) return shortened
	}
	const withoutTalk = decodedSentence(head, identity, undefined, encrypted)
	if (withoutTalk.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return withoutTalk
	if (identity !== undefined && identity.length > 0) {
		const shortened = shortenIdentity(head, identity, encrypted)
		if (shortened !== undefined) return shortened
	}
	const marker = encrypted ? `${head} (encrypted)` : head
	return marker.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS
		? marker
		: marker.slice(0, SCANNER_PROOF_SUMMARY_MAX_CHARS)
}

function toneBits(proof: BareProof): string[] {
	const bits: string[] = []
	const tone = proof.tone
	if (tone === undefined) return bits
	const hz = tone.ctcssHz
	if (typeof hz === "number" && Number.isFinite(hz) && hz > 0)
		bits.push(`CTCSS ${hz.toFixed(1)}`)
	const dcs = tone.dcs
	if (dcs !== null && dcs !== undefined && typeof dcs.code === "string") {
		const mark = dcs.polarity === "inverted" ? "I" : "N"
		bits.push(`DCS ${dcs.code}${mark}`)
	}
	return bits
}

function analogSummary(proof: BareProof): string {
	const label = knownProtocol(proof.protocol)
		? SCANNER_PROOF_PROTOCOL_LABEL[proof.protocol]
		: "Analog"
	if (proof.kind === "analog-voice") return `${label} voice`
	const voice = proof.voice === true ? " voice" : ""
	const bits = toneBits(proof)
	return bits.length === 0
		? `${label}${voice}`
		: `${label}${voice}, ${bits.join(", ")}`
}

function summaryOf(proof: BareProof): string {
	switch (proof.kind) {
		case "decoded":
			return decodedSummary(proof)
		case "analog-tone":
		case "analog-voice":
			return analogSummary(proof)
		case "digital-undecoded":
			return digitalSummary(proof.tried, proof.unavailable)
		case "carrier-only":
			return "Carrier only"
		default:
			return ""
	}
}

/** Fixed English summary, at most 160 characters. A throwing proof yields an empty string. */
export function proofSummary(proof: BareProof): string {
	try {
		const text = summaryOf(proof)
		return text.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS
			? text
			: text.slice(0, SCANNER_PROOF_SUMMARY_MAX_CHARS)
	} catch {
		return ""
	}
}

/**
 * Proof of one observation. Null unless the evidence names a decoded identity,
 * an analog tone or voice under known trust, a completed digital plan, or a carrier.
 */
/** Renders facts this module already accepted. Does not classify the evidence again. */
export function proofFromFacts(
	input: ProofInput,
	facts: ProofFacts,
): ScannerProof | null {
	try {
		const observationId = input.observationId
		if (typeof observationId !== "string" || observationId.length === 0)
			return null
		const row: BareProof = {
			kind: facts.kind,
			protocol: facts.protocol,
			transport: facts.transport,
			at: new Date(facts.at).toISOString(),
			observationId,
			tried: triedOf(input.trials),
			unavailable: unavailableOf(input.unavailable),
			encrypted: facts.encrypted,
		}
		if (facts.identity !== undefined)
			row.identity = { kind: facts.identity.kind, value: facts.identity.value }
		if (
			facts.talkgroup !== undefined &&
			facts.talkgroup.length > 0 &&
			facts.talkgroup.length <= MAX_IDENTITY_VALUE_LENGTH
		)
			row.talkgroup = facts.talkgroup
		if (facts.tone !== undefined) {
			const hz = facts.tone.ctcssHz
			row.tone = {
				ctcssHz: typeof hz === "number" && hz > 0 ? hz : null,
				dcs:
					facts.tone.dcs === null
						? null
						: {
								code: facts.tone.dcs.code,
								polarity: facts.tone.dcs.polarity,
							},
			}
		}
		if (
			facts.voice !== undefined &&
			(facts.kind === "analog-tone" || facts.kind === "analog-voice")
		)
			row.voice = facts.voice
		return { ...row, summary: proofSummary(row) }
	} catch {
		return null
	}
}

/**
 * Proof of one observation. Null unless the evidence names a decoded identity,
 * an analog tone or voice under known trust, a completed digital plan, or a carrier.
 */
export function deriveProof(input: ProofInput): ScannerProof | null {
	const facts = proofFacts(input)
	if (facts === null) return null
	return proofFromFacts(input, facts)
}

/**
 * Highest rank, then newest `at` (`Date.parse`), among proofs already accepted.
 * An invalid stamp is not newer. Equal timestamps keep the later element.
 * No grammar check: the caller cached them.
 */
export function strongestKnownProof(
	proofs: readonly ScannerProof[],
): ScannerProof | null {
	let best: ScannerProof | null = null
	for (let index = 0; index < proofs.length; index++) {
		const row = proofs[index]
		if (row === undefined) continue
		if (
			best === null ||
			RANK[row.kind] > RANK[best.kind] ||
			(RANK[row.kind] === RANK[best.kind] && newerAt(row.at, best.at))
		)
			best = row
	}
	return best
}

/** A tone the grammar counts: CTCSS above 0 Hz, or a DCS code. */
function toneSignal(tone: BareProof["tone"]): boolean {
	if (tone === undefined) return false
	if (typeof tone.ctcssHz === "number" && tone.ctcssHz > 0) return true
	return tone.dcs !== null && tone.dcs !== undefined
}

function kindAgrees(
	kind: ScannerProofKind,
	protocol: ScannerProtocol,
): boolean {
	if (kind === "analog-tone" || kind === "analog-voice")
		return protocol === "analog-fm" || protocol === "analog-am"
	if (kind === "digital-undecoded") return protocol === "digital-unknown"
	if (kind === "carrier-only") return protocol === "carrier"
	return decodableProtocol(protocol)
}

const DcsSchema = z.union([
	z.object({
		code: z.string().regex(/^[0-7]{3}$/),
		polarity: z.enum(["normal", "inverted"]),
	}),
	z.null(),
])

/**
 * Nested proof grammar. Unknown keys are ignored. `safeParse` is a check:
 * callers keep the original object so identity and list order stay put.
 */
const ProofSchema = z
	.object({
		kind: z.enum([
			"decoded",
			"analog-tone",
			"analog-voice",
			"digital-undecoded",
			"carrier-only",
		]),
		protocol: z.string(),
		transport: z.enum(["live", "replay", "ambient"]),
		at: z.string().refine(value => Number.isFinite(Date.parse(value))),
		observationId: z.string().min(1),
		identity: z.unknown().optional(),
		talkgroup: z.string().min(1).max(MAX_IDENTITY_VALUE_LENGTH).optional(),
		tone: z
			.object({
				ctcssHz: z.union([z.number().finite().positive(), z.null()]),
				dcs: DcsSchema,
			})
			.optional(),
		voice: z.boolean().optional(),
		tried: z.array(z.string()).max(SCANNER_PROOF_TRIED_MAX),
		unavailable: z.array(z.string()),
		encrypted: z.boolean(),
		summary: z.string().max(SCANNER_PROOF_SUMMARY_MAX_CHARS),
	})
	.superRefine((row, ctx) => {
		if (!knownProtocol(row.protocol) || !kindAgrees(row.kind, row.protocol)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "kind" })
			return
		}
		const seenTried = new Set<string>()
		for (const protocol of row.tried) {
			if (!knownProtocol(protocol) || seenTried.has(protocol)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tried" })
				return
			}
			seenTried.add(protocol)
		}
		let previous: string | undefined
		for (const type of row.unavailable) {
			if (!PROBES.has(type) || (previous !== undefined && type <= previous)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "unavailable",
				})
				return
			}
			previous = type
		}
		if (row.kind === "decoded") {
			if (!identityFitsProtocol(row.protocol, row.identity)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: "identity" })
				return
			}
		} else if (row.identity !== undefined) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "identity" })
			return
		}
		if (row.kind === "analog-voice" && row.voice !== true) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "voice" })
			return
		}
		if (row.kind === "analog-tone") {
			if (!toneSignal(row.tone)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tone" })
				return
			}
		} else if (
			(row.kind === "carrier-only" || row.kind === "digital-undecoded") &&
			row.tone !== undefined
		) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tone" })
			return
		}
		const { summary, ...bare } = row
		if (summary !== proofSummary(bare as BareProof))
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "summary" })
	})

/**
 * True when `candidate` is a finite timestamp at or after `incumbent`.
 * An unparseable candidate is not newer. An unparseable incumbent loses to a
 * finite candidate. Equal timestamps count as newer so the later element wins.
 */
function newerAt(candidate: string, incumbent: string): boolean {
	const next = Date.parse(candidate)
	if (!Number.isFinite(next)) return false
	const previous = Date.parse(incumbent)
	if (!Number.isFinite(previous)) return true
	return next >= previous
}

/** Full proof shape. A throwing getter or a field outside the grammar is not a proof. */
function acceptedProof(value: unknown): ScannerProof | undefined {
	try {
		if (!ProofSchema.safeParse(value).success) return undefined
		return value as ScannerProof
	} catch {
		return undefined
	}
}

/** `proven` only for a proof whose fields match this grammar. Anything else is `weak`. */
export function evidenceLevelOf(d: {
	proof?: ScannerProof
}): ScannerEvidenceLevel {
	try {
		return acceptedProof(d.proof) !== undefined ? "proven" : "weak"
	} catch {
		return "weak"
	}
}

/**
 * Highest rank, then newest `at` (`Date.parse`). An equal timestamp keeps the
 * later element. A malformed or throwing entry is skipped; a throwing list is null.
 */
export function strongestProof(
	proofs: readonly ScannerProof[],
): ScannerProof | null {
	try {
		let best: ScannerProof | null = null
		for (let index = 0; index < proofs.length; index++) {
			try {
				const row = acceptedProof(proofs[index])
				if (row === undefined) continue
				if (
					best === null ||
					RANK[row.kind] > RANK[best.kind] ||
					(RANK[row.kind] === RANK[best.kind] && newerAt(row.at, best.at))
				)
					best = row
			} catch {
				// That element is not a proof.
			}
		}
		return best
	} catch {
		return null
	}
}
