import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	link,
	mkdir,
	mkdtemp,
	open,
	rmdir,
	lstat,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
	utimes,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WavFileWriter } from "../../../../src/core/scanner/channel/wav-writer.js"
import {
	AnalogReceiptSchema,
	AnalogOperations,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const dirs: string[] = []
const logger = createLogger({ level: "fatal" })
const NOW = 1_700_000_000_000
const caps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 1,
	maxAgeDays: 30,
	minFreeDiskMb: 1,
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})
async function harness(
	opts: {
		root?: string
		store?: DiscoveryStore
		io?: AnalogOperationIo
		freeBytes?: () => Promise<{ freeBytes: number }>
		maxRecordingsMb?: number
	} = {},
) {
	const root =
		opts.root ??
		(await realpath(await mkdtemp(join(tmpdir(), "wavekit-analog-op-"))))
	if (!opts.root) dirs.push(root)
	const store =
		opts.store ??
		new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => NOW,
			newId: counterIds(),
		})
	const ingested = opts.store
		? { discoveryId: store.list({}).items[0]?.id ?? null }
		: store.ingest(makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }))
	if (!ingested.discoveryId) throw new Error("Missing test discovery")
	const discoveryId = ingested.discoveryId
	const binding: RecordingBinding = {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque-native-grant",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz: 446_000_000,
		captureCentreHz: null,
		tuningTrust: "unverified",
	}
	const state = { healthy: true, live: true }
	const adapter: AnalogMetadataAdapter = {
		authorityHealthy: () => state.healthy,
		bindingLive: () => state.live,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
	const evidence = new EvidenceStore({
		dir: root,
		caps: {
			...caps,
			maxRecordingsMb: opts.maxRecordingsMb ?? caps.maxRecordingsMb,
		},
		logger,
		now: () => NOW,
		statfs: opts.freeBytes ?? (async () => ({ freeBytes: 1e9 })),
		isDiscoveryLive: id => !!store.get(id),
		...(opts.io ? { analogIo: opts.io } : {}),
	})
	evidence.configureAnalog(adapter)
	await evidence.recoverAnalog()
	return {
		root,
		store,
		discoveryId,
		binding,
		state,
		adapter,
		evidence,
		begin: () =>
			evidence.beginAnalog({ discoveryId, observationId: "o1", binding }),
	}
}
async function record(
	h: Awaited<ReturnType<typeof harness>>,
): Promise<AnalogReceipt> {
	const op = h.begin()
	await op.ready
	await op.push(new Int16Array([1, -2, 3]))
	return op.finish()
}
function privateDir(root: string, operationId: string): string {
	return join(root, ".analog-operations", operationId)
}

