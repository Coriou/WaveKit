/**
 * One discovery per emitter: a known analog discovery at a frequency keeps that frequency's voiced
 * observations when the only digital evidence it holds is a weak sync hint (an unchecked,
 * identity-less dsd-fme decode). A co-channel split needs real identity evidence, and a recording
 * whose observation such a split moves follows it onto the linked twin, as it follows a merge.
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	recordingAlias,
	recordingArtifact,
} from "../../../../src/core/scanner/store/recording-operation.js"
import type { PreparedRecordingMetadata } from "../../../../src/core/scanner/store/recording-operation.js"
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

function newStore(): { store: DiscoveryStore; entries: JournalEntry[] } {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

const voice = (id: string, startedAt: number, open = true) =>
	makeObs({
		id,
		centreHz: CH,
		startedAt,
		cls: "analog-fm",
		open,
		gate: "passed",
	})

/** The wideband recorder's tone row (voice false), as widebandToneEvidence writes it. */
const tone = (at: number): ProofAnalogInput => ({
	outcome: "decoded",
	mode: "nfm",
	voice: false,
	tone: { ctcssHz: 88.5, dcs: null },
	transport: "live",
	at,
})

/** Live audio's voice row: heard voice without a tone. */
const heard = (at: number): ProofAnalogInput => ({
	outcome: "heard",
	mode: "nfm",
	voice: true,
	tone: { ctcssHz: null, dcs: null },
	transport: "live",
	at,
})

/** An ambient dsd-fme decode with no checked content: it keeps no identity (a sync hint). */
const syncHint = (at: number) => ({
	...evidence("p25p1", at, { contentVerified: false }),
	origin: "ambient" as const,
})

function prepared(
	discoveryId: string,
	observationId: string,
): PreparedRecordingMetadata {
	const operationId = randomUUID()
	return {
		version: 1,
		operationId,
		producerRecordingId: operationId,
		discoveryId,
		observationId,
		alias: recordingAlias(discoveryId, operationId),
		artifact: recordingArtifact(discoveryId, operationId),
		desiredState: "linked",
		binding: {
			sourceId: "src-1",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "opaque",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: CH,
			captureCentreHz: null,
			tuningTrust: "commanded",
		},
		expectedOutput: {
			sampleRateHz: 8000,
			channelCount: 1,
			outputFrames: 80,
			fileBytes: 204,
		},
	}
}

/** A known discovery whose only digital evidence is an older observation's sync hint. */
function knownWithHint(store: DiscoveryStore): string {
	const id = store.ingest(voice("old", T0, false)).discoveryId ?? ""
	expect(id).not.toBe("")
	const hint = syncHint(T0 + 500)
	expect(store.appendObservationEvidence("old", hint)).toBe(true)
	store.applyEvidence(id, hint)
	expect(store.get(id)?.proof?.kind).toBe("digital-undecoded")
	expect(store.get(id)?.evidenceLevel).toBe("weak")
	return id
}

describe("a voiced transmission on a known discovery with a sync hint", () => {
	for (const [name, row] of [
		["a recorder tone", tone],
		["live audio's voice", heard],
	] as const) {
		it(`${name} keeps the observation and its recording on the known discovery`, () => {
			const { store, entries } = newStore()
			const known = knownWithHint(store)
			const at = T0 + 60_000
			expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
			const metadata = prepared(known, "id")
			store.prepareRecording(metadata)
			const before = entries.length
			expect(store.recordAnalog("id", row(at + 3_000))).toBe(true)
			// No co-channel twin was created at the same frequency key.
			expect(store.discoveryIdOf("id")).toBe(known)
			expect(store.snapshot().discoveries).toHaveLength(1)
			expect(store.get(known)?.coChannel).toEqual([])
			for (const entry of entries.slice(before)) {
				const payload = entry.payload as {
					discoveries?: { id: string }[]
				}
				for (const d of payload.discoveries ?? []) expect(d.id).toBe(known)
			}
			expect(store.recordingAssociation(known, "id")).not.toBeNull()
			const plan = store.buildRecordingCommitPlan(metadata.operationId)
			expect(plan?.discovery.id).toBe(known)
		})
	}

	it("a sync hint arriving on a voiced observation of an analog discovery does not split it", () => {
		const { store } = newStore()
		const known = store.ingest(voice("old", T0, false)).discoveryId ?? ""
		expect(store.recordAnalog("old", tone(T0 + 500))).toBe(true)
		expect(store.get(known)?.family).toBe("analog")
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		const hint = syncHint(at + 1_000)
		expect(store.appendObservationEvidence("id", hint)).toBe(true)
		store.applyEvidence(known, hint)
		expect(store.discoveryIdOf("id")).toBe(known)
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.get(known)?.family).toBe("analog")
	})
})

