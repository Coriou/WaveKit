import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { SCANNER_PROOF_SUMMARY_MAX_CHARS } from "@wavekit/api-types"
import type { ScannerProbeDecoderType } from "@wavekit/api-types"
import { labelFromEvidence } from "../../../../src/core/scanner/classify/label-from-evidence.js"
import type { EvidenceLabel } from "../../../../src/core/scanner/classify/label-from-evidence.js"
import {
	deriveProof,
	evidenceLevelOf,
	proofSummary,
	strongestProof,
} from "../../../../src/core/scanner/proof.js"
import type {
	ProofAnalogInput,
	ProofDecodeInput,
	ProofInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	IdentityKind,
	ScannerProof,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"

const PROTOCOLS: readonly ScannerProtocol[] = [
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
]
const KINDS: Readonly<Record<ScannerProtocol, IdentityKind | undefined>> = {
	"analog-fm": undefined,
	"analog-am": undefined,
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
	"digital-unknown": undefined,
	carrier: undefined,
	unknown: undefined,
	ais: "ais-mmsi",
	acars: "acars-reg",
	vdl2: "vdl2-addr",
	lora: "lora-node",
	adsb: "icao",
}
const RAN = new Set([
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"heard",
	"data-like",
	"carrier-only",
])
const OUTCOMES: readonly ProofTrialInput["outcome"][] = [
	"pending",
	"running",
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"skipped-budget",
	"unsupported",
	"not-needed",
	"cancelled",
	"heard",
	"data-like",
	"carrier-only",
]
const PROBES: readonly ScannerProbeDecoderType[] = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
]
const RANK: Readonly<Record<ScannerProof["kind"], number>> = {
	decoded: 5,
	"analog-tone": 4,
	"analog-voice": 3,
	"digital-undecoded": 2,
	"carrier-only": 1,
}

const token = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/)

function proofWorthy(label: EvidenceLabel): boolean {
	if (label.confidence === "decoded") return true
	if (label.protocol === "analog-fm" || label.protocol === "analog-am")
		return label.confidence === "classified" || label.confidence === "candidate"
	if (label.protocol === "digital-unknown" || label.protocol === "carrier")
		return true
	return false
}

function isAnalogTrial(row: ProofTrialInput): boolean {
	return row.decoder === "analog-demod" || row.decoder === "live-audio"
}

/** Spec tried list: ran outcomes, analog trial omitted unless decoded, order, unique, ≤ 16. */
function expectedTried(trials: readonly ProofTrialInput[]): ScannerProtocol[] {
	const ranked = trials
		.map((row, index) => ({ row, index }))
		.filter(
			({ row }) =>
				RAN.has(row.outcome) &&
				row.protocol !== "unknown" &&
				PROTOCOLS.includes(row.protocol) &&
				!(isAnalogTrial(row) && row.outcome !== "decoded"),
		)
		.sort((a, b) => a.row.order - b.row.order || a.index - b.index)
	const out: ScannerProtocol[] = []
	for (const { row } of ranked) {
		if (out.includes(row.protocol)) continue
		out.push(row.protocol)
		if (out.length === 16) break
	}
	return out
}

function expectedUnavailable(
	rows: readonly string[],
): ScannerProbeDecoderType[] {
	return [
		...new Set(
			rows.filter((row): row is ScannerProbeDecoderType =>
				(PROBES as readonly string[]).includes(row),
			),
		),
	].sort()
}

function grammar(kind: ScannerProof["kind"]): RegExp {
	if (kind === "decoded") return /^.+ decoded( \([^)]+\))?$/
	if (kind === "analog-tone")
		return /^Analog (FM|AM)( voice)?, (CTCSS \d+\.\d|DCS [0-7]{3}[NI])(, (CTCSS \d+\.\d|DCS [0-7]{3}[NI]))?$/
	if (kind === "analog-voice") return /^Analog (FM|AM) voice$/
	if (kind === "digital-undecoded")
		return /^Digital, not decoded \((no decoder available|tried .+|[^)]*unavailable)\)$/
	return /^Carrier only$/
}

const decodeArb: fc.Arbitrary<ProofDecodeInput> = fc
	.record({
		protocol: fc.constantFrom(...PROTOCOLS),
		transport: fc.constantFrom(
			"live" as const,
			"replay" as const,
			"ambient" as const,
		),
		at: fc.integer({ min: 0, max: 1_000_000 }),
		encrypted: fc.boolean(),
		identified: fc.boolean(),
		talk: fc.option(token, { nil: undefined }),
		value: token,
	})
	.map(row => {
		const decode: ProofDecodeInput = {
			protocol: row.protocol,
			transport: row.transport,
			at: row.at,
			encrypted: row.encrypted,
		}
		const kind = KINDS[row.protocol]
		if (row.identified && kind !== undefined)
			decode.identity = { kind, value: row.value }
		if (row.talk !== undefined) decode.talkgroup = row.talk
		return decode
	})

const trialArb: fc.Arbitrary<ProofTrialInput> = fc.record({
	protocol: fc.constantFrom(...PROTOCOLS),
	decoder: fc.constantFrom(
		"dsd-fme",
		"analog-demod",
		"live-audio",
		"multimon-ng",
	),
	outcome: fc.constantFrom(...OUTCOMES),
	order: fc.integer({ min: 0, max: 40 }),
	at: fc.integer({ min: 0, max: 1_000_000 }),
})

