import { describe, expect, it } from "vitest"
import {
	SCANNER_PROOF_PROTOCOL_LABEL,
	SCANNER_PROOF_SUMMARY_MAX_CHARS,
	SCANNER_PROOF_TRIED_MAX,
} from "@wavekit/api-types"
import type { ScannerProbeDecoderType } from "@wavekit/api-types"
import { labelFromEvidence } from "../../../../src/core/scanner/classify/label-from-evidence.js"
import {
	deriveProof,
	evidenceLevelOf,
	proofSummary,
	strongestKnownProof,
	strongestProof,
} from "../../../../src/core/scanner/proof.js"
import type {
	ProofAnalogInput,
	ProofDecodeInput,
	ProofInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	PROOF_ANALOG_MAX_PER_OBSERVATION,
	PROOF_TRIALS_MAX_PER_OBSERVATION,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Identity,
	ScannerProof,
	ScannerProtocol,
	ScannerProofTransport,
} from "../../../../src/core/scanner/types.js"

const AT = Date.UTC(2026, 9, 9, 12, 0, 0)
const ISO = "2026-10-09T12:00:00.000Z"

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

const RAN = new Set([
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"heard",
	"data-like",
	"carrier-only",
])

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

function decode(
	protocol: ScannerProtocol,
	at: number,
	extra: {
		identity?: Identity
		talkgroup?: string
		encrypted?: boolean
		transport?: ScannerProofTransport
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

function trial(
	protocol: ScannerProtocol,
	order: number,
	outcome: ProofTrialInput["outcome"] = "no-sync",
	extra: { decoder?: string; at?: number } = {},
): ProofTrialInput {
	return {
		protocol,
		decoder: extra.decoder ?? "dsd-fme",
		outcome,
		order,
		at: extra.at ?? AT + order,
	}
}

function analog(
	outcome: ProofAnalogInput["outcome"],
	at: number,
	extra: {
		mode?: ProofAnalogInput["mode"]
		voice?: boolean
		tone?: ProofAnalogInput["tone"]
		transport?: ScannerProofTransport
	} = {},
): ProofAnalogInput {
	const quiet = outcome !== "decoded"
	return {
		outcome,
		mode: extra.mode ?? "nfm",
		voice: extra.voice ?? outcome === "heard",
		tone: extra.tone ?? {
			ctcssHz: quiet ? null : 88.5,
			dcs: null,
		},
		transport: extra.transport ?? "live",
		at,
	}
}

type Bare = Omit<ScannerProof, "summary">

function bare(over: Partial<Bare> & Pick<Bare, "kind" | "protocol">): Bare {
	return {
		transport: "live",
		at: ISO,
		observationId: "obs-1",
		tried: [],
		unavailable: [],
		encrypted: false,
		...over,
	}
}

function dmr(
	extra: {
		identity?: Identity
		talkgroup?: string
		encrypted?: boolean
	} = {},
): Bare {
	const row = bare({
		kind: "decoded",
		protocol: "dmr",
		encrypted: extra.encrypted ?? false,
	})
	if (extra.identity !== undefined) row.identity = extra.identity
	if (extra.talkgroup !== undefined) row.talkgroup = extra.talkgroup
	return row
}

function tone(extra: {
	ctcssHz?: number
	dcs?: NonNullable<ProofAnalogInput["tone"]["dcs"]>
	voice: boolean
	mode?: "nfm" | "am"
}): Bare {
	return bare({
		kind: "analog-tone",
		protocol: extra.mode === "am" ? "analog-am" : "analog-fm",
		voice: extra.voice,
		tone: {
			ctcssHz: extra.ctcssHz ?? null,
			dcs: extra.dcs ?? null,
		},
	})
}

function voice(mode: "am" | "fm"): Bare {
	return bare({
		kind: "analog-voice",
		protocol: mode === "am" ? "analog-am" : "analog-fm",
		voice: true,
	})
}

function undecoded(
	tried: ScannerProtocol[],
	unavailable: ScannerProbeDecoderType[] = [],
): Bare {
	return bare({
		kind: "digital-undecoded",
		protocol: "digital-unknown",
		tried,
		unavailable,
	})
}

function carrier(): Bare {
	return bare({ kind: "carrier-only", protocol: "carrier" })
}

function dedupedLabels(protocols: readonly ScannerProtocol[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const protocol of protocols) {
		const label = SCANNER_PROOF_PROTOCOL_LABEL[protocol]
		if (seen.has(label)) continue
		seen.add(label)
		out.push(label)
	}
	return out
}

/** Spec sentence before the 160-character cap. Not the production truncator. */
function digitalSentence(
	labels: readonly string[],
	unavailable: readonly string[] = [],
): string {
	if (labels.length === 0) return "Digital, not decoded (no decoder available)"
	const parts: string[] = []
	if (labels.length > 0) parts.push(`tried ${labels.join(", ")}`)
	if (unavailable.length > 0)
		parts.push(`${unavailable.join(", ")} unavailable`)
	return `Digital, not decoded (${parts.join("; ")})`
}

/**
 * Spec cap: keep the longest label prefix whose `+<n> more` form fits in 160.
 * `n` counts labels omitted after NXDN dedupe.
 */
function cappedDigitalSentence(
	labels: readonly string[],
	unavailable: readonly string[] = [],
): string {
	const full = digitalSentence(labels, unavailable)
	if (full.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return full
	const tail = (kept: readonly string[], omitted: number): string => {
		const tried =
			kept.length === 0
				? `tried +${omitted} more`
				: `tried ${kept.join(", ")}, +${omitted} more`
		const parts = [tried]
		if (unavailable.length > 0)
			parts.push(`${unavailable.join(", ")} unavailable`)
		return `Digital, not decoded (${parts.join("; ")})`
	}
	for (let keep = labels.length - 1; keep >= 0; keep--) {
		const sentence = tail(labels.slice(0, keep), labels.length - keep)
		if (sentence.length <= SCANNER_PROOF_SUMMARY_MAX_CHARS) return sentence
	}
	return tail([], labels.length).slice(0, SCANNER_PROOF_SUMMARY_MAX_CHARS)
}

function analogTrial(row: ProofTrialInput): boolean {
	return (
		row.decoder === "analog-demod" ||
		row.decoder === "live-audio" ||
		row.protocol === "analog-fm" ||
		row.protocol === "analog-am"
	)
}

describe("proofSummary", () => {
	it("prints the fixed proof sentences", () => {
		expect(
			proofSummary(
				dmr({ identity: { kind: "dmr-cc", value: "1" }, talkgroup: "9" }),
			),
		).toBe("DMR decoded (CC1, TG 9)")
		expect(proofSummary(tone({ ctcssHz: 88.5, voice: true }))).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
		expect(
			proofSummary(
				tone({ dcs: { code: "023", polarity: "normal" }, voice: true }),
			),
		).toBe("Analog FM voice, DCS 023N")
		expect(
			proofSummary(
				tone({ dcs: { code: "023", polarity: "inverted" }, voice: true }),
			),
		).toBe("Analog FM voice, DCS 023I")
		expect(proofSummary(tone({ ctcssHz: 88.5, voice: false }))).toBe(
			"Analog FM, CTCSS 88.5",
		)
		expect(
			proofSummary(
				tone({
					ctcssHz: 88.5,
					dcs: { code: "023", polarity: "normal" },
					voice: true,
				}),
			),
		).toBe("Analog FM voice, CTCSS 88.5, DCS 023N")
		expect(proofSummary(voice("am"))).toBe("Analog AM voice")
		expect(proofSummary(voice("fm"))).toBe("Analog FM voice")
		expect(proofSummary(undecoded(["dmr", "dpmr", "nxdn48"]))).toBe(
			"Digital, not decoded (tried DMR, dPMR, NXDN)",
		)
		expect(proofSummary(undecoded(["nxdn96", "nxdn48", "dmr"]))).toBe(
			"Digital, not decoded (tried NXDN, DMR)",
		)
		expect(proofSummary(undecoded(["dpmr"], ["dsd-fme"]))).toBe(
			"Digital, not decoded (tried dPMR; dsd-fme unavailable)",
		)
		expect(proofSummary(undecoded([]))).toBe(
			"Digital, not decoded (no decoder available)",
		)
		expect(proofSummary(undecoded([], ["rtl433", "direwolf"]))).toBe(
			"Digital, not decoded (no decoder available)",
		)
		expect(proofSummary(carrier())).toBe("Carrier only")
		expect(proofSummary(dmr({ encrypted: true }))).toBe(
			"DMR decoded (encrypted)",
		)
		expect(
			proofSummary(
				dmr({
					identity: { kind: "dmr-cc", value: "1" },
					encrypted: true,
				}),
			),
		).toBe("DMR decoded (CC1, encrypted)")
	})

	it("formats the other identity parts and omits an empty talkgroup", () => {
		const cases: [Identity, string][] = [
			[{ kind: "dpmr-cc", value: "2" }, "dPMR decoded (CC2)"],
			[{ kind: "p25-nac", value: "1A2" }, "P25 decoded (NAC 1A2)"],
			[{ kind: "nxdn-ran", value: "4" }, "NXDN decoded (RAN 4)"],
			[{ kind: "ysf-dgid", value: "7" }, "YSF decoded (DG-ID 7)"],
			[{ kind: "pocsag-capcode", value: "99" }, "POCSAG decoded (capcode 99)"],
			[
				{ kind: "ais-mmsi", value: "211234567" },
				"AIS decoded (MMSI 211234567)",
			],
			[{ kind: "aprs-call", value: "N0CALL" }, "APRS decoded (N0CALL)"],
		]
		const protocol: Record<Identity["kind"], ScannerProtocol> = {
			"dmr-cc": "dmr",
			"dpmr-cc": "dpmr",
			"p25-nac": "p25p1",
			"nxdn-ran": "nxdn48",
			"ysf-dgid": "ysf",
			"pocsag-capcode": "pocsag",
			"ais-mmsi": "ais",
			"aprs-call": "aprs",
			"dstar-call": "dstar",
			"ism-model": "ism",
			"acars-reg": "acars",
			"vdl2-addr": "vdl2",
			"lora-node": "lora",
		}
		for (const [identity, summary] of cases) {
			expect(
				proofSummary(
					bare({
						kind: "decoded",
						protocol: protocol[identity.kind],
						identity,
						talkgroup: "",
					}),
				),
			).toBe(summary)
		}
	})

	it("keeps encrypted in a decoded summary and shortens the talkgroup or identity first", () => {
		const identity = { kind: "dmr-cc" as const, value: "1" }
		const at160 = "9".repeat(127)
		const exact = `DMR decoded (CC1, TG ${at160}, encrypted)`
		expect(exact).toHaveLength(160)
		expect(
			proofSummary(dmr({ identity, talkgroup: at160, encrypted: true })),
		).toBe(exact)
		const at161 = "9".repeat(128)
		expect(`DMR decoded (CC1, TG ${at161}, encrypted)`).toHaveLength(161)
		const shortened = proofSummary(
			dmr({ identity, talkgroup: at161, encrypted: true }),
		)
		expect(shortened).toBe(`DMR decoded (CC1, TG ${at160}, encrypted)`)
		expect(shortened.endsWith(", encrypted)")).toBe(true)
		const longTalk = proofSummary(
			dmr({
				identity,
				talkgroup: "9".repeat(200),
				encrypted: true,
			}),
		)
		expect(longTalk).toContain("encrypted")
		expect(longTalk).toContain("CC1")
		expect(longTalk.length).toBeLessThanOrEqual(160)
		expect(longTalk).not.toBe("DMR decoded (CC1)")
		const longIdentity = proofSummary(
			dmr({
				identity: { kind: "dmr-cc", value: "1".repeat(1024) },
				talkgroup: "9",
				encrypted: true,
			}),
		)
		expect(longIdentity).toContain("encrypted")
		expect(longIdentity.startsWith("DMR decoded (CC")).toBe(true)
		expect(longIdentity.length).toBeLessThanOrEqual(160)
		expect(longIdentity).not.toBe("DMR decoded")
	})

	it("caps a digital summary at 160 characters on the character bound and one past it", () => {
		const unique = [...PROTOCOLS]
			.filter(protocol => protocol !== "nxdn96")
			.sort((a, b) => {
				const delta =
					SCANNER_PROOF_PROTOCOL_LABEL[b].length -
					SCANNER_PROOF_PROTOCOL_LABEL[a].length
				return delta !== 0
					? delta
					: SCANNER_PROOF_PROTOCOL_LABEL[a] < SCANNER_PROOF_PROTOCOL_LABEL[b]
						? -1
						: 1
			})
		let fit: ScannerProtocol[] = []
		let past: ScannerProtocol[] | undefined
		for (const protocol of unique) {
			const next = [...fit, protocol]
			if (
				digitalSentence(dedupedLabels(next)).length <=
				SCANNER_PROOF_SUMMARY_MAX_CHARS
			)
				fit = next
			else {
				past = next
				break
			}
		}
		expect(past).toBeDefined()
		const fitLabels = dedupedLabels(fit)
		const fitSentence = digitalSentence(fitLabels)
		expect(fitSentence.length).toBeLessThanOrEqual(
			SCANNER_PROOF_SUMMARY_MAX_CHARS,
		)
		expect(fitSentence).not.toMatch(/\+\d+ more/)
		expect(proofSummary(undecoded(fit))).toBe(fitSentence)
		const pastLabels = dedupedLabels(past ?? [])
		const pastSentence = cappedDigitalSentence(pastLabels)
		expect(digitalSentence(pastLabels).length).toBeGreaterThan(
			SCANNER_PROOF_SUMMARY_MAX_CHARS,
		)
		expect(pastSentence.length).toBeLessThanOrEqual(
			SCANNER_PROOF_SUMMARY_MAX_CHARS,
		)
		expect(pastSentence).toMatch(/\+\d+ more\)$/)
		expect(proofSummary(undecoded(past ?? []))).toBe(pastSentence)
		const withGap = cappedDigitalSentence(pastLabels, ["dsd-fme"])
		expect(withGap.length).toBeLessThanOrEqual(SCANNER_PROOF_SUMMARY_MAX_CHARS)
		expect(withGap).toMatch(/\+\d+ more; dsd-fme unavailable\)$/)
		expect(proofSummary(undecoded(past ?? [], ["dsd-fme"]))).toBe(withGap)
		// Frame is "Digital, not decoded (tried )" = 29. Sixteen longest labels fit.
		expect(fit.length).toBeGreaterThanOrEqual(SCANNER_PROOF_TRIED_MAX)
	})
})

describe("deriveProof", () => {
	it("drops a talkgroup past the identity bound so the derived proof stays valid", () => {
		const derived = deriveProof(
			proof({
				decodes: [
					decode("dmr", AT, {
						identity: { kind: "dmr-cc", value: "1" },
						talkgroup: "1".repeat(1025),
					}),
				],
			}),
		)
		expect(derived?.talkgroup).toBeUndefined()
		expect(evidenceLevelOf(derived === null ? {} : { proof: derived })).toBe(
			"proven",
		)
	})

	it("rejects an analog voice proof that says no voice", () => {
		const heard = deriveProof(proof({ analog: [analog("heard", AT, {})] }))
		expect(heard?.kind).toBe("analog-voice")
		if (heard === null) return
		expect(evidenceLevelOf({ proof: heard })).toBe("proven")
		expect(evidenceLevelOf({ proof: { ...heard, voice: false } })).toBe("weak")
	})

	it("names a decoded proof only from an accepted identity, including ambient and replay", () => {
		const live = deriveProof(
			proof({
				decodes: [
					decode("dmr", AT, {
						identity: { kind: "dmr-cc", value: "1" },
						talkgroup: "9",
					}),
				],
			}),
		)
		expect(live?.kind).toBe("decoded")
		expect(live?.protocol).toBe("dmr")
		expect(live?.transport).toBe("live")
		expect(live?.at).toBe(ISO)
		expect(live?.observationId).toBe("obs-1")
		expect(live?.encrypted).toBe(false)
		expect(live?.summary).toBe("DMR decoded (CC1, TG 9)")
		expect(
			labelFromEvidence(
				proof({
					decodes:
						live === null
							? []
							: [
									decode("dmr", AT, {
										identity: { kind: "dmr-cc", value: "1" },
										talkgroup: "9",
									}),
								],
				}),
			).confidence,
		).toBe("decoded")
		const ambient = deriveProof(
			proof({
				decodes: [
					decode("ais", AT, {
						identity: { kind: "ais-mmsi", value: "211234567" },
						transport: "ambient",
					}),
				],
			}),
		)
		expect(ambient?.transport).toBe("ambient")
		expect(ambient?.summary).toBe("AIS decoded (MMSI 211234567)")
		const replay = deriveProof(
			proof({
				decodes: [
					decode("dmr", AT, {
						identity: { kind: "dmr-cc", value: "1" },
						transport: "replay",
						encrypted: true,
					}),
				],
			}),
		)
		expect(replay?.transport).toBe("replay")
		expect(replay?.encrypted).toBe(true)
		expect(replay?.summary).toBe("DMR decoded (CC1, encrypted)")
	})

	it("returns null for an identity-less or encrypted decode that the label does not call decoded", () => {
		const input = proof({
			decodes: [decode("dmr", AT, { encrypted: true, talkgroup: "9" })],
		})
		expect(labelFromEvidence(input).confidence).not.toBe("decoded")
		expect(deriveProof(input)).toBeNull()
		expect(deriveProof(proof({ decodes: [decode("dmr", AT)] }))).toBeNull()
	})

	it("follows the label for tone, voice, digital and carrier, and skips unknown trust for analog audio", () => {
		const toneInput = proof({
			analog: [analog("decoded", AT, { voice: true })],
		})
		expect(deriveProof(toneInput)?.summary).toBe("Analog FM voice, CTCSS 88.5")
		expect(deriveProof({ ...toneInput, trust: "relay" })?.kind).toBe(
			"analog-tone",
		)
		expect(deriveProof({ ...toneInput, trust: "unverified" })?.kind).toBe(
			"analog-tone",
		)
		expect(
			deriveProof({ ...toneInput, trust: "unknown" } as unknown as ProofInput),
		).toBeNull()
		const heard = proof({ analog: [analog("heard", AT, { mode: "am" })] })
		expect(deriveProof(heard)?.summary).toBe("Analog AM voice")
		expect(deriveProof({ ...heard, trust: "unverified" })?.kind).toBe(
			"analog-voice",
		)
		expect(deriveProof({ ...heard, trust: "nope" as "commanded" })).toBeNull()
		const digital = proof({
			analog: [analog("data-like", AT)],
			digitalPlanComplete: true,
			trials: [trial("dmr", 1), trial("dpmr", 2), trial("nxdn48", 3)],
		})
		expect(deriveProof(digital)?.summary).toBe(
			"Digital, not decoded (tried DMR, dPMR, NXDN)",
		)
		expect(
			deriveProof({ ...digital, trust: "unknown" } as unknown as ProofInput)
				?.kind,
		).toBe("digital-undecoded")
		expect(deriveProof({ ...digital, digitalPlanComplete: false })).toBeNull()
		const carrierInput = proof({ analog: [analog("carrier-only", AT)] })
		expect(deriveProof(carrierInput)?.summary).toBe("Carrier only")
		expect(
			deriveProof({
				...carrierInput,
				trust: "unknown",
			} as unknown as ProofInput)?.kind,
		).toBe("carrier-only")
		expect(deriveProof(proof())).toBeNull()
	})

	it("keeps tried to ran outcomes, excludes the analog trial unless it decoded, and omits unavailable decoders", () => {
		const input = proof({
			analog: [analog("data-like", AT)],
			digitalPlanComplete: true,
			trials: [
				trial("dmr", 3, "no-sync"),
				trial("p25p1", 1, "pending"),
				trial("p25p2", 2, "running"),
				trial("ysf", 4, "skipped-budget"),
				trial("dstar", 5, "unsupported"),
				trial("dpmr", 6, "cancelled"),
				trial("pocsag", 7, "not-needed"),
				trial("flex", 8, "timeout"),
				trial("analog-fm", 9, "heard", { decoder: "analog-demod" }),
				trial("analog-am", 10, "decoded", { decoder: "live-audio" }),
				trial("nxdn48", 11, "decoded"),
				trial("nope" as "dmr", 12, "no-sync"),
			],
			unavailable: ["dsd-fme", "dsd-fme", "not-a-decoder" as "rtl433"],
		})
		const got = deriveProof(input)
		expect(got?.tried).toEqual(["dmr", "flex", "analog-am", "nxdn48"])
		expect(got?.unavailable).toEqual(["dsd-fme"])
		expect(got?.tried.join(" ")).not.toContain("dsd-fme")
	})

	it("caps tried at 16 and keeps the earliest orders", () => {
		const trials = PROTOCOLS.filter(p => p !== "unknown").map((protocol, i) =>
			trial(protocol, i + 1),
		)
		expect(trials.length).toBeGreaterThan(SCANNER_PROOF_TRIED_MAX)
		const got = deriveProof(
			proof({
				analog: [analog("data-like", AT)],
				digitalPlanComplete: true,
				trials,
			}),
		)
		expect(got?.tried).toHaveLength(SCANNER_PROOF_TRIED_MAX)
		expect(got?.tried).toEqual(
			trials.slice(0, SCANNER_PROOF_TRIED_MAX).map(row => row.protocol),
		)
		expect(got?.tried).not.toContain(trials[SCANNER_PROOF_TRIED_MAX]?.protocol)
	})

	it("returns null on missing, malformed and throwing inputs", () => {
		expect(deriveProof(undefined as unknown as ProofInput)).toBeNull()
		expect(deriveProof(proof({ observationId: "" }))).toBeNull()
		expect(
			deriveProof(proof({ digitalPlanComplete: "yes" as unknown as boolean })),
		).toBeNull()
		expect(deriveProof(proof({ decodes: null as unknown as [] }))).toBeNull()
		const throwing = new Proxy(proof(), {
			get(target, key) {
				if (key === "decodes") throw new Error("decode blew up")
				return Reflect.get(target, key)
			},
		})
		expect(() => deriveProof(throwing)).not.toThrow()
		expect(deriveProof(throwing)).toBeNull()
		const badDecode = new Proxy(
			decode("dmr", AT, { identity: { kind: "dmr-cc", value: "1" } }),
			{
				get(target, key) {
					if (key === "at") throw new Error("at blew up")
					return Reflect.get(target, key)
				},
			},
		)
		expect(
			deriveProof(proof({ decodes: [badDecode as ProofDecodeInput] })),
		).toBeNull()
		expect(
			deriveProof(
				proof({
					decodes: [
						decode("dmr", AT, {
							identity: { kind: "ais-mmsi", value: "211234567" },
						}),
					],
				}),
			),
		).toBeNull()
	})

	it("uses the newest naming row and does not alias caller-owned identity or tone", () => {
		const older = decode("dmr", AT, {
			identity: { kind: "dmr-cc", value: "1" },
		})
		const newer = decode("p25p1", AT + 5, {
			identity: { kind: "p25-nac", value: "AB" },
		})
		const got = deriveProof(proof({ decodes: [older, newer] }))
		expect(got?.summary).toBe("P25 decoded (NAC AB)")
		if (newer.identity === undefined) throw new Error("missing identity")
		newer.identity.value = "FF"
		expect(got?.identity?.value).toBe("AB")
		const toneRow = analog("decoded", AT, { voice: true })
		const named = deriveProof(proof({ analog: [toneRow] }))
		toneRow.tone.ctcssHz = 100
		expect(named?.summary).toBe("Analog FM voice, CTCSS 88.5")
		expect(named?.tone?.ctcssHz).toBe(88.5)
	})
})

describe("identity-less decode rank", () => {
	it("ranks an identity-less decode below an analog tone and voice proof", () => {
		const stray = decode("dmr", AT + 5, { talkgroup: "9" })
		const toned = proof({
			decodes: [stray],
			analog: [analog("decoded", AT, { voice: true })],
		})
		expect(labelFromEvidence(toned)).toEqual({
			protocol: "analog-fm",
			family: "analog",
			confidence: "classified",
		})
		expect(deriveProof(toned)?.kind).toBe("analog-tone")
		expect(deriveProof(toned)?.summary).toBe("Analog FM voice, CTCSS 88.5")
		const heard = proof({ decodes: [stray], analog: [analog("heard", AT)] })
		expect(labelFromEvidence(heard).confidence).toBe("candidate")
		expect(deriveProof(heard)?.kind).toBe("analog-voice")
	})

	it("still names its protocol at activity, above a completed digital plan and a carrier", () => {
		const stray = decode("dmr", AT + 5, { talkgroup: "9" })
		const input = proof({
			decodes: [stray],
			analog: [analog("data-like", AT), analog("carrier-only", AT + 1)],
			trials: [trial("dmr", 1)],
			digitalPlanComplete: true,
		})
		expect(labelFromEvidence(input)).toEqual({
			protocol: "dmr",
			family: "digital-voice",
			confidence: "activity",
		})
		expect(deriveProof(input)).toBeNull()
	})

	it("an identity decode still beats a tone", () => {
		const input = proof({
			decodes: [
				decode("dmr", AT + 5, { identity: { kind: "dmr-cc", value: "1" } }),
			],
			analog: [analog("decoded", AT, { voice: true })],
		})
		expect(labelFromEvidence(input).confidence).toBe("decoded")
		expect(deriveProof(input)?.kind).toBe("decoded")
	})
})

describe("evidenceLevelOf", () => {
	it("is proven only for a proof of a known kind", () => {
		const named = deriveProof(proof({ analog: [analog("carrier-only", AT)] }))
		expect(named).not.toBeNull()
		if (named === null) throw new Error("missing proof")
		expect(evidenceLevelOf({ proof: named })).toBe("proven")
		expect(evidenceLevelOf({})).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: {
					...carrier(),
					summary: "Carrier only",
					kind: "nope",
				} as unknown as ScannerProof,
			}),
		).toBe("weak")
		const throwing = new Proxy(
			{},
			{
				get() {
					throw new Error("level blew up")
				},
			},
		)
		expect(evidenceLevelOf(throwing)).toBe("weak")
	})

	it("rejects a proof that does not match the grammar, including a throwing getter", () => {
		const named = deriveProof(proof({ analog: [analog("carrier-only", AT)] }))
		if (named === null) throw new Error("missing proof")
		expect(evidenceLevelOf({ proof: named })).toBe("proven")
		expect(
			evidenceLevelOf({
				proof: { kind: "decoded" } as ScannerProof,
			}),
		).toBe("weak")
		const broken: [string, ScannerProof][] = [
			["kind", { ...named, kind: "nope" as ScannerProof["kind"] }],
			["at", { ...named, at: "garbage" }],
			["at-number", { ...named, at: 1 as unknown as string }],
			["observationId", { ...named, observationId: 4 as unknown as string }],
			["observationId-empty", { ...named, observationId: "" }],
			["protocol", { ...named, protocol: "nope" as ScannerProof["protocol"] }],
			[
				"transport",
				{ ...named, transport: "probe" as ScannerProof["transport"] },
			],
			[
				"transport-missing",
				{
					...named,
					transport: undefined as unknown as ScannerProof["transport"],
				},
			],
			["tried", { ...named, tried: "dmr" as unknown as ScannerProof["tried"] }],
			[
				"unavailable",
				{
					...named,
					unavailable: null as unknown as ScannerProof["unavailable"],
				},
			],
			["summary", { ...named, summary: "x".repeat(161) }],
			["encrypted", { ...named, encrypted: "yes" as unknown as boolean }],
		]
		for (const [, row] of broken)
			expect(evidenceLevelOf({ proof: row })).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...named, summary: "x".repeat(160) },
			}),
		).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...named, transport: "replay" },
			}),
		).toBe("proven")
		const fields = [
			"kind",
			"protocol",
			"transport",
			"at",
			"observationId",
			"tried",
			"unavailable",
			"encrypted",
			"summary",
		] as const
		for (const field of fields) {
			const row = new Proxy(
				{ ...named },
				{
					get(target, key) {
						if (key === field) throw new Error(`${field} blew up`)
						return Reflect.get(target, key)
					},
				},
			)
			expect(evidenceLevelOf({ proof: row })).toBe("weak")
			expect(strongestProof([row, named])?.observationId).toBe(
				named.observationId,
			)
			expect(strongestProof([row])).toBeNull()
		}
		expect(
			strongestProof([
				{ kind: "decoded", at: "garbage" } as ScannerProof,
				named,
			])?.observationId,
		).toBe(named.observationId)
		expect(
			strongestProof([{ kind: "decoded", at: "garbage" } as ScannerProof]),
		).toBeNull()
	})

	it("rejects nested fields outside the proof grammar", () => {
		const decoded = deriveProof(
			proof({
				decodes: [
					decode("dmr", AT, {
						identity: { kind: "dmr-cc", value: "1" },
						talkgroup: "9",
					}),
				],
			}),
		)
		const carrierProof = deriveProof(
			proof({ analog: [analog("carrier-only", AT)] }),
		)
		if (decoded === null || carrierProof === null)
			throw new Error("missing proof")
		expect(evidenceLevelOf({ proof: decoded })).toBe("proven")
		expect(evidenceLevelOf({ proof: carrierProof })).toBe("proven")
		const seventeen = PROTOCOLS.slice(0, 17)
		expect(seventeen).toHaveLength(17)
		const weak: ScannerProof[] = [
			{ ...decoded, tried: [null as unknown as ScannerProtocol] },
			{
				...decoded,
				unavailable: [123 as unknown as ScannerProbeDecoderType],
			},
			{ ...decoded, tried: seventeen },
			{ ...decoded, tried: ["dmr", "dmr"] },
			{ ...decoded, unavailable: ["rtl433", "direwolf"] },
			{ ...decoded, identity: { kind: "p25-nac", value: "AB" } },
			{ ...carrierProof, identity: { kind: "dmr-cc", value: "1" } },
			{ ...decoded, tone: { ctcssHz: Number.NaN, dcs: null } },
			{ ...decoded, tone: { ctcssHz: 0, dcs: null } },
			{ ...decoded, talkgroup: "" },
			{ ...decoded, talkgroup: "x".repeat(1025) },
			{ ...decoded, kind: "analog-voice" },
			{ ...decoded, protocol: "analog-fm" },
			{ ...carrierProof, protocol: "dmr" },
			{ ...decoded, protocol: "digital-unknown" },
			{ ...decoded, protocol: "carrier" },
			{ ...decoded, kind: "digital-undecoded", protocol: "dmr" },
			{ ...decoded, kind: "carrier-only", protocol: "analog-fm" },
		]
		for (const row of weak) expect(evidenceLevelOf({ proof: row })).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...decoded, unavailable: ["direwolf", "rtl433"] },
			}),
		).toBe("proven")
		const longTalk = { ...decoded, talkgroup: "x".repeat(1024) }
		const { summary: _longSummary, ...longBare } = longTalk
		expect(
			evidenceLevelOf({
				proof: { ...longBare, summary: proofSummary(longBare) },
			}),
		).toBe("proven")
		expect(evidenceLevelOf({ proof: { ...decoded, tried: ["unknown"] } })).toBe(
			"proven",
		)
		const namedTone = deriveProof(
			proof({ analog: [analog("decoded", AT, { voice: true })] }),
		)
		if (namedTone === null) throw new Error("missing tone proof")
		expect(evidenceLevelOf({ proof: namedTone })).toBe("proven")
		expect(
			evidenceLevelOf({
				proof: {
					...namedTone,
					tone: { ctcssHz: Number.NaN, dcs: null },
				},
			}),
		).toBe("weak")
		const swapped: ScannerProof = {
			...carrierProof,
			kind: "analog-tone",
			protocol: "analog-fm",
			summary: "Carrier only",
		}
		expect(evidenceLevelOf({ proof: swapped })).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...swapped, summary: "Analog FM" },
			}),
		).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: {
					...carrierProof,
					tone: { ctcssHz: 88.5, dcs: null },
				},
			}),
		).toBe("weak")
		const digital = deriveProof(
			proof({
				analog: [analog("data-like", AT)],
				digitalPlanComplete: true,
			}),
		)
		const voiceProof = deriveProof(proof({ analog: [analog("heard", AT)] }))
		if (digital === null || voiceProof === null)
			throw new Error("missing proof")
		expect(
			evidenceLevelOf({
				proof: {
					...digital,
					tone: { ctcssHz: null, dcs: { code: "023", polarity: "normal" } },
				},
			}),
		).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: {
					...voiceProof,
					identity: { kind: "dmr-cc", value: "1" },
				},
			}),
		).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...decoded, summary: "not the derived sentence" },
			}),
		).toBe("weak")
		expect(
			evidenceLevelOf({
				proof: { ...namedTone, summary: "Analog FM voice, CTCSS 88.5" },
			}),
		).toBe("proven")
	})

	it("treats a commanded DCS decode with ctcssHz 0 as proven", () => {
		const got = deriveProof(
			proof({
				analog: [
					analog("decoded", AT, {
						voice: false,
						tone: {
							ctcssHz: 0,
							dcs: { code: "023", polarity: "normal" },
						},
					}),
				],
			}),
		)
		expect(got?.summary).toBe("Analog FM, DCS 023N")
		expect(got?.tone?.ctcssHz).toBeNull()
		expect(got?.tone?.dcs).toEqual({ code: "023", polarity: "normal" })
		if (got === null) throw new Error("missing proof")
		expect(evidenceLevelOf({ proof: got })).toBe("proven")
	})
})

