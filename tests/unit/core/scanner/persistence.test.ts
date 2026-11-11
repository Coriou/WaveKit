import { describe, expect, it } from "vitest"
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import {
	BACKUPS_DIR,
	STATE_FORMAT_FILE,
} from "../../../../src/core/state-backup.js"
import type { PersistedJob } from "../../../../src/core/scanner/store/persistence.js"
import type {
	EngineState,
	Raster,
} from "../../../../src/core/spectrum/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { makeNormalisedSpec } from "../../../mocks/scanner/job-spec.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const EMPTY_MUTATION = { discoveries: [], observations: [], deleted: [] }
const entry = (at: number): Omit<JournalEntry, "seq"> => ({
	at: new Date(at).toISOString(),
	op: "observation",
	payload: EMPTY_MUTATION,
})

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-scanner-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function journalFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(join(dir, "journal"))).sort()
	} catch {
		return []
	}
}

async function maxSeqOf(path: string): Promise<number> {
	const text = await readFile(path, "utf8")
	let max = 0
	for (const line of text.split("\n")) {
		if (line === "") continue
		try {
			const seq = (JSON.parse(line) as { seq?: unknown }).seq
			if (typeof seq === "number") max = Math.max(max, seq)
		} catch {
			// torn line
		}
	}
	return max
}