const analogArb: fc.Arbitrary<ProofAnalogInput> = fc
	.record({
		outcome: fc.constantFrom(
			"decoded" as const,
			"heard" as const,
			"data-like" as const,
			"carrier-only" as const,
			"no-sync" as const,
		),
		mode: fc.constantFrom("nfm" as const, "am" as const),
		at: fc.integer({ min: 0, max: 1_000_000 }),
		transport: fc.constantFrom(
			"live" as const,
			"replay" as const,
			"ambient" as const,
		),
		hz: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 250 })),
		code: fc.constantFrom("023", "114"),
		polarity: fc.constantFrom("normal" as const, "inverted" as const),
		which: fc.constantFrom(
			"ctcss" as const,
			"dcs" as const,
			"both" as const,
			"quiet" as const,
		),
	})
	.map(row => {
		const tone =
			row.outcome === "decoded"
				? {
						ctcssHz: row.which === "dcs" ? null : row.hz,
						dcs:
							row.which === "ctcss"
								? null
								: { code: row.code, polarity: row.polarity },
					}
				: { ctcssHz: null, dcs: null }
		const voice = row.outcome === "heard"
		return {
			outcome: row.outcome,
			mode: row.mode,
			voice,
			tone,
			transport: row.transport,
			at: row.at,
		}
	})

const inputArb = fc.record({
	observationId: fc.stringMatching(/^[a-z0-9]{1,8}$/),
	decodes: fc.array(decodeArb, { maxLength: 3 }),
	trials: fc.array(trialArb, { maxLength: 6 }),
	analog: fc.array(analogArb, { maxLength: 3 }),
	unavailable: fc.array(fc.constantFrom(...PROBES, "nope"), { maxLength: 4 }),
	trust: fc.constantFrom(
		"commanded" as const,
		"relay" as const,
		"unverified" as const,
		"unknown" as const,
	),
	digitalPlanComplete: fc.boolean(),
})

function omitSummary(row: ScannerProof): Omit<ScannerProof, "summary"> {
	const { summary: _summary, ...rest } = row
	return rest
}

// Feature: scanner-redesign, Property 8: Proof is a function of the evidence
// Validates: Requirements 3.4, 3.5, 4.5
describe("proof is a function of the evidence", () => {
	it("is deterministic, matches the label, and stays inside the grammar", () => {
		fc.assert(
			fc.property(inputArb, raw => {
				const input = raw as unknown as ProofInput
				const once = deriveProof(input)
				expect(deriveProof(input)).toEqual(once)
				const label = labelFromEvidence(input)
				if (once === null) {
					// An identity-less decode is activity and is not a proof, including
					// when its protocol is `carrier` (that label is also used by a carrier proof).
					expect(label.confidence).not.toBe("decoded")
					if (
						label.protocol === "analog-fm" ||
						label.protocol === "analog-am" ||
						label.protocol === "digital-unknown"
					)
						expect(label.confidence).toBe("activity")
					expect(evidenceLevelOf({})).toBe("weak")
					return
				}
				expect(proofWorthy(label)).toBe(true)
				expect(once.protocol).toBe(label.protocol)
				expect(once.observationId).toBe(input.observationId)
				expect(once.summary.length).toBeLessThanOrEqual(
					SCANNER_PROOF_SUMMARY_MAX_CHARS,
				)
				expect(once.summary.length).toBeGreaterThan(0)
				expect(once.summary).toMatch(grammar(once.kind))
				expect(proofSummary(omitSummary(once))).toBe(once.summary)
				expect(once.tried).toEqual(expectedTried(input.trials))
				expect(once.unavailable).toEqual(expectedUnavailable(input.unavailable))
				expect(new Set(once.tried).size).toBe(once.tried.length)
				expect(once.tried.length).toBeLessThanOrEqual(16)
				for (const probe of once.unavailable)
					expect(once.tried.join(" ")).not.toContain(probe)
				if (label.confidence === "decoded") expect(once.kind).toBe("decoded")
				if (label.protocol === "digital-unknown")
					expect(once.kind).toBe("digital-undecoded")
				if (label.protocol === "carrier") expect(once.kind).toBe("carrier-only")
				if (label.protocol === "analog-fm" || label.protocol === "analog-am") {
					expect(["analog-tone", "analog-voice"]).toContain(once.kind)
					if (label.confidence === "classified")
						expect(once.kind).toBe("analog-tone")
				}
				expect(evidenceLevelOf({ proof: once })).toBe("proven")
				expect(strongestProof([once])).toEqual(once)
			}),
			{ numRuns: 100 },
		)
	})

	it("picks the highest rank and then the newest at, with a later tie winning", () => {
		fc.assert(
			fc.property(
				fc.array(inputArb, { minLength: 1, maxLength: 4 }),
				rawInputs => {
					const inputs = rawInputs as unknown as ProofInput[]
					const proofs = inputs
						.map(deriveProof)
						.filter((row): row is ScannerProof => row !== null)
					const winner = strongestProof(proofs)
					if (proofs.length === 0) {
						expect(winner).toBeNull()
						return
					}
					expect(winner).not.toBeNull()
					let best = proofs[0]
					if (best === undefined || winner === null) throw new Error("empty")
					for (let i = 1; i < proofs.length; i++) {
						const row = proofs[i]
						if (row === undefined) continue
						const next = Date.parse(row.at)
						const previous = Date.parse(best.at)
						const newerAt =
							Number.isFinite(next) &&
							(!Number.isFinite(previous) || next >= previous)
						const newer =
							RANK[row.kind] > RANK[best.kind] ||
							(RANK[row.kind] === RANK[best.kind] && newerAt)
						if (newer) best = row
					}
					expect(winner).toBe(best)
				},
			),
			{ numRuns: 100 },
		)
	})
})
