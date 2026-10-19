import type {
	ProofAnalogInput,
	ProofInput,
} from "../scanner-redesign-contract.js"
import type {
	IdentityKind,
	ProtocolFamily,
	ScannerConfidence,
	ScannerProtocol,
} from "../types.js"
import { familyOf } from "./classifier.js"

/**
 * Discovery label from trial evidence only (requirements 3.1, 3.2, 3.9).
 * A missing, malformed or unknown input yields the safe label. Nothing here is logged.
 */
export interface EvidenceLabel {
	readonly protocol: ScannerProtocol
	readonly family: ProtocolFamily
	readonly confidence: ScannerConfidence
}

export const UNKNOWN_LABEL: EvidenceLabel = Object.freeze({
	protocol: "unknown",
	family: "unknown",
	confidence: "activity",
})

const PROTOCOLS = new Set<string>([
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	"digital-unknown",
	"carrier",
	"unknown",
	"ais",
	"acars",
	"vdl2",
	"lora",
])

/**
 * Kind each confirm interpreter attaches. analog-fm, analog-am, digital-unknown,
 * carrier and unknown attach none, so an identity on those protocols is refused.
 * Pairing: dsd-fme.ts IDENTITY_KIND (p25p2 and both NXDN rates share the link key),
 * multimon.ts (POCSAG and FLEX both store pocsag-capcode), direwolf, rtl433, ais,
 * acars, vdl2, meshtastic.
 */
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

/**
 * Longest identity value that may still count as `decoded`.
 *
 * Bounded producers, in characters of the stored value:
 * - AIS MMSI is 9 (`mmsiOf`).
 * - ACARS registration is at most 8 (`tailOf`; a raw tail longer than 32 is refused).
 * - VDL2 address is 6 (`addrOf`; a string longer than 16 is refused before that).
 * - LoRa node id is 9: `!` plus 8 hex digits from a uint32 (`nodeOf`).
 * - D-STAR callsign from the dsd-fme line parser is at most 8 (`[A-Z0-9/ ]{3,8}`).
 * - AX.25 source from the direwolf frame parser is at most 9: 6 callsign bytes,
 *   plus `-` and an SSID of 1–15 (2 digits) when the SSID is set. 6 + 1 + 2 = 9.
 * - DMR and dPMR colour code, NXDN RAN, YSF DG-ID and a POCSAG address are
 *   `String(number)`. `Number#toString` of a finite value is at most 24
 *   characters (`-1.7976931348623157e+308`). A nonnegative integer below 1e21
 *   is at most 21 digits.
 *
 * These producers store a string with no length cap, so the ceiling is 1024
 * rather than the bounded maximum above:
 * - rtl_433: `model` is `z.string().min(1)` and `id` is a number or
 *   `z.string().min(1)`. The stored value is `${model}:${String(id)}`.
 *   `Rtl433Decoder.parseOutput` JSON-parses the line and does not slice fields.
 * - P25 NAC: the link parser keeps `[0-9A-Fa-f]+`, then `trim().toUpperCase()`.
 * - FLEX capcode: `z.string()` trimmed. The line parser's `(\d+)` has no max.
 * - direwolf `source`: `z.string()` trimmed and upper-cased. The AX.25 parser's
 *   9-character bound is not checked again.
 * - A dsd-fme D-STAR callsign on a link line is a `string`. The `{3,8}` parser
 *   regex is not checked again.
 */
export const MAX_IDENTITY_VALUE_LENGTH = 1024

const TRUSTS = new Set(["commanded", "relay", "unverified"])
const TRANSPORTS = new Set(["live", "replay", "ambient"])
const ANALOG_OUTCOMES = new Set([
	"decoded",
	"heard",
	"data-like",
	"carrier-only",
	"no-sync",
])

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

function prop(rec: Record<string, unknown>, key: string): unknown {
	return rec[key]
}

function isProtocol(v: unknown): v is ScannerProtocol {
	return typeof v === "string" && PROTOCOLS.has(v)
}

/**
 * True when `identity` may confirm `protocol` as `decoded`: its kind is the one
 * that protocol's confirm interpreter stores, and its value is a non-empty string
 * no longer than `MAX_IDENTITY_VALUE_LENGTH`. Protocols that attach no identity
 * (analog-fm, analog-am, digital-unknown, carrier, unknown) never fit.
 */