describe("ScannerPersistence journal", () => {
	it("assigns monotonic seq across restarts and rotates files per UTC day", async () => {
		await withDir(async dir => {
			let clock = T0
			const p = new ScannerPersistence({ dir, logger, now: () => clock })
			await p.load()
			expect(await p.append(entry(clock))).toBe(1)
			expect(await p.append(entry(clock))).toBe(2)
			clock += DAY
			expect(await p.append(entry(clock))).toBe(3)
			expect(await journalFiles(dir)).toEqual([
				"observations-20261009.jsonl",
				"observations-20261010.jsonl",
			])

			const again = new ScannerPersistence({ dir, logger, now: () => clock })
			const loaded = await again.load()
			expect(loaded.entries.map(e => e.seq)).toEqual([1, 2, 3])
			expect(await again.append(entry(clock))).toBe(4)
		})
	})

	it("drops a torn final line, keeps earlier lines, and appends cleanly after it", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.load()
			await p.append(entry(T0))
			await p.append(entry(T0))
			const [file] = await journalFiles(dir)
			await appendFile(
				join(dir, "journal", file ?? ""),
				'{"seq":3,"at":"2026-10-09T12:00:00.000Z","op":"obs',
			)
			const reopened = new ScannerPersistence({ dir, logger, now: () => T0 })
			const loaded = await reopened.load()
			expect(loaded.entries.map(e => e.seq)).toEqual([1, 2])
			expect(loaded.droppedLines).toBe(1)
			expect(await reopened.append(entry(T0))).toBe(3)
			const final = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(final.entries.map(e => e.seq)).toEqual([1, 2, 3])
			expect(final.droppedLines).toBe(0)
		})
	})

	it("skips invalid middle lines and lines whose payload is not a store mutation, and replays the valid line past the gap they leave", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.load()
			await p.append(entry(T0))
			const [file] = await journalFiles(dir)
			const path = join(dir, "journal", file ?? "")
			await appendFile(path, "not json\n")
			await appendFile(
				path,
				`${JSON.stringify({ seq: 2, at: "x", op: "observation", payload: { bogus: 1 } })}\n`,
			)
			await appendFile(path, `${JSON.stringify({ seq: 3, ...entry(T0) })}\n`)
			const reopened = new ScannerPersistence({ dir, logger, now: () => T0 })
			const loaded = await reopened.load()
			// Seq 2 is invalid: salvage replays 3 past it and reports the gap as degraded recovery.
			expect(loaded.entries.map(e => e.seq)).toEqual([1, 3])
			expect(loaded.droppedLines).toBe(2)
			expect(loaded.recoveryHealth).toBe("degraded")
			expect(loaded.journalGap).toEqual({ firstMissing: 2, missing: 1 })
			// A boot gap is no hole: appends go on at once after the highest valid seq.
			expect(await reopened.append(entry(T0))).toBe(4)
			const after = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(after.entries.map(e => e.seq)).toEqual([1, 3, 4])
		})
	})

	it("replays only entries newer than the snapshot", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.load()
			for (let i = 0; i < 3; i++) await p.append(entry(T0))
			await p.writeSnapshot({
				discoveries: [],
				observations: [],
				corrections: [{ sourceId: "src-1", hz: -1_200 }],
			})
			await p.append(entry(T0))
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(3)
			expect(loaded.entries.map(e => e.seq)).toEqual([4])
			expect(loaded.corrections).toEqual([{ sourceId: "src-1", hz: -1_200 }])
		})
	})

	it("reads a snapshot written without corrections as no corrections", async () => {
		await withDir(async dir => {
			await writeFile(
				join(dir, "discoveries.json"),
				JSON.stringify({
					version: 1,
					lastSeq: 0,
					savedAt: new Date(T0).toISOString(),
					discoveries: [],
					observations: [],
				}),
			)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.corrections).toEqual([])
			// Nothing set aside; the pre-migration backup's marker and backup are the only additions.
			expect((await readdir(dir)).sort()).toEqual([
				BACKUPS_DIR,
				"discoveries.json",
				STATE_FORMAT_FILE,
			])
		})
	})

	it("truncates a failed partial append so the next line starts clean, and writes nothing past the hole until a snapshot covers it", async () => {
		await withDir(async dir => {
			let failNext = false
			const shortWrite = async (path: string, data: string): Promise<void> => {
				if (!failNext) return appendFile(path, data)
				failNext = false
				await appendFile(path, data.slice(0, Math.floor(data.length / 2)))
				throw Object.assign(new Error("ENOSPC: no space left on device"), {
					code: "ENOSPC",
				})
			}
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: shortWrite,
			})
			await p.load()
			expect(await p.append(entry(T0))).toBe(1)
			failNext = true
			await expect(p.append(entry(T0))).rejects.toBeInstanceOf(WaveKitError)
			// Seq 2 is a hole: line 3 would replay on a base missing 2, so it is refused.
			await expect(p.append(entry(T0))).rejects.toBeInstanceOf(WaveKitError)
			await p.writeSnapshot({
				discoveries: [],
				observations: [],
				corrections: [],
			})
			expect(await p.append(entry(T0))).toBe(4)
			const [file] = await journalFiles(dir)
			const text = await readFile(join(dir, "journal", file ?? ""), "utf8")
			expect(text.split("\n").filter(l => l !== "")).toHaveLength(2)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(3)
			expect(loaded.entries.map(e => e.seq)).toEqual([4])
			expect(loaded.droppedLines).toBe(0)
		})
	})

	it("rejects appends and snapshots before load()", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await expect(p.append(entry(T0))).rejects.toBeInstanceOf(WaveKitError)
			await expect(
				p.writeSnapshot({ discoveries: [], observations: [], corrections: [] }),
			).rejects.toBeInstanceOf(WaveKitError)
		})
	})

	it("never prunes a file holding a seq beyond the durable snapshot", async () => {
		await withDir(async dir => {
			let clock = T0
			const p = new ScannerPersistence({ dir, logger, now: () => clock })
			await p.load()
			await p.append(entry(clock))
			await p.append(entry(clock))
			await p.writeSnapshot({
				discoveries: [],
				observations: [],
				corrections: [],
			})
			clock += DAY
			await p.append(entry(clock))
			expect(await p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 })).toEqual({
				deleted: ["observations-20261009.jsonl"],
			})
			expect(await journalFiles(dir)).toEqual(["observations-20261010.jsonl"])
		})
	})
})

