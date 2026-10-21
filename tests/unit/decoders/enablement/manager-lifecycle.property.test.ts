import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, expect, it, vi } from "vitest"
import {
	PlacementLifecycle,
	PLACEMENT_STOP_TIMEOUT_MS,
} from "../../../../src/decoders/placement-lifecycle.js"

const flush = () => vi.advanceTimersByTimeAsync(0)
afterEach(() => vi.useRealTimers())

function fixture() {
	let live = 0
	let run = 0
	let removed = false
	let forgotten = false
	const starts: Array<{ resolve: () => void; reject: () => void }> = []
	const stops: Array<{ resolve: () => void; reject: () => void }> = []
	const admissions: number[] = []
	const actor = new PlacementLifecycle({
		start: generation => {
			admissions.push(generation)
			return new Promise<boolean>((resolve, reject) => {
				starts.push({
					resolve: () => {
						expect(live).toBe(0)
						live++
						run++
						resolve(true)
					},
					reject: () => reject(new Error("start failed")),
				})
			})
		},
		stop: () =>
			new Promise<void>((resolve, reject) => {
				const stoppingRun = run
				stops.push({
					resolve: () => {
						if (run === stoppingRun) live = 0
						resolve()
					},
					reject: () => reject(new Error("stop failed")),
				})
			}),
		running: () => live > 0,
		invalidate: vi.fn(),
		incomplete: vi.fn(),
		idle: () => {
			if (removed) forgotten = true
		},
	})
	return {
		actor,
		starts,
		stops,
		admissions,
		live: () => live,
		appear: () => {
			live = 1
			actor.kick()
		},
		forgotten: () => forgotten,
		remove: () => {
			removed = true
			return actor.request("stopped")
		},
		exit: () => {
			live = 0
			actor.exited()
		},
	}
}

// Feature: decoder-enablement, Property 12: Placement lifecycle is serial
// Validates: Requirements 2.5, 3.7, 4.1, 4.2, 4.3, 11.3
it("serializes arbitrary placement desires and adapter completions", async () => {
	vi.useFakeTimers()
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 60 }),
			async commands => {
				const f = fixture()
				let removed = false
				for (const command of commands) {
					if (command === 0 && !removed) void f.actor.request("running")
					if (command === 1) void f.actor.request("stopped")
					if (command === 2) f.starts.shift()?.resolve()
					if (command === 3) f.starts.shift()?.reject()
					if (command === 4) f.stops.shift()?.resolve()
					if (command === 5) f.stops.shift()?.reject()
					if (command === 6) f.exit()
					if (command === 7) {
						removed = true
						void f.remove()
					}
					if (command === 8) await vi.advanceTimersByTimeAsync(5_001)
					// 9 leaves the adapter operation unsettled.
					await flush()
					expect(f.live()).toBeLessThanOrEqual(1)
					expect(f.forgotten() && f.live() > 0).toBe(false)
				}
				void f.actor.request("stopped")
				f.starts.shift()?.resolve()
				await flush()
				f.stops.shift()?.resolve()
				await flush()
				if (f.live()) {
					void f.actor.request("stopped")
					await flush()
					f.stops.shift()?.resolve()
					await flush()
				}
				expect(f.actor.actual).toBe(f.live() ? "stopping-failed" : "idle")
				if (f.live()) expect(f.forgotten()).toBe(false)
				if (!removed && !f.live() && commands.length % 2 === 1) {
					void f.actor.request("running")
					await flush()
					f.starts.shift()!.resolve()
					await flush()
					expect(f.actor.actual).toBe("running")
					expect(f.actor.desired).toBe("running")
				}
				expect(new Set(f.admissions).size).toBe(f.admissions.length)
				await vi.advanceTimersByTimeAsync(5_001)
			},
		),
		{ numRuns: 200 },
	)
})

it("a newer stop supersedes a start waiting for an older stop", async () => {
	vi.useFakeTimers()
	const f = fixture()
	void f.actor.request("running")
	await flush()
	f.starts.shift()!.resolve()
	await flush()
	void f.actor.request("stopped")
	await flush()
	void f.actor.request("running")
	void f.actor.request("stopped")
	f.stops.shift()!.resolve()
	await flush()
	expect(f.starts).toHaveLength(0)
	expect(f.actor.actual).toBe("idle")
})