/** dsd-fme DMR voice with checked talkgroup and source (verified TG/SRC) but no colour code. */
const checkedDmr = (at: number) => {
	const ev = evidence("dmr", at, { talkgroups: ["9"] })
	return { ...ev, metadata: { ...ev.metadata, sources: ["1234"] } }
}

describe("checked DMR content without a colour code names the digital family", () => {
	it("verified TG/SRC: an analog tone on the channel splits off it", () => {
		const { store } = newStore()
		const known = store.ingest(voice("old", T0, false)).discoveryId ?? ""
		const checked = checkedDmr(T0 + 500)
		expect(store.appendObservationEvidence("old", checked)).toBe(true)
		store.applyEvidence(known, checked)
		const proof = store.get(known)?.proof
		expect(proof?.kind).toBe("digital-undecoded")
		expect(proof?.identity).toBeUndefined()
		expect(proof?.tgSrcVerified).toBe(true)
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
		const twin = store.discoveryIdOf("id") ?? ""
		expect(twin).not.toBe(known)
		expect(store.discoveryIdOf("old")).toBe(known)
		expect(store.get(twin)?.coChannel).toEqual([known])
	})

	it("the unchecked hint beside it (no content of any kind) still splits nothing", () => {
		const { store } = newStore()
		const known = knownWithHint(store)
		const proof = store.get(known)?.proof
		expect(proof?.tgSrcVerified).toBeUndefined()
		expect(proof?.talkgroup).toBeUndefined()
		expect(proof?.encrypted).toBe(false)
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
		expect(store.discoveryIdOf("id")).toBe(known)
		expect(store.snapshot().discoveries).toHaveLength(1)
	})
})

describe("a co-channel split on real identity evidence", () => {
	it("still splits an analog tone off a decoded identity, and the recording follows the move", () => {
		const { store } = newStore()
		const known = store.ingest(voice("old", T0, false)).discoveryId ?? ""
		const decoded = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("old", decoded)).toBe(true)
		store.applyEvidence(known, decoded)
		expect(store.get(known)?.confidence).toBe("decoded")
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		const metadata = prepared(known, "id")
		store.prepareRecording(metadata)
		expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
		const twin = store.discoveryIdOf("id") ?? ""
		expect(twin).not.toBe(known)
		expect(store.get(twin)?.coChannel).toEqual([known])
		// The recording follows its observation onto the twin, never association-lost.
		expect(store.recordingAssociation(known, "id")).not.toBeNull()
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		expect(plan?.discovery.id).toBe(twin)
		expect(store.recordingCommitPlanCurrent(plan!)).toBe(true)
		store.applyRecordingCommitPlan(plan!)
		store.publishRecordingCommit(plan!)
		expect(store.get(twin)?.evidence.recordings).toBe(1)
		expect(store.get(known)?.evidence.recordings).toBe(0)
	})

	it("a recording does not follow its observation onto an unlinked discovery", () => {
		const { store } = newStore()
		const a = store.ingest(voice("a", T0, false)).discoveryId ?? ""
		const metadata = prepared(a, "a")
		store.prepareRecording(metadata)
		expect(store.delete(a)).toBe(true)
		expect(store.recordingAssociation(a, "a")).toBeNull()
		expect(store.buildRecordingCommitPlan(metadata.operationId)).toBeNull()
	})
})

/**
 * A parked receiver hears a repeater whose record is proven analog (its recordings' tones). An
 * over's key-up snapshot reads as a short burst about 1 kHz off the record's median: within
 * 1 000 Hz it joins the record, past it the cross-family limit creates a co-channel record (DQ
 * 9.3), which folds back into the repeater's record once the track settles. The analog operation
 * prepares its metadata only when the transmission ends, so a recording begun on that record
 * must still prepare and commit after the fold.
 */