describe("ScannerPersistence lifecycle files", () => {
	const job: PersistedJob = {
		id: "j_1",
		spec: makeNormalisedSpec(),
		rawSpec: {
			name: "UHF sweep",
			mode: "sweep",
			ranges: [{ startHz: 400_000_000, endHz: 470_000_000 }],
		},
		state: "paused",
		reason: "preempted-operator",
		createdAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0 + 1_000).toISOString(),
		lease: {
			sourceId: "src-1",
			jobId: "j_1",
			acquiredAt: T0,
			snapshot: { frequency: 446_100_000, gainMode: "manual", gain: 496 },
			changedFields: ["frequency"],
		},
	}
	const engine: EngineState = {
		version: 1,
		absoluteFloors: [{ key: "2048000:m:496:2048", dbfs: -92.5 }],
		spurs: [
			{
				key: "2048000:m:496:2048",
				basebandBin: 1100,
				widthBins: 2,
				kind: "baseband",
			},
		],
		kByRange: [{ startHz: 446_000_000, endHz: 446_200_000, k: 9.5 }],
		provisionalSpurs: [
			{
				key: "2048000:m:496:2048",
				basebandBin: 1590,
				widthBins: 2,
				comb: true,
			},
		],
	}

	it("round-trips jobs with the lease, settings and per-source engine state", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.writeJobs([job])
			await p.writeSettings({
				cpuBudgetCores: 0.5,
				passive: { "src-1": false },
				ws: { spectrumHz: 1 },
			})
			await p.writeEngine("rtl/one", engine)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.jobs).toEqual([job])
			expect(loaded.settings).toEqual({
				cpuBudgetCores: 0.5,
				passive: { "src-1": false },
				ws: { spectrumHz: 1 },
			})
			expect(loaded.engines).toEqual({ "rtl/one": engine })
		})
	})

	it("loads a sweep held after a plain resume next to jobs stored before that reason existed", async () => {
		await withDir(async dir => {
			const old = {
				...job,
				id: "j_old",
				state: "paused" as const,
				reason: "source-down" as const,
			}
			const held = {
				...job,
				id: "j_held",
				state: "paused" as const,
				reason: "resumed-without-retune" as const,
			}
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.writeJobs([old])
			// A jobs.json written before the reason existed parses as it did.
			expect(
				(await new ScannerPersistence({ dir, logger, now: () => T0 }).load())
					.jobs,
			).toEqual([old])
			await p.writeJobs([old, held])
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.jobs).toEqual([old, held])
		})
	})

	it("round-trips a lease whose job was deleted (S1-B final review, finding 1)", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			const orphan = { ...job.lease!, sourceId: "src-2", jobId: "j_gone" }
			await p.writeJobs([job], [orphan])
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.jobs).toEqual([job])
			expect(loaded.leases).toEqual([orphan])
			// No orphan: the file has no `leases` key, as before.
			await p.writeJobs([job])
			const raw = JSON.parse(
				await readFile(join(dir, "jobs.json"), "utf8"),
			) as Record<string, unknown>
			expect(raw).not.toHaveProperty("leases")
		})
	})

	it("loadConfig reads jobs, settings and engine state when the journal is unreadable, and stays unloaded", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.writeJobs([job])
			await p.writeSettings({ cpuBudgetCores: 0.5 })
			await p.writeEngine("rtl", engine)
			// a journal "file" that is a directory: load() rejects (EISDIR)
			await mkdir(join(dir, "journal", "observations-20261009.jsonl"), {
				recursive: true,
			})
			const q = new ScannerPersistence({ dir, logger, now: () => T0 })
			await expect(q.load()).rejects.toThrow()
			await expect(q.loadConfig()).resolves.toEqual({
				jobs: [job],
				leases: [],
				settings: { cpuBudgetCores: 0.5 },
				engines: { rtl: engine },
			})
			await expect(q.append(entry(T0))).rejects.toBeInstanceOf(WaveKitError)
			await expect(
				q.writeSnapshot({ discoveries: [], observations: [], corrections: [] }),
			).rejects.toBeInstanceOf(WaveKitError)
		})
	})

	it("starts from defaults when files are corrupt or out of bounds, and never throws", async () => {
		await withDir(async dir => {
			await writeFile(join(dir, "jobs.json"), "{bad json")
			await writeFile(
				join(dir, "settings.json"),
				JSON.stringify({ version: 1, settings: { cpuBudgetCores: -1 } }),
			)
			await writeFile(
				join(dir, "discoveries.json"),
				JSON.stringify({ version: 1, lastSeq: "x" }),
			)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.jobs).toEqual([])
			expect(loaded.settings).toEqual({})
			expect(loaded.discoveries).toEqual([])
			expect(loaded.lastSeq).toBe(0)
			const names = await readdir(dir)
			expect(names.some(n => n.startsWith("discoveries.json.invalid-"))).toBe(
				true,
			)
		})
	})

	it.each([
		["jobs.json", "{bad json"],
		[
			"settings.json",
			JSON.stringify({ version: 1, settings: { futureKnob: true } }),
		],
	])(
		"moves an invalid %s aside before the next write can replace it",
		async (name, bad) => {
			await withDir(async dir => {
				await writeFile(join(dir, name), bad)
				const p = new ScannerPersistence({ dir, logger, now: () => T0 })
				await p.load()
				await p.writeJobs([job])
				await p.writeSettings({ cpuBudgetCores: 0.5 })
				const aside = (await readdir(dir)).filter(n =>
					n.startsWith(`${name}.invalid-`),
				)
				expect(aside).toEqual([`${name}.invalid-${T0}`])
				expect(await readFile(join(dir, aside[0] ?? ""), "utf8")).toBe(bad)
			})
		},
	)

	it("skips invalid engine state files and keeps the valid ones", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.writeEngine("good", engine)
			await p.writeEngine("old", {
				...engine,
				version: 2,
			} as unknown as EngineState)
			await writeFile(
				join(dir, "engine", "torn.json"),
				'{"version":1,"absolute',
			)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.engines).toEqual({ good: engine })
		})
	})
})

