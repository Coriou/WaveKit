import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { arch, cpus, platform, release, tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { snapshotToken } from "../../../src/operator-data/domain.js"
import {
	encodeSnapshot,
	OPERATOR_DATA_LIMITS,
	validateSnapshot,
} from "../../../src/operator-data/schema.js"
import type { OperatorDataSnapshot } from "../../../src/operator-data/schema.js"
import { OperatorDataService } from "../../../src/operator-data/service.js"
import type { OperatorDataServiceOptions } from "../../../src/operator-data/service.js"
import type { StorageStage } from "../../../src/operator-data/storage.js"

const roots: string[] = []
const services: OperatorDataService[] = []
afterEach(async () => {
	await Promise.all(
		services.splice(0).map(service => service.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(path => rm(path, { recursive: true, force: true })),
	)
})
async function root() {
	const path = await mkdtemp(join(tmpdir(), "wavekit-operator-service-"))
	roots.push(path)
	return path
}
async function open(
	stateDir: string,
	options: Omit<OperatorDataServiceOptions, "stateDir"> = {},
) {
	const service = await OperatorDataService.open({ stateDir, ...options })
	services.push(service)
	return service
}
const file = (path: string) => join(path, "operator-data", "state.json")
const unavailable = { code: "OPERATOR_DATA_UNAVAILABLE" }
const conflict = { code: "OPERATOR_DATA_CONFLICT" }
const busy = { code: "OPERATOR_DATA_BUSY" }
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}
function patch(
	snapshot: OperatorDataSnapshot,
	revision = snapshot.revision,
	units = "metric",
) {
	return {
		type: "patch-preferences",
		expected: { ...snapshotToken(snapshot), revision },
		set: { units },
	}
}
function blockedStage() {
	const entered = gate()
	const blocked = gate()
	let armed = false
	const stage = async (stage: StorageStage, phase: string) => {
		if (armed && stage === "directory-sync" && phase === "before") {
			armed = false
			entered.release()
			await blocked.promise
		}
	}
	return {
		entered,
		blocked,
		stage,
		arm: () => {
			armed = true
		},
	}
}

describe("bounded durable operator-data service", () => {
	it("allows exactly one winner for competing same-token writes and never persists stale/current noops", async () => {
		const stages: string[] = []
		const sink = vi.fn(() => undefined)
		const service = await open(await root(), {
			onCommit: sink,
			storageStage: (stage, phase) => {
				stages.push(`${stage}:${phase}`)
			},
		})
		const initial = service.snapshot()
		stages.length = 0
		const results = await Promise.allSettled([
			service.mutate(patch(initial)),
			service.mutate(patch(initial, 0, "imperial")),
		])
		expect(results[0]?.status).toBe("fulfilled")
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: { ...conflict, current: snapshotToken(service.snapshot()) },
		})
		expect(service.snapshot().revision).toBe(1)
		expect(sink).toHaveBeenCalledTimes(1)
		expect(stages.filter(stage => stage === "temp-open:before")).toHaveLength(1)
		stages.length = 0
		await expect(service.mutate(patch(initial))).rejects.toMatchObject(conflict)
		await expect(
			service.mutate(patch(service.snapshot())),
		).resolves.toMatchObject({
			changed: false,
			delivery: "not-needed",
			snapshot: { revision: 1 },
		})
		expect(stages).toEqual([])
		expect(sink).toHaveBeenCalledTimes(1)
	})

	it("holds the prior snapshot through directory sync and publishes synchronously before resolution and later work", async () => {
		const path = await root()
		const block = blockedStage()
		const order: string[] = []
		let service!: OperatorDataService
		service = await open(path, {
			storageStage: (stage, phase) => {
				if (stage === "directory-sync" && phase === "after")
					order.push("synced")
				return block.stage(stage, phase)
			},
			onCommit: snapshot => {
				expect(service.snapshot()).toEqual(snapshot)
				order.push(`sink:${snapshot.revision}`)
				return undefined
			},
		})
		order.length = 0
		const prior = service.snapshot()
		block.arm()
		let resolved = false
		const first = service.mutate(patch(prior)).then(result => {
			resolved = true
			order.push("response:1")
			return result
		})
		const second = service.mutate(patch(prior, 1, "imperial"))
		await block.entered.promise
		expect(service.snapshot()).toEqual(prior)
		expect(resolved).toBe(false)
		expect(order).toEqual([])
		expect(JSON.parse(await readFile(file(path), "utf8"))).toMatchObject({
			revision: 1,
		})
		// Existing transport registers, captures and enqueues synchronously here.
		const subscription = [service.snapshot().revision]
		block.blocked.release()
		await first
		await second
		expect(order).toEqual([
			"synced",
			"sink:1",
			"response:1",
			"synced",
			"sink:2",
		])
		expect(subscription).toEqual([0])
	})

	it("supports synchronous subscription capture inside the sink before later queued publication", async () => {
		let service!: OperatorDataService
		const revisions: number[] = []
		let enqueue: ((revision: number) => void) | undefined
		service = await open(await root(), {
			onCommit: snapshot => {
				if (!enqueue) {
					enqueue = revision => {
						revisions.push(revision)
					}
					enqueue(service.snapshot().revision)
				} else enqueue(snapshot.revision)
				return undefined
			},
		})
		const prior = service.snapshot()
		await Promise.all([
			service.mutate(patch(prior)),
			service.mutate(patch(prior, 1, "imperial")),
		])
		expect(revisions).toEqual([1, 2])
	})

	it("captures detached request, snapshot, sink and response objects with deterministic context", async () => {
		const id = "ea9f7e26-8b4d-44b6-90d5-92c7048b0173"
		const service = await open(await root(), {
			context: { now: () => "2026-10-10T00:00:00.000Z", uuid: () => id },
			onCommit: snapshot => {
				snapshot.savedFrequencies[0]!.name = "sink edit"
				return undefined
			},
		})
		const request = {
			type: "create-saved-frequency",
			expected: snapshotToken(service.snapshot()),
			frequency: {
				name: "original",
				frequencyHz: 100000000,
				mode: "nfm",
				bandwidthHz: 12500,
				tone: { kind: "none" },
			},
		}
		const mutation = service.mutate(request)
		request.frequency.name = "caller edit"
		request.frequency.tone.kind = "invalid"
		const result = await mutation
		expect(result).toMatchObject({ savedFrequencyId: id, delivery: "sent" })
		expect(result.snapshot.savedFrequencies[0]).toMatchObject({
			name: "original",
			createdAt: "2026-10-10T00:00:00.000Z",
		})
		result.snapshot.savedFrequencies[0]!.name = "response edit"
		const snapshot = service.snapshot()
		snapshot.savedFrequencies.length = 0
		expect(service.snapshot().savedFrequencies[0]?.name).toBe("original")
	})

	it.each(["stationLocation", "activity", "tuner", "scanner", "credentials"])(
		"rejects unknown %s before queue admission",
		async key => {
			const block = blockedStage()
			const service = await open(await root(), { storageStage: block.stage })
			const prior = service.snapshot()
			block.arm()
			const active = service.mutate(patch(prior))
			await block.entered.promise
			await expect(
				service.mutate({ ...patch(prior), [key]: {} }),
			).rejects.toMatchObject({ code: "OPERATOR_DATA_INVALID" })
			await expect(
				service.mutate({ type: "reset-command-usage" }),
			).rejects.toMatchObject({ code: "OPERATOR_DATA_PRECONDITION_REQUIRED" })
			const waiting = Array.from({ length: 32 }, () =>
				service.mutate(patch(prior, 1)),
			)
			await expect(service.mutate(patch(prior, 1))).rejects.toMatchObject(busy)
			block.blocked.release()
			await active
			await Promise.all(waiting)
		},
	)

	// Feature: operator-data, Property 9: Bounded lifecycle
	// Validates: Requirements 4.6–4.7
	it("bounds admission and drains all accepted operations before releasing ownership over 100 cases", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 36 }), async count => {
				const path = await root()
				const block = blockedStage()
				const service = await open(path, { storageStage: block.stage })
				const prior = service.snapshot()
				block.arm()
				const active = service.mutate(patch(prior))
				await block.entered.promise
				const waiting = Array.from({ length: count }, () =>
					service.mutate(patch(prior, 1)),
				)
				// Attach every rejection handler before releasing the gate.
				const settled = Promise.allSettled(waiting)
				const closing = service.close()
				expect(service.close()).toBe(closing)
				await expect(service.mutate(patch(prior))).rejects.toMatchObject(
					unavailable,
				)
				await expect(open(path)).rejects.toMatchObject(unavailable)
				block.blocked.release()
				await active
				const results = await settled
				expect(
					results.filter(result => result.status === "fulfilled"),
				).toHaveLength(Math.min(count, 32))
				for (const result of results.slice(32))
					expect(result).toMatchObject({ status: "rejected", reason: busy })
				await closing
				expect(() => service.snapshot()).toThrow(
					"Operator data is unavailable.",
				)
				const reopened = await open(path)
				expect(reopened.snapshot()).toMatchObject({
					storeId: prior.storeId,
					revision: 1,
					preferenceOverrides: { units: "metric" },
				})
				await reopened.close()
			}),
			{ numRuns: 100 },
		)
	}, 60000)

	it("drains changed queued work on close even when responses are discarded; has no implicit cancellation", async () => {
		const path = await root()
		const block = blockedStage()
		const revisions: number[] = []
		const service = await open(path, {
			storageStage: block.stage,
			onCommit: snapshot => {
				revisions.push(snapshot.revision)
				return undefined
			},
		})
		const prior = service.snapshot()
		block.arm()
		const active = service.mutate(patch(prior))
		await block.entered.promise
		// Ignore the response while retaining an explicit rejection handler.
		void service.mutate(patch(prior, 1, "imperial")).catch(() => undefined)
		const last = service.mutate(patch(prior, 2, "nautical"))
		const closing = service.close()
		block.blocked.release()
		await active
		await expect(last).resolves.toMatchObject({
			snapshot: { revision: 3 },
			delivery: "sent",
		})
		await closing
		expect(revisions).toEqual([1, 2, 3])
		expect((await open(path)).snapshot().preferenceOverrides.units).toBe(
			"nautical",
		)
	})

	it.each([
		"temp-open",
		"temp-write",
		"temp-sync",
		"temp-close",
		"rename",
	] as const)(
		"recovers from pre-rename %s failure without poisoning already queued work",
		async failure => {
			const path = await root()
			let armed = false
			const sink = vi.fn(() => undefined)
			const service = await open(path, {
				onCommit: sink,
				storageStage: (stage, phase) => {
					if (armed && stage === failure && phase === "before") {
						armed = false
						throw new Error("injected")
					}
				},
			})
			const prior = service.snapshot()
			const bytes = await readFile(file(path))
			armed = true
			await expect(service.mutate(patch(prior))).rejects.toMatchObject(
				unavailable,
			)
			expect(service.snapshot()).toEqual(prior)
			expect(await readFile(file(path))).toEqual(bytes)
			expect(sink).not.toHaveBeenCalled()
			armed = true
			const failed = service.mutate(patch(prior))
			const retry = service.mutate(patch(prior))
			await expect(failed).rejects.toMatchObject(unavailable)
			await expect(retry).resolves.toMatchObject({
				snapshot: { revision: 1 },
				delivery: "sent",
			})
			expect(sink).toHaveBeenCalledTimes(1)
		},
	)

	it.each(["rename:after", "directory-sync:before", "directory-sync:after"])(
		"latches unavailable and rejects accepted queued work after uncertain %s",
		async failure => {
			const path = await root()
			let armed = false
			const sink = vi.fn(() => undefined)
			const service = await open(path, {
				onCommit: sink,
				storageStage: (stage, phase) => {
					if (armed && `${stage}:${phase}` === failure)
						throw new Error("injected")
				},
			})
			const prior = service.snapshot()
			armed = true
			const first = service.mutate(patch(prior))
			const second = service.mutate(patch(prior, 1, "imperial"))
			const results = await Promise.allSettled([first, second])
			for (const result of results)
				expect(result).toMatchObject({
					status: "rejected",
					reason: unavailable,
				})
			expect(sink).not.toHaveBeenCalled()
			expect(() => service.snapshot()).toThrow("Operator data is unavailable.")
			await expect(service.mutate(patch(prior))).rejects.toMatchObject(
				unavailable,
			)
			armed = false
			await service.close()
			expect((await open(path)).snapshot().revision).toBe(1)
		},
	)

	it("preserves corrupt startup data without returning a fake empty snapshot", async () => {
		const path = await root()
		const service = await open(path)
		await service.close()
		await writeFile(file(path), "{corrupt")
		await expect(open(path)).rejects.toMatchObject(unavailable)
		expect(await readFile(file(path), "utf8")).toBe("{corrupt")
	})

	it.each(["throw", "resolved-promise", "rejected-promise", "thenable"])(
		"isolates %s sink failure from durable success without awaiting",
		async kind => {
			const pending = gate()
			let calls = 0
			const sink = () => {
				calls += 1
				if (kind === "throw") throw new Error("sink")
				if (kind === "resolved-promise") return pending.promise
				if (kind === "rejected-promise")
					return Promise.reject(new Error("async sink"))
				return {
					then: (_resolve: unknown, reject: (error: Error) => void) => {
						reject(new Error("thenable"))
					},
				}
			}
			const service = await open(await root(), {
				onCommit: sink as unknown as NonNullable<
					OperatorDataServiceOptions["onCommit"]
				>,
			})
			await expect(
				service.mutate(patch(service.snapshot())),
			).resolves.toMatchObject({
				delivery: "failed",
				changed: true,
				snapshot: { revision: 1 },
			})
			await expect(
				service.mutate(patch(service.snapshot(), 1, "imperial")),
			).resolves.toMatchObject({
				delivery: "failed",
				snapshot: { revision: 2 },
			})
			expect(calls).toBe(2)
			pending.release()
			await service.close()
		},
	)

	it("reports absent sink as unmounted and noop as not-needed", async () => {
		const service = await open(await root())
		await expect(
			service.mutate(patch(service.snapshot())),
		).resolves.toMatchObject({ delivery: "unmounted" })
		await expect(
			service.mutate(patch(service.snapshot())),
		).resolves.toMatchObject({ delivery: "not-needed" })
	})

	it("persists maximum record/ranking state and measures ten actual-fsync bounded mutations", async () => {
		const path = await root()
		const initial = await open(path)
		const snapshot = initial.snapshot()
		await initial.close()
		const time = "2026-10-10T00:00:00.000Z"
		snapshot.revision = 64
		snapshot.savedFrequencies = Array.from({ length: 256 }, () => ({
			id: randomUUID(),
			name: "📻".repeat(128),
			group: "📻".repeat(64),
			frequencyHz: 100_000_000_000,
			mode: "nfm",
			bandwidthHz: 10_000_000,
			tone: { kind: "dcs", code: "777", polarity: "inverted" },
			createdAt: time,
			updatedAt: time,
		}))
		snapshot.commandUsage = snapshot.savedFrequencies
			.slice(0, 64)
			.map((preset, index) => ({
				command: "open-saved-frequency",
				savedFrequencyId: preset.id,
				count: 1_000_000,
				lastUsedAt: time,
				lastUsedRevision: 64 - index,
			}))
		const encoded = encodeSnapshot(snapshot)
		const bytes = Buffer.byteLength(encoded)
		expect(bytes).toBeLessThan(OPERATOR_DATA_LIMITS.snapshotBytes)
		await writeFile(file(path), encoded)
		const service = await open(path)
		const latencies: number[] = []
		for (let index = 0; index < 10; index += 1) {
			const start = performance.now()
			await service.mutate(
				patch(
					service.snapshot(),
					64 + index,
					index % 2 ? "imperial" : "metric",
				),
			)
			latencies.push(performance.now() - start)
		}
		const final = service.snapshot()
		expect(final.savedFrequencies).toHaveLength(256)
		expect(final.commandUsage).toHaveLength(64)
		expect(final.revision).toBe(74)
		expect(
			validateSnapshot(JSON.parse(await readFile(file(path), "utf8"))),
		).toEqual(final)
		await service.close()
		expect((await open(path)).snapshot()).toEqual(final)
		latencies.sort((a, b) => a - b)
		console.info(
			JSON.stringify({
				scope:
					"synthetic local maximum-state, ten serial mutations including snapshot capture and actual fsync",
				bytes,
				finalBytes: Buffer.byteLength(encodeSnapshot(final)),
				milliseconds: {
					min: latencies[0],
					median: (latencies[4]! + latencies[5]!) / 2,
					max: latencies[9],
				},
				host: {
					platform: platform(),
					release: release(),
					arch: arch(),
					cpu: cpus()[0]?.model,
					node: process.version,
				},
			}),
		)
	})
})