async function assertSameOwnerUncertainty(
	h: Awaited<ReturnType<typeof harness>>,
	operationId: string,
	paths: readonly string[],
): Promise<void> {
	const before = await Promise.all(paths.map(path => readFile(path)))
	const prepared = h.store.preparedRecordingOperations()
	const inverse = vi.spyOn(h.adapter, "inverse")
	await h.evidence.stopAnalog()
	const reconciliation = await h.evidence.recoverAnalog()
	expect(reconciliation).toContainEqual({
		operationId,
		discoveryId: h.discoveryId,
		status: "quarantined",
		errorCode: "cleanup-failed",
		residueBytes: null,
	})
	expect(h.store.preparedRecordingOperations()).toEqual(prepared)
	expect(inverse).not.toHaveBeenCalled()
	h.evidence.setCaps({ ...caps, maxRecordingsMb: 0, maxAgeDays: 1 })
	expect(await h.evidence.retention(new Set())).toEqual({ deleted: [] })
	expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
	expect(inverse).not.toHaveBeenCalled()
	expect(
		h.evidence.recordingPath(`${h.discoveryId}~analog-${operationId}.wav`),
	).toBeNull()
	await expect(h.evidence.removeDiscovery(h.discoveryId)).rejects.toMatchObject(
		{ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" },
	)
	const denied = h.begin()
	await expect(denied.ready).rejects.toThrow()
	await denied.settled
	expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
	expect(inverse).not.toHaveBeenCalled()
	inverse.mockRestore()
}

describe("Task42 owned prepared-link operations", () => {
	it("failed recovery read close stays unknown through later inventory refresh and DELETE", async () => {
		const h = await harness(),
			receipt = await record(h)
		const handles: Awaited<ReturnType<typeof open>>[] = []
		let fail = true
		let readOpens = 0
		const evidence = new EvidenceStore({
			dir: h.root,
			caps,
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			analogIo: {
				unlink,
				checkpoint: async () => undefined,
				readOpen: async (path, flags) => {
					readOpens++
					const handle = await open(path, flags)
					if (fail) {
						fail = false
						handles.push(handle)
						vi.spyOn(handle, "close").mockRejectedValueOnce(
							new Error("read close failed"),
						)
					}
					return handle
				},
			},
		})
		try {
			evidence.configureAnalog(h.adapter)
			await evidence.recoverAnalog()
			expect(evidence.analogAuthorityReady).toBe(false)
			await expect(
				evidence.removeDiscovery(h.discoveryId),
			).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
			await expect(
				evidence.removeDiscovery(h.discoveryId),
			).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
			await evidence.stopAnalog()
			await evidence.recoverAnalog()
			evidence.setCaps({ ...caps, maxRecordingsMb: 0 })
			expect(await evidence.retention(new Set())).toEqual({ deleted: [] })
			expect(readOpens).toBe(1)
			expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		} finally {
			await Promise.all(handles.map(handle => handle.close()))
		}
	})

	it("exact inventory charges one inode across both media links and credits only its final unlink", async () => {
		const h = await harness()
		const operations = new AnalogOperations({
			root: h.root,
			adapter: h.adapter,
			admits: () => true,
			serialise: async (_id, job) => job(),
			legacyBytes: async () => 0,
			limits: () => ({ maxBytes: 20 * 1024 * 1024, minFreeBytes: 0 }),
			freeBytes: async () => 1e9,
		})
		try {
			await operations.recover()
			const op = operations.begin({
				discoveryId: h.discoveryId,
				observationId: "o1",
				binding: h.binding,
			})
			await op.ready
			await op.push(new Int16Array(24000))
			const stage = join(privateDir(h.root, op.operationId), "payload.wav.part")
			const final = join(
				h.root,
				"recordings",
				"analog",
				h.discoveryId,
				`analog-${op.operationId}.wav`,
			)
			await link(stage, final)
			const second = operations.begin({
				discoveryId: h.discoveryId,
				observationId: "o1",
				binding: h.binding,
			})
			await second.ready
			await operations.hasCleanup(h.discoveryId)
			const intentBytes = (
				await lstat(join(privateDir(h.root, op.operationId), "intent.json"))
			).size
			const secondIntentBytes = (
				await lstat(join(privateDir(h.root, second.operationId), "intent.json"))
			).size
			const exact = 48044 + 44 + intentBytes + secondIntentBytes
			expect(operations.managedBytes).toBe(exact)
			await unlink(final)
			second.cancel()
			await second.settled
			expect(operations.managedBytes).toBe(48044 + intentBytes)
			op.cancel()
			await op.settled
			expect(operations.managedBytes).toBe(0)
		} finally {
			await operations.stop()
		}
	})
	it("own-link assignment failure retains finalized decision and never invokes compensation", async () => {
		const h = await harness(),
			original = h.adapter.buildCommitPlan
		const inverse = vi.spyOn(h.adapter, "inverse")
		h.adapter.buildCommitPlan = id => {
			const plan = original(id)
			if (plan)
				Object.defineProperty(plan.observation, "recordingIds", {
					configurable: true,
					get: () => plan.priorIds,
					set: () => {
						throw new Error("post-link assignment fault")
					},
				})
			return plan
		}
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		expect(inverse).not.toHaveBeenCalled()
		expect(
			existsSync(join(privateDir(h.root, receipt.operationId), "receipt.json")),
		).toBe(true)
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
	})
	it("actual silent commit snapshot reload preserves later state/count before optional projection append", async () => {
		const h = await harness()
		const stateDir = join(h.root, "state")
		const persistence = new ScannerPersistence({
			dir: stateDir,
			logger,
			now: () => NOW,
		})
		await persistence.load()
		let snapshot = h.store.snapshot()
		const publish = h.adapter.publishCommit
		h.adapter.publishCommit = plan => {
			// This callback is first reached after own marker link and all silent plain assignments.
			expect(
				existsSync(
					join(privateDir(h.root, plan.metadata.operationId), "receipt.json"),
				),
			).toBe(true)
			h.store.attachRecordings("o1", ["later-unrelated"], "cut")
			snapshot = h.store.snapshot()
			throw new Error("optional projection never appended")
		}
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		const restored = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => NOW,
			newId: counterIds(),
		})
		await persistence.writeSnapshot(snapshot)
		const loaded = await new ScannerPersistence({
			dir: stateDir,
			logger,
			now: () => NOW,
		}).load()
		expect(loaded.recoveryHealth).toBe("healthy")
		expect(loaded.recordingOperations).toHaveLength(1)
		restored.restore(loaded)
		for (const entry of loaded.entries) restored.replay(entry)
		const before = restored.snapshot()
		const restarted = await harness({ root: h.root, store: restored })
		expect(restored.snapshot()).toEqual(before)
		expect(
			restored.observations(h.discoveryId, null, 100).items[0],
		).toMatchObject({
			recording: "cut",
			recordingIds: [receipt.alias, "later-unrelated"],
		})
		expect(restored.get(h.discoveryId)?.evidence.recordings).toBe(2)
		expect(restarted.evidence.recordingPath(receipt.alias!)).not.toBeNull()
		h.adapter.publishCommit = publish
	})
	it("cleanup sibling unlink failure retries after restart even if a stale alias remains", async () => {
		let fail = true
		const h = await harness({
			io: {
				checkpoint: async () => undefined,
				unlink: async path => {
					if (path.endsWith(".cleanup") && fail) {
						fail = false
						throw new Error("transient sibling unlink")
					}
					await unlink(path)
				},
			},
		})
		const receipt = await record(h)
		await expect(
			h.evidence.removeDiscovery(h.discoveryId),
		).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
		expect(existsSync(privateDir(h.root, receipt.operationId))).toBe(false)
		expect(
			existsSync(
				join(h.root, ".analog-operations", `${receipt.operationId}.cleanup`),
			),
		).toBe(true)
		const restarted = await harness({ root: h.root, store: h.store })
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
		expect(
			existsSync(
				join(h.root, ".analog-operations", `${receipt.operationId}.cleanup`),
			),
		).toBe(false)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recordingIds,
		).toContain(receipt.alias)
	})

	it.each([false, true])(
		"real writer initialization retains failed-close ownership (cancel=%s)",
		async cancelled => {
			const handles: Awaited<ReturnType<typeof open>>[] = []
			let operation:
				| ReturnType<Awaited<ReturnType<typeof harness>>["begin"]>
				| undefined
			const h = await harness({
				io: {
					unlink,
					checkpoint: async () => undefined,
					wavIo: {
						open: async (path, flags) => {
							const handle = await open(path, flags)
							handles.push(handle)
							let wrote = false
							return {
								sync: () => handle.sync(),
								close: async () => {
									throw new Error("failed physical close")
								},
								write: async (buffer, offset, length, position) => {
									if (wrote) {
										if (cancelled) operation?.cancel()
										throw new Error("header write failed")
									}
									wrote = true
									return handle.write(
										buffer,
										offset,
										Math.min(2, length),
										position,
									)
								},
							}
						},
						inspect: async () => {
							throw new Error("must not inspect")
						},
						unlink,
					},
				},
			})
			try {
				operation = h.begin()
				await expect(operation.ready).rejects.toThrow()
				const receipt = await operation.settled
				expect(receipt).toMatchObject({
					outcome: "failed",
					cleanup: "pending",
					closure: "unknown",
					residueBytes: null,
				})
				expect(
					existsSync(
						join(privateDir(h.root, operation.operationId), "intent.json"),
					),
				).toBe(true)
				expect(
					existsSync(
						join(privateDir(h.root, operation.operationId), "payload.wav.part"),
					),
				).toBe(true)
				await assertSameOwnerUncertainty(h, operation.operationId, [
					join(privateDir(h.root, operation.operationId), "intent.json"),
					join(privateDir(h.root, operation.operationId), "payload.wav.part"),
				])
				await expect(
					h.evidence.removeDiscovery(h.discoveryId),
				).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
				h.evidence.setCaps({ ...caps, maxRecordingsMb: 1 })
				const next = h.begin()
				await expect(next.ready).rejects.toThrow()
				await next.settled
			} finally {
				await Promise.all(handles.map(handle => handle.close()))
			}
			// A fresh owner after the descriptor lifetime ends may reconcile a genuine crash leftover.
			const fresh = await harness({ root: h.root, store: h.store })
			expect(fresh.evidence.analogAuthorityReady).toBe(true)
			expect(existsSync(privateDir(h.root, operation!.operationId))).toBe(false)
		},
	)
	it.each(["intent.tmp", "receipt.tmp"])(
		"metadata %s failed close retains typed ownership",
		async name => {
			for (const cancelled of [false, true]) {
				const handles: Awaited<ReturnType<typeof open>>[] = []
				let operation:
					| ReturnType<Awaited<ReturnType<typeof harness>>["begin"]>
					| undefined
				const h = await harness({
					io: {
						unlink,
						checkpoint: async () => undefined,
						metadataOpen: async path => {
							const handle = await open(path, "wx")
							if (!path.endsWith(name)) return handle
							handles.push(handle)
							return {
								write: (buffer, offset, length, position) =>
									handle.write(buffer, offset, length, position),
								sync: () => handle.sync(),
								close: async () => {
									if (cancelled) operation?.cancel()
									throw new Error("metadata close failed")
								},
							}
						},
					},
				})
				try {
					operation = h.begin()
					if (name === "intent.tmp")
						await operation.ready.catch(() => undefined)
					else await operation.ready
					const receipt = await operation.finish()
					expect(receipt).toMatchObject({
						outcome: "failed",
						cleanup: "pending",
						closure: "unknown",
						residueBytes: null,
					})
					expect(
						existsSync(join(privateDir(h.root, operation.operationId), name)),
					).toBe(true)
					if (name === "receipt.tmp") {
						const final = join(
							h.root,
							`recordings/analog/${h.discoveryId}/analog-${operation.operationId}.wav`,
						)
						const old = new Date(NOW - 2 * 86400_000)
						await utimes(final, old, old)
						expect(receipt.output).toMatchObject({
							fileBytes: 44,
							outputFrames: 0,
						})
						expect(h.store.preparedRecordingOperations()).toHaveLength(1)
						await assertSameOwnerUncertainty(h, operation.operationId, [
							join(privateDir(h.root, operation.operationId), "intent.json"),
							join(privateDir(h.root, operation.operationId), "receipt.tmp"),
							final,
						])
					}
					await expect(
						h.evidence.removeDiscovery(h.discoveryId),
					).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
				} finally {
					await Promise.all(handles.map(handle => handle.close()))
				}
				if (name === "receipt.tmp") {
					const fresh = await harness({ root: h.root, store: h.store })
					expect(fresh.evidence.analogAuthorityReady).toBe(true)
					expect(h.store.preparedRecordingOperations()).toHaveLength(0)
					expect(existsSync(privateDir(h.root, operation!.operationId))).toBe(
						false,
					)
				}
			}
		},
	)
	it.each([false, true])(
		"persistent cleanup ownership retries failed rmdir (restart=%s)",
		async restart => {
			let fail = true
			const h = await harness({
				io: {
					unlink,
					checkpoint: async () => undefined,
					rmdir: async path => {
						if (fail) {
							fail = false
							throw new Error("transient directory removal")
						}
						await rmdir(path)
					},
				},
			})
			const receipt = await record(h)
			h.store.delete(h.discoveryId)
			await expect(
				h.evidence.removeDiscovery(h.discoveryId),
			).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
			expect(
				existsSync(
					join(h.root, ".analog-operations", `${receipt.operationId}.cleanup`),
				),
			).toBe(true)
			expect(
				existsSync(
					join(privateDir(h.root, receipt.operationId), "intent.json"),
				),
			).toBe(false)
			if (restart) {
				const recovered = new EvidenceStore({
					dir: h.root,
					caps,
					logger,
					now: () => NOW,
					statfs: async () => ({ freeBytes: 1e9 }),
				})
				recovered.configureAnalog(h.adapter)
				expect(await recovered.recoverAnalog()).toContainEqual(
					expect.objectContaining({
						status: "cleaned",
						operationId: receipt.operationId,
					}),
				)
				expect(recovered.analogAuthorityReady).toBe(true)
			} else await h.evidence.removeDiscovery(h.discoveryId)
			expect(existsSync(privateDir(h.root, receipt.operationId))).toBe(false)
			expect(
				existsSync(
					join(h.root, ".analog-operations", `${receipt.operationId}.cleanup`),
				),
			).toBe(false)
		},
	)
	it("DELETE cancels a ready unfinished handle before returning control", async () => {
		const entered = deferred(),
			release = deferred()
		const h = await harness({
			io: {
				unlink,
				checkpoint: async () => undefined,
				wavIo: {
					open: async (path, flags) => {
						const handle = await open(path, flags)
						return {
							sync: () => handle.sync(),
							close: () => handle.close(),
							write: async (buffer, offset, length, position) => {
								if (position >= 44) {
									entered.resolve()
									await release.promise
								}
								return handle.write(buffer, offset, length, position)
							},
						}
					},
					inspect: async () => {
						throw new Error("cancelled writer must not inspect")
					},
					unlink,
				},
			},
		})
		const op = h.begin()
		await op.ready
		const write = op.push(new Int16Array(160)).catch(() => undefined)
		await entered.promise
		const removal = h.evidence.removeDiscovery(h.discoveryId)
		await expect(op.push(new Int16Array(80))).rejects.toThrow()
		release.resolve()
		await write
		await removal
		expect((await op.settled).outcome).toBe("aborted")
	})
	it.each([true, false])(
		"null finalized output facts quarantine with prepared ledger=%s",
		async ledger => {
			const h = await harness()
			const receipt = await record(h)
			if (!ledger) h.store.removePreparedRecording(receipt.operationId)
			const marker = join(
				privateDir(h.root, receipt.operationId),
				"receipt.json",
			)
			await writeFile(
				marker,
				JSON.stringify({
					...receipt,
					output: { ...receipt.output, sampleRateHz: null, channelCount: null },
				}),
			)
			const restarted = await harness({ root: h.root, store: h.store })
			expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
			expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
			expect(
				AnalogReceiptSchema.safeParse({
					...receipt,
					output: { ...receipt.output, sampleRateHz: null },
				}).success,
			).toBe(false)
		},
	)

	it("commits verified media, frozen provenance and input/output units, then preserves its immutable decision", async () => {
		const h = await harness()
		const op = h.begin()
		await op.ready
		for (let i = 0; i < 66; i++)
			op.addGap({
				cause: "input-gap",
				inputSampleIndex: i * 480,
				droppedInputSamples: 10,
				outputFrameIndex: null,
			})
		await op.push(new Int16Array([12, -34]))
		const finish = op.finish()
		expect(op.finish()).toBe(finish)
		const receipt = await finish
		expect(receipt).toMatchObject({
			outcome: "finalized",
			producerRecordingId: op.operationId,
			producerStoreId: null,
			binding: { inputSampleRateHz: 48000 },
			output: { sampleRateHz: 8000, outputFrames: 2, fileBytes: 48 },
			omittedGapCount: 2,
			cleanup: "pending",
			durability: {
				metadataPowerLossDurable: false,
				finalMarkerDirectorySync: "not-attempted",
			},
		})
		expect(receipt.gaps).toHaveLength(64)
		expect(Object.isFrozen(receipt.binding)).toBe(true)
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(1)
		expect(h.evidence.recordingPath(receipt.alias!)).toBe(
			join(h.root, receipt.artifact!),
		)
		op.cancel("discovery-deleted")
		expect(await op.settled).toBe(receipt)
		expect(await op.finish()).toBe(receipt)
		expect(
			existsSync(join(privateDir(h.root, op.operationId), "receipt.tmp")),
		).toBe(false)
	})
	it.each([
		"reserve",
		"intent",
		"stage",
		"closed",
		"media-linked",
		"prepared",
		"marker-ready",
	])(
		"cancels at %s, remains invisible and drains without self-await",
		async phase => {
			const gate = deferred()
			const entered = deferred()
			const io: AnalogOperationIo = {
				unlink,
				checkpoint: async name => {
					if (name === phase) {
						entered.resolve()
						await gate.promise
					}
				},
			}
			const h = await harness({ io })
			const before = {
				d: h.store.get(h.discoveryId),
				o: h.store.observations(h.discoveryId, null, 100),
			}
			const op = h.begin()
			const ready = op.ready.catch(() => undefined)
			const finish = op.finish()
			await entered.promise
			expect({
				d: h.store.get(h.discoveryId),
				o: h.store.observations(h.discoveryId, null, 100),
			}).toEqual(before)
			expect(
				h.evidence.recordingPath(
					`${h.discoveryId}~analog-${op.operationId}.wav`,
				),
			).toBeNull()
			op.cancel("cancelled")
			gate.resolve()
			await ready
			expect(await finish).toMatchObject({
				outcome: "aborted",
				cleanup: "complete",
				cutReason: "cancelled",
			})
			expect(await op.settled).toBe(await finish)
			expect(h.store.preparedRecordingOperations()).toEqual([])
			expect({
				d: h.store.get(h.discoveryId),
				o: h.store.observations(h.discoveryId, null, 100),
			}).toEqual(before)
		},
	)
	it("takes the final plan from current count/state after marker preparation", async () => {
		let mutate: () => void = () => undefined
		const h = await harness({
			io: {
				unlink,
				checkpoint: async name => {
					if (name === "marker-ready") mutate()
				},
			},
		})
		mutate = () => {
			h.store.attachRecordings("o1", ["unrelated"], "encrypted-dropped")
			h.store.setEvidenceFlags(h.discoveryId, { recordings: 9 })
		}
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(10)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recordingIds,
		).toEqual(["unrelated", receipt.alias])
	})
	it("keeps committed outcome after throwing notification and cleanup checkpoint", async () => {
		const h = await harness({
			io: {
				unlink,
				checkpoint: async name => {
					if (name === "decided") throw new Error("postdecision")
				},
			},
		})
		h.store.on("change", () => {
			throw new Error("listener")
		})
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		expect(h.evidence.recordingPath(receipt.alias!)).not.toBeNull()
	})
	it("failed prepare and failed inverse keep strict intent, public ABA unchanged and cleanup pending", async () => {
		const h = await harness()
		let snapshot = h.store.snapshot()
		h.adapter.prepare = async metadata => {
			h.store.prepareRecording(metadata)
			snapshot = h.store.snapshot()
			h.store.attachRecordings("o1", ["unrelated"], "cut")
			h.store.setEvidenceFlags(h.discoveryId, { recordings: 7 })
			throw new Error("exact append")
		}
		h.adapter.inverse = async id => {
			h.store.removePreparedRecording(id)
			throw new Error("inverse")
		}
		const receipt = await record(h)
		expect(receipt).toMatchObject({
			outcome: "failed",
			cleanup: "pending",
			errorCode: "cleanup-failed",
		})
		expect(snapshot.recordingOperations).toHaveLength(1)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recording,
		).toBe("cut")
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(7)
		expect(
			existsSync(join(privateDir(h.root, receipt.operationId), "intent.json")),
		).toBe(true)
		expect(
			h.evidence.recordingPath(
				`${h.discoveryId}~analog-${receipt.operationId}.wav`,
			),
		).toBeNull()
	})
	it("successful compensation after prepare append failure removes only own map and files", async () => {
		const h = await harness()
		h.adapter.prepare = async metadata => {
			h.store.prepareRecording(metadata)
			throw new Error("append")
		}
		const inverse = vi.spyOn(h.adapter, "inverse")
		const receipt = await record(h)
		expect(receipt).toMatchObject({
			outcome: "failed",
			cleanup: "complete",
			errorCode: "metadata-failed",
		})
		expect(inverse).toHaveBeenCalledWith(receipt.operationId)
		expect(existsSync(privateDir(h.root, receipt.operationId))).toBe(false)
	})
	it("DELETE fences immediately and drains pending metadata outside the publication queue", async () => {
		const h = await harness()
		const entered = deferred()
		const gate = deferred()
		h.adapter.prepare = async metadata => {
			h.store.prepareRecording(metadata)
			entered.resolve()
			await gate.promise
		}
		const op = h.begin()
		await op.ready
		await op.push(new Int16Array([1]))
		const finish = op.finish()
		await entered.promise
		h.store.delete(h.discoveryId)
		const removal = h.evidence.removeDiscovery(h.discoveryId)
		await expect(op.push(new Int16Array([2]))).rejects.toThrow()
		gate.resolve()
		await removal
		expect((await finish).outcome).toBe("aborted")
		expect(await h.evidence.hasAnalogCleanup(h.discoveryId)).toBe(false)
	})
	it("failed unlink retains residue and second DELETE retries exact owned intent after metadata absence", async () => {
		let fail = false
		const h = await harness({
			io: {
				unlink: async path => {
					if (fail && path.endsWith(".wav")) throw new Error("unlink")
					await unlink(path)
				},
				checkpoint: async () => undefined,
			},
		})
		const receipt = await record(h)
		h.store.delete(h.discoveryId)
		fail = true
		await expect(
			h.evidence.removeDiscovery(h.discoveryId),
		).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
		expect(await h.evidence.hasAnalogCleanup(h.discoveryId)).toBe(true)
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		fail = false
		await h.evidence.removeDiscovery(h.discoveryId)
		expect(await h.evidence.hasAnalogCleanup(h.discoveryId)).toBe(false)
	})
	it("startup validates present alias without changing later state/count", async () => {
		const h = await harness()
		const receipt = await record(h)
		h.store.attachRecordings("o1", [], "encrypted-dropped")
		h.store.setEvidenceFlags(h.discoveryId, { recordings: 13 })
		const restarted = await harness({ root: h.root, store: h.store })
		restarted.state.live = false
		expect(restarted.evidence.recordingPath(receipt.alias!)).not.toBeNull()
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(13)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recording,
		).toBe("encrypted-dropped")
	})
	it("crash link before projection or deliberate alias removal preserves media and quarantines without resurrection", async () => {
		const h = await harness()
		const receipt = await record(h)
		const snapshot = h.store.snapshot()
		for (const obs of snapshot.observations) obs.recordingIds = []
		for (const d of snapshot.discoveries) d.evidence.recordings = 0
		const restored = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => NOW,
			newId: counterIds(),
		})
		restored.restore(snapshot)
		const restarted = await harness({ root: h.root, store: restored })
		expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
		expect(
			restored.observations(h.discoveryId, null, 100).items[0]?.recordingIds,
		).toEqual([])
		expect(restored.get(h.discoveryId)?.evidence.recordings).toBe(0)
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		expect(await restarted.evidence.recoverAnalog()).toEqual([
			expect.objectContaining({
				status: "quarantined",
				errorCode: "recovery-ambiguous",
			}),
		])
	})
	it.each(["bad-header", "missing", "foreign-marker"])(
		"quarantines %s while retaining cleanup ownership",
		async kind => {
			const h = await harness()
			const receipt = await record(h)
			if (kind === "missing") await unlink(join(h.root, receipt.artifact!))
			if (kind === "bad-header")
				await writeFile(
					join(h.root, receipt.artifact!),
					Buffer.alloc(receipt.output.fileBytes!),
				)
			if (kind === "foreign-marker") {
				const marker = { ...receipt, producerRunId: randomUUID() }
				await writeFile(
					join(privateDir(h.root, receipt.operationId), "receipt.json"),
					JSON.stringify(marker),
				)
			}
			const restarted = await harness({ root: h.root, store: h.store })
			expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
			expect(
				existsSync(
					join(privateDir(h.root, receipt.operationId), "intent.json"),
				),
			).toBe(true)
		},
	)
	it("retention protects accepted closing operations and reclaims completed metadata together", async () => {
		const gate = deferred()
		const entered = deferred()
		const h = await harness({
			io: {
				unlink,
				checkpoint: async name => {
					if (name === "closed") {
						entered.resolve()
						await gate.promise
					}
				},
			},
		})
		const op = h.begin()
		await op.ready
		const finish = op.finish()
		await entered.promise
		h.evidence.setCaps({ ...caps, maxRecordingsMb: 0 })
		expect((await h.evidence.retention(new Set())).deleted).toEqual([])
		gate.resolve()
		const receipt = await finish
		expect(receipt.outcome).toBe("finalized")
		expect((await h.evidence.retention(new Set())).deleted).toContain(
			receipt.artifact,
		)
		expect(await h.evidence.hasAnalogCleanup(h.discoveryId)).toBe(false)
	})
	it("bounds concurrent reservations atomically and fails closed on unknown disk or live binding", async () => {
		const h = await harness({ maxRecordingsMb: 3 })
		const first = h.begin()
		await first.ready
		const second = h.begin()
		await expect(second.ready).rejects.toThrow("storage cap")
		expect((await second.settled).outcome).toBe("failed")
		first.cancel()
		await first.settled
		const unknown = await harness({
			freeBytes: async () => {
				throw new Error("statfs")
			},
		})
		const denied = unknown.begin()
		await expect(denied.ready).rejects.toThrow("Free disk unavailable")
		await denied.settled
		const stale = await harness()
		stale.state.live = false
		const invalid = stale.begin()
		await expect(invalid.ready).rejects.toThrow("binding")
		await invalid.settled
	})
	it("degraded authority and malformed/symlink inventory never count as authoritative absence", async () => {
		const h = await harness()
		h.state.healthy = false
		const op = h.begin()
		await expect(op.ready).rejects.toThrow()
		await op.settled
		await expect(h.evidence.hasAnalogCleanup(h.discoveryId)).rejects.toThrow(
			"authority",
		)
		const orphan = randomUUID()
		await mkdir(privateDir(h.root, orphan), { recursive: true })
		await writeFile(join(privateDir(h.root, orphan), "intent.tmp"), "partial")
		const restarted = await harness({ root: h.root, store: h.store })
		expect(restarted.evidence.analogAuthorityReady).toBe(false)
		await expect(
			restarted.evidence.hasAnalogCleanup(h.discoveryId),
		).rejects.toThrow("inventory")
		const other = await harness()
		await symlink(other.root, join(h.root, "recordings"))
		expect(existsSync(join(other.root, "intent.tmp"))).toBe(false)
	})
	it("counts a media inode once through the stage/final hardlink phase", async () => {
		const h = await harness({ maxRecordingsMb: 3.7 })
		const op = h.begin()
		await op.ready
		await op.push(new Int16Array(80))
		// Closing the writer first creates a valid fixture for a paused crash inventory.
		const stage = join(privateDir(h.root, op.operationId), "payload.wav.part")
		const final = join(
			h.root,
			"recordings",
			"analog",
			h.discoveryId,
			`analog-${op.operationId}.wav`,
		)
		await mkdir(join(h.root, "recordings", "analog", h.discoveryId), {
			recursive: true,
		})
		await link(stage, final)
		const second = h.begin()
		await second.ready
		second.cancel()
		await second.settled
		op.cancel()
		await op.settled
	})
	it.each(["intent", "stage", "media-linked", "prepared", "marker-ready"])(
		"recovers an interrupted %s operation with exact inverse before cleanup",
		async phase => {
			let failCleanup = false
			const h = await harness({
				io: {
					unlink: async path => {
						if (failCleanup) throw new Error("interrupted cleanup")
						await unlink(path)
					},
					checkpoint: async name => {
						if (name === phase) {
							failCleanup = true
							throw new Error("crash cut")
						}
					},
				},
			})
			const op = h.begin()
			await op.ready.catch(() => undefined)
			const failed = await op.finish()
			expect(failed.cleanup).toBe("pending")
			const restarted = await harness({ root: h.root, store: h.store })
			expect(await restarted.evidence.recoverAnalog()).toEqual([
				expect.objectContaining({
					operationId: op.operationId,
					status: "cleaned",
				}),
			])
			expect(h.store.preparedRecordingOperations()).toEqual([])
			expect(await restarted.evidence.hasAnalogCleanup(h.discoveryId)).toBe(
				false,
			)
		},
	)
	it("foreign EEXIST marker is preserved and never compensated or unlinked", async () => {
		let root = ""
		const h = await harness({
			io: {
				unlink,
				checkpoint: async (name, id) => {
					if (name === "marker-ready") {
						const path = privateDir(root, id)
						const marker = JSON.parse(
							await readFile(join(path, "receipt.tmp"), "utf8"),
						) as AnalogReceipt
						await writeFile(
							join(path, "receipt.json"),
							JSON.stringify({ ...marker, producerRunId: randomUUID() }),
						)
					}
				},
			},
		})
		root = h.root
		const inverse = vi.spyOn(h.adapter, "inverse")
		const failed = await record(h)
		expect(failed).toMatchObject({
			outcome: "failed",
			cleanup: "pending",
			errorCode: "recovery-ambiguous",
		})
		expect(inverse).not.toHaveBeenCalled()
		h.store.delete(h.discoveryId)
		await expect(
			h.evidence.removeDiscovery(h.discoveryId),
		).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
		expect(inverse).not.toHaveBeenCalled()
		expect(
			existsSync(join(privateDir(root, failed.operationId), "receipt.json")),
		).toBe(true)
		expect(
			h.evidence.recordingPath(
				`${h.discoveryId}~analog-${failed.operationId}.wav`,
			),
		).toBeNull()
	})
	it("matching own EEXIST follows alias-presence reconciliation without applying desired state", async () => {
		let root = ""
		let store: DiscoveryStore | null = null
		let discoveryId = ""
		const h = await harness({
			io: {
				unlink,
				checkpoint: async (name, id) => {
					if (name === "marker-ready") {
						const path = privateDir(root, id)
						await link(join(path, "receipt.tmp"), join(path, "receipt.json"))
						store!.attachRecordings(
							"o1",
							[`${discoveryId}~analog-${id}.wav`],
							"cut",
						)
						store!.setEvidenceFlags(discoveryId, { recordings: 17 })
					}
				},
			},
		})
		root = h.root
		store = h.store
		discoveryId = h.discoveryId
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(17)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recording,
		).toBe("cut")
	})
	it("matching own EEXIST with absent alias preserves media and never adds its association", async () => {
		let root = ""
		const h = await harness({
			io: {
				unlink,
				checkpoint: async (name, id) => {
					if (name === "marker-ready") {
						const path = privateDir(root, id)
						await link(join(path, "receipt.tmp"), join(path, "receipt.json"))
					}
				},
			},
		})
		root = h.root
		const receipt = await record(h)
		expect(receipt).toMatchObject({
			outcome: "failed",
			cleanup: "pending",
			errorCode: "recovery-ambiguous",
		})
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(0)
		expect(
			h.store.observations(h.discoveryId, null, 100).items[0]?.recordingIds,
		).toEqual([])
		expect(
			existsSync(
				join(
					root,
					"recordings",
					"analog",
					h.discoveryId,
					`analog-${receipt.operationId}.wav`,
				),
			),
		).toBe(true)
		const restarted = await harness({ root: h.root, store: h.store })
		expect(
			restarted.evidence.recordingPath(
				`${h.discoveryId}~analog-${receipt.operationId}.wav`,
			),
		).toBeNull()
	})
	it("historical source/stream/epoch mismatch quarantines reused observation IDs without live-capability checks", async () => {
		const h = await harness()
		const receipt = await record(h)
		const snapshot = h.store.snapshot()
		for (const observation of snapshot.observations)
			observation.sampleRange.epoch++
		const restored = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => NOW,
			newId: counterIds(),
		})
		restored.restore(snapshot)
		const restarted = await harness({ root: h.root, store: restored })
		expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
		expect(
			restored.observations(h.discoveryId, null, 100).items[0]?.recordingIds,
		).toEqual([receipt.alias])
		expect(restored.get(h.discoveryId)?.evidence.recordings).toBe(1)
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
	})
	it("rechecks cancellation around the known plain commit checker", async () => {
		const h = await harness()
		const op = h.begin()
		await op.ready
		h.adapter.commitPlanCurrent = plan => {
			op.cancel()
			return h.store.recordingCommitPlanCurrent(plan)
		}
		expect(await op.finish()).toMatchObject({
			outcome: "aborted",
			cleanup: "complete",
		})
		expect(h.store.get(h.discoveryId)?.evidence.recordings).toBe(0)
	})
	it("rejects complete-pair IQ errors and uses the realized rate for a one-second cap", async () => {
		const h = await harness()
		const name = await h.evidence.writeIq(h.discoveryId, new Uint8Array(11), {
			sampleRateHz: 3,
			centreHz: 446e6,
		})
		expect(
			(await readFile(join(h.root, "evidence", h.discoveryId, name!))).length,
		).toBe(6)
		const next = await h.evidence.writeIq(h.discoveryId, new Uint8Array(5), {
			sampleRateHz: 48000,
			centreHz: 446e6,
		})
		expect(
			(await readFile(join(h.root, "evidence", h.discoveryId, next!))).length,
		).toBe(4)
		expect(
			await h.evidence.writeIq(h.discoveryId, new Uint8Array(1), {
				sampleRateHz: 48000,
				centreHz: 446e6,
			}),
		).toBeNull()
		await expect(
			h.evidence.writeIq(h.discoveryId, new Uint8Array(10), {
				sampleRateHz: NaN,
				centreHz: 446e6,
			}),
		).rejects.toThrow("metadata")
	})
	it("writer close failure retains conservative residue and refuses deletion acknowledgement", async () => {
		const h = await harness()
		const op = h.begin()
		await op.ready
		const originalFinish = WavFileWriter.prototype.finish
		vi.spyOn(WavFileWriter.prototype, "finish").mockImplementation(
			async function (this: WavFileWriter) {
				await originalFinish.call(this)
				throw new Error("close failure")
			},
		)
		vi.spyOn(WavFileWriter.prototype, "abort").mockRejectedValue(
			new Error("close failure"),
		)
		expect(await op.finish()).toMatchObject({
			outcome: "failed",
			cleanup: "pending",
			errorCode: "cleanup-failed",
		})
		expect(await h.evidence.hasAnalogCleanup(h.discoveryId)).toBe(true)
		h.store.delete(h.discoveryId)
		await expect(
			h.evidence.removeDiscovery(h.discoveryId),
		).rejects.toMatchObject({ code: "SCANNER_EVIDENCE_CLEANUP_PENDING" })
	})
	it("enforces two accepted operations per source without opening a denied payload", async () => {
		const h = await harness()
		const first = h.begin()
		const second = h.begin()
		await Promise.all([first.ready, second.ready])
		const third = h.begin()
		await expect(third.ready).rejects.toThrow("Active analog operation limit")
		expect((await third.settled).outcome).toBe("failed")
		expect(existsSync(privateDir(h.root, third.operationId))).toBe(false)
		first.cancel()
		second.cancel()
		await Promise.all([first.settled, second.settled])
	})
	it("metadata aggregate overflow and bounded directory enumeration fail closed without cleanup", async () => {
		const h = await harness()
		const receipt = await record(h)
		await writeFile(
			join(privateDir(h.root, receipt.operationId), "receipt.tmp"),
			Buffer.alloc(16_384),
		)
		const restarted = await harness({ root: h.root, store: h.store })
		expect(restarted.evidence.analogAuthorityReady).toBe(false)
		expect(restarted.evidence.recordingPath(receipt.alias!)).toBeNull()
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		const second = await harness()
		const id = randomUUID()
		const dir = privateDir(second.root, id)
		await mkdir(dir, { recursive: true })
		for (let i = 0; i < 9; i++) await writeFile(join(dir, `foreign-${i}`), "x")
		const overflow = await harness({ root: second.root, store: second.store })
		expect(overflow.evidence.analogAuthorityReady).toBe(false)
		expect(existsSync(join(dir, "foreign-8"))).toBe(true)
	})
	it("anchors a trusted configured root beneath an ancestor alias", async () => {
		const owner = await harness()
		const aliases = await realpath(
			await mkdtemp(join(tmpdir(), "wavekit-root-alias-")),
		)
		dirs.push(aliases)
		await symlink(owner.root, join(aliases, "ancestor"))
		const configured = join(aliases, "ancestor", "storage")
		await mkdir(configured)
		const h = await harness({ root: configured })
		expect(h.evidence.analogAuthorityReady).toBe(true)
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		expect(existsSync(join(owner.root, "storage", receipt.artifact!))).toBe(
			true,
		)
	})
	it("follows a symlink at the configured storage root itself once (WG9 R2: operator config is trusted)", async () => {
		const owner = await harness()
		const aliases = await realpath(
			await mkdtemp(join(tmpdir(), "wavekit-root-link-")),
		)
		dirs.push(aliases)
		const configured = join(aliases, "storage")
		await symlink(owner.root, configured)
		const h = await harness({ root: configured })
		expect(h.evidence.analogAuthorityReady).toBe(true)
		const receipt = await record(h)
		expect(receipt.outcome).toBe("finalized")
		// Written under the real directory the link named at construction.
		expect(existsSync(join(owner.root, receipt.artifact!))).toBe(true)
	})
	it("refuses a symlink final ancestor and leaves foreign storage untouched", async () => {
		const h = await harness()
		const outside = await harness()
		await symlink(outside.root, join(h.root, "recordings"))
		const op = h.begin()
		await op.ready.catch(() => undefined)
		const failed = await op.finish()
		expect(failed.outcome).toBe("failed")
		expect(existsSync(join(outside.root, "analog", h.discoveryId))).toBe(false)
	})
	it("missing current association never revives a committed alias", async () => {
		const h = await harness()
		const receipt = await record(h)
		h.store.delete(h.discoveryId)
		// Construct with the same store directly: the association intentionally no longer exists.
		const evidence = new EvidenceStore({
			dir: h.root,
			caps,
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			isDiscoveryLive: id => !!h.store.get(id),
		})
		evidence.configureAnalog(h.adapter)
		expect(await evidence.recoverAnalog()).toEqual([
			expect.objectContaining({
				status: "quarantined",
				errorCode: "recovery-ambiguous",
			}),
		])
		expect(evidence.recordingPath(receipt.alias!)).toBeNull()
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
	})
	it("validates receipt bounds and stops all accepted operations synchronously", async () => {
		const h = await harness()
		const op = h.begin()
		await op.ready
		const stop = h.evidence.stopAnalog()
		await expect(op.push(new Int16Array([1]))).rejects.toThrow()
		await stop
		expect(await op.settled).toMatchObject({
			outcome: "aborted",
			cutReason: "shutdown",
		})
		expect(AnalogReceiptSchema.safeParse({}).success).toBe(false)
	})
})
