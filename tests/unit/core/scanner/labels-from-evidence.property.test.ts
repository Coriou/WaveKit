import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { withBandBurstPrior } from "../../../../src/core/scanner/band-scan-burst-prior.js"
import {
	classifySpectral,
	familyOf,
} from "../../../../src/core/scanner/classify/classifier.js"
import {
	identityFitsProtocol,
	labelFromEvidence,
	MAX_IDENTITY_VALUE_LENGTH,
	UNKNOWN_LABEL,
} from "../../../../src/core/scanner/classify/label-from-evidence.js"
import type { EvidenceLabel } from "../../../../src/core/scanner/classify/label-from-evidence.js"
import type { DsdFmeLinkLine } from "../../../../src/decoders/builtin/dsd-fme-link.js"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretDsdFme } from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import type { DsdFmeScannerEvent } from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import { interpretMultimon } from "../../../../src/core/scanner/probes/confirm/multimon.js"
import { interpretRtl433 } from "../../../../src/core/scanner/probes/confirm/rtl433.js"
import { interpretAis } from "../../../../src/core/scanner/probes/confirm/ais.js"
import type {
	ProofAnalogInput,
	ProofDecodeInput,
	ProofInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	DecodeEvidence,
	Identity,
	IdentityKind,
	ScannerClass,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import { CONFIDENCE_RANK } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
	makeTrack,
} from "../../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

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
const NAMED = PROTOCOLS.filter(p => p !== "unknown")
const KINDS: readonly IdentityKind[] = [
	"dmr-cc",
	"p25-nac",
	"nxdn-ran",
	"ysf-dgid",
	"dstar-call",
	"dpmr-cc",
	"pocsag-capcode",
	"aprs-call",
	"ism-model",
	"ais-mmsi",
	"acars-reg",
	"vdl2-addr",
	"lora-node",
]
const CLASSES: readonly ScannerClass[] = [
	"fsk4-12k5",
	"fsk4-6k25",
	"tdma-ms",
	"fsk2-wide",
	"gmsk-narrow",
	"afsk-fm",
	"analog-fm",
	"ook-burst",
	"carrier",
	"wideband",
	"unknown",
]
const TRUSTS = ["commanded", "relay", "unverified"] as const
const TRANSPORTS = ["live", "replay", "ambient"] as const
const OUTCOMES = [
	"decoded",
	"heard",
	"data-like",
	"carrier-only",
	"no-sync",
] as const

const SAFE: EvidenceLabel = {
	protocol: "unknown",
	family: "unknown",
	confidence: "activity",
}

function identityProves(
	protocol: ScannerProtocol,
	identity: Identity | undefined,
): boolean {
	return identity !== undefined && identityFitsProtocol(protocol, identity)
}

function toneQuiet(tone: ProofAnalogInput["tone"]): boolean {
	return (tone.ctcssHz === null || tone.ctcssHz === 0) && tone.dcs === null
}

function tonePresent(tone: ProofAnalogInput["tone"]): boolean {
	const ctcss = typeof tone.ctcssHz === "number" && tone.ctcssHz > 0
	const dcs = tone.dcs
	const code =
		dcs !== null &&
		/^[0-7]{3}$/.test(dcs.code) &&
		(dcs.polarity === "normal" || dcs.polarity === "inverted")
	return ctcss || code
}

/** Heard, data-like, carrier-only and decoded rows that disagree with the analog decision order. */
function analogContradicts(row: ProofAnalogInput): boolean {
	if (row.outcome === "heard") return !row.voice || !toneQuiet(row.tone)
	if (row.outcome === "data-like" || row.outcome === "carrier-only")
		return row.voice || !toneQuiet(row.tone)
	if (row.outcome === "decoded") return !tonePresent(row.tone)
	return false
}

function decodeSupports(
	row: ProofDecodeInput,
	protocol: ScannerProtocol,
): boolean {
	if (row.protocol !== protocol) return false
	if (
		row.transport !== "live" &&
		row.transport !== "replay" &&
		row.transport !== "ambient"
	)
		return false
	if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false
	if (typeof row.encrypted !== "boolean") return false
	if (row.talkgroup !== undefined && typeof row.talkgroup !== "string")
		return false
	if (row.identity !== undefined && !identityProves(protocol, row.identity))
		return false
	return true
}

