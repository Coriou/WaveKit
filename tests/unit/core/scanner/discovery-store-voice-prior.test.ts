/**
 * DiscoveryStore.voicePrior composed with the recorder's policy (recording-verdict.ts), as
 * scanner-service wires it: a discovery decoded POCSAG within STRONG_PRIOR_TTL_MS admits a recording only
 * as a shadow its own tone must class, one decoded DMR only holds; a channel where analog voice
 * was heard (a recorder tone) keeps recording despite a decode; a folder nobody owns reads no
 * prior.
 */
import { describe, expect, it } from "vitest"
import {
	admissionVerdict,
	readPrior,
	STRONG_PRIOR_TTL_MS,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
}

const obs = (id: string, startedAt: number) =>
	makeObs({
		id,
		centreHz: CH,
		startedAt,
		cls: "analog-fm",
		open: false,
		gate: "passed",
	})

const tone = (at: number): ProofAnalogInput => ({
	outcome: "decoded",
	mode: "nfm",
	voice: false,
	tone: { ctcssHz: 88.5, dcs: null },
	transport: "live",
	at,
})

/** A discovery decoded DMR (checked colour code) by an earlier observation. */
function decodedDmr(store: DiscoveryStore): string {
	const id = store.ingest(obs("dig", T0)).discoveryId ?? ""
	const ev = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
	expect(store.appendObservationEvidence("dig", ev)).toBe(true)
	store.applyEvidence(id, ev)
	return store.discoveryIdOf("dig") ?? id
}