it("late exit clears failed stop ownership before a fresh run stops", async () => {
	vi.useFakeTimers()
	const f = fixture()
	void f.actor.request("running")
	await flush()
	f.starts.shift()!.resolve()
	await flush()
	void f.actor.request("stopped")
	await flush()
	f.stops.shift()!.reject()
	await flush()
	f.exit()
	void f.actor.request("running")
	await flush()
	f.starts.shift()!.resolve()
	await flush()
	void f.actor.request("stopped")
	await flush()
	expect(f.stops).toHaveLength(1)
	f.stops.shift()!.resolve()
	await flush()
	expect(f.actor.actual).toBe("idle")
})

it("retains a never settling start through bounded removal and stops its late process", async () => {
	vi.useFakeTimers()
	const f = fixture()
	void f.actor.request("running")
	await flush()
	const removal = f.remove()
	await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS)
	await removal
	expect(f.forgotten()).toBe(false)
	f.starts.shift()!.resolve()
	await flush()
	f.stops.shift()!.resolve()
	await flush()
	expect(f.forgotten()).toBe(true)
})

it("uses the process bases graceful stop deadline and one placement start choke point", () => {
	const base = readFileSync("src/decoders/base-decoder.ts", "utf8")
	expect(Number(base.match(/const GRACEFUL_STOP_TIMEOUT = (\d+)/)?.[1])).toBe(
		PLACEMENT_STOP_TIMEOUT_MS,
	)
	const manager = readFileSync("src/decoders/manager.ts", "utf8")
	const choke = manager.slice(
		manager.indexOf("private async startPlacementNow("),
	)
	expect(choke.match(/await state.decoder.start\(\)/g)).toHaveLength(1)
	expect(manager.match(/await state.decoder.start\(\)/g)).toHaveLength(1)
	const parentMethods = manager.slice(
		manager.indexOf("startDecoder(id: string"),
		manager.indexOf("async startAll()"),
	)
	expect(parentMethods).not.toMatch(/\.decoder\.(start|stop|restart)\(/)
	expect(manager).not.toMatch(/state\.decoder\.restart\(/)
	expect(manager.match(/return state.decoder.stop\(\)/g)).toHaveLength(1)

	expect(manager).not.toMatch(
		/workerStop|workerStart|workerTermination|workerGeneration/,
	)
})

it("stops a late process even when its start promise never settles", async () => {
	vi.useFakeTimers()
	const f = fixture()
	void f.actor.request("running")
	await flush()
	const removing = f.remove()
	await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS)
	await removing
	f.appear()
	await flush()
	expect(f.stops).toHaveLength(1)
	f.stops.shift()!.resolve()
	await flush()
	expect(f.live()).toBe(0)
	expect(f.actor.pending).toBe(true)
	expect(f.forgotten()).toBe(false)
})

it("confirmed exit releases a hanging stop without reusing its completion", async () => {
	vi.useFakeTimers()
	const f = fixture()
	void f.actor.request("running")
	await flush()
	f.starts.shift()!.resolve()
	await flush()
	void f.actor.request("stopped")
	await flush()
	await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS)
	expect(f.actor.actual).toBe("stopping-failed")
	f.exit()
	await flush()
	void f.actor.request("running")
	await flush()
	f.starts.shift()!.resolve()
	await flush()
	f.stops.shift()!.resolve()
	await flush()
	expect(f.actor.actual).toBe("running")
	expect(f.live()).toBe(1)
})

it("settles the original request when a cancelled start rejects after its deadline", async () => {
	vi.useFakeTimers()
	const f = fixture()
	let settled = false
	const running = f.actor.request("running").then(() => {
		settled = true
	})
	await flush()
	const stopping = f.actor.request("stopped")
	await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS + 1)
	await stopping
	f.starts.shift()!.reject()
	await flush()
	await running
	expect(settled).toBe(true)
	expect(f.actor.actual).toBe("idle")
	expect(f.actor.pending).toBe(false)
})
