// Scanner discoveries search (Scanner board, DESIGN.md "Discoveries list"): typed chips like Activity's,
// mapped onto GET /api/scanner/discoveries. The core takes one value per filter (q, identity, protocol,
// minConfidence, freqMinHz/freqMaxHz), so a new chip of a kind replaces the old one of that kind.
import type {
	IdentityKind,
	ScannerConfidence,
	ScannerProtocol,
} from "@wavekit/api-types"

import type { DiscoveryQuery, DiscoverySort } from "../../../data/index.ts"
import { parseFrequency } from "../../activity/search.ts"
import { formatMHz } from "../../format.ts"

export type ScanTokenKind =
	| "frequency"
	| "protocol"
	| "identity"
	| "confidence"
	| "text"

export interface ScanToken {
	kind: ScanTokenKind
	/** Protocol id, `kind:value` identity, confidence level or text; "min-max" Hz for a frequency. */
	value: string
	/** The chip's quiet kind word ("Frequency", "Colour code", "Protocol"…). */
	kindLabel: string
	/** The chip's value ("161.150–161.160 MHz", "DMR", "1"). */
	label: string
}

export const SORTS: readonly { value: DiscoverySort; label: string }[] = [
	{ value: "lastSeen", label: "Last heard" },
	{ value: "frequency", label: "Frequency" },
	{ value: "confidence", label: "Confidence" },
]

/** Search words for the protocol filter; the core has one id per variant. */
const PROTOCOLS: readonly { id: ScannerProtocol; label: string }[] = [
	{ id: "dmr", label: "DMR" },
	{ id: "p25p1", label: "P25 phase 1" },
	{ id: "p25p2", label: "P25 phase 2" },
	{ id: "nxdn48", label: "NXDN 4800" },
	{ id: "nxdn96", label: "NXDN 9600" },
	{ id: "ysf", label: "YSF" },
	{ id: "dstar", label: "D-STAR" },
	{ id: "dpmr", label: "dPMR" },
	{ id: "analog-fm", label: "FM voice" },
	{ id: "analog-am", label: "AM voice" },
	{ id: "pocsag", label: "POCSAG" },
	{ id: "flex", label: "FLEX" },
	{ id: "aprs", label: "APRS" },
	{ id: "ism", label: "ISM" },
	{ id: "lora", label: "LoRa" },
	{ id: "ais", label: "AIS" },
	{ id: "acars", label: "ACARS" },
	{ id: "vdl2", label: "VDL2" },
	{ id: "digital-unknown", label: "Digital" },
	{ id: "carrier", label: "Carrier" },
]

const CONFIDENCE: readonly {
	level: ScannerConfidence
	word: string
	label: string
}[] = [
	{ level: "decoded", word: "decoded", label: "Decoded" },
	{ level: "classified", word: "likely", label: "Likely or better" },
	{ level: "candidate", word: "maybe", label: "Maybe or better" },
]

const IDENTITY_KIND_LABEL: Readonly<Record<IdentityKind, string>> = {
	"dmr-cc": "Colour code",
	"p25-nac": "NAC",
	"nxdn-ran": "RAN",
	"ysf-dgid": "DG-ID",
	"dstar-call": "D-STAR call",
	"dpmr-cc": "dPMR colour code",
	"pocsag-capcode": "Capcode",
	"aprs-call": "Callsign",
	"ism-model": "Device",
	"ais-mmsi": "MMSI",
	"acars-reg": "Registration",
	"vdl2-addr": "Address",
	"lora-node": "Node",
}

/** Typed prefixes for identities ("cc 1", "nac 293", "capcode 1234567"…). */
const IDENTITY_PREFIXES: readonly [RegExp, IdentityKind][] = [
	[/^(?:cc|colou?r\s*code)\s*:?\s*(\d{1,2})$/i, "dmr-cc"],
	[/^nac\s*:?\s*([0-9a-f]{1,3})$/i, "p25-nac"],
	[/^ran\s*:?\s*(\d{1,2})$/i, "nxdn-ran"],
	[/^(?:dg-?id|dgid)\s*:?\s*(\d{1,3})$/i, "ysf-dgid"],
	[/^(?:capcode|cap|ric)\s*:?\s*(\d{1,8})$/i, "pocsag-capcode"],
	[/^mmsi\s*:?\s*(\d{9})$/i, "ais-mmsi"],
	[/^(?:call|callsign)\s*:?\s*([a-z0-9]{3,7}(?:-\d{1,2})?)$/i, "aprs-call"],
	[/^(?:reg|registration)\s*:?\s*([a-z0-9-]{3,8})$/i, "acars-reg"],
	[/^node\s*:?\s*(!?[0-9a-f]{4,8})$/i, "lora-node"],
	[/^(?:model|device)\s*:?\s*(.{2,40})$/i, "ism-model"],
]