describe("an over whose key-up reads off the repeater's record", () => {
	const KEY_UP_JOINS = 900
	const KEY_UP_SPLITS = 1_100

	function repeater(): {
		store: DiscoveryStore
		clock: { now: number }
		known: string
	} {
		const clock = { now: T0 }
		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => clock.now,
			newId: counterIds(),
			rasters: () => PMR,
		})
		for (let i = 0; i < 5; i++) {
			const id = `past${i}`
			store.ingest(
				makeObs({
					id,
					centreHz: CH - 40,
					startedAt: clock.now,
					durationMs: 10_000,
					obwHz: 10_000,
					cls: "analog-fm",
					gate: "passed",
				}),
			)
			expect(store.recordAnalog(id, tone(clock.now))).toBe(true)
			clock.now += 900_000
		}
		const known = store.discoveryIdOf("past0") ?? ""
		expect(store.get(known)?.family).toBe("analog")
		return { store, clock, known }
	}

	/**
	 * Plays one over of `seconds` (a key-up snapshot `keyUpHz` off the channel, then 1 s updates
	 * near the centre, the last one closing), checking the recording's association at each, and
	 * prepares and commits its file at the end as the analog operation does.
	 */
	function over(seconds: number, keyUpHz: number) {
		const { store, clock, known } = repeater()
		const start = clock.now
		const snap = (ms: number, centre: number, open: boolean) =>
			makeObs({
				id: "over",
				centreHz: centre,
				startedAt: start,
				durationMs: ms,
				obwHz: centre === CH + keyUpHz ? 5_000 : 11_000,
				cls: centre === CH + keyUpHz ? "ook-burst" : "analog-fm",
				blocks: centre === CH + keyUpHz ? 2 : 20 + ms / 100,
				open,
				gate: "passed",
			})
		const bound = store.ingest(snap(100, CH + keyUpHz, true)).discoveryId ?? ""
		expect(bound).not.toBe("")
		const metadata = prepared(bound, "over")
		let associated = 0
		for (let s = 1; s <= seconds; s++) {
			clock.now = start + s * 1_000
			store.ingest(snap(s * 1_000, CH - 80, s < seconds))
			if (s === 3)
				expect(store.recordAnalog("over", heard(clock.now))).toBe(true)
			if (store.recordingAssociation(bound, "over", metadata.binding) !== null)
				associated++
		}
		// The analog operation's finish: prepare, then the commit plan, its final check and the commit.
		store.prepareRecording(metadata)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		expect(plan).not.toBeNull()
		expect(store.recordingCommitPlanCurrent(plan!)).toBe(true)
		store.applyRecordingCommitPlan(plan!)
		store.publishRecordingCommit(plan!)
		return { store, known, bound, associated }
	}

	it("a 12 s over keyed up within 1 000 Hz is recorded whole on the repeater's record", () => {
		const r = over(12, KEY_UP_JOINS)
		expect(r.bound).toBe(r.known)
		expect(r.associated).toBe(12)
		expect(r.store.discoveryIdOf("over")).toBe(r.known)
		expect(r.store.get(r.known)?.evidence.recordings).toBe(1)
	})

	for (const seconds of [12, 30]) {
		it(`a ${seconds} s ID keyed up past 1 000 Hz is recorded whole after its record folds back`, () => {
			const r = over(seconds, KEY_UP_SPLITS)
			// The key-up created a co-channel record, which folded into the repeater's record.
			expect(r.bound).not.toBe(r.known)
			expect(r.store.get(r.bound)).toBeUndefined()
			expect(r.store.aliasOwner(r.bound)).toBe(r.known)
			expect(r.store.snapshot().discoveries).toHaveLength(1)
			// Never association-lost, and the file commits on the survivor.
			expect(r.associated).toBe(seconds)
			expect(r.store.discoveryIdOf("over")).toBe(r.known)
			expect(r.store.get(r.known)?.evidence.recordings).toBe(1)
		})
	}

	it("the analog sync-hint scene: a 30 s ID bound to the known record prepares there at its end", () => {
		const { store, entries } = newStore()
		const known = knownWithHint(store)
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		const metadata = prepared(known, "id")
		let associated = 0
		for (let s = 1; s <= 30; s++) {
			const update = voice("id", at)
			update.track.lastSample = (at + s * 1_000) * 2048
			if (s === 30) {
				update.endedAt = at + 30_000
				update.endReason = "quiet"
			}
			store.ingest(update)
			if (s === 3)
				expect(store.recordAnalog("id", heard(at + 3_000))).toBe(true)
			if (store.recordingAssociation(known, "id") !== null) associated++
		}
		expect(associated).toBe(30)
		expect(entries.some(e => e.op === "evidence")).toBe(true)
		store.prepareRecording(metadata)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		expect(plan?.discovery.id).toBe(known)
		expect(store.snapshot().discoveries).toHaveLength(1)
	})
})

describe("prepare at the end follows a split", () => {
	it("a recording whose observation a real identity split moved prepares on the twin", () => {
		const { store } = newStore()
		const known = store.ingest(voice("old", T0, false)).discoveryId ?? ""
		const decoded = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("old", decoded)).toBe(true)
		store.applyEvidence(known, decoded)
		const at = T0 + 60_000
		expect(store.ingest(voice("id", at)).discoveryId).toBe(known)
		const metadata = prepared(known, "id")
		expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
		const twin = store.discoveryIdOf("id") ?? ""
		expect(twin).not.toBe(known)
		store.prepareRecording(metadata)
		expect(
			store.buildRecordingCommitPlan(metadata.operationId)?.discovery.id,
		).toBe(twin)
	})
})