describe("DiscoveryStore.voicePrior", () => {
	it("a discovery decoded DMR at any earlier time is a suspect prior (held, never refused), labelled as the owner's", () => {
		const store = newStore()
		const id = decodedDmr(store)
		const prior = store.voicePrior(id) ?? null
		// The owner's own label, marked as the owner's, with the live owner's id.
		expect(prior?.id).toBe(id)
		expect(prior?.labels).toContainEqual(
			expect.objectContaining({
				protocol: "dmr",
				confidence: "decoded",
				owner: true,
			}),
		)
		expect(readPrior(prior, false, T0)).toBe("suspect")
		expect(admissionVerdict(prior, false, T0)).toBeNull()
	})

	it("a discovery decoded POCSAG admits a later recording only as a shadow its own tone must class", () => {
		const store = newStore()
		const id = store.ingest(obs("pager", T0)).discoveryId ?? ""
		const ev = evidence("pocsag", T0 + 500, {
			identity: { kind: "pocsag-capcode", value: "1234" },
		})
		expect(store.appendObservationEvidence("pager", ev)).toBe(true)
		store.applyEvidence(id, ev)
		const prior = store.voicePrior(id) ?? null
		// With its decode's time: strong for STRONG_PRIOR_TTL_MS after it, suspect past it.
		expect(prior?.labels).toContainEqual({
			protocol: "pocsag",
			confidence: "decoded",
			owner: true,
			at: T0 + 500,
			checkedHint: false,
		})
		expect(admissionVerdict(prior, false, T0 + 500)).toBe("tone-required")
		const last = T0 + 500 + STRONG_PRIOR_TTL_MS
		expect(admissionVerdict(prior, false, last)).toBe("tone-required")
		expect(admissionVerdict(prior, false, last + 1)).toBeNull()
		expect(readPrior(prior, false, last + 1)).toBe("suspect")
	})

	it("the same channel with analog voice heard (a recorder tone) keeps recording: frozen voice", () => {
		const store = newStore()
		const id = decodedDmr(store)
		const at = T0 + 60_000
		const voice = store.ingest(obs("voice", at)).discoveryId ?? ""
		expect(store.recordAnalog("voice", tone(at + 3_000))).toBe(true)
		for (const which of [id, voice]) {
			const prior = store.voicePrior(which) ?? null
			expect(prior).not.toBeNull()
			expect(admissionVerdict(prior, false, at)).toBeNull()
		}
	})

	describe("classVotes and checkedHint: the owner's class votes per class, its sync hint checked or not", () => {
		type Cls = "fsk4-12k5" | "fsk4-6k25" | "gmsk-narrow" | "analog-fm"
		const voted = (id: string, startedAt: number, cls: Cls) =>
			makeObs({ id, centreHz: CH, startedAt, cls, open: false, gate: "passed" })
		/**
		 * Six overs, `n` of them `cls` and the rest `other`; on the first, a `protocol` sync hint with
		 * no checked content (`unchecked`), a DMR sync hint with verified TG/SRC (`tg-src`: the only
		 * checked content a sync hint's proof keeps), or a decode with a colour code (`decoded`).
		 */
		function channel(
			store: DiscoveryStore,
			n: number,
			cls: Cls,
			other: Cls,
			protocol: "dmr" | "dpmr" = "dmr",
			proof: "unchecked" | "tg-src" | "decoded" = "unchecked",
		): string {
			let id = ""
			for (let k = 0; k < 6; k++)
				id =
					store.ingest(voted(`o${k}`, T0 + k * 10_000, k < n ? cls : other))
						.discoveryId ?? id
			const base = evidence(
				protocol,
				T0 + 500,
				proof === "decoded"
					? {
							identity:
								protocol === "dmr" ? dmrCc(1) : { kind: "dpmr-cc", value: "1" },
						}
					: {},
			)
			const ev =
				proof === "tg-src"
					? { ...base, metadata: { talkgroups: ["9"], sources: ["1"] } }
					: base
			expect(store.appendObservationEvidence("o0", ev)).toBe(true)
			store.applyEvidence(id, ev)
			return store.discoveryIdOf("o0") ?? id
		}
		const ownerLabel = (store: DiscoveryStore, id: string) =>
			store.voicePrior(id)?.labels.find(l => l.owner)

		it("an unchecked DMR sync hint on a 4FSK channel with no analog proof: suspect (held, then kept)", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-12k5", "analog-fm")
			const prior = store.voicePrior(id) ?? null
			expect(ownerLabel(store, id)).toEqual(
				expect.objectContaining({ protocol: "dmr", checkedHint: false }),
			)
			expect(prior?.classVotes?.()).toEqual({
				total: 6,
				votes: { "fsk4-12k5": 6 },
			})
			expect(readPrior(prior, false, T0 + 60_000)).toBe("suspect")
		})

		it("an unchecked sync hint and only fsk4-6k25 votes: suspect", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-6k25", "analog-fm", "dpmr")
			expect(readPrior(store.voicePrior(id) ?? null, false, T0 + 60_000)).toBe(
				"suspect",
			)
		})

		it("a checked DMR sync hint on a 4FSK channel: tone required within STRONG_PRIOR_TTL_MS of its proof, suspect past it", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-12k5", "analog-fm", "dmr", "tg-src")
			const prior = store.voicePrior(id) ?? null
			const label = ownerLabel(store, id)
			expect(label).toEqual(
				expect.objectContaining({ protocol: "dmr", checkedHint: true }),
			)
			const at = label?.at ?? Number.NaN
			expect(Number.isFinite(at)).toBe(true)
			expect(admissionVerdict(prior, false, at + STRONG_PRIOR_TTL_MS)).toBe(
				"tone-required",
			)
			expect(readPrior(prior, false, at + STRONG_PRIOR_TTL_MS + 1)).toBe(
				"suspect",
			)
			expect(readPrior(prior, false, T0 + 5 * 60 * 60_000)).toBe("suspect")
		})

		it("a checked DMR sync hint with fsk4-6k25 votes (no DMR class): suspect", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-6k25", "analog-fm", "dmr", "tg-src")
			expect(readPrior(store.voicePrior(id) ?? null, false, T0 + 60_000)).toBe(
				"suspect",
			)
		})

		it("a dPMR decode with fsk4-6k25 votes: tone required (a dPMR sync hint keeps no checked content)", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-6k25", "analog-fm", "dpmr", "decoded")
			expect(ownerLabel(store, id)).toEqual(
				expect.objectContaining({ protocol: "dpmr", confidence: "decoded" }),
			)
			expect(
				admissionVerdict(store.voicePrior(id) ?? null, false, T0 + 60_000),
			).toBe("tone-required")
		})

		it("GMSK votes are no DMR class: a channel read gmsk-narrow stays suspect", () => {
			const store = newStore()
			const id = channel(store, 1, "fsk4-12k5", "gmsk-narrow", "dmr", "tg-src")
			const prior = store.voicePrior(id) ?? null
			expect(prior?.classVotes?.()).toEqual({
				total: 6,
				votes: { "fsk4-12k5": 1, "gmsk-narrow": 5 },
			})
			expect(readPrior(prior, false, T0 + 60_000)).toBe("suspect")
		})

		it("FROZEN: an analog tone heard on a checked digital channel keeps recording", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-12k5", "analog-fm", "dmr", "tg-src")
			expect(store.recordAnalog("o5", tone(T0 + 60_000))).toBe(true)
			expect(
				admissionVerdict(store.voicePrior(id) ?? null, false, T0 + 60_000),
			).toBeNull()
		})
	})

	it("a discovery with no decode reads no non-voice prior", () => {
		const store = newStore()
		const id = store.ingest(obs("v", T0)).discoveryId ?? ""
		expect(admissionVerdict(store.voicePrior(id) ?? null, false, T0)).toBeNull()
	})

	it("a folder nobody owns reads undefined", () => {
		expect(newStore().voicePrior("d_nobody")).toBeUndefined()
	})
})