type POp =
	| { k: "ingest"; slot: number; blocks: number; jitter: number }
	| { k: "evidence"; pick: number; cc: number }
	| { k: "obsEvidence"; pick: number; cc: number }
	| { k: "operator"; pick: number; label: string }
	| { k: "delete"; pick: number }
	| { k: "rekey"; corr: number }
	| { k: "snapshot" }
	| { k: "day" }
	| { k: "prune"; maxBytes: number }

const pOpArb: fc.Arbitrary<POp> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			k: fc.constant("ingest" as const),
			slot: fc.integer({ min: 0, max: 5 }),
			blocks: fc.integer({ min: 1, max: 3 }),
			jitter: fc.integer({ min: -4_000, max: 4_000 }),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			k: fc.constant("evidence" as const),
			pick: fc.nat(),
			cc: fc.integer({ min: 1, max: 3 }),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			k: fc.constant("obsEvidence" as const),
			pick: fc.nat(),
			cc: fc.integer({ min: 1, max: 3 }),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant("operator" as const),
			pick: fc.nat(),
			label: fc.string({ maxLength: 8 }),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({ k: fc.constant("delete" as const), pick: fc.nat() }),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant("rekey" as const),
			corr: fc.integer({ min: -4_000, max: 4_000 }),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ k: fc.constant("snapshot" as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant("day" as const) }) },
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant("prune" as const),
			maxBytes: fc.integer({ min: 0, max: 20_000 }),
		}),
	},
)
const RASTER: Raster[] = [{ spacingHz: 12_500, firstChannelHz: 446_000_000 }]