function analogNames(
	row: ProofAnalogInput,
	protocol: ScannerProtocol,
): boolean {
	if (analogContradicts(row)) return false
	if (row.mode !== "nfm" && row.mode !== "am") return false
	if (row.outcome === "heard" || row.outcome === "decoded")
		return protocol === (row.mode === "am" ? "analog-am" : "analog-fm")
	if (row.outcome === "data-like") return protocol === "digital-unknown"
	if (row.outcome === "carrier-only") return protocol === "carrier"
	return false
}

function decode(
	protocol: ScannerProtocol,
	at: number,
	extra: {
		identity?: Identity
		transport?: ProofDecodeInput["transport"]
		encrypted?: boolean
		talkgroup?: string
	} = {},
): ProofDecodeInput {
	const row: ProofDecodeInput = {
		protocol,
		transport: extra.transport ?? "live",
		at,
		encrypted: extra.encrypted ?? false,
	}
	if (extra.identity !== undefined) row.identity = extra.identity
	if (extra.talkgroup !== undefined) row.talkgroup = extra.talkgroup
	return row
}

function analog(
	outcome: ProofAnalogInput["outcome"],
	mode: ProofAnalogInput["mode"],
	at: number,
	tone: ProofAnalogInput["tone"] = { ctcssHz: null, dcs: null },
	voice: boolean = outcome === "heard",
): ProofAnalogInput {
	return {
		outcome,
		mode,
		voice,
		tone,
		transport: "live",
		at,
	}
}

function proof(over: Partial<ProofInput> = {}): ProofInput {
	return {
		observationId: "obs-1",
		decodes: [],
		trials: [],
		analog: [],
		unavailable: [],
		trust: "commanded",
		digitalPlanComplete: false,
		...over,
	}
}

const ais: Identity = { kind: "ais-mmsi", value: "211234567" }
const cc: Identity = { kind: "dmr-cc", value: "1" }
const tone = { ctcssHz: 88.5, dcs: null }
const dcs = { ctcssHz: null, dcs: { code: "023", polarity: "normal" as const } }

