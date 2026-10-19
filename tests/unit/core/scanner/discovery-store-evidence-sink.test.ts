import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ScannerProbeDecoderType } from "@wavekit/api-types"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { OBSERVATIONS_PER_DISCOVERY } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type {
	ProofAnalogInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	PROOF_ANALOG_MAX_PER_OBSERVATION,
	PROOF_TRIALS_MAX_PER_OBSERVATION,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const logger = createLogger({ level: "fatal" })

function newStore(opts: { max?: number; rasters?: Raster[] } = {}): {
	store: DiscoveryStore
	entries: JournalEntry[]
} {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: opts.max ?? 100,
		now: () => T0,
		newId: counterIds(),
		...(opts.rasters !== undefined
			? { rasters: () => opts.rasters ?? [] }
			: {}),
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

function sideSize(store: DiscoveryStore): number {
	const bag = (
		store as unknown as {
			evidenceByObservation?: { size: number }
		}
	).evidenceByObservation
	return bag?.size ?? -1
}

function trial(
	protocol: ProofTrialInput["protocol"],
	order: number,
	outcome: ProofTrialInput["outcome"] = "no-sync",
	at = T0 + order,
): ProofTrialInput {
	return { protocol, decoder: "dsd-fme", outcome, order, at }
}

function carrierOnly(at = T0): ProofAnalogInput {
	return {
		outcome: "carrier-only",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function heard(at = T0): ProofAnalogInput {
	return {
		outcome: "heard",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function tone(at = T0): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}

function dataLike(at = T0): ProofAnalogInput {
	return {
		outcome: "data-like",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function noSyncAnalog(at: number): ProofAnalogInput {
	return {
		outcome: "no-sync",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function planted(): {
	store: DiscoveryStore
	entries: JournalEntry[]
	id: string
	obs: string
} {
	const built = newStore({ rasters: PMR })
	const ingested = built.store.ingest(
		makeObs({ id: "o1", centreHz: CH, startedAt: T0 }),
	)
	return {
		...built,
		id: ingested.discoveryId ?? "",
		obs: "o1",
	}
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-scanner-proof-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function diskText(dir: string): Promise<string> {
	const parts: string[] = []
	try {
		parts.push(await readFile(join(dir, "discoveries.json"), "utf8"))
	} catch {
		// snapshot not written
	}
	let names: string[] = []
	try {
		names = await readdir(join(dir, "journal"))
	} catch {
		names = []
	}
	for (const name of names.sort())
		parts.push(await readFile(join(dir, "journal", name), "utf8"))
	return parts.join("\n")
}

describe("DiscoveryStore evidence sink", () => {
	it("recordTrial on an unknown observation returns false and emits no change", () => {
		const { store } = planted()
		const changes: string[] = []
		store.on("change", (id: string, change: string) =>
			changes.push(`${id}:${change}`),
		)
		const before = store.snapshot()
		expect(store.recordTrial("missing", trial("dmr", 1))).toBe(false)
		expect(changes).toEqual([])
		expect(store.snapshot()).toEqual(before)
		expect(sideSize(store)).toBe(0)
	})

	it("replaces a later outcome for the same protocol, decoder and order", () => {
		const { store, id, obs } = planted()
		expect(store.recordAnalog(obs, dataLike())).toBe(true)
		expect(store.recordTrial(obs, trial("dmr", 1, "pending"))).toBe(true)
		expect(store.get(id)?.proof).toBeUndefined()
		const changes: string[] = []
		store.on("change", (idSeen: string, change: string) =>
			changes.push(`${idSeen}:${change}`),
		)
		expect(store.recordTrial(obs, trial("dmr", 1, "pending"))).toBe(false)
		expect(changes).toEqual([])
		expect(store.recordTrial(obs, trial("dmr", 1, "no-sync", T0 + 5))).toBe(
			true,
		)
		expect(changes).toEqual([`${id}:updated`])
		expect(store.get(id)?.proof?.tried).toEqual(["dmr"])
		expect(store.get(id)?.proof?.kind).toBe("digital-undecoded")
	})

	it("nextTrialOrder is strictly increasing", () => {
		const { store } = planted()
		expect(store.nextTrialOrder()).toBe(1)
		expect(store.nextTrialOrder()).toBe(2)
		store.restore(store.snapshot())
		expect(store.nextTrialOrder()).toBe(3)
		expect(newStore().store.nextTrialOrder()).toBe(1)
	})

	it("keeps the 32 highest trial orders and the 8 newest analog rows", () => {
		const { store, id, obs } = planted()
		expect(store.recordAnalog(obs, dataLike(1))).toBe(true)
		for (let order = 1; order <= PROOF_TRIALS_MAX_PER_OBSERVATION; order++) {
			const protocol = order === 1 ? "lora" : "dmr"
			expect(
				store.recordTrial(obs, trial(protocol, order, "no-sync", order)),
			).toBe(true)
		}
		expect(store.get(id)?.proof?.tried).toEqual(["lora", "dmr"])
		expect(
			store.recordTrial(
				obs,
				trial("p25p1", PROOF_TRIALS_MAX_PER_OBSERVATION + 1, "no-sync"),
			),
		).toBe(true)
		expect(store.get(id)?.proof?.tried).toEqual(["dmr", "p25p1"])
		expect(store.get(id)?.proof?.tried).not.toContain("lora")
		const bounded = planted()
		expect(bounded.store.recordAnalog(bounded.obs, dataLike())).toBe(true)
		for (let order = 2; order <= PROOF_TRIALS_MAX_PER_OBSERVATION + 1; order++)
			expect(
				bounded.store.recordTrial(bounded.obs, trial("dmr", order, "no-sync")),
			).toBe(true)
		expect(bounded.store.get(bounded.id)?.proof?.tried).toEqual(["dmr"])
		expect(bounded.store.recordTrial(bounded.obs, trial("lora", 1))).toBe(false)
		expect(bounded.store.get(bounded.id)?.proof?.tried).toEqual(["dmr"])

		const tones = planted()
		expect(tones.store.recordAnalog(tones.obs, tone(1))).toBe(true)
		for (let i = 0; i < PROOF_ANALOG_MAX_PER_OBSERVATION - 1; i++)
			expect(tones.store.recordAnalog(tones.obs, noSyncAnalog(10 + i))).toBe(
				true,
			)
		expect(tones.store.get(tones.id)?.proof?.summary).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
		expect(tones.store.recordAnalog(tones.obs, noSyncAnalog(0))).toBe(false)
		expect(tones.store.get(tones.id)?.proof?.summary).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
		expect(tones.store.recordAnalog(tones.obs, noSyncAnalog(100))).toBe(true)
		expect(tones.store.get(tones.id)?.proof).toBeUndefined()
		expect(tones.store.get(tones.id)?.evidenceLevel).toBe("weak")
		const same = noSyncAnalog(10)
		expect(tones.store.recordAnalog(tones.obs, same)).toBe(false)
	})

	it("recordUnavailable is set-like and sorted", () => {
		const { store, obs } = planted()
		const order = ["rtl433", "direwolf", "dsd-fme", "multimon-ng"] as const
		for (const type of order)
			expect(store.recordUnavailable(obs, type)).toBe(true)
		expect(store.recordUnavailable(obs, "dsd-fme")).toBe(false)
		expect(
			store.recordUnavailable(obs, "nope" as ScannerProbeDecoderType),
		).toBe(false)
		expect(store.recordAnalog(obs, dataLike())).toBe(true)
		expect(
			store.get(store.discoveryIdOf(obs) ?? "")?.proof?.unavailable,
		).toEqual(["direwolf", "dsd-fme", "multimon-ng", "rtl433"])
		expect(store.get(store.discoveryIdOf(obs) ?? "")?.proof?.summary).toBe(
			"Digital, not decoded (direwolf, dsd-fme, multimon-ng, rtl433 unavailable)",
		)
	})

	it("a true return emits one updated change whose discovery DTO carries the new proof", () => {
		const { store, id, obs } = planted()
		const seen: string[] = []
		store.on("change", (changed: string) => {
			seen.push(store.get(changed)?.proof?.summary ?? "")
		})
		expect(store.recordAnalog(obs, heard())).toBe(true)
		expect(seen).toEqual(["Analog FM voice"])
		const dto = store.get(id)
		expect(dto?.proof?.kind).toBe("analog-voice")
		expect(dto?.evidenceLevel).toBe("proven")
		expect(dto?.protocol).toBe("analog-fm")
		expect(dto?.family).toBe("analog")
		expect(dto?.confidence).toBe("candidate")
		const listed = store.list({}).items[0]
		expect(listed?.protocol).toBe("analog-fm")
		expect(listed?.evidenceLevel).toBe("proven")
		expect(listed?.proof?.summary).toBe("Analog FM voice")
		const observation = store.observations(id, null, 10).items[0]
		expect(observation?.proof?.kind).toBe("analog-voice")
		expect(JSON.stringify(observation)).not.toContain('"evidenceLevel"')
		const operated = store.setOperator(id, { label: "Site" })
		expect(operated.evidenceLevel).toBe("proven")
		expect(operated.protocol).toBe("analog-fm")
		expect(operated.proof?.summary).toBe("Analog FM voice")
		expect(store.get(id)?.proof).not.toBe(dto?.proof)
	})

	it("the sink writes no journal entry and snapshot() is deep-equal before and after", async () => {
		await withDir(async dir => {
			const persistence = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			})
			await persistence.load()
			const { store, entries, id, obs } = planted()
			const pending: Promise<unknown>[] = []
			store.on("mutation", (entry: Omit<JournalEntry, "seq">) => {
				pending.push(persistence.append(entry))
			})
			const before = store.snapshot()
			const journalled = entries.length
			expect(store.recordAnalog(obs, heard())).toBe(true)
			expect(store.recordTrial(obs, trial("dmr", 1, "unsupported"))).toBe(true)
			expect(store.recordUnavailable(obs, "dsd-fme")).toBe(true)
			expect(entries).toHaveLength(journalled)
			expect(store.snapshot()).toEqual(before)
			expect(JSON.stringify(store.snapshot())).not.toContain('"proof"')
			expect(JSON.stringify(store.snapshot())).not.toContain('"evidenceLevel"')
			expect(JSON.stringify(before)).not.toContain("Analog FM voice")
			store.setOperator(id, { label: "kept" })
			await Promise.all(pending)
			await persistence.writeSnapshot(store.snapshot())
			const text = await diskText(dir)
			expect(text).not.toContain('"proof"')
			expect(text).not.toContain('"evidenceLevel"')
			expect(text).not.toContain("Analog FM voice")
			expect(text.length).toBeGreaterThan(0)
		})
	})

	it("restore drops an analog-voice proof and keeps a persisted decode", () => {
		const voiceStore = planted()
		expect(voiceStore.store.recordAnalog(voiceStore.obs, heard())).toBe(true)
		expect(voiceStore.store.get(voiceStore.id)?.evidenceLevel).toBe("proven")
		const restored = newStore({ rasters: PMR }).store
		restored.restore(voiceStore.store.snapshot())
		expect(restored.get(voiceStore.id)?.proof).toBeUndefined()
		expect(restored.get(voiceStore.id)?.evidenceLevel).toBe("weak")
		expect(sideSize(restored)).toBe(0)

		const decoded = planted()
		expect(
			decoded.store.appendObservationEvidence(
				decoded.obs,
				evidence("dmr", T0 + 10, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(decoded.store.get(decoded.id)?.proof).toBeUndefined()
		expect(decoded.store.get(decoded.id)?.confidence).toBe("activity")
		expect(decoded.store.get(decoded.id)?.identity).toBeUndefined()
		expect(
			decoded.store.applyEvidence(
				decoded.id,
				evidence("dmr", T0 + 10, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		expect(decoded.store.get(decoded.id)?.proof?.summary).toBe(
			"DMR decoded (CC1)",
		)
		expect(decoded.store.get(decoded.id)?.proof?.transport).toBe("live")
		expect(
			decoded.store.observations(decoded.id, null, 10).items[0]?.proof?.kind,
		).toBe("decoded")
		const again = newStore({ rasters: PMR }).store
		again.restore(decoded.store.snapshot())
		expect(again.get(decoded.id)?.proof?.summary).toBe("DMR decoded (CC1)")
		expect(again.get(decoded.id)?.evidenceLevel).toBe("proven")

		const labeled = planted()
		expect(
			labeled.store.applyEvidence(
				labeled.id,
				evidence("dmr", T0 + 20, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		expect(labeled.store.get(labeled.id)?.confidence).toBe("decoded")
		expect(labeled.store.get(labeled.id)?.proof).toBeUndefined()

		const ambient = planted()
		const ambientEvidence = {
			...evidence("ais", T0 + 10, {
				identity: { kind: "ais-mmsi", value: "211234567" },
			}),
			origin: "ambient" as const,
		}
		expect(
			ambient.store.appendObservationEvidence(ambient.obs, ambientEvidence),
		).toBe(true)
		expect(ambient.store.get(ambient.id)?.proof).toBeUndefined()
		expect(ambient.store.applyEvidence(ambient.id, ambientEvidence)).toBe(
			"upgraded",
		)
		expect(ambient.store.get(ambient.id)?.proof?.transport).toBe("ambient")
		expect(ambient.store.get(ambient.id)?.proof?.summary).toBe(
			"AIS decoded (MMSI 211234567)",
		)
	})

	it("evicting or pruning a discovery deletes its observations' side-table entries", () => {
		const evicting = newStore({ max: 1 })
		const first = evicting.store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0 }),
		)
		expect(evicting.store.recordAnalog("o1", heard())).toBe(true)
		expect(sideSize(evicting.store)).toBe(1)
		expect(first.discoveryId).toBeTruthy()
		evicting.store.ingest(
			makeObs({ id: "o2", centreHz: CH + 1_000_000, startedAt: T0 + 1_000 }),
		)
		expect(evicting.store.get(first.discoveryId ?? "")).toBeUndefined()
		expect(sideSize(evicting.store)).toBe(0)

		const pruning = newStore()
		pruning.store.ingest(
			makeObs({ id: "old", centreHz: CH, startedAt: T0 - 10 * DAY }),
		)
		expect(pruning.store.recordAnalog("old", heard())).toBe(true)
		expect(sideSize(pruning.store)).toBe(1)
		expect(pruning.store.pruneInactive(1)).toHaveLength(1)
		expect(sideSize(pruning.store)).toBe(0)

		const dropped = planted()
		expect(dropped.store.recordTrial(dropped.obs, trial("dmr", 1))).toBe(true)
		expect(dropped.store.delete(dropped.id)).toBe(true)
		expect(sideSize(dropped.store)).toBe(0)
		const again = dropped.store.ingest(
			makeObs({ id: dropped.obs, centreHz: CH, startedAt: T0 }),
		)
		expect(dropped.store.recordAnalog(dropped.obs, dataLike())).toBe(true)
		expect(dropped.store.get(again.discoveryId ?? "")?.proof).toBeUndefined()
		expect(dropped.store.get(again.discoveryId ?? "")?.evidenceLevel).toBe(
			"weak",
		)
	})

	it("after a merge, the survivor's proof still sees the absorbed observation's trials", () => {
		const { store } = newStore({ rasters: PMR })
		const a = store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0 }),
		).discoveryId
		const b = store.ingest(
			makeObs({ id: "o2", centreHz: CH + 3_500, startedAt: T0 + 1_000 }),
		).discoveryId
		expect(a).toBeTruthy()
		expect(b).toBeTruthy()
		expect(a).not.toBe(b)
		expect(store.recordAnalog("o2", dataLike())).toBe(true)
		expect(store.recordTrial("o2", trial("dmr", 1))).toBe(true)
		expect(store.rekey("src-1", 3_000)).toEqual({ merged: [[a, b]] })
		expect(store.get(a ?? "")?.proof?.tried).toEqual(["dmr"])
		expect(store.get(a ?? "")?.proof?.kind).toBe("digital-undecoded")
		expect(store.discoveryIdOf("o2")).toBe(a)
	})

	it("refuses malformed or throwing evidence without emitting or storing it", () => {
		const { store, id, obs, entries } = planted()
		const before = store.snapshot()
		const changes: string[] = []
		store.on("change", () => changes.push("x"))
		const boom = new Proxy(trial("dmr", 1), {
			get(target, key) {
				if (key === "outcome") throw new Error("trial blew up")
				return Reflect.get(target, key)
			},
		})
		expect(store.recordTrial(obs, boom)).toBe(false)
		expect(store.recordTrial(obs, { ...trial("dmr", 1), decoder: "" })).toBe(
			false,
		)
		expect(
			store.recordTrial(obs, { ...trial("dmr", 1), order: Number.NaN }),
		).toBe(false)
		expect(
			store.recordTrial(obs, {
				...trial("nope" as "dmr", 1),
			}),
		).toBe(false)
		const badAnalog = new Proxy(heard(), {
			get(target, key) {
				if (key === "voice") throw new Error("analog blew up")
				return Reflect.get(target, key)
			},
		})
		expect(store.recordAnalog(obs, badAnalog)).toBe(false)
		expect(store.recordAnalog(obs, { ...heard(), outcome: "decoded" })).toBe(
			false,
		)
		expect(changes).toEqual([])
		expect(store.snapshot()).toEqual(before)
		expect(entries.filter(entry => entry.op !== "observation")).toEqual([])
		expect(store.get(id)?.proof).toBeUndefined()
		expect(sideSize(store)).toBe(0)
	})

	it("drops a trimmed observation's side-table entry and completes a digital plan from the rows that remain", () => {
		const { store } = newStore({ rasters: PMR })
		const first = store.ingest(
			makeObs({ id: "old", centreHz: CH, startedAt: T0 }),
		).discoveryId
		expect(store.recordAnalog("old", dataLike())).toBe(true)
		expect(store.recordTrial("old", trial("lora", 1))).toBe(true)
		for (let i = 1; i <= OBSERVATIONS_PER_DISCOVERY; i++) {
			store.ingest(
				makeObs({
					id: `n${i}`,
					centreHz: CH,
					startedAt: T0 + i,
				}),
			)
		}
		expect(store.discoveryIdOf("old")).toBeUndefined()
		expect(sideSize(store)).toBe(0)
		expect(store.recordAnalog("n1", dataLike(T0 + 1))).toBe(true)
		expect(store.recordTrial("n1", trial("dmr", 4, "pending"))).toBe(true)
		expect(store.get(first ?? "")?.proof).toBeUndefined()
		expect(store.recordTrial("n1", trial("dmr", 4, "no-sync", T0 + 4))).toBe(
			true,
		)
		expect(store.get(first ?? "")?.proof?.tried).toEqual(["dmr"])
		const floor = planted()
		expect(floor.store.recordAnalog(floor.obs, dataLike(50))).toBe(true)
		expect(
			floor.store.recordTrial(floor.obs, {
				...trial("analog-fm", 5, "pending", 50),
				decoder: "analog-demod",
			}),
		).toBe(true)
		expect(
			floor.store.recordTrial(floor.obs, trial("dmr", 6, "no-sync", 80)),
		).toBe(true)
		expect(floor.store.get(floor.id)?.proof?.kind).toBe("digital-undecoded")
		expect(
			floor.store.recordTrial(floor.obs, trial("p25p1", 7, "running", 90)),
		).toBe(true)
		expect(floor.store.get(floor.id)?.proof).toBeUndefined()
	})

	it("copies stored rows so a caller cannot alias them into the snapshot", () => {
		const { store, obs } = planted()
		const row = tone()
		expect(store.recordAnalog(obs, row)).toBe(true)
		const snap = JSON.stringify(store.snapshot())
		row.tone.ctcssHz = 67
		row.outcome = "heard"
		expect(JSON.stringify(store.snapshot())).toBe(snap)
		expect(store.get(store.discoveryIdOf(obs) ?? "")?.proof?.summary).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
	})

	it("takes protocol and identity from the same winning decode", () => {
		const first = planted()
		expect(
			first.store.appendObservationEvidence(
				first.obs,
				evidence("p25p1", T0 + 100, {
					identity: { kind: "p25-nac", value: "AB" },
				}),
			),
		).toBe(true)
		expect(
			first.store.applyEvidence(
				first.id,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		const won = first.store.get(first.id)
		expect(won?.protocol).toBe("p25p1")
		expect(won?.family).toBe("digital-voice")
		expect(won?.confidence).toBe("decoded")
		expect(won?.identity).toEqual({ kind: "p25-nac", value: "AB" })
		const stored = first.store
			.snapshot()
			.discoveries.find(d => d.id === first.id)
		expect(stored?.protocol).toBe("p25p1")
		expect(stored?.identity).toEqual({ kind: "p25-nac", value: "AB" })

		const held = planted()
		expect(
			held.store.applyEvidence(
				held.id,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		expect(
			held.store.appendObservationEvidence(
				held.obs,
				evidence("p25p1", T0 + 100, {
					identity: { kind: "p25-nac", value: "AB" },
				}),
			),
		).toBe(true)
		expect(
			held.store.applyEvidence(
				held.id,
				evidence("dmr", T0 + 2, { identity: dmrCc(1) }),
			),
		).toBeNull()
		expect(held.store.get(held.id)?.protocol).toBe("dmr")
		expect(held.store.get(held.id)?.identity).toEqual(dmrCc(1))
		expect(held.store.get(held.id)?.confidence).toBe("decoded")
		const kept = held.store.snapshot().discoveries.find(d => d.id === held.id)
		expect(kept?.protocol).toBe("dmr")
		expect(kept?.identity).toEqual(dmrCc(1))
	})

	it("withholds digital-undecoded proof unless every digital trial ran and failed", () => {
		const skipped = planted()
		expect(
			skipped.store.recordTrial(skipped.obs, trial("dmr", 1, "skipped-budget")),
		).toBe(true)
		expect(skipped.store.recordAnalog(skipped.obs, dataLike())).toBe(true)
		expect(skipped.store.get(skipped.id)?.proof).toBeUndefined()
		expect(skipped.store.get(skipped.id)?.evidenceLevel).toBe("weak")

		const cancelled = planted()
		expect(
			cancelled.store.recordTrial(cancelled.obs, trial("dmr", 1, "cancelled")),
		).toBe(true)
		expect(cancelled.store.recordAnalog(cancelled.obs, dataLike())).toBe(true)
		expect(cancelled.store.get(cancelled.id)?.proof).toBeUndefined()
		expect(cancelled.store.get(cancelled.id)?.evidenceLevel).toBe("weak")

		const decodedTrial = planted()
		expect(decodedTrial.store.recordAnalog(decodedTrial.obs, dataLike())).toBe(
			true,
		)
		expect(
			decodedTrial.store.recordTrial(
				decodedTrial.obs,
				trial("dmr", 1, "decoded"),
			),
		).toBe(true)
		expect(
			decodedTrial.store.recordTrial(
				decodedTrial.obs,
				trial("p25p1", 2, "no-sync"),
			),
		).toBe(true)
		expect(decodedTrial.store.get(decodedTrial.id)?.proof?.kind).not.toBe(
			"digital-undecoded",
		)
		expect(decodedTrial.store.get(decodedTrial.id)?.proof).toBeUndefined()

		const alone = planted()
		expect(alone.store.recordAnalog(alone.obs, dataLike())).toBe(true)
		expect(alone.store.get(alone.id)?.proof).toBeUndefined()
		expect(alone.store.get(alone.id)?.evidenceLevel).toBe("weak")

		const unsupported = planted()
		expect(
			unsupported.store.recordTrial(
				unsupported.obs,
				trial("dmr", 1, "unsupported"),
			),
		).toBe(true)
		expect(unsupported.store.recordAnalog(unsupported.obs, dataLike())).toBe(
			true,
		)
		expect(unsupported.store.get(unsupported.id)?.proof).toBeUndefined()

		const missing = planted()
		expect(missing.store.recordUnavailable(missing.obs, "dsd-fme")).toBe(true)
		expect(missing.store.recordAnalog(missing.obs, dataLike())).toBe(true)
		expect(missing.store.get(missing.id)?.proof?.kind).toBe("digital-undecoded")
		expect(missing.store.get(missing.id)?.proof?.summary).toBe(
			"Digital, not decoded (dsd-fme unavailable)",
		)
	})

	it("emits one updated change when a later decode changes only the derived proof", () => {
		const { store, entries, id, obs } = planted()
		expect(
			store.appendObservationEvidence(
				obs,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 1, { identity: dmrCc(1) })),
		).toBe("upgraded")
		const second = store.ingest(
			makeObs({ id: "o2", centreHz: CH, startedAt: T0 + 100_000 }),
		)
		expect(second.discoveryId).toBe(id)
		const journalled = entries.length
		const changes: string[] = []
		const onChange = (changed: string, change: string): void => {
			changes.push(`${changed}:${change}`)
		}
		store.on("change", onChange)
		expect(
			store.appendObservationEvidence(
				"o2",
				evidence("dmr", T0 + 2, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 2, { identity: dmrCc(1) })),
		).toBeNull()
		expect(store.get(id)?.proof?.at).toBe(new Date(T0 + 2).toISOString())
		expect(store.get(id)?.proof?.observationId).toBe("o2")
		expect(changes).toEqual([`${id}:updated`])
		expect(entries).toHaveLength(journalled + 1)
		const payload = entries.at(-1)?.payload as { discoveries?: unknown[] }
		expect(payload.discoveries).toEqual([])
		store.off("change", onChange)
		const quiet: string[] = []
		store.on("change", (changed: string, change: string) => {
			quiet.push(`${changed}:${change}`)
		})
		expect(
			store.appendObservationEvidence(
				obs,
				evidence("dmr", T0, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(store.get(id)?.proof?.at).toBe(new Date(T0 + 2).toISOString())
		expect(store.get(id)?.proof?.observationId).toBe("o2")
		expect(quiet).toEqual([])
	})

	it("raises the returned label from analog evidence and filters on it without persisting it", () => {
		const { store, id, obs } = planted()
		const seen: string[] = []
		store.on("change", (changed: string) => {
			const dto = store.get(changed)
			seen.push(`${dto?.protocol ?? ""}:${dto?.confidence ?? ""}`)
		})
		expect(store.recordAnalog(obs, heard())).toBe(true)
		expect(seen).toEqual(["analog-fm:candidate"])
		const dto = store.get(id)
		expect(dto?.protocol).toBe("analog-fm")
		expect(dto?.family).toBe("analog")
		expect(dto?.confidence).toBe("candidate")
		expect(dto?.evidenceLevel).toBe("proven")
		expect(store.identityOf(id)?.protocol).toBe("unknown")
		expect(store.identityOf(id)?.confidence).toBe("activity")
		expect(store.list({ protocol: "analog-fm" }).items.map(d => d.id)).toEqual([
			id,
		])
		expect(store.list({ protocol: "unknown" }).items).toEqual([])
		expect(
			store.list({ minConfidence: "candidate" }).items.map(d => d.id),
		).toEqual([id])
		expect(store.list({ minConfidence: "classified" }).items).toEqual([])
		expect(store.list({ minConfidence: "decoded" }).items).toEqual([])
		const operated = store.setOperator(id, { label: "Tower" })
		expect(operated.protocol).toBe("analog-fm")
		expect(operated.confidence).toBe("candidate")
		const snap = store.snapshot().discoveries.find(d => d.id === id)
		expect(snap?.protocol).toBe("unknown")
		expect(snap?.confidence).toBe("activity")
		expect(snap?.proof).toBeUndefined()

		const decoded = planted()
		expect(
			decoded.store.applyEvidence(
				decoded.id,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		expect(decoded.store.recordAnalog(decoded.obs, heard())).toBe(true)
		expect(decoded.store.get(decoded.id)?.protocol).toBe("analog-fm")
		expect(decoded.store.get(decoded.id)?.family).toBe("analog")
		expect(decoded.store.get(decoded.id)?.confidence).toBe("candidate")
		expect(decoded.store.get(decoded.id)?.evidenceLevel).toBe("proven")
		expect(decoded.store.get(decoded.id)?.proof?.kind).toBe("analog-voice")
		expect(
			decoded.store.list({ protocol: "analog-fm" }).items.map(d => d.id),
		).toContain(decoded.id)
		expect(decoded.store.list({ protocol: "dmr" }).items).toEqual([])
		const decodedSnap = decoded.store
			.snapshot()
			.discoveries.find(d => d.id === decoded.id)
		expect(decodedSnap?.protocol).toBe("dmr")
		expect(decodedSnap?.confidence).toBe("decoded")

		const capped = planted()
		expect(
			capped.store.appendObservationEvidence(
				capped.obs,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(
			capped.store.applyEvidence(
				capped.id,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
				{ cap: "adjacent-leak" },
			),
		).toBe("upgraded")
		expect(capped.store.get(capped.id)?.confidence).toBe("candidate")
		expect(capped.store.get(capped.id)?.confidenceCap).toBe("adjacent-leak")
		expect(capped.store.get(capped.id)?.proof?.kind).toBe("decoded")
		expect(capped.store.list({ minConfidence: "decoded" }).items).toEqual([])
		expect(
			capped.store.list({ minConfidence: "candidate" }).items.map(d => d.id),
		).toEqual([capped.id])
	})

	it("shows a carrier-only proof as carrier activity and filters on that label", () => {
		const { store, id, obs } = planted()
		expect(store.recordAnalog(obs, carrierOnly())).toBe(true)
		const dto = store.get(id)
		expect(dto?.protocol).toBe("carrier")
		expect(dto?.family).toBe("carrier")
		expect(dto?.confidence).toBe("activity")
		expect(dto?.evidenceLevel).toBe("proven")
		expect(dto?.proof?.kind).toBe("carrier-only")
		expect(dto?.proof?.protocol).toBe("carrier")
		expect(store.list({ protocol: "carrier" }).items.map(d => d.id)).toEqual([
			id,
		])
		expect(store.list({ protocol: "unknown" }).items).toEqual([])
		expect(store.identityOf(id)?.protocol).toBe("unknown")
		expect(store.identityOf(id)?.confidence).toBe("activity")
		const snap = store.snapshot().discoveries.find(d => d.id === id)
		expect(snap?.protocol).toBe("unknown")
		expect(snap?.confidence).toBe("activity")
		expect(snap?.proof).toBeUndefined()
	})

	it("shows the analog-voice proof after a decoded observation is trimmed", () => {
		const { store, id, obs } = planted()
		expect(
			store.appendObservationEvidence(
				obs,
				evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
			),
		).toBe(true)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 1, { identity: dmrCc(1) })),
		).toBe("upgraded")
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.confidence).toBe("decoded")
		for (let i = 1; i <= OBSERVATIONS_PER_DISCOVERY; i++) {
			store.ingest(
				makeObs({
					id: `n${i}`,
					centreHz: CH,
					startedAt: T0 + i,
				}),
			)
		}
		expect(store.discoveryIdOf(obs)).toBeUndefined()
		expect(store.recordAnalog("n1", heard(T0 + 1))).toBe(true)
		const dto = store.get(id)
		expect(dto?.protocol).toBe("analog-fm")
		expect(dto?.family).toBe("analog")
		expect(dto?.confidence).toBe("candidate")
		expect(dto?.evidenceLevel).toBe("proven")
		expect(dto?.proof?.kind).toBe("analog-voice")
		expect(dto?.proof?.summary).toBe("Analog FM voice")
		expect(store.list({ protocol: "analog-fm" }).items.map(d => d.id)).toEqual([
			id,
		])
		expect(store.list({ protocol: "dmr" }).items).toEqual([])
		const snap = store.snapshot().discoveries.find(d => d.id === id)
		expect(snap?.protocol).toBe("dmr")
		expect(snap?.confidence).toBe("decoded")
		expect(snap?.proof).toBeUndefined()
	})

	it("attributes a newer co-channel decode to the discovery that stores its identity", () => {
		const { store, id, obs } = planted()
		const dmr = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
		const p25 = evidence("p25p1", T0 + 2, {
			identity: { kind: "p25-nac", value: "AB" },
		})
		expect(store.appendObservationEvidence(obs, dmr)).toBe(true)
		expect(store.applyEvidence(id, dmr)).toBe("upgraded")
		expect(store.appendObservationEvidence(obs, p25)).toBe(true)
		const before = store.get(id)
		expect(before?.protocol).toBe("dmr")
		expect(before?.confidence).toBe("decoded")
		expect(before?.evidenceLevel).toBe("proven")
		expect(before?.proof?.protocol).toBe("dmr")
		expect(before?.proof?.identity).toEqual(dmrCc(1))
		expect(before?.proof?.kind).toBe("decoded")
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.applyEvidence(id, p25)).toBe("created")
		const dmrDto = store.get(id)
		expect(dmrDto?.protocol).toBe("dmr")
		expect(dmrDto?.confidence).toBe("decoded")
		expect(dmrDto?.evidenceLevel).toBe("proven")
		expect(dmrDto?.proof?.protocol).toBe("dmr")
		expect(dmrDto?.proof?.identity).toEqual(dmrCc(1))
		const twin = store
			.snapshot()
			.discoveries.find(d => d.identity?.value === "AB")
		expect(twin?.protocol).toBe("p25p1")
		expect(twin?.id).toBeTruthy()
		const p25Dto = store.get(twin?.id ?? "")
		expect(p25Dto?.protocol).toBe("p25p1")
		expect(p25Dto?.confidence).toBe("decoded")
		expect(p25Dto?.evidenceLevel).toBe("proven")
		expect(p25Dto?.proof?.kind).toBe("decoded")
		expect(p25Dto?.proof?.protocol).toBe("p25p1")
		expect(p25Dto?.proof?.identity).toEqual({ kind: "p25-nac", value: "AB" })
		expect(p25Dto?.proof?.summary).toBe("P25 decoded (NAC AB)")
	})

	it("publishes one proof after the cap and leaves confidence undecoded until apply", () => {
		const { store, id, obs } = planted()
		const ev = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
		const seen: string[] = []
		store.on("change", (changed: string) => {
			const dto = store.get(changed)
			seen.push(
				`${dto?.confidence ?? ""}:${dto?.confidenceCap ?? ""}:${dto?.proof?.kind ?? ""}`,
			)
		})
		expect(store.appendObservationEvidence(obs, ev)).toBe(true)
		const between = store.get(id)
		expect(between?.confidence).toBe("activity")
		expect(between?.identity).toBeUndefined()
		expect(between?.proof).toBeUndefined()
		const wasDecoded = store.get(id)?.confidence === "decoded"
		expect(wasDecoded).toBe(false)
		expect(seen).toEqual([])
		expect(store.applyEvidence(id, ev, { cap: "adjacent-leak" })).toBe(
			"upgraded",
		)
		expect(seen).toEqual(["candidate:adjacent-leak:decoded"])
		const dto = store.get(id)
		expect(dto?.confidence).toBe("candidate")
		expect(dto?.confidenceCap).toBe("adjacent-leak")
		expect(dto?.protocol).toBe("dmr")
		expect(dto?.proof?.kind).toBe("decoded")
		expect(dto?.proof?.identity).toEqual(dmrCc(1))
		expect(dto?.evidenceLevel).toBe("proven")
		expect(store.identityOf(id)?.confidence).toBe("candidate")
		expect(store.identityOf(id)?.protocol).toBe("dmr")
		const snap = store.snapshot().discoveries.find(d => d.id === id)
		expect(snap?.confidence).toBe("candidate")
		expect(snap?.confidenceCap).toBe("adjacent-leak")
		expect(store.list({ minConfidence: "decoded" }).items).toEqual([])
	})

	it("shows analog tone as classified, candidate when unverified, and candidate under a cap", () => {
		const commanded = planted()
		expect(commanded.store.recordAnalog(commanded.obs, tone())).toBe(true)
		expect(commanded.store.get(commanded.id)?.protocol).toBe("analog-fm")
		expect(commanded.store.get(commanded.id)?.confidence).toBe("classified")
		expect(commanded.store.get(commanded.id)?.proof?.kind).toBe("analog-tone")
		expect(
			commanded.store.applyClassification(commanded.id, {
				class: "unknown",
				hypotheses: [],
				tier: "channel",
				cap: "adjacent-leak",
			}),
		).toBe("updated")
		expect(commanded.store.get(commanded.id)?.confidence).toBe("candidate")
		expect(commanded.store.get(commanded.id)?.confidenceCap).toBe(
			"adjacent-leak",
		)
		expect(commanded.store.get(commanded.id)?.protocol).toBe("analog-fm")
		expect(commanded.store.get(commanded.id)?.proof?.kind).toBe("analog-tone")

		const { store } = newStore({ rasters: PMR })
		const input = makeObs({ id: "o1", centreHz: CH, startedAt: T0 })
		input.track.tuningTrust = "unverified"
		const ingested = store.ingest(input)
		const id = ingested.discoveryId ?? ""
		expect(store.recordAnalog("o1", tone())).toBe(true)
		expect(store.get(id)?.protocol).toBe("analog-fm")
		expect(store.get(id)?.confidence).toBe("candidate")
		expect(store.get(id)?.proof?.kind).toBe("analog-tone")
		const snap = store.snapshot().discoveries.find(d => d.id === id)
		expect(snap?.protocol).toBe("unknown")
		expect(snap?.confidence).toBe("activity")
	})

	it("keeps the evidence filter and the DTO together after the proof cache drops", () => {
		const { store, id, obs } = planted()
		expect(store.recordAnalog(obs, tone())).toBe(true)
		expect(store.list({ evidence: "proven" }).items.map(d => d.id)).toEqual([
			id,
		])
		const agree = (
			rows: { id: string; evidenceLevel?: string }[],
			dto: ReturnType<DiscoveryStore["get"]>,
		): void => {
			expect(rows.map(d => d.id)).toEqual([id])
			const listed = rows[0]
			expect(listed?.evidenceLevel).toBe(dto?.evidenceLevel)
			expect(listed).toMatchObject({
				protocol: dto?.protocol,
				family: dto?.family,
				confidence: dto?.confidence,
				evidenceLevel: dto?.evidenceLevel,
			})
		}

		expect(
			store.applyClassification(id, {
				class: "unknown",
				hypotheses: [],
				tier: "channel",
				cap: "adjacent-leak",
			}),
		).toBe("updated")
		const capped = store.get(id)
		expect(capped?.evidenceLevel).toBe("proven")
		expect(capped?.protocol).toBe("analog-fm")
		expect(capped?.confidence).toBe("candidate")
		agree(store.list({ evidence: "proven" }).items, capped)
		agree(
			store.list({ evidence: "proven", protocol: "analog-fm" }).items,
			capped,
		)
		expect(store.list({ evidence: "weak" }).items).toEqual([])
		expect(
			store.list({ evidence: "proven", minConfidence: "classified" }).items,
		).toEqual([])
		expect(
			store
				.list({ evidence: "proven", minConfidence: "candidate" })
				.items.map(d => d.id),
		).toEqual([id])

		const restored = newStore({ rasters: PMR })
		restored.store.restore(store.snapshot())
		const weak = restored.store.get(id)
		expect(weak?.evidenceLevel).toBe("weak")
		expect(weak?.proof).toBeUndefined()
		expect(weak?.protocol).toBe("unknown")
		expect(restored.store.list({ evidence: "proven" }).items).toEqual([])
		agree(restored.store.list({ evidence: "weak" }).items, weak)
		agree(
			restored.store.list({ evidence: "weak", protocol: "unknown" }).items,
			weak,
		)
		expect(restored.store.list({ protocol: "analog-fm" }).items).toEqual([])

		const decode = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
		expect(restored.store.appendObservationEvidence(obs, decode)).toBe(true)
		expect(restored.store.applyEvidence(id, decode)).toBe("upgraded")
		const proven = restored.store.get(id)
		expect(proven?.evidenceLevel).toBe("proven")
		expect(proven?.protocol).toBe("dmr")
		expect(proven?.confidence).toBe("candidate")
		expect(proven?.confidenceCap).toBe("adjacent-leak")
		expect(proven?.proof?.kind).toBe("decoded")
		agree(restored.store.list({ evidence: "proven" }).items, proven)
		agree(
			restored.store.list({ evidence: "proven", protocol: "dmr" }).items,
			proven,
		)
		expect(
			restored.store.list({ evidence: "proven", minConfidence: "decoded" })
				.items,
		).toEqual([])
		expect(
			restored.store
				.list({ evidence: "proven", minConfidence: "candidate" })
				.items.map(d => d.id),
		).toEqual([id])
		expect(restored.store.list({ evidence: "weak" }).items).toEqual([])
		expect(restored.store.list({ protocol: "unknown" }).items).toEqual([])
	})
})

function coChannelPair(): {
	store: DiscoveryStore
	entries: JournalEntry[]
	ownerId: string
	twinId: string
	obs: string
} {
	const { store, entries, id, obs } = planted()
	const dmr = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
	const p25 = evidence("p25p1", T0 + 2, {
		identity: { kind: "p25-nac", value: "AB" },
	})
	expect(store.appendObservationEvidence(obs, dmr)).toBe(true)
	expect(store.applyEvidence(id, dmr)).toBe("upgraded")
	expect(store.appendObservationEvidence(obs, p25)).toBe(true)
	expect(store.applyEvidence(id, p25)).toBe("created")
	const twin = store
		.snapshot()
		.discoveries.find(d => d.identity?.value === "AB")
	const twinId = twin?.id ?? ""
	expect(twinId).not.toBe("")
	expect(store.get(twinId)?.evidenceLevel).toBe("proven")
	expect(store.get(twinId)?.proof?.observationId).toBe(obs)
	return { store, entries, ownerId: id, twinId, obs }
}

describe("co-channel proof invalidation", () => {
	it("drops the twin proof when the observation owner is deleted", () => {
		const { store, entries, ownerId, twinId, obs } = coChannelPair()
		const seen: string[] = []
		store.on("change", (id: string, change: string) => {
			if (id !== twinId) return
			const dto = store.get(id)
			seen.push(
				`${change}:${dto?.evidenceLevel ?? ""}:${dto?.proof?.observationId ?? ""}`,
			)
		})
		const journalBefore = entries.length
		expect(store.delete(ownerId)).toBe(true)
		expect(store.get(ownerId)).toBeUndefined()
		expect(store.discoveryIdOf(obs)).toBeUndefined()
		expect(store.get(twinId)?.evidenceLevel).toBe("weak")
		expect(store.get(twinId)?.proof).toBeUndefined()
		expect(seen).toEqual(["updated:weak:"])
		expect(entries.length).toBe(journalBefore + 1)
		const snap = store.snapshot()
		const again = newStore({ rasters: PMR })
		again.store.restore(snap)
		expect(again.store.get(twinId)?.evidenceLevel).toBe("weak")
		expect(again.store.get(twinId)?.proof).toBeUndefined()
	})

	it("drops the twin proof when newer decodes trim its evidence", () => {
		const { store, entries, twinId, obs } = coChannelPair()
		const seen: string[] = []
		store.on("change", (id: string, change: string) => {
			if (id !== twinId) return
			const dto = store.get(id)
			seen.push(
				`${change}:${dto?.evidenceLevel ?? ""}:${dto?.proof?.protocol ?? ""}`,
			)
		})
		const journalBefore = entries.length
		for (let i = 0; i < 16; i++) {
			expect(
				store.appendObservationEvidence(
					obs,
					evidence("dmr", T0 + 10 + i, { identity: dmrCc(1) }),
				),
			).toBe(true)
		}
		expect(store.get(twinId)?.evidenceLevel).toBe("weak")
		expect(store.get(twinId)?.proof).toBeUndefined()
		expect(seen).toEqual(["updated:weak:"])
		const added = entries.slice(journalBefore)
		expect(added).toHaveLength(16)
		for (const entry of added) {
			const discoveries = (entry.payload as { discoveries?: { id: string }[] })
				.discoveries
			expect(discoveries?.map(d => d.id)).not.toContain(twinId)
		}
		const again = newStore({ rasters: PMR })
		again.store.restore(store.snapshot())
		expect(again.store.get(twinId)?.evidenceLevel).toBe("weak")
		expect(again.store.get(twinId)?.proof).toBeUndefined()
	})

	it("drops the twin proof when the source observation is trimmed", () => {
		const { store, entries } = newStore({ rasters: PMR })
		const ownerId =
			store.ingest(makeObs({ id: "o1", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		for (let i = 1; i < OBSERVATIONS_PER_DISCOVERY; i++) {
			store.ingest(makeObs({ id: `n${i}`, centreHz: CH, startedAt: T0 + i }))
		}
		const dmr = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
		const p25 = evidence("p25p1", T0 + 2, {
			identity: { kind: "p25-nac", value: "AB" },
		})
		expect(store.appendObservationEvidence("o1", dmr)).toBe(true)
		expect(store.applyEvidence(ownerId, dmr)).toBe("upgraded")
		expect(store.appendObservationEvidence("o1", p25)).toBe(true)
		expect(store.applyEvidence(ownerId, p25)).toBe("created")
		const twinId =
			store.snapshot().discoveries.find(d => d.identity?.value === "AB")?.id ??
			""
		expect(store.get(twinId)?.evidenceLevel).toBe("proven")
		expect(store.get(twinId)?.proof?.observationId).toBe("o1")
		const seen: string[] = []
		store.on("change", (id: string, change: string) => {
			if (id !== twinId) return
			seen.push(`${change}:${store.get(id)?.evidenceLevel ?? ""}`)
		})
		const otherId =
			store.ingest(
				makeObs({
					id: "extra",
					centreHz: CH + 3_500,
					startedAt: T0 + 50_000,
				}),
			).discoveryId ?? ""
		const later = evidence("dmr", T0 + 50_000, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("extra", later)).toBe(true)
		expect(store.applyEvidence(otherId, later)).toBe("upgraded")
		expect(store.rekey("src-1", 3_000).merged.length).toBeGreaterThan(0)
		expect(store.discoveryIdOf("o1")).toBeUndefined()
		expect(store.get(twinId)?.evidenceLevel).toBe("weak")
		expect(store.get(twinId)?.proof).toBeUndefined()
		expect(seen).toEqual(["updated:weak"])
		for (const entry of entries)
			expect(JSON.stringify(entry.payload)).not.toContain('"proof"')
	})

	it("publishes one co-channel update when a shared trial changes the proof", () => {
		const { store, entries, twinId, obs } = coChannelPair()
		const seen: string[] = []
		store.on("change", (id: string) => {
			if (id !== twinId) return
			seen.push(store.get(id)?.proof?.tried.join(",") ?? "")
		})
		const journalBefore = entries.length
		expect(store.recordTrial(obs, trial("ysf", 1))).toBe(true)
		expect(store.get(twinId)?.evidenceLevel).toBe("proven")
		expect(store.get(twinId)?.proof?.summary).toBe("P25 decoded (NAC AB)")
		expect(seen).toEqual(["ysf"])
		expect(entries.length).toBe(journalBefore)
	})
})