const UPPER: ReadonlySet<IdentityKind> = new Set([
	"aprs-call",
	"dstar-call",
	"acars-reg",
	"p25-nac",
])

export function identityToken(kind: IdentityKind, raw: string): ScanToken {
	const value = UPPER.has(kind) ? raw.toUpperCase() : raw
	return {
		kind: "identity",
		value: `${kind}:${value}`,
		kindLabel: IDENTITY_KIND_LABEL[kind],
		label: value,
	}
}

export function protocolToken(id: ScannerProtocol): ScanToken {
	const label = PROTOCOLS.find(p => p.id === id)?.label ?? id
	return { kind: "protocol", value: id, kindLabel: "Protocol", label }
}

export function textToken(text: string): ScanToken {
	return {
		kind: "text",
		value: text,
		kindLabel: "Label or ID",
		label: `“${text}”`,
	}
}

/** A frequency filter from `minHz` to `maxHz` (inclusive). */
export function frequencyToken(
	minHz: number,
	maxHz: number,
	label?: string,
): ScanToken {
	const lo = Math.round(Math.min(minHz, maxHz))
	const hi = Math.round(Math.max(minHz, maxHz))
	return {
		kind: "frequency",
		value: `${lo}-${hi}`,
		kindLabel: "Frequency",
		label: label ?? `${formatMHz(lo)}–${formatMHz(hi)} MHz`,
	}
}

/** The Hz range of a frequency token, or null. */
export function frequencyRange(
	t: ScanToken,
): { minHz: number; maxHz: number } | null {
	if (t.kind !== "frequency") return null
	const m = /^(\d+)-(\d+)$/.exec(t.value)
	if (!m?.[1] || !m[2]) return null
	return { minHz: Number(m[1]), maxHz: Number(m[2]) }
}

/** Half width of a frequency typed with a unit ("161.15 MHz"): one 12.5 kHz channel. */
const CHANNEL_HALF_HZ = 6250
const MIN_MHZ = 0.1
const MAX_MHZ = 7000

/**
 * "161" → 161.000–161.999999 MHz, "161.15" → 161.150–161.159999: a number without a unit is a
 * frequency prefix in MHz, so typing more digits narrows it.
 */
export function prefixRange(
	raw: string,
): { minHz: number; maxHz: number } | null {
	const m = /^(\d{1,4})(?:[.,](\d{0,6}))?$/.exec(raw.trim())
	if (!m?.[1]) return null
	const decimals = m[2] ?? ""
	const mhz = Number(`${m[1]}.${decimals || "0"}`)
	if (!(mhz >= MIN_MHZ && mhz <= MAX_MHZ)) return null
	const minHz = Math.round(mhz * 1e6)
	const stepHz = Math.round(1e6 / 10 ** decimals.length)
	return { minHz, maxHz: minHz + stepHz - 1 }
}

/** A typed prefix as its chip says it: "161 MHz", "161.15 MHz". */
function prefixLabel(raw: string): string {
	return `${raw.trim().replace(",", ".").replace(/\.$/, "")} MHz`
}

/** "146-174", "146–174 MHz", "433.05 - 434.79": a range in MHz. */
function typedRange(raw: string): { minHz: number; maxHz: number } | null {
	const m =
		/^(\d{1,4}(?:[.,]\d{1,6})?)\s*[-–]\s*(\d{1,4}(?:[.,]\d{1,6})?)\s*(?:mhz)?$/i.exec(
			raw.trim(),
		)
	if (!m?.[1] || !m[2]) return null
	const a = Number(m[1].replace(",", "."))
	const b = Number(m[2].replace(",", "."))
	if (!(a >= MIN_MHZ && b >= MIN_MHZ && a <= MAX_MHZ && b <= MAX_MHZ))
		return null
	return {
		minHz: Math.round(Math.min(a, b) * 1e6),
		maxHz: Math.round(Math.max(a, b) * 1e6),
	}
}

/**
 * What the typed text could mean, best guess first (Enter takes the first). The last suggestion is
 * always the text itself, which the core matches against labels and identity values.
 */