export function identityFitsProtocol(
	protocol: ScannerProtocol,
	identity: unknown,
): boolean {
	try {
		if (!isRecord(identity)) return false
		const kind = prop(identity, "kind")
		const value = prop(identity, "value")
		const expected = IDENTITY_KIND_FOR[protocol]
		return (
			typeof kind === "string" &&
			typeof value === "string" &&
			expected !== undefined &&
			kind === expected &&
			value.length > 0 &&
			value.length <= MAX_IDENTITY_VALUE_LENGTH
		)
	} catch {
		// A throwing getter or proxy proves nothing.
		return false
	}
}

function named(
	protocol: ScannerProtocol,
	confidence: ScannerConfidence,
): EvidenceLabel {
	return { protocol, family: familyOf(protocol), confidence }
}

interface AcceptedDecode {
	readonly protocol: ScannerProtocol
	readonly at: number
	readonly identity: boolean
}

function acceptDecode(item: unknown): AcceptedDecode | undefined {
	if (!isRecord(item)) return undefined
	const protocol = prop(item, "protocol")
	const transport = prop(item, "transport")
	const at = prop(item, "at")
	const encrypted = prop(item, "encrypted")
	const identity = prop(item, "identity")
	const talkgroup = prop(item, "talkgroup")
	if (!isProtocol(protocol) || protocol === "unknown") return undefined
	if (typeof transport !== "string" || !TRANSPORTS.has(transport))
		return undefined
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined
	if (typeof encrypted !== "boolean") return undefined
	if (identity !== undefined && !identityFitsProtocol(protocol, identity))
		return undefined
	if (talkgroup !== undefined && typeof talkgroup !== "string") return undefined
	return { protocol, at, identity: identity !== undefined }
}

interface ToneFacts {
	readonly present: boolean
	/** ctcssHz null or 0, and no DCS code. */
	readonly quiet: boolean
}

function toneFacts(tone: unknown): ToneFacts | undefined {
	if (!isRecord(tone)) return undefined
	const hz = prop(tone, "ctcssHz")
	if (hz !== null && (typeof hz !== "number" || !Number.isFinite(hz)))
		return undefined
	const dcs = prop(tone, "dcs")
	let dcsPresent = false
	if (dcs === null) dcsPresent = false
	else if (!isRecord(dcs)) return undefined
	else {
		const code = prop(dcs, "code")
		const polarity = prop(dcs, "polarity")
		const codeOk = typeof code === "string" && /^[0-7]{3}$/.test(code)
		const polarityOk = polarity === "normal" || polarity === "inverted"
		if (!codeOk || !polarityOk) return undefined
		dcsPresent = true
	}
	const ctcssPresent = typeof hz === "number" && hz > 0
	return {
		present: ctcssPresent || dcsPresent,
		quiet: (hz === null || hz === 0) && !dcsPresent,
	}
}

interface AcceptedAnalog {
	readonly outcome: ProofAnalogInput["outcome"]
	readonly mode: ProofAnalogInput["mode"]
	readonly at: number
	readonly tone: boolean
}

/**
 * Analog outcomes are exclusive (design: tone or DCS → decoded; then data-like;
 * then voice → heard; else carrier-only). A row that contradicts that is skipped:
 * heard needs voice and no tone; data-like and carrier-only need no voice and no
 * tone (ctcssHz null or 0, dcs null); decoded needs a tone.
 */
function analogAgrees(
	outcome: string,
	voice: boolean,
	tone: ToneFacts,
): boolean {
	if (outcome === "heard") return voice && tone.quiet
	if (outcome === "data-like" || outcome === "carrier-only")
		return !voice && tone.quiet
	if (outcome === "decoded") return tone.present
	return outcome === "no-sync"
}

