/**
 * DiscoveryStore.voicePrior composed with the recorder's policy (recording-verdict.ts), as
 * scanner-service wires it: a channel decoded POCSAG within OWNER_DEDICATED_PRIOR_TTL_MS admits a recording only
 * as a shadow its own tone must class, one decoded DMR only holds; a channel where analog voice
 * was heard (a recorder tone) keeps recording despite a decode; a folder nobody owns reads no
 * prior.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	admissionVerdict,
	readPrior,
	OWNER_DEDICATED_PRIOR_TTL_MS,
	STRONG_PRIOR_TTL_MS,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { createLogger } from "../../../../src/utils/logger.js"
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
		// With its decode's time: the owner's own pager decode lasts OWNER_DEDICATED_PRIOR_TTL_MS (24 h).
		expect(prior?.labels).toContainEqual({
			protocol: "pocsag",
			confidence: "decoded",
			owner: true,
			at: T0 + 500,
			checkedHint: false,
			verifiedHint: false,
			observationId: "pager",
		})
		expect(admissionVerdict(prior, false, T0 + 500)).toBe("tone-required")
		const day = T0 + 500 + OWNER_DEDICATED_PRIOR_TTL_MS
		expect(
			admissionVerdict(prior, false, T0 + 500 + 23 * 60 * 60_000 + 59 * 60_000),
		).toBe("tone-required")
		expect(admissionVerdict(prior, false, day)).toBe("tone-required")
		expect(readPrior(prior, false, day + 1)).toBe("suspect")
		expect(prior?.digitalSeenAt?.()).toBe(T0 + 500)
		// A new decode refreshes it: 24 h from the newest page.
		const later = T0 + 2 * 60 * 60_000
		expect(store.ingest(obs("pager2", later)).discoveryId).toBe(id)
		const ev2 = evidence("pocsag", later + 500, {
			identity: { kind: "pocsag-capcode", value: "1234" },
		})
		expect(store.appendObservationEvidence("pager2", ev2)).toBe(true)
		store.applyEvidence(id, ev2)
		const refreshed = store.voicePrior(id) ?? null
		expect(refreshed?.labels.find(l => l.owner)?.at).toBe(later + 500)
		expect(admissionVerdict(refreshed, false, day + 1)).toBe("tone-required")
		expect(
			readPrior(
				refreshed,
				false,
				later + 500 + OWNER_DEDICATED_PRIOR_TTL_MS + 1,
			),
		).toBe("suspect")
		// FROZEN: an analog tone heard on the channel ends it.
		expect(store.ingest(obs("voice", T0 + 60_000)).discoveryId).toBe(id)
		expect(store.recordAnalog("voice", tone(T0 + 61_000))).toBe(true)
		expect(
			admissionVerdict(store.voicePrior(id) ?? null, false, day),
		).toBeNull()
	})

	it("a page of another capcode placed on the owner refreshes its 24 h window, though it lands on a co-channel twin and the owner's proof stays 30 h old", () => {
		const store = newStore()
		const id = store.ingest(obs("pager", T0)).discoveryId ?? ""
		const old = evidence("pocsag", T0 + 500, {
			identity: { kind: "pocsag-capcode", value: "1234" },
		})
		expect(store.appendObservationEvidence("pager", old)).toBe(true)
		store.applyEvidence(id, old)
		const later = T0 + 30 * 60 * 60_000
		expect(store.ingest(obs("pager2", later)).discoveryId).toBe(id)
		const page = evidence("pocsag", later + 500, {
			identity: { kind: "pocsag-capcode", value: "9999" },
		})
		store.appendObservationEvidence("pager2", page)
		expect(store.applyEvidenceResult(id, page).accepted).toBe(true)
		const prior = store.voicePrior(id) ?? null
		// The owner's published proof is the old capcode's page, 30 h old.
		expect(prior?.labels.find(l => l.owner)?.at).toBe(T0 + 500)
		expect(prior?.ownerDecode).toEqual({ protocol: "pocsag", at: later + 500 })
		// Within 24 h of the new page: strong.
		const now = later + 500 + 2 * 60 * 60_000
		expect(readPrior(prior, false, now)).toBe("tone-required")
		expect(
			readPrior(prior, false, later + 500 + OWNER_DEDICATED_PRIOR_TTL_MS + 1),
		).toBe("suspect")
		// FROZEN: analog voice heard still ends it (priorReading reads analogVoice after the source).
		expect(readPrior({ ...prior!, analogVoice: () => true }, false, now)).toBe(
			"none",
		)
	})

	describe("the pager prior is per channel: three capcode twins on one channel", () => {
		// Feature: recording-verdict, the per-channel pager prior (docs/SCANNER.md, "Known digital or paging channels").
		const H = 3_600_000
		/** Twins d1, d2, d3 (capcodes 1, 2, 3 paged at T0), then pages of capcode 1 only. */
		function twins(pageAt: readonly number[], cls: "fsk2-wide" = "fsk2-wide") {
			let now = T0
			const store = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => now,
				newId: counterIds(),
				rasters: () => PMR,
			})
			const page = (o: string, at: number, cap: string): string => {
				now = at
				const id =
					store.ingest(
						makeObs({
							id: o,
							centreHz: CH,
							startedAt: at,
							cls,
							open: false,
							gate: "passed",
						}),
					).discoveryId ?? ""
				const ev = evidence("pocsag", at + 500, {
					identity: { kind: "pocsag-capcode", value: cap },
				})
				store.appendObservationEvidence(o, ev)
				expect(store.applyEvidenceResult(id, ev).accepted).toBe(true)
				return store.discoveryIdOf(o) ?? id
			}
			const ids = [
				page("p1", T0, "1"),
				page("p2", T0 + 60_000, "2"),
				page("p3", T0 + 120_000, "3"),
			]
			expect(new Set(ids).size).toBe(3)
			pageAt.forEach((at, k) => page(`a${k}`, at, "1"))
			return { store, ids, setNow: (t: number) => (now = t) }
		}
		it("pages of capcode 1 only, 2 h old, 34 h after the twins' own: every twin reads strong", () => {
			const last = T0 + 32 * H
			const { store, ids } = twins([T0 + 30 * H, last])
			const now = last + 2 * H
			// The leak's shape: twins 2 and 3 publish their own 34 h old pages.
			const stale = ids.filter(id => {
				const at = store.ownerLabel(id)?.proofAt
				return typeof at === "number" && now - at > OWNER_DEDICATED_PRIOR_TTL_MS
			})
			expect(stale.length).toBeGreaterThanOrEqual(2)
			for (const id of ids) {
				const prior = store.voicePrior(id) ?? null
				expect(readPrior(prior, false, now)).toBe("tone-required")
				expect(admissionVerdict(prior, false, now)).toBe("tone-required")
				// The channel memo holds the newest page, whichever twin it was placed on.
				expect(prior?.channelDecodes).toContainEqual({
					protocol: "pocsag",
					at: last + 500,
				})
			}
		})

		it("every page older than 24 h: each twin reads suspect", () => {
			const last = T0 + 30 * H
			const { store, ids } = twins([last])
			const now = last + 500 + OWNER_DEDICATED_PRIOR_TTL_MS + 1
			for (const id of ids)
				expect(readPrior(store.voicePrior(id) ?? null, false, now)).toBe(
					"suspect",
				)
		})

		it("FROZEN: analog voice heard on the channel: none, fresh pages notwithstanding", () => {
			const last = T0 + 32 * H
			const { store, setNow } = twins([last])
			const at = last + H
			setNow(at)
			const voiced = store.ingest(obs("voice", at)).discoveryId ?? ""
			expect(store.recordAnalog("voice", tone(at + 1_000))).toBe(true)
			const owner = store.discoveryIdOf("voice") ?? voiced
			expect(
				readPrior(store.voicePrior(owner) ?? null, false, at + 2_000),
			).toBe("none")
		})

		it("FROZEN: ten capcode twins, analog voice on a discovery past a twin's linked partners: none", () => {
			let now = T0
			const store = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => now,
				newId: counterIds(),
				rasters: () => PMR,
			})
			const ids: string[] = []
			for (let k = 0; k < 10; k++) {
				const at = T0 + k * 60_000
				now = at
				const o = `p${k}`
				const id =
					store.ingest(
						makeObs({
							id: o,
							centreHz: CH,
							startedAt: at,
							cls: "fsk2-wide",
							open: false,
							gate: "passed",
						}),
					).discoveryId ?? ""
				const ev = evidence("pocsag", at + 500, {
					identity: { kind: "pocsag-capcode", value: String(k + 1) },
				})
				store.appendObservationEvidence(o, ev)
				expect(store.applyEvidenceResult(id, ev).accepted).toBe(true)
				ids.push(store.discoveryIdOf(o) ?? id)
			}
			expect(new Set(ids).size).toBe(10)
			const at = T0 + 20 * 60_000
			now = at
			const voiced = store.ingest(obs("voice", at)).discoveryId ?? ""
			expect(store.recordAnalog("voice", tone(at + 1_000))).toBe(true)
			const voiceOwner = store.discoveryIdOf("voice") ?? voiced
			// A twin that owns the folder and does not list the voice discovery among its (at
			// most 8) partners: before the per-channel read it saw a fresh page and no voice.
			const folder = ids.find(
				id =>
					id !== voiceOwner &&
					!(store.get(id)?.coChannel ?? []).includes(voiceOwner),
			)
			expect(folder).toBeDefined()
			const prior = store.voicePrior(folder ?? "") ?? null
			expect(prior?.channelDecodes?.length ?? 0).toBeGreaterThan(0)
			expect(prior?.analogVoice()).toBe(true)
			expect(readPrior(prior, false, at + 2_000)).toBe("none")
		})

		it("a fresh twin created after the pages, with no link of its own yet (first heard on another source, as after a retune): strong at its first read (the channel memo by its frequency key)", () => {
			const last = T0 + 32 * H
			const { store, ids, setNow } = twins([last])
			const at = last + H
			setNow(at)
			const fresh =
				store.ingest(
					makeObs({
						id: "fresh",
						centreHz: CH,
						startedAt: at,
						cls: "analog-fm",
						open: false,
						gate: "passed",
						sourceId: "src-2",
					}),
				).discoveryId ?? ""
			expect(ids).not.toContain(fresh)
			expect(store.get(fresh)?.coChannel ?? []).toEqual([])
			const prior = store.voicePrior(fresh) ?? null
			expect(prior?.labels.filter(l => !l.owner)).toEqual([])
			expect(prior?.channelDecodes).toContainEqual({
				protocol: "pocsag",
				at: last + 500,
			})
			expect(readPrior(prior, false, at)).toBe("tone-required")
			expect(admissionVerdict(prior, false, at)).toBe("tone-required")
		})

		it("a twin first heard on another source of the same channel reads the memo too (keyed by frequency, any source)", () => {
			let now = T0
			const store = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => now,
				newId: counterIds(),
				rasters: () => PMR,
			})
			const o = (id: string, at: number, sourceId: string) =>
				makeObs({
					id,
					centreHz: CH,
					startedAt: at,
					cls: "fsk2-wide",
					open: false,
					gate: "passed",
					sourceId,
				})
			// The pager owner was heard on src-b first, then on src-a.
			const owner = store.ingest(o("b0", T0, "src-b")).discoveryId ?? ""
			now = T0 + 1_000
			store.ingest(o("a0", T0 + 1_000, "src-a"))
			expect(store.get(store.discoveryIdOf("a0") ?? "")?.sourceIds).toContain(
				"src-a",
			)
			now = T0 + 2 * H
			const page = evidence("pocsag", now, {
				identity: { kind: "pocsag-capcode", value: "7" },
			})
			store.appendObservationEvidence("a0", page)
			expect(
				store.applyEvidenceResult(store.discoveryIdOf("a0") ?? owner, page)
					.accepted,
			).toBe(true)
			// A new twin on src-a only (its first source differs from the owner's).
			now = T0 + 3 * H
			const fresh = store.ingest(o("fresh", now, "src-a")).discoveryId ?? ""
			const prior = store.voicePrior(fresh) ?? null
			expect(prior?.channelDecodes).toContainEqual({
				protocol: "pocsag",
				at: T0 + 2 * H,
			})
			expect(readPrior({ ...prior!, labels: [] }, false, now)).toBe(
				"tone-required",
			)
		})

		it("after a restart (snapshot restored into a new store): the memo is rebuilt from the kept pages, a fresh twin reads strong", () => {
			const last = T0 + 32 * H
			const { store } = twins([T0 + 30 * H, last])
			const at = last + 90 * 60_000
			const restarted = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => at,
				newId: () => "R1".padEnd(26, "0"),
				rasters: () => PMR,
			})
			restarted.restore(store.snapshot())
			const fresh =
				restarted.ingest(
					makeObs({
						id: "after",
						centreHz: CH,
						startedAt: at,
						cls: "analog-fm",
						open: false,
						gate: "passed",
					}),
				).discoveryId ?? ""
			const prior = restarted.voicePrior(fresh) ?? null
			expect(prior?.channelDecodes).toContainEqual({
				protocol: "pocsag",
				at: last + 500,
			})
			expect(readPrior({ ...prior!, labels: [] }, false, at)).toBe(
				"tone-required",
			)
			// 24 h after the newest kept page: suspect again (the rebuild keeps the TTL).
			expect(
				readPrior(
					{ ...prior!, labels: [] },
					false,
					last + 500 + OWNER_DEDICATED_PRIOR_TTL_MS + 1,
				),
			).not.toBe("tone-required")
		})

		it("after a restart, the rebuild assesses no observation last seen more than 24 h ago, nor any discovery not seen in 24 h", () => {
			// d1 (capcode 1): paged at T0 and at T0 + 30 h; d2, d3 last seen at T0 (a minute or two after).
			const { store } = twins([T0 + 30 * H])
			const at = T0 + 32 * H
			const restarted = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => at,
				newId: () => "R1".padEnd(26, "0"),
				rasters: () => PMR,
			})
			restarted.restore(store.snapshot())
			const fresh =
				restarted.ingest(
					makeObs({
						id: "after",
						centreHz: CH,
						startedAt: at,
						cls: "analog-fm",
						open: false,
						gate: "passed",
					}),
				).discoveryId ?? ""
			expect(fresh).not.toBe("")
			const target = restarted as unknown as {
				observationAssessment(o: { readonly id: string }): unknown
			}
			const spy = vi.spyOn(target, "observationAssessment")
			const prior = restarted.voicePrior(fresh) ?? null
			const assessed = spy.mock.calls.map(([o]) => o.id)
			spy.mockRestore()
			expect(assessed).toContain("a0")
			for (const old of ["p1", "p2", "p3"]) expect(assessed).not.toContain(old)
			expect(prior?.channelDecodes).toContainEqual({
				protocol: "pocsag",
				at: T0 + 30 * H + 500,
			})
			expect(prior?.channelDecodes).not.toContainEqual({
				protocol: "pocsag",
				at: T0 + 500,
			})
		})

		it("after a restart through ScannerPersistence (save, then a new store loading the same state dir): strong", async () => {
			const dir = await mkdtemp(join(tmpdir(), "wavekit-voice-prior-"))
			try {
				const logger = createLogger({ level: "fatal" })
				let now = T0
				const p = new ScannerPersistence({ dir, logger, now: () => now })
				await p.load()
				const store = new DiscoveryStore({
					maxDiscoveries: 100,
					now: () => now,
					newId: counterIds(),
					rasters: () => PMR,
				})
				const writes: Promise<number>[] = []
				store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
					writes.push(p.append(e)),
				)
				for (const [k, cap] of ["1", "2", "1"].entries()) {
					now = T0 + k * H
					const o = `p${k}`
					const id =
						store.ingest(
							makeObs({
								id: o,
								centreHz: CH,
								startedAt: now,
								cls: "fsk2-wide",
								open: false,
								gate: "passed",
							}),
						).discoveryId ?? ""
					const ev = evidence("pocsag", now + 500, {
						identity: { kind: "pocsag-capcode", value: cap },
					})
					store.appendObservationEvidence(o, ev)
					expect(store.applyEvidenceResult(id, ev).accepted).toBe(true)
				}
				await Promise.all(writes)
				await p.writeSnapshot(store.snapshot())
				await p.closeSnapshotWorker()
				// The restarted process: 90 min after the last page.
				now = T0 + 2 * H + 90 * 60_000
				const loaded = await new ScannerPersistence({
					dir,
					logger,
					now: () => now,
				}).load()
				const replica = new DiscoveryStore({
					maxDiscoveries: 100,
					now: () => now,
					newId: () => "R1".padEnd(26, "0"),
					rasters: () => PMR,
				})
				replica.restore(loaded)
				for (const e of loaded.entries) replica.replay(e)
				const fresh =
					replica.ingest(
						makeObs({
							id: "after",
							centreHz: CH,
							startedAt: now,
							cls: "analog-fm",
							open: false,
							gate: "passed",
						}),
					).discoveryId ?? ""
				const prior = replica.voicePrior(fresh) ?? null
				expect(prior?.channelDecodes).toContainEqual({
					protocol: "pocsag",
					at: T0 + 2 * H + 500,
				})
				expect(readPrior({ ...prior!, labels: [] }, false, now)).toBe(
					"tone-required",
				)
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		})

		it("a DMR decode on the channel never gets the 24 h treatment: an hour later, suspect", () => {
			const store = newStore()
			const id = decodedDmr(store)
			const prior = store.voicePrior(id) ?? null
			expect(prior?.channelDecodes).toContainEqual({
				protocol: "dmr",
				at: T0 + 500,
			})
			expect(readPrior(prior, false, T0 + 3_600_000)).toBe("suspect")
		})
	})

	it("ownerDecode ignores a decode the store refused and a digital voice decode", () => {
		const store = newStore()
		const id = decodedDmr(store)
		expect(store.voicePrior(id)?.ownerDecode).toEqual({
			protocol: "dmr",
			at: T0 + 500,
		})
		// A DMR decode stays suspect: ownerDecode reads only like a dedicated-channel label.
		expect(readPrior(store.voicePrior(id) ?? null, false, T0 + 600)).toBe(
			"suspect",
		)
		const other = store.ingest(obs("o2", T0)).discoveryId ?? ""
		const dirty = {
			...evidence("pocsag", T0 + 700, {
				identity: { kind: "pocsag-capcode", value: "1" },
			}),
			crcClean: false,
		}
		store.applyEvidence(other, dirty)
		expect(store.voicePrior(other)?.ownerDecode ?? null).toEqual(
			store.voicePrior(id)?.ownerDecode ?? null,
		)
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

		it("a checked DMR sync hint on a 4FSK channel: tone required within STRONG_PRIOR_TTL_MS of its latest digital evidence (the hint: fsk4-12k5 votes never refresh it), suspect past it", () => {
			const store = newStore()
			const id = channel(store, 6, "fsk4-12k5", "analog-fm", "dmr", "tg-src")
			const prior = store.voicePrior(id) ?? null
			const label = ownerLabel(store, id)
			expect(label).toEqual(
				expect.objectContaining({
					protocol: "dmr",
					checkedHint: true,
					verifiedHint: true,
				}),
			)
			// fsk4-12k5 votes only: no tdma-ms vote time.
			expect(prior?.tdmaSeenAt?.()).toBeNull()
			expect(Number.isFinite(label?.at ?? Number.NaN)).toBe(true)
			// The six overs voted fsk4-12k5 (no refresh); the hint was made at T0 + 500 ms.
			const at = prior?.digitalSeenAt?.() ?? Number.NaN
			expect(at).toBe(T0 + 500)
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

	describe("digitalProofs: the owner's observation proofs of any rank hold the digital-channel bar", () => {
		type Cls = "fsk4-12k5" | "tdma-ms" | "analog-fm"
		const MIN = 60_000
		/**
		 * Six overs `o0`..`o5` voted `cls`, then on each observation `k` of `hints` an unchecked DMR sync
		 * hint (no checked content) at `at(k)`; `tgSrc` overs carry verified TG/SRC instead.
		 */
		function channel(
			store: DiscoveryStore,
			cls: Cls,
			hints: readonly number[],
			at: (k: number) => number,
			tgSrc: readonly number[] = [],
		): string {
			let id = ""
			for (let k = 0; k < 6; k++)
				id =
					store.ingest(
						makeObs({
							id: `o${k}`,
							centreHz: CH,
							startedAt: T0 + k * 10_000,
							cls,
							open: false,
							gate: "passed",
						}),
					).discoveryId ?? id
			for (const k of hints) {
				const base = evidence("dmr", at(k))
				const ev = tgSrc.includes(k)
					? { ...base, metadata: { talkgroups: ["9"], sources: ["1"] } }
					: base
				expect(store.appendObservationEvidence(`o${k}`, ev)).toBe(true)
				store.applyEvidence(store.discoveryIdOf(`o${k}`) ?? id, ev)
			}
			return store.discoveryIdOf("o0") ?? id
		}
		const read = (store: DiscoveryStore, id: string, now: number) =>
			readPrior(store.voicePrior(id) ?? null, false, now)

		it("live shape: one unchecked DMR hint on a TDMA channel, no analog proof: tone required", () => {
			const store = newStore()
			const id = channel(store, "tdma-ms", [0], () => T0 + 500)
			expect(store.voicePrior(id)?.digitalProofs?.()).toEqual([
				{
					protocol: "dmr",
					at: T0 + 500,
					checked: false,
					verified: false,
					colourCode: false,
					observationId: "o0",
				},
			])
			expect(store.voicePrior(id)?.tdmaSeenAt?.()).toEqual(expect.any(Number))
			expect(read(store, id, T0 + MIN)).toBe("tone-required")
		})

		it("unchecked DMR hints from 2 observations within the TTL on a 4FSK 12.5 kHz channel: tone required", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0, 1], k => T0 + k * 10 * MIN)
			expect(read(store, id, T0 + 11 * MIN)).toBe("tone-required")
		})

		it("the same with 1 observation: suspect", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0], () => T0 + 500)
			expect(read(store, id, T0 + MIN)).toBe("suspect")
		})

		it("2 observations, one older than STRONG_PRIOR_TTL_MS: suspect (rule b counts only hints within the TTL)", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0, 1], k => T0 + k * 40 * MIN)
			expect(store.voicePrior(id)?.digitalSeenAt?.()).toBe(T0 + 40 * MIN)
			expect(read(store, id, T0 + 41 * MIN)).toBe("suspect")
		})

		const over = (id: string, startedAt: number, cls: Cls) =>
			makeObs({ id, centreHz: CH, startedAt, cls, open: false, gate: "passed" })

		// Live audit: DMR hints 57 and 62 min old, the channel's overs still voting fsk4-12k5.
		it("2 unchecked hints both older than STRONG_PRIOR_TTL_MS are not counted, even with fresh tdma-ms evidence", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0, 1], k => T0 + k * MIN)
			expect(read(store, id, T0 + 2 * MIN)).toBe("tone-required")
			// One tdma-ms over (1 of 7 votes: no TDMA share) refreshes the evidence time only.
			expect(
				store.ingest(over("late", T0 + 34 * MIN, "tdma-ms")).discoveryId,
			).toBe(id)
			expect(store.voicePrior(id)?.digitalSeenAt?.()).toBe(
				T0 + 34 * MIN + 1_000,
			)
			expect(read(store, id, T0 + 34 * MIN + 2_000)).toBe("suspect")
		})

		it("a weak analog channel: one old checked DMR decode and fresh fsk4-12k5 votes only: the bar lapses 30 min after the decode; tdma-ms votes keep it fresh", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [], () => T0)
			const ev = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
			expect(store.appendObservationEvidence("o0", ev)).toBe(true)
			store.applyEvidence(id, ev)
			expect(read(store, id, T0 + MIN)).toBe("tone-required")
			// Fresh fsk4-12k5 overs never refresh it.
			for (const k of [10, 20, 29])
				expect(
					store.ingest(over(`f${k}`, T0 + k * MIN, "fsk4-12k5")).discoveryId,
				).toBe(id)
			expect(store.voicePrior(id)?.digitalSeenAt?.()).toBe(T0 + 500)
			expect(read(store, id, T0 + 500 + STRONG_PRIOR_TTL_MS)).toBe(
				"tone-required",
			)
			expect(read(store, id, T0 + 500 + STRONG_PRIOR_TTL_MS + 1)).toBe(
				"suspect",
			)
			// A tdma-ms over refreshes it.
			const at = T0 + 45 * MIN
			expect(store.ingest(over("t45", at, "tdma-ms")).discoveryId).toBe(id)
			expect(store.voicePrior(id)?.digitalSeenAt?.()).toBe(at + 1_000)
			expect(read(store, id, at + 2_000)).toBe("tone-required")
			expect(read(store, id, at + 1_000 + STRONG_PRIOR_TTL_MS + 1)).toBe(
				"suspect",
			)
		})

		it("a class-only TDMA channel (no digital label): tone required while its overs vote tdma-ms", () => {
			const store = newStore()
			let id = ""
			for (let k = 0; k < 6; k++)
				id =
					store.ingest(
						makeObs({
							id: `t${k}`,
							centreHz: CH,
							startedAt: T0 + k * 10_000,
							cls: "tdma-ms",
							open: false,
							gate: "passed",
						}),
					).discoveryId ?? id
			const prior = store.voicePrior(id) ?? null
			expect(prior?.class).toBe("tdma-ms")
			expect(prior?.labels.some(l => l.owner && l.protocol !== "unknown")).toBe(
				false,
			)
			expect(readPrior(prior, false, T0 + MIN)).toBe("tone-required")
			expect(
				readPrior(prior, false, T0 + 51_000 + STRONG_PRIOR_TTL_MS + 1),
			).toBe("suspect")
		})

		it("FROZEN: an analog CTCSS tone on that channel keeps recording", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0, 1], k => T0 + k * 10 * MIN)
			expect(store.recordAnalog("o5", tone(T0 + 11 * MIN))).toBe(true)
			expect(read(store, id, T0 + 11 * MIN)).toBe("none")
		})

		it("a checked hint followed by a newer unchecked one: tone required", () => {
			const store = newStore()
			const id = channel(store, "fsk4-12k5", [0, 1], k => T0 + k * 5 * MIN, [0])
			expect(store.voicePrior(id)?.digitalProofs?.()).toEqual([
				expect.objectContaining({ observationId: "o0", checked: true }),
				expect.objectContaining({ observationId: "o1", checked: false }),
			])
			expect(read(store, id, T0 + 6 * MIN)).toBe("tone-required")
		})

		it("a decode 40 min ago and unchecked hints every minute since from 5 overs: tone required", () => {
			const store = newStore()
			const id = channel(
				store,
				"fsk4-12k5",
				[1, 2, 3, 4, 5],
				k => T0 + (35 + k) * MIN,
			)
			const ev = evidence("dmr", T0, { identity: dmrCc(1) })
			expect(store.appendObservationEvidence("o0", ev)).toBe(true)
			store.applyEvidence(id, ev)
			const now = T0 + 41 * MIN
			expect(read(store, id, now)).toBe("tone-required")
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

describe("a lone sync-only DMR row is evidence, never the published label", () => {
	// Feature: discovery-store, sync-only dsd-fme rows (docs/SCANNER.md, "Identification from running decoders").
	const MIN = 60_000
	const syncRow = (
		store: DiscoveryStore,
		obsId: string,
		at: number,
		extra: { contentVerified?: boolean; unverifiedCc?: number } = {},
	): string => {
		const id = store.ingest(obs(obsId, at)).discoveryId ?? ""
		const base = evidence("dmr", at + 500, {
			contentVerified: extra.contentVerified ?? false,
		})
		const ev = {
			...base,
			...(extra.contentVerified === true
				? { metadata: { talkgroups: ["9"], sources: ["1"] } }
				: {}),
			...(extra.unverifiedCc !== undefined
				? { unverifiedCc: extra.unverifiedCc }
				: {}),
		}
		store.appendObservationEvidence(obsId, ev)
		store.applyEvidence(id, ev)
		return store.discoveryIdOf(obsId) ?? id
	}

	it("one row with no TG/SRC and no colour code: published unknown, no proof; the recorder still reads the hint", () => {
		const store = newStore()
		const id = syncRow(store, "s1", T0)
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.proof).toBeUndefined()
		// The recorder's reads keep the hint (owner label and digitalProofs).
		expect(store.ownerLabel(id)?.protocol).toBe("dmr")
		const prior = store.voicePrior(id) ?? null
		expect(prior?.labels.find(l => l.owner)?.protocol).toBe("dmr")
		expect(prior?.digitalProofs?.().map(p => p.observationId)).toEqual(["s1"])
		expect(prior?.digitalProofs?.()[0]?.colourCode).toBe(false)
	})

	it("the same row repeated on a second over: published dmr (activity) with its proof", () => {
		const store = newStore()
		const id = syncRow(store, "s1", T0)
		expect(syncRow(store, "s2", T0 + MIN)).toBe(id)
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.confidence).toBe("activity")
		expect(store.get(id)?.proof?.kind).toBe("digital-undecoded")
	})

	it("one row with a colour code: published dmr", () => {
		const store = newStore()
		const id = syncRow(store, "s1", T0, { unverifiedCc: 7 })
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.proof?.unverifiedCc).toBe(7)
		// ownDmrHint counts it (VoicePrior.digitalProofs `colourCode`).
		expect(store.voicePrior(id)?.digitalProofs?.()[0]).toMatchObject({
			checked: false,
			colourCode: true,
		})
	})

	it("one row with verified TG/SRC: published dmr", () => {
		const store = newStore()
		const id = syncRow(store, "s1", T0, { contentVerified: true })
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.proof?.tgSrcVerified).toBe(true)
	})
})