describe("labelFromEvidence", () => {
	it("follows the evidence table and fails closed", () => {
		const cases: [ProofInput, EvidenceLabel][] = [
			[proof(), SAFE],
			[
				proof({
					decodes: [decode("ais", 5, { identity: ais, transport: "ambient" })],
				}),
				{ protocol: "ais", family: "packet", confidence: "decoded" },
			],
			[
				proof({ decodes: [decode("dmr", 5, { talkgroup: "9" })] }),
				{ protocol: "dmr", family: "digital-voice", confidence: "activity" },
			],
			[
				proof({ analog: [analog("decoded", "nfm", 5, tone)] }),
				{ protocol: "analog-fm", family: "analog", confidence: "classified" },
			],
			[
				proof({
					trust: "relay",
					analog: [analog("decoded", "nfm", 5, tone)],
				}),
				{ protocol: "analog-fm", family: "analog", confidence: "classified" },
			],
			[
				proof({
					trust: "unverified",
					analog: [analog("decoded", "nfm", 5, tone)],
				}),
				{ protocol: "analog-fm", family: "analog", confidence: "candidate" },
			],
			[
				proof({ analog: [analog("decoded", "am", 5, tone)] }),
				{ protocol: "analog-am", family: "analog", confidence: "classified" },
			],
			[
				proof({ analog: [analog("decoded", "nfm", 5, dcs)] }),
				{ protocol: "analog-fm", family: "analog", confidence: "classified" },
			],
			[
				proof({ analog: [analog("heard", "nfm", 5)] }),
				{ protocol: "analog-fm", family: "analog", confidence: "candidate" },
			],
			[
				proof({ analog: [analog("heard", "am", 5)] }),
				{ protocol: "analog-am", family: "analog", confidence: "candidate" },
			],
			[
				proof({
					digitalPlanComplete: true,
					analog: [analog("data-like", "nfm", 5)],
				}),
				{
					protocol: "digital-unknown",
					family: "unknown",
					confidence: "candidate",
				},
			],
			[proof({ analog: [analog("data-like", "nfm", 5)] }), SAFE],
			[
				proof({ analog: [analog("carrier-only", "nfm", 5)] }),
				{ protocol: "carrier", family: "carrier", confidence: "activity" },
			],
			[proof({ analog: [analog("no-sync", "nfm", 5)] }), SAFE],
			// An identity-less decode ranks below an analog tone proof.
			[
				proof({
					decodes: [decode("dmr", 1)],
					analog: [analog("decoded", "nfm", 9, tone)],
				}),
				{ protocol: "analog-fm", family: "analog", confidence: "classified" },
			],
			[
				proof({
					decodes: [decode("pocsag", 1), decode("dmr", 2, { identity: cc })],
				}),
				{ protocol: "dmr", family: "digital-voice", confidence: "decoded" },
			],
			[
				proof({
					decodes: [decode("dmr", 1, { identity: cc }), decode("pocsag", 9)],
				}),
				{ protocol: "dmr", family: "digital-voice", confidence: "decoded" },
			],
			[
				proof({
					decodes: [
						decode("ysf", 4, { identity: { kind: "ysf-dgid", value: "1" } }),
						decode("dmr", 4, { identity: cc }),
					],
				}),
				{ protocol: "dmr", family: "digital-voice", confidence: "decoded" },
			],
			[
				proof({
					decodes: [
						{
							...decode("dmr", 3),
							protocol: "not-a-protocol",
						} as unknown as ProofDecodeInput,
						decode("ais", 3, { identity: ais, transport: "ambient" }),
					],
				}),
				{ protocol: "ais", family: "packet", confidence: "decoded" },
			],
			[
				proof({
					trust: "bogus" as "commanded",
					analog: [analog("decoded", "nfm", 5, tone)],
				}),
				SAFE,
			],
			[
				proof({
					trust: "bogus" as "commanded",
					decodes: [decode("ais", 4, { identity: ais, transport: "ambient" })],
					analog: [analog("decoded", "nfm", 9, tone)],
				}),
				{ protocol: "ais", family: "packet", confidence: "decoded" },
			],
			[
				proof({
					trust: "bogus" as "commanded",
					analog: [analog("heard", "nfm", 5), analog("carrier-only", "am", 1)],
				}),
				{ protocol: "carrier", family: "carrier", confidence: "activity" },
			],
			[
				proof({ decodes: [decode("dmr", 5, { identity: cc })] }),
				{ protocol: "dmr", family: "digital-voice", confidence: "decoded" },
			],
			[
				proof({
					analog: [analog("decoded", "nfm", 5, { ctcssHz: 0, dcs: null })],
				}),
				SAFE,
			],
			[
				proof({
					digitalPlanComplete: true,
					decodes: [decode("pocsag", 2)],
					analog: [analog("data-like", "nfm", 9)],
				}),
				{ protocol: "pocsag", family: "pager", confidence: "activity" },
			],
			[
				proof({
					decodes: [
						decode("dmr", 5, {
							identity: { kind: "dmr-cc", value: "garbage" },
						}),
					],
				}),
				{ protocol: "dmr", family: "digital-voice", confidence: "decoded" },
			],
			[
				proof({
					decodes: [
						decode("carrier", 5, {
							identity: { kind: "dmr-cc", value: "1" },
						}),
					],
				}),
				SAFE,
			],
			[
				proof({
					decodes: [
						decode("dmr", 1, {
							identity: { kind: "p25-nac", value: "293" },
						}),
						decode("ais", 2, { identity: ais, transport: "ambient" }),
					],
				}),
				{ protocol: "ais", family: "packet", confidence: "decoded" },
			],
			[
				proof({
					decodes: [
						decode("analog-fm", 1, { identity: cc }),
						decode("digital-unknown", 2, { identity: cc }),
					],
				}),
				SAFE,
			],
			[
				proof({
					analog: [
						analog("heard", "nfm", 5, { ctcssHz: null, dcs: null }, false),
					],
				}),
				SAFE,
			],
			[proof({ analog: [analog("heard", "nfm", 5, tone)] }), SAFE],
			[
				proof({
					digitalPlanComplete: true,
					analog: [
						analog("data-like", "nfm", 5, { ctcssHz: null, dcs: null }, true),
					],
				}),
				SAFE,
			],
			[
				proof({
					digitalPlanComplete: true,
					analog: [analog("data-like", "nfm", 5, tone)],
				}),
				SAFE,
			],
			[
				proof({
					analog: [
						analog(
							"carrier-only",
							"nfm",
							5,
							{ ctcssHz: null, dcs: null },
							true,
						),
					],
				}),
				SAFE,
			],
			[proof({ analog: [analog("carrier-only", "nfm", 5, dcs)] }), SAFE],
			[
				proof({
					analog: [
						analog("heard", "nfm", 9, { ctcssHz: null, dcs: null }, false),
						analog("carrier-only", "nfm", 1),
					],
				}),
				{ protocol: "carrier", family: "carrier", confidence: "activity" },
			],
		]
		for (const [input, want] of cases) {
			expect(labelFromEvidence(input)).toEqual(want)
		}
		const broken = [
			null,
			undefined,
			1,
			"obs",
			[],
			{},
			{ ...proof(), observationId: "" },
			{ ...proof(), decodes: "nope" },
			{ ...proof(), digitalPlanComplete: "yes" },
			{ ...proof(), trust: 1 },
		]
		for (const input of broken) {
			expect(labelFromEvidence(input as ProofInput)).toEqual(SAFE)
			expect(labelFromEvidence(input as ProofInput)).toEqual(UNKNOWN_LABEL)
		}
	})

	it("confirms a decode when its identity kind belongs to the protocol", () => {
		const proved: readonly [ScannerProtocol, Identity][] = [
			["dmr", { kind: "dmr-cc", value: "15" }],
			["dmr", { kind: "dmr-cc", value: "garbage" }],
			["p25p1", { kind: "p25-nac", value: "0293" }],
			["p25p2", { kind: "p25-nac", value: "293" }],
			["nxdn48", { kind: "nxdn-ran", value: "0" }],
			["nxdn96", { kind: "nxdn-ran", value: "63" }],
			["ysf", { kind: "ysf-dgid", value: "127" }],
			["dstar", { kind: "dstar-call", value: "DL1ABC" }],
			["dpmr", { kind: "dpmr-cc", value: "63" }],
			["pocsag", { kind: "pocsag-capcode", value: "1234567" }],
			["flex", { kind: "pocsag-capcode", value: "001234567" }],
			["aprs", { kind: "aprs-call", value: "DL1ABC-9" }],
			["ism", { kind: "ism-model", value: "Acurite-Tower:1234" }],
			[
				"ism",
				{
					kind: "ism-model",
					value: "x".repeat(MAX_IDENTITY_VALUE_LENGTH),
				},
			],
			["ais", { kind: "ais-mmsi", value: "211234567" }],
			["acars", { kind: "acars-reg", value: "G-ABCD" }],
			["vdl2", { kind: "vdl2-addr", value: "4CA1B2" }],
			["lora", { kind: "lora-node", value: "!deadbeef" }],
		]
		for (const [protocol, identity] of proved) {
			expect(identityFitsProtocol(protocol, identity)).toBe(true)
			expect(
				labelFromEvidence(
					proof({ decodes: [decode(protocol, 1, { identity })] }),
				),
			).toEqual({
				protocol,
				family: familyOf(protocol),
				confidence: "decoded",
			})
		}
		const refused: readonly [ScannerProtocol, Identity][] = [
			["dmr", { kind: "dmr-cc", value: "" }],
			[
				"dmr",
				{
					kind: "dmr-cc",
					value: "x".repeat(MAX_IDENTITY_VALUE_LENGTH + 1),
				},
			],
			["dmr", { kind: "p25-nac", value: "1" }],
			["carrier", { kind: "dmr-cc", value: "1" }],
			["analog-fm", { kind: "dmr-cc", value: "1" }],
			["analog-am", { kind: "dmr-cc", value: "1" }],
			["digital-unknown", { kind: "dmr-cc", value: "1" }],
			["unknown", { kind: "dmr-cc", value: "1" }],
		]
		for (const [protocol, identity] of refused) {
			expect(identityFitsProtocol(protocol, identity)).toBe(false)
			expect(
				labelFromEvidence(
					proof({ decodes: [decode(protocol, 1, { identity })] }),
				),
			).toEqual(SAFE)
		}
	})

	it("labels confirm-interpreter identities decoded", () => {
		const labelOf = (ev: DecodeEvidence): EvidenceLabel => {
			const row: ProofDecodeInput = {
				protocol: ev.protocol,
				transport: ev.origin === "ambient" ? "ambient" : "live",
				at: ev.at,
				encrypted: ev.encrypted === true,
			}
			if (ev.identity !== undefined) row.identity = ev.identity
			return labelFromEvidence(proof({ decodes: [row] }))
		}
		const one = (items: readonly DecodeEvidence[]): DecodeEvidence => {
			expect(items).toHaveLength(1)
			const item = items[0]
			if (item === undefined) throw new Error("missing evidence")
			return item
		}
		const link = (
			line: Partial<DsdFmeLinkLine> & Pick<DsdFmeLinkLine, "protocol">,
		): DsdFmeScannerEvent => ({
			kind: "link",
			line: { crcErr: false, at: T0, ...line },
		})
		const p25 = createInterpreterState({ epoch: 1, origin: "probe" })
		expect(
			interpretDsdFme(link({ protocol: "p25", nac: "0293" }), p25),
		).toEqual([])
		const nac = one(
			interpretDsdFme(link({ protocol: "p25", nac: "0293", at: T0 + 1 }), p25),
		)
		expect(nac.identity).toEqual({ kind: "p25-nac", value: "0293" })
		expect(labelOf(nac)).toEqual({
			protocol: "p25p1",
			family: "digital-voice",
			confidence: "decoded",
		})

		const model = "M".repeat(120)
		const deviceId = "12345678"
		const deviceValue = `${model}:${deviceId}`
		expect(deviceValue).toHaveLength(129)
		const ism = createInterpreterState({ epoch: 1, origin: "probe" })
		const dev = (at: number): DecoderOutputLike => ({
			type: "signal",
			timestamp: new Date(at),
			data: { model, id: deviceId, mic: "CRC" },
		})
		expect(interpretRtl433(dev(T0), ism)).toEqual([])
		const device = one(interpretRtl433(dev(T0 + 1), ism))
		expect(device.identity).toEqual({ kind: "ism-model", value: deviceValue })
		expect(labelOf(device)).toEqual({
			protocol: "ism",
			family: "ism",
			confidence: "decoded",
		})

		const pager = createInterpreterState({ epoch: 1, origin: "probe" })
		const pocsag = one(
			interpretMultimon(
				{
					type: "message",
					timestamp: new Date(T0),
					data: {
						protocol: "POCSAG1200",
						address: 1234567,
						function: 3,
						messageType: "alpha",
						message: "CALL OFFICE 0800",
					},
				},
				pager,
			),
		)
		expect(pocsag.identity).toEqual({
			kind: "pocsag-capcode",
			value: "1234567",
		})
		expect(labelOf(pocsag)).toEqual({
			protocol: "pocsag",
			family: "pager",
			confidence: "decoded",
		})

		const aisState = createInterpreterState({
			epoch: 1,
			origin: "ambient",
			decoderId: "ais",
		})
		const ship = (at: number): DecoderOutputLike => ({
			type: "ship",
			timestamp: new Date(at),
			data: { mmsi: "235000001", channel: "A" },
		})
		const aisCtx = { targetsHz: [161_975_000] }
		expect(
			interpretAis(ship(T0), aisState, aisCtx)[0]?.identity,
		).toBeUndefined()
		const aisEv = one(interpretAis(ship(T0 + 1), aisState, aisCtx))
		expect(aisEv.identity).toEqual({ kind: "ais-mmsi", value: "235000001" })
		expect(labelOf(aisEv)).toEqual({
			protocol: "ais",
			family: "packet",
			confidence: "decoded",
		})
	})

	it("returns the safe label when a getter throws", () => {
		const input = proof()
		Object.defineProperty(input, "decodes", {
			get() {
				throw new Error("decode getter")
			},
		})
		expect(labelFromEvidence(input)).toEqual(UNKNOWN_LABEL)
		const nested = proof({
			decodes: [
				Object.defineProperty(decode("dmr", 1, { identity: cc }), "identity", {
					get() {
						throw new Error("identity getter")
					},
				}),
			],
		})
		expect(labelFromEvidence(nested)).toEqual(UNKNOWN_LABEL)
	})

	it("returns the safe label when a proxy throws", () => {
		const input = new Proxy(proof(), {
			get() {
				throw new Error("proxy")
			},
		})
		expect(labelFromEvidence(input)).toEqual(UNKNOWN_LABEL)
		const row = new Proxy(
			decode("ais", 1, { identity: ais, transport: "ambient" }),
			{
				get(target, key, receiver) {
					if (key === "identity") throw new Error("nested proxy")
					return Reflect.get(target, key, receiver)
				},
			},
		)
		expect(labelFromEvidence(proof({ decodes: [row] }))).toEqual(UNKNOWN_LABEL)
	})

	// Feature: scanner-redesign, Property 7: Labels only from evidence
	// Validates: Requirements 3.1, 3.2, 3.3, 3.9
	it("names a protocol only from accepted evidence, and agrees with itself", () => {
		const identityArb = fc.record({
			kind: fc.constantFrom(...KINDS),
			value: fc.string({ minLength: 1, maxLength: 8 }),
		})
		const decodeArb = fc.record({
			protocol: fc.constantFrom(...NAMED, "unknown", "not-a-protocol"),
			transport: fc.constantFrom(...TRANSPORTS, "nope"),
			at: fc.integer({ min: 0, max: 5_000 }),
			encrypted: fc.boolean(),
			withIdentity: fc.boolean(),
			identity: identityArb,
			badIdentity: fc.boolean(),
		})
		const analogArb = fc.record({
			outcome: fc.constantFrom(...OUTCOMES),
			mode: fc.constantFrom("nfm" as const, "am" as const, "lsb" as const),
			at: fc.integer({ min: 0, max: 5_000 }),
			voice: fc.boolean(),
			ctcssHz: fc.oneof(
				fc.constant(null),
				fc.double({ min: -1, max: 250, noNaN: true }),
			),
			dcs: fc.oneof(
				fc.constant(null),
				fc.record({
					code: fc.constantFrom("023", "999", "23", ""),
					polarity: fc.constantFrom(
						"normal" as const,
						"inverted" as const,
						"nope" as const,
					),
				}),
			),
		})
		fc.assert(
			fc.property(
				fc.record({
					observationId: fc.string({ minLength: 1, maxLength: 16 }),
					trust: fc.constantFrom(...TRUSTS, "mystery", ""),
					digitalPlanComplete: fc.boolean(),
					decodes: fc.array(decodeArb, { maxLength: 5 }),
					analog: fc.array(analogArb, { maxLength: 5 }),
				}),
				fc.constantFrom(null, 1, "", [], {}),
				(raw, garbage) => {
					const input: ProofInput = {
						observationId: raw.observationId,
						decodes: raw.decodes.map(row => {
							const item: ProofDecodeInput = {
								protocol: row.protocol as ScannerProtocol,
								transport: row.transport as ProofDecodeInput["transport"],
								at: row.at,
								encrypted: row.encrypted,
							}
							if (row.withIdentity)
								item.identity = row.badIdentity
									? { kind: "dmr-cc", value: "" }
									: row.identity
							return item
						}),
						trials: [],
						analog: raw.analog.map(
							row =>
								({
									outcome: row.outcome,
									mode: row.mode,
									voice: row.voice,
									tone: { ctcssHz: row.ctcssHz, dcs: row.dcs },
									transport: "live",
									at: row.at,
								}) as ProofAnalogInput,
						),
						unavailable: [],
						trust: raw.trust as ProofInput["trust"],
						digitalPlanComplete: raw.digitalPlanComplete,
					}
					const once = labelFromEvidence(input)
					expect(labelFromEvidence(input)).toEqual(once)
					expect(once.family).toBe(familyOf(once.protocol))
					expect(() => labelFromEvidence(garbage as ProofInput)).not.toThrow()
					expect(labelFromEvidence(garbage as ProofInput)).toEqual(SAFE)
					if (once.protocol !== "unknown") {
						expect(
							input.decodes.some(row => decodeSupports(row, once.protocol)) ||
								input.analog.some(row => analogNames(row, once.protocol)),
						).toBe(true)
					}
					if (once.confidence === "decoded") {
						expect(
							input.decodes.some(
								row =>
									row.protocol === once.protocol &&
									identityProves(row.protocol, row.identity),
							),
						).toBe(true)
					}
					if (once.confidence === "classified") {
						expect(
							once.protocol === "analog-fm" || once.protocol === "analog-am",
						).toBe(true)
						expect(input.trust === "commanded" || input.trust === "relay").toBe(
							true,
						)
						expect(
							input.analog.some(
								row =>
									analogNames(row, once.protocol) && row.outcome === "decoded",
							),
						).toBe(true)
					}
					if (once.confidence === "candidate") {
						const trustKnown = TRUSTS.some(t => t === input.trust)
						const analogSupport =
							(once.protocol === "analog-fm" ||
								once.protocol === "analog-am") &&
							trustKnown &&
							input.analog.some(
								row =>
									analogNames(row, once.protocol) &&
									(row.outcome === "heard" || row.outcome === "decoded"),
							)
						const digitalSupport =
							once.protocol === "digital-unknown" &&
							input.digitalPlanComplete &&
							input.analog.some(
								row => row.outcome === "data-like" && !analogContradicts(row),
							)
						expect(analogSupport || digitalSupport).toBe(true)
					}
					expect(CONFIDENCE_RANK[once.confidence]).toBeLessThanOrEqual(
						CONFIDENCE_RANK.decoded,
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 7: Labels only from evidence
	// Validates: Requirements 3.1, 3.2, 3.3, 3.9
	it("never labels from contradictory analog or from garbage, and never throws", () => {
		const contradictory = fc.record({
			outcome: fc.constantFrom(
				"heard" as const,
				"data-like" as const,
				"carrier-only" as const,
				"decoded" as const,
			),
			mode: fc.constantFrom("nfm" as const, "am" as const),
			at: fc.integer({ min: 0, max: 20 }),
			// heard is voiced off; data-like and carrier-only are voiced on;
			// decoded carries no tone. Each of those disagrees with the decision order.
			flip: fc.boolean(),
		})
		const garbage = fc.oneof(
			fc.constant(null),
			fc.constant(undefined),
			fc.integer(),
			fc.string(),
			fc.array(fc.anything(), { maxLength: 3 }),
			fc.dictionary(fc.string({ maxLength: 8 }), fc.anything(), {
				maxKeys: 3,
			}),
		)
		fc.assert(
			fc.property(
				fc.array(contradictory, { minLength: 1, maxLength: 4 }),
				fc.constantFrom(...TRUSTS),
				fc.boolean(),
				garbage,
				(rows, trust, plan, junk) => {
					const analogRows = rows.map(row => {
						if (row.outcome === "heard")
							return analog(row.outcome, row.mode, row.at, undefined, false)
						if (row.outcome === "decoded")
							return analog(
								row.outcome,
								row.mode,
								row.at,
								row.flip
									? { ctcssHz: 0, dcs: null }
									: { ctcssHz: null, dcs: null },
								row.flip,
							)
						return analog(
							row.outcome,
							row.mode,
							row.at,
							row.flip
								? { ctcssHz: 88.5, dcs: null }
								: { ctcssHz: null, dcs: null },
							true,
						)
					})
					expect(analogRows.every(analogContradicts)).toBe(true)
					expect(
						labelFromEvidence(
							proof({
								analog: analogRows,
								trust,
								digitalPlanComplete: plan,
							}),
						),
					).toEqual(SAFE)
					const junkInput = junk as unknown as ProofInput
					expect(() => labelFromEvidence(junkInput)).not.toThrow()
					expect(labelFromEvidence(junkInput)).toEqual(SAFE)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 7: Labels only from evidence
	// Validates: Requirements 3.1, 3.2, 3.3, 3.9
	it("keeps a classified track unknown until a decode, then matches labelFromEvidence", () => {
		const priorArb = fc.double({ min: 0, max: 2, noNaN: true })
		fc.assert(
			fc.property(
				fc.record({
					slot: fc.integer({ min: 0, max: 6 }),
					blocks: fc.integer({ min: 1, max: 6 }),
					obwHz: fc.integer({ min: 1_000, max: 30_000 }),
					cls: fc.constantFrom(...CLASSES),
					score: fc.double({ min: 0, max: 1, noNaN: true }),
					hyp: fc.constantFrom(...PROTOCOLS),
					sweep: fc.boolean(),
					rangesListProtocols: fc.boolean(),
					ism: priorArb,
					dmr: priorArb,
					bandIsm: priorArb,
					first: fc.option(fc.constantFrom(...NAMED), { nil: undefined }),
					second: fc.constantFrom(...NAMED),
					ambient: fc.boolean(),
				}),
				spec => {
					const hz = 146_000_000 + spec.slot * 12_500
					const track = makeTrack({
						id: "o1",
						centreHz: hz,
						startedAt: T0,
						blocks: spec.blocks,
						obwHz: spec.obwHz,
					})
					const protocols: ScannerProtocol[] = spec.rangesListProtocols
						? [spec.hyp]
						: []
					const priors = withBandBurstPrior(
						{
							hz,
							priors: { ism: spec.ism, dmr: spec.dmr },
							protocols,
							rangesListProtocols: spec.rangesListProtocols,
							sweep: spec.sweep,
						},
						() => ({ ism: spec.bandIsm }),
					)
					const measured = classifySpectral(track, { priors, protocols })
					const store = new DiscoveryStore({
						maxDiscoveries: 20,
						now: () => T0,
						newId: counterIds(),
					})
					const created = store.ingest(
						makeObs({
							id: "o1",
							centreHz: hz,
							startedAt: T0,
							blocks: spec.blocks,
							obwHz: spec.obwHz,
							gate: "passed",
							cls: spec.cls,
							hypotheses: [[spec.hyp, spec.score]],
							tier: "channel",
						}),
					)
					const id = created.discoveryId ?? ""
					expect(store.get(id)?.protocol).toBe("unknown")
					expect(store.get(id)?.confidence).toBe("activity")
					expect(store.get(id)?.proof).toBeUndefined()
					store.applyClassification(id, measured)
					expect(store.get(id)?.protocol).toBe("unknown")
					expect(store.get(id)?.confidence).toBe("activity")
					const decodes: ProofDecodeInput[] = []
					if (spec.first !== undefined) {
						store.applyEvidence(
							id,
							evidence(spec.first, T0 + 10, { talkgroups: ["9"] }),
						)
						decodes.push(decode(spec.first, T0 + 10, { talkgroup: "9" }))
					}
					const origin = spec.ambient
						? ("ambient" as const)
						: ("probe" as const)
					store.applyEvidence(id, {
						...evidence(spec.second, T0 + 20, { identity: cc }),
						origin,
					})
					decodes.push(
						decode(spec.second, T0 + 20, {
							identity: cc,
							transport: spec.ambient ? "ambient" : "live",
						}),
					)
					const label = labelFromEvidence(
						proof({ observationId: id, decodes, trust: "commanded" }),
					)
					// Scanner-redesign 3.10: the stored ladder matches; without a proof it publishes unknown.
					const stored = store.snapshot().discoveries.find(d => d.id === id)
					expect(stored?.protocol).toBe(label.protocol)
					expect(stored?.confidence).toBe(label.confidence)
					expect(store.get(id)?.protocol).toBe("unknown")
					expect(store.get(id)?.confidence).toBe("activity")
					expect(store.get(id)?.proof).toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
	})
})
