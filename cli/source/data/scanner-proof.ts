// Fixed proof grammar mirrored from core/scanner/proof.ts; agreement is tested.
import {
	SCANNER_PROBE_DECODER_TYPES,
	SCANNER_PROOF_PROTOCOL_LABEL,
	SCANNER_PROOF_SUMMARY_MAX_CHARS,
} from "@wavekit/api-types"
import type {
	ScannerProof,
	ScannerProtocol,
	ScannerProbeDecoderType,
	Identity,
	IdentityKind,
} from "@wavekit/api-types"

type BareProof = Omit<ScannerProof, "summary">
const PROBES = new Set<string>(SCANNER_PROBE_DECODER_TYPES)
function knownProtocol(value: unknown): value is ScannerProtocol {
	return (
		typeof value === "string" &&
		Object.hasOwn(SCANNER_PROOF_PROTOCOL_LABEL, value)
	)
}
const IDENTITY_KIND_FOR: Readonly<
	Partial<Record<ScannerProtocol, IdentityKind>>
> = Object.freeze({
	dmr: "dmr-cc",
	p25p1: "p25-nac",
	p25p2: "p25-nac",
	nxdn48: "nxdn-ran",
	nxdn96: "nxdn-ran",
	ysf: "ysf-dgid",
	dstar: "dstar-call",
	dpmr: "dpmr-cc",
	pocsag: "pocsag-capcode",
	flex: "pocsag-capcode",
	aprs: "aprs-call",
	ism: "ism-model",
	ais: "ais-mmsi",
	acars: "acars-reg",
	vdl2: "vdl2-addr",
	lora: "lora-node",
})

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

export function validProofFields(proof: ScannerProof): boolean {
	const analog = proof.kind === "analog-tone" || proof.kind === "analog-voice"
	const toneOn =
		proof.tone !== undefined &&
		(proof.tone.ctcssHz !== null || proof.tone.dcs !== null)
	if (
		proof.tried.includes("unknown") ||
		new Set(proof.tried).size !== proof.tried.length
	)
		return false
	if (
		proof.unavailable.some(
			(value, index) => index > 0 && value <= proof.unavailable[index - 1]!,
		)
	)
		return false
	if (proof.kind === "decoded") {
		if (
			proof.identity === undefined ||
			IDENTITY_KIND_FOR[proof.protocol] === undefined ||
			proof.identity?.kind !== IDENTITY_KIND_FOR[proof.protocol] ||
			!proof.identity.value.length ||
			proof.identity.value.length > 1024
		)
			return false
	} else if (proof.identity !== undefined) return false
	if (analog) {
		if (proof.protocol !== "analog-fm" && proof.protocol !== "analog-am")
			return false
		if (proof.kind === "analog-tone" ? !toneOn : proof.voice !== true || toneOn)
			return false
	} else if (proof.tone !== undefined || proof.voice !== undefined) return false
	if (
		proof.kind !== "decoded" &&
		(proof.talkgroup !== undefined || proof.encrypted)
	)
		return false
	if (
		proof.kind === "digital-undecoded" &&
		proof.protocol !== "digital-unknown"
	)
		return false
	if (proof.kind === "carrier-only" && proof.protocol !== "carrier")
		return false
	return proof.summary === proofSummary(proof)
}
