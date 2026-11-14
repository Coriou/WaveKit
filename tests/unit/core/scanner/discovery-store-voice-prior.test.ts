/**
 * DiscoveryStore.voicePrior composed with the recorder's policy (recording-verdict.ts), as
 * scanner-service wires it: a discovery decoded POCSAG at any earlier time admits a recording only
 * as a shadow its own tone must class, one decoded DMR only holds; a channel where analog voice
 * was heard (a recorder tone) keeps recording despite a decode; a folder nobody owns reads no
 * prior.
 */
import { describe, expect, it } from "vitest"
import {
	admissionVerdict,
	readPrior,
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
		expect(prior?.labels).toContainEqual({
			protocol: "dmr",
			confidence: "decoded",
			owner: true,
		})
		expect(readPrior(prior, false)).toBe("suspect")
		expect(admissionVerdict(prior, false)).toBeNull()
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
		expect(prior?.labels).toContainEqual({
			protocol: "pocsag",
			confidence: "decoded",
			owner: true,
		})
		expect(admissionVerdict(prior, false)).toBe("tone-required")
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
			expect(admissionVerdict(prior, false)).toBeNull()
		}
	})

	it("a discovery with no decode reads no non-voice prior", () => {
		const store = newStore()
		const id = store.ingest(obs("v", T0)).discoveryId ?? ""
		expect(admissionVerdict(store.voicePrior(id) ?? null, false)).toBeNull()
	})

	it("a folder nobody owns reads undefined", () => {
		expect(newStore().voicePrior("d_nobody")).toBeUndefined()
	})
})