describe("ScannerPersistence properties", () => {
	// Feature: signal-discovery-scanner, Property 13: Persistence round trip
	// Validates: spec § 8, § 7.4 (corrections survive pruning)
	it("snapshot + journal replay reproduces the store for any interleaving of snapshots, rotations, re-keys and retention", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(pOpArb, { minLength: 1, maxLength: 25 }),
				fc.boolean(),
				async (ops, torn) => {
					await withDir(async dir => {
						let clock = T0
						const p = new ScannerPersistence({ dir, logger, now: () => clock })
						await p.load()
						const store = new DiscoveryStore({
							maxDiscoveries: 50,
							now: () => clock,
							newId: counterIds(),
							rasters: () => RASTER,
						})
						const writes: Promise<unknown>[] = []
						store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
							writes.push(p.append(e)),
						)
						const pick = (n: number): string | undefined => {
							const ids = store.snapshot().discoveries.map(d => d.id)
							return ids[n % Math.max(1, ids.length)]
						}
						const pickObservation = (n: number): string | undefined => {
							const ids = store.snapshot().observations.map(o => o.id)
							return ids[n % Math.max(1, ids.length)]
						}
						ops.forEach((op, i) => {
							switch (op.k) {
								case "ingest":
									store.ingest(
										makeObs({
											id: `o${i}`,
											centreHz: 446_000_000 + op.slot * 25_000 + op.jitter,
											startedAt: clock + i,
											blocks: op.blocks,
											cls: "fsk4-12k5",
											hypotheses: [["dmr", 0.8]],
										}),
									)
									break
								case "evidence": {
									const id = pick(op.pick)
									if (id !== undefined)
										store.applyEvidence(
											id,
											evidence("dmr", clock + i, {
												identity: dmrCc(op.cc),
												talkgroups: [String(i)],
											}),
										)
									break
								}
								case "obsEvidence": {
									const id = pickObservation(op.pick)
									if (id !== undefined)
										store.appendObservationEvidence(
											id,
											evidence("dmr", clock + i, { identity: dmrCc(op.cc) }),
										)
									break
								}
								case "operator": {
									const id = pick(op.pick)
									if (id !== undefined)
										store.setOperator(id, { label: op.label })
									break
								}
								case "delete": {
									const id = pick(op.pick)
									if (id !== undefined) store.delete(id)
									break
								}
								case "rekey":
									store.rekey("src-1", op.corr)
									break
								case "snapshot":
									writes.push(p.writeSnapshot(store.snapshot()))
									break
								case "day":
									clock += DAY
									break
								case "prune":
									writes.push(
										p.pruneJournal({ maxBytes: op.maxBytes, maxAgeDays: 1 }),
									)
									break
							}
						})
						await Promise.all(writes)
						const files = await journalFiles(dir)
						const newest = files.at(-1)
						if (torn && newest !== undefined)
							await appendFile(
								join(dir, "journal", newest),
								'{"seq":999999,"at":"2026-10-09T00:00:00.000Z","op":"observ',
							)
						const loaded = await new ScannerPersistence({
							dir,
							logger,
							now: () => clock,
						}).load()
						// a restarted process never reuses ids (ULIDs in production)
						const replica = new DiscoveryStore({
							maxDiscoveries: 50,
							now: () => clock,
							newId: () => `R${clock}`,
							rasters: () => RASTER,
						})
						replica.restore(loaded)
						for (const e of loaded.entries) replica.replay(e)
						expect(replica.snapshot()).toEqual(store.snapshot())
						expect(replica.correction("src-1")).toBe(store.correction("src-1"))
						for (const e of loaded.entries) replica.replay(e)
						expect(replica.snapshot()).toEqual(store.snapshot())
						// the restored store keeps snapping like the original (a lost correction splits emitters)
						const late = makeObs({
							id: "late",
							centreHz: 446_003_300,
							startedAt: clock + 1_000,
							cls: "fsk4-12k5",
							hypotheses: [["dmr", 0.8]],
						})
						const original = store.ingest(late)
						const restored = replica.ingest(late)
						expect(restored.change).toBe(original.change)
						expect(replica.get(restored.discoveryId ?? "")?.frequencyKey).toBe(
							store.get(original.discoveryId ?? "")?.frequencyKey,
						)
						// The late ingest journals too: settle it before the directory is removed.
						await Promise.allSettled(writes)
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000) // 100 runs of real file I/O: ≈ 6 s here, above vitest's 5 s default

	// Feature: signal-discovery-scanner, Property 14: Retention
	// Validates: spec § 8
	it("journal retention never deletes a file with seq > lastSeq, meets the cap otherwise, expired before oldest", async () => {
		const batchArb = fc.record({
			day: fc.integer({ min: 0, max: 5 }),
			lines: fc.integer({ min: 1, max: 4 }),
		})
		await fc.assert(
			fc.asyncProperty(
				fc.array(batchArb, { minLength: 1, maxLength: 6 }),
				fc.nat(),
				fc.integer({ min: 0, max: 3_000 }),
				fc.integer({ min: 1, max: 4 }),
				async (rawBatches, snapAt, maxBytes, maxAgeDays) => {
					await withDir(async dir => {
						const batches = [...rawBatches].sort((a, b) => a.day - b.day)
						let clock = T0
						const p = new ScannerPersistence({ dir, logger, now: () => clock })
						await p.load()
						let lastSeq = 0
						let highest = 0
						for (const [i, batch] of batches.entries()) {
							clock = T0 + batch.day * DAY
							for (let n = 0; n < batch.lines; n++)
								highest = await p.append(entry(clock))
							if (i === snapAt % batches.length) {
								await p.writeSnapshot({
									discoveries: [],
									observations: [],
									corrections: [],
								})
								lastSeq = highest
							}
						}
						clock = T0 + 6 * DAY
						const before = new Map<string, { maxSeq: number; bytes: number }>()
						for (const name of await journalFiles(dir)) {
							const path = join(dir, "journal", name)
							before.set(name, {
								maxSeq: await maxSeqOf(path),
								bytes: (await stat(path)).size,
							})
						}
						const { deleted } = await p.pruneJournal({ maxBytes, maxAgeDays })
						const cutoff = new Date(clock - maxAgeDays * DAY)
							.toISOString()
							.slice(0, 10)
							.replaceAll("-", "")
						const expired = (name: string) => name.slice(13, 21) < cutoff
						for (const name of deleted)
							expect(before.get(name)?.maxSeq ?? Infinity).toBeLessThanOrEqual(
								lastSeq,
							)
						const remaining = await journalFiles(dir)
						const total = remaining.reduce(
							(s, n) => s + (before.get(n)?.bytes ?? 0),
							0,
						)
						if (total > maxBytes)
							for (const n of remaining)
								expect(before.get(n)?.maxSeq ?? 0).toBeGreaterThan(lastSeq)
						for (const n of remaining)
							if (expired(n))
								expect(before.get(n)?.maxSeq ?? 0).toBeGreaterThan(lastSeq)
						const firstFresh = deleted.findIndex(n => !expired(n))
						if (firstFresh >= 0)
							expect(deleted.slice(firstFresh).every(n => !expired(n))).toBe(
								true,
							)
						expect(deleted.filter(expired)).toEqual(
							[...deleted.filter(expired)].sort(),
						)
						expect(deleted.filter(n => !expired(n))).toEqual(
							[...deleted.filter(n => !expired(n))].sort(),
						)
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("ScannerPersistence journal salvage past a gap", () => {
	let opened = 0
	/** `counterIds` starting past `from`: each restart draws ids no earlier run used. */
	const idsFrom = (from: number): (() => string) => {
		let n = from
		return () => {
			n += 1
			return n.toString(36).toUpperCase().padStart(26, "0")
		}
	}
	/** Persistence + a store journaling every mutation, as ScannerService wires them. */
	async function open(dir: string, clock: { now: number }) {
		const p = new ScannerPersistence({ dir, logger, now: () => clock.now })
		const loaded = await p.load()
		// A restarted process never reuses ids (ULIDs in production).
		opened++
		const store = new DiscoveryStore({
			maxDiscoveries: 50,
			now: () => clock.now,
			newId: idsFrom(opened * 1_000_000),
			rasters: () => RASTER,
		})
		store.restore(loaded)
		for (const e of loaded.entries) store.replay(e)
		const writes: Promise<number>[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			writes.push(p.append(e)),
		)
		return { p, loaded, store, writes }
	}

	/** One new emitter per call, each on its own 25 kHz slot: one discovery per seq range. */
	function ingest(store: DiscoveryStore, clock: { now: number }, slot: number) {
		store.ingest(
			makeObs({
				id: `o${slot}`,
				centreHz: 446_000_000 + slot * 25_000,
				startedAt: clock.now + slot,
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.8]],
			}),
		)
	}

	const centres = (store: DiscoveryStore): number[] =>
		store
			.snapshot()
			.discoveries.map(d => d.frequencyHz)
			.sort((a, b) => a - b)

	it("an invalid snapshot with a pruned prefix replays the valid tail, and a snapshot of it survives pruning and a second restart", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const first = await open(dir, clock)
			for (let slot = 0; slot < 3; slot++) ingest(first.store, clock, slot)
			await Promise.all(first.writes)
			await first.p.writeSnapshot(first.store.snapshot())
			const covered = first.store.snapshot().discoveries.length
			clock.now += DAY
			for (let slot = 10; slot < 14; slot++) ingest(first.store, clock, slot)
			const tailSeqs = await Promise.all(first.writes.splice(0))
			const tail = tailSeqs.slice(-4)
			const top = Math.max(...tailSeqs)
			// The snapshot covers day 1, so pruning deletes it; then the snapshot is corrupted.
			expect(
				await first.p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 }),
			).toEqual({ deleted: ["observations-20261009.jsonl"] })
			await writeFile(join(dir, "discoveries.json"), "{not json")
			const tailCentres = centres(first.store).slice(covered)
			expect(tailCentres).toEqual(
				[10, 11, 12, 13].map(slot => 446_000_000 + slot * 25_000),
			)

			const second = await open(dir, clock)
			expect(second.loaded.lastSeq).toBe(0)
			expect(second.loaded.entries.map(e => e.seq)).toEqual(
				expect.arrayContaining(tail),
			)
			expect(second.loaded.entries.at(-1)?.seq).toBe(top)
			expect(second.loaded.recoveryHealth).toBe("degraded")
			const firstTail = second.loaded.entries[0]?.seq ?? 0
			expect(second.loaded.journalGap).toEqual({
				firstMissing: 1,
				missing: firstTail - 1,
			})
			expect(centres(second.store)).toEqual(tailCentres)
			// Appends are not refused, and the snapshot of the salvaged store covers the tail.
			ingest(second.store, clock, 20)
			expect(await Promise.all(second.writes.splice(0))).toEqual([top + 1])
			await second.p.writeSnapshot(second.store.snapshot())
			expect(
				await second.p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 }),
			).toEqual({ deleted: ["observations-20261010.jsonl"] })

			const third = await open(dir, clock)
			expect(third.loaded.lastSeq).toBe(top + 1)
			expect(third.loaded.entries).toEqual([])
			expect(third.loaded.journalGap).toBeUndefined()
			expect(centres(third.store)).toEqual(centres(second.store))
			expect(centres(third.store)).toEqual(expect.arrayContaining(tailCentres))
		})
	})

	it("a corrupt middle line withholds only itself: the lines after it replay and a later snapshot keeps them", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const first = await open(dir, clock)
			for (let slot = 0; slot < 6; slot++) {
				ingest(first.store, clock, slot)
				await Promise.all(first.writes.splice(0))
			}
			const [file] = await journalFiles(dir)
			const path = join(dir, "journal", file ?? "")
			const lines = (await readFile(path, "utf8")).split("\n")
			const victim = lines.findIndex(l => l.startsWith('{"seq":3,'))
			expect(victim).toBeGreaterThan(0)
			lines[victim] = '{"seq":3,"at":"corrupt'
			await writeFile(path, lines.join("\n"))
			const top = await maxSeqOf(path)

			const second = await open(dir, clock)
			const seqs = second.loaded.entries.map(e => e.seq)
			expect(seqs).not.toContain(3)
			expect(seqs).toEqual(
				Array.from({ length: top }, (_, i) => i + 1).filter(n => n !== 3),
			)
			expect(second.loaded.journalGap).toEqual({ firstMissing: 3, missing: 1 })
			expect(second.loaded.droppedLines).toBe(1)
			expect(second.loaded.recoveryHealth).toBe("degraded")
			const salvaged = centres(second.store)
			// Seq 3 created slot 2's emitter: only it is lost.
			expect(salvaged).toEqual(
				[0, 1, 3, 4, 5].map(slot => 446_000_000 + slot * 25_000),
			)
			// Every emitter journaled after the corrupt line is back.
			expect(salvaged).toEqual(
				expect.arrayContaining(
					centres(first.store).filter(hz => hz >= 446_000_000 + 3 * 25_000),
				),
			)
			await second.p.writeSnapshot(second.store.snapshot())
			expect(
				await second.p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 }),
			).toEqual({ deleted: [file] })

			const third = await open(dir, clock)
			expect(third.loaded.lastSeq).toBe(top)
			expect(third.loaded.entries).toEqual([])
			expect(centres(third.store)).toEqual(salvaged)
		})
	})
})