export function suggest(input: string): ScanToken[] {
	const raw = input.trim()
	if (raw.length === 0) return []
	const out: ScanToken[] = []
	const push = (t: ScanToken) => {
		if (!out.some(x => x.kind === t.kind && x.value === t.value)) out.push(t)
	}

	for (const [re, kind] of IDENTITY_PREFIXES) {
		const m = re.exec(raw)
		if (m?.[1]) {
			push(identityToken(kind, m[1].trim()))
			if (kind === "aprs-call") push(identityToken("dstar-call", m[1].trim()))
		}
	}

	const range = typedRange(raw)
	if (range) push(frequencyToken(range.minHz, range.maxHz))

	const withUnit = /[a-z]\s*$/i.test(raw) ? parseFrequency(raw) : null
	if (withUnit !== null)
		push(frequencyToken(withUnit - CHANNEL_HALF_HZ, withUnit + CHANNEL_HALF_HZ))

	if (/^\d+$/.test(raw)) {
		const n = raw.length
		const prefix = prefixRange(raw)
		if (n <= 2) {
			push(identityToken("dmr-cc", raw))
			if (prefix)
				push(frequencyToken(prefix.minHz, prefix.maxHz, prefixLabel(raw)))
		} else if (n <= 4) {
			if (prefix)
				push(frequencyToken(prefix.minHz, prefix.maxHz, prefixLabel(raw)))
			if (n === 3) push(identityToken("p25-nac", raw))
			push(identityToken("pocsag-capcode", raw))
		} else {
			if (n === 9) push(identityToken("ais-mmsi", raw))
			if (n <= 8) push(identityToken("pocsag-capcode", raw))
		}
	} else {
		const prefix = prefixRange(raw)
		if (prefix)
			push(frequencyToken(prefix.minHz, prefix.maxHz, prefixLabel(raw)))
	}

	if (/^[a-z]{1,2}\d[a-z]{1,4}(?:-\d{1,2})?$/i.test(raw)) {
		push(identityToken("aprs-call", raw))
		push(identityToken("dstar-call", raw))
	}

	if (/^[a-z]/i.test(raw)) {
		const lower = raw.toLowerCase()
		const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
		for (const p of PROTOCOLS)
			if (
				p.label.toLowerCase().startsWith(lower) ||
				squash(p.label).startsWith(squash(raw)) ||
				p.id.startsWith(lower)
			)
				push(protocolToken(p.id))
		if (lower.length >= 3)
			for (const c of CONFIDENCE)
				if (c.word.startsWith(lower))
					push({
						kind: "confidence",
						value: c.level,
						kindLabel: "Confidence",
						label: c.label,
					})
	}

	push(textToken(raw))
	return out
}

/** Adds a chip; the core takes one filter of each kind, so it replaces one of the same kind. */
export function addToken(
	tokens: readonly ScanToken[],
	t: ScanToken,
): ScanToken[] {
	return [...tokens.filter(x => x.kind !== t.kind), t]
}

/**
 * The core query for the chips and the sort. `weak` (WG12 cores): proven discoveries only unless weak
 * activity is shown; null on a core that takes no `evidence` filter.
 */
export function buildDiscoveryQuery(
	tokens: readonly ScanToken[],
	sort: DiscoverySort,
	weak: boolean | null = null,
): DiscoveryQuery {
	const q: DiscoveryQuery = {}
	if (sort !== "lastSeen") q.sort = sort
	if (weak !== null) q.evidence = weak ? "all" : "proven"
	for (const t of tokens) {
		switch (t.kind) {
			case "text":
				q.q = t.value
				break
			case "identity":
				q.identity = t.value
				break
			case "protocol":
				q.protocol = t.value as ScannerProtocol
				break
			case "confidence":
				q.minConfidence = t.value as ScannerConfidence
				break
			case "frequency": {
				const r = frequencyRange(t)
				if (r) {
					q.freqMinHz = r.minHz
					q.freqMaxHz = r.maxHz
				}
				break
			}
		}
	}
	return q
}

/** Two queries ask the core the same thing. */
export function sameQuery(a: DiscoveryQuery, b: DiscoveryQuery): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	for (const k of keys)
		if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k])
			return false
	return true
}

/** The search chip for a discovery's identity. */
export function tokenForIdentity(identity: {
	kind: IdentityKind
	value: string
}): ScanToken {
	return identityToken(identity.kind, identity.value.trim())
}