describe("strongestProof", () => {
	it("ranks decoded above analog, digital and carrier, then the newest at", () => {
		const decoded = deriveProof(
			proof({
				observationId: "a",
				decodes: [
					decode("dmr", AT, { identity: { kind: "dmr-cc", value: "1" } }),
				],
			}),
		)
		const toneProof = deriveProof(
			proof({
				observationId: "b",
				analog: [analog("decoded", AT + 10_000, { voice: true })],
			}),
		)
		const voiceProof = deriveProof(
			proof({
				observationId: "c",
				analog: [analog("heard", AT + 20_000)],
			}),
		)
		const digital = deriveProof(
			proof({
				observationId: "d",
				analog: [analog("data-like", AT + 30_000)],
				digitalPlanComplete: true,
			}),
		)
		const only = deriveProof(
			proof({
				observationId: "e",
				analog: [analog("carrier-only", AT + 40_000)],
			}),
		)
		const proofs = [only, digital, voiceProof, toneProof, decoded].filter(
			(row): row is ScannerProof => row !== null,
		)
		expect(proofs).toHaveLength(5)
		expect(strongestProof(proofs)?.observationId).toBe("a")
		expect(
			strongestProof(
				[only, digital, voiceProof].filter(
					(row): row is ScannerProof => row !== null,
				),
			)?.kind,
		).toBe("analog-voice")
		const older = deriveProof(
			proof({
				observationId: "old",
				analog: [analog("carrier-only", AT)],
			}),
		)
		const newer = deriveProof(
			proof({
				observationId: "new",
				analog: [analog("carrier-only", AT + 1)],
			}),
		)
		expect(
			strongestProof(
				[older, newer].filter((row): row is ScannerProof => row !== null),
			)?.observationId,
		).toBe("new")
		const first = deriveProof(
			proof({
				observationId: "first",
				analog: [analog("carrier-only", AT)],
			}),
		)
		const second = deriveProof(
			proof({
				observationId: "second",
				analog: [analog("carrier-only", AT)],
			}),
		)
		expect(
			strongestProof(
				[first, second].filter((row): row is ScannerProof => row !== null),
			)?.observationId,
		).toBe("second")
		expect(strongestProof([])).toBeNull()
		const bad = new Proxy({} as ScannerProof, {
			get() {
				throw new Error("rank blew up")
			},
		})
		expect(
			strongestProof(
				[bad, only].filter((row): row is ScannerProof => row !== null),
			)?.observationId,
		).toBe("e")
		expect(() => strongestProof(bad as unknown as ScannerProof[])).not.toThrow()
		expect(strongestProof(bad as unknown as ScannerProof[])).toBeNull()
	})

	it("orders equal-rank proofs by parsed time, including a fractional second", () => {
		const base = deriveProof(proof({ analog: [analog("carrier-only", AT)] }))
		if (base === null) throw new Error("missing proof")
		const whole = {
			...base,
			at: "2020-01-02T00:00:00Z",
			observationId: "whole",
		}
		const fraction = {
			...base,
			at: "2020-01-02T00:00:00.100Z",
			observationId: "fraction",
		}
		expect(fraction.at < whole.at).toBe(true)
		expect(strongestProof([whole, fraction])?.observationId).toBe("fraction")
		expect(strongestProof([fraction, whole])?.observationId).toBe("fraction")
		expect(strongestKnownProof([whole, fraction])?.observationId).toBe(
			"fraction",
		)
		expect(strongestKnownProof([fraction, whole])?.observationId).toBe(
			"fraction",
		)
		const broken = { ...base, at: "not-a-time", observationId: "broken" }
		expect(strongestKnownProof([broken, whole])?.observationId).toBe("whole")
		expect(strongestKnownProof([whole, broken])?.observationId).toBe("whole")
		expect(strongestProof([broken, whole])?.observationId).toBe("whole")
	})
})

describe("proof bounds", () => {
	it("documents the frozen caps the sink and the summary share", () => {
		expect(PROOF_TRIALS_MAX_PER_OBSERVATION).toBe(32)
		expect(PROOF_ANALOG_MAX_PER_OBSERVATION).toBe(8)
		expect(SCANNER_PROOF_TRIED_MAX).toBe(16)
		expect(SCANNER_PROOF_SUMMARY_MAX_CHARS).toBe(160)
		expect("Digital, not decoded (tried )".length).toBe(29)
		expect(RAN.size).toBe(7)
		expect(
			analogTrial(trial("dmr", 1, "no-sync", { decoder: "analog-demod" })),
		).toBe(true)
	})
})