function acceptAnalog(item: unknown): AcceptedAnalog | undefined {
	if (!isRecord(item)) return undefined
	const outcome = prop(item, "outcome")
	const mode = prop(item, "mode")
	const voice = prop(item, "voice")
	const at = prop(item, "at")
	const transport = prop(item, "transport")
	if (typeof outcome !== "string" || !ANALOG_OUTCOMES.has(outcome))
		return undefined
	if (mode !== "nfm" && mode !== "am") return undefined
	if (typeof voice !== "boolean") return undefined
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined
	if (typeof transport !== "string" || !TRANSPORTS.has(transport))
		return undefined
	const tone = toneFacts(prop(item, "tone"))
	if (tone === undefined || !analogAgrees(outcome, voice, tone))
		return undefined
	return {
		outcome: outcome as ProofAnalogInput["outcome"],
		mode,
		at,
		tone: tone.present,
	}
}

function newest<T extends { at: number }>(items: readonly T[]): T | undefined {
	let best: T | undefined
	for (const item of items) {
		if (best === undefined || item.at >= best.at) best = item
	}
	return best
}

function analogProtocol(mode: ProofAnalogInput["mode"]): ScannerProtocol {
	return mode === "am" ? "analog-am" : "analog-fm"
}

interface Shaped {
	readonly decodes: readonly AcceptedDecode[]
	readonly analog: readonly AcceptedAnalog[]
	readonly trust: "commanded" | "relay" | "unverified" | "unknown"
	readonly digitalPlanComplete: boolean
}

function shapeOf(value: unknown): Shaped | undefined {
	if (!isRecord(value)) return undefined
	const observationId = prop(value, "observationId")
	const decodesIn = prop(value, "decodes")
	const trials = prop(value, "trials")
	const analogIn = prop(value, "analog")
	const unavailable = prop(value, "unavailable")
	const digitalPlanComplete = prop(value, "digitalPlanComplete")
	const trust = prop(value, "trust")
	if (typeof observationId !== "string" || observationId.length === 0)
		return undefined
	if (!Array.isArray(decodesIn) || !Array.isArray(trials)) return undefined
	if (!Array.isArray(analogIn) || !Array.isArray(unavailable)) return undefined
	if (typeof digitalPlanComplete !== "boolean") return undefined
	if (typeof trust !== "string") return undefined
	const knownTrust = TRUSTS.has(trust)
		? (trust as "commanded" | "relay" | "unverified")
		: "unknown"
	const decodes: AcceptedDecode[] = []
	for (const item of decodesIn) {
		const accepted = acceptDecode(item)
		if (accepted !== undefined) decodes.push(accepted)
	}
	const analog: AcceptedAnalog[] = []
	for (const item of analogIn) {
		const accepted = acceptAnalog(item)
		if (accepted !== undefined) analog.push(accepted)
	}
	return { decodes, analog, trust: knownTrust, digitalPlanComplete }
}

/**
 * One winning outcome, strongest first: accepted identity, any other decode,
 * analog tone or code, analog voice, completed digital plan, carrier.
 * An identity-less decode names its protocol at `activity` (requirement 3.2:
 * `decoded` is the first accepted identity). DMR's two CRC-clean lines stay
 * in the confirm interpreters; a decode that reaches this function is already
 * accepted.
 */
export function labelFromEvidence(e: ProofInput): EvidenceLabel {
	try {
		const input = shapeOf(e as unknown)
		if (input === undefined) return UNKNOWN_LABEL
		const identified = newest(input.decodes.filter(d => d.identity))
		if (identified !== undefined) return named(identified.protocol, "decoded")
		const namedDecode = newest(input.decodes)
		if (namedDecode !== undefined)
			return named(namedDecode.protocol, "activity")
		const trustKnown = input.trust !== "unknown"
		if (trustKnown) {
			const tone = newest(
				input.analog.filter(a => a.outcome === "decoded" && a.tone),
			)
			if (tone !== undefined) {
				const confidence =
					input.trust === "unverified" ? "candidate" : "classified"
				return named(analogProtocol(tone.mode), confidence)
			}
			const heard = newest(input.analog.filter(a => a.outcome === "heard"))
			if (heard !== undefined)
				return named(analogProtocol(heard.mode), "candidate")
		}
		if (
			input.digitalPlanComplete &&
			input.analog.some(a => a.outcome === "data-like")
		)
			return named("digital-unknown", "candidate")
		if (input.analog.some(a => a.outcome === "carrier-only"))
			return named("carrier", "activity")
		return UNKNOWN_LABEL
	} catch {
		return UNKNOWN_LABEL
	}
}
