/**
 * Files waiting for a free store operation (WidebandAnalogRecorder storeWaiters): a voiced shadow
 * classed while every operation the store allows is held waits instead of being refused, is
 * written whole once one frees (even after its transmission ended), is dropped once it waited
 * longer than WIDEBAND_MAX_BUFFERED_MS on the recorder's monotonic clock, a recording's own next
 * file (a continuation) is served before new waiters, at most MAX_STORE_WAITERS new waiters wait
 * and continuations never outnumber the store's operations. The store's per-source count (the
 * channel tier's operations included) counts too. Time is the test's own clocks (the recorder's
 * `now` and `clock`), never the wall clock.
 */
import { describe, expect, it } from "vitest"
import { RECORDER_STREAK_FIXES } from "../../../../packages/api-types/src/status.js"
import {
	MAX_STORE_WAITERS,
	MAX_WAITING_FILES,
	WIDEBAND_MAX_BUFFERED_FRAMES,
	WIDEBAND_MAX_BUFFERED_MS,
	type RecordingCpuReading,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	MAX_ACTIVE_ANALOG_OPERATIONS,
	MAX_ACTIVE_ANALOG_PER_SOURCE,
} from "../../../../src/core/scanner/store/analog-operations.js"
import {
	CENTRE,
	HARNESS_T0,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}
/** Lets the settle chain (then, catch, finally) run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}
const CALM: RecordingCpuReading = {
	label: "calm",
	ownCores: 0.5,
	capacityCores: 8,
	guardPercent: 90,
	hostPercent: 0,
}

interface WaitingFile {
	waitSeq: number
	storeSince: number | null
	continuation?: boolean
	failed?: boolean
	decided?: boolean
	handle?: unknown
}
interface WaiterView {
	id?: string
	owner?: string
	ops: number
	done: boolean
	sourceId: string
	waiting: WaitingFile[]
	files?: Set<unknown>
	file?: WaitingFile | null
}
interface Internals {
	storeWaiters: Set<WaiterView>
	sessions: Map<string, WaiterView>
	unsettled: Map<string, number>
	admit(s: WaiterView, file: WaitingFile): void
	beginOp(s: WaiterView, file: WaitingFile): void
	drainStoreWaiters(): void
	storeWaiting(): number
}

/**
 * Other producers hold `state.all` operations over all sources and `state.on` on source rtl
 * (this recorder's own sessions are all on rtl); the fake store denies an admission past either
 * limit. `state.t` is the recorder's wall clock (`now`, ms), `state.m` its monotonic clock
 * (`clock`, ms). `settle(i)` ends the i-th operation this recorder began (finalized).
 */
function scene() {
	const state = {
		all: MAX_ACTIVE_ANALOG_OPERATIONS,
		on: 0,
		t: HARNESS_T0,
		m: 1_000,
		denied: 0,
	}
	const forced: ((r: unknown) => void)[] = []
	let ref: ReturnType<typeof harness> | null = null
	const mine = () =>
		ref === null
			? 0
			: ref.ops.filter(op => op.outcome === null && !op.denied).length
	const h = harness({
		recordingCpu: () => CALM,
		analogActive: () => state.all + mine(),
		analogActiveOn: sourceId => (sourceId === "rtl" ? state.on + mine() : 0),
		now: () => state.t,
		clock: () => state.m,
		beginWrap: begin => inp => {
			const inner = begin(inp)
			let force!: (r: unknown) => void
			const forcedSettle = new Promise<unknown>(r => {
				force = r
			})
			forced.push(force)
			const handle = {
				...inner,
				settled: Promise.race([inner.settled, forcedSettle]),
			} as typeof inner
			if (
				state.all + mine() > MAX_ACTIVE_ANALOG_OPERATIONS ||
				state.on + mine() > MAX_ACTIVE_ANALOG_PER_SOURCE
			) {
				// As the store: readiness rejects first, the operation settles after it.
				state.denied++
				const ready = Promise.reject(new Error("admission-denied"))
				ready.catch(() => handle.cancel())
				return { ...handle, ready }
			}
			return handle
		},
	})
	ref = h
	const settle = (i: number) => {
		const op = h.ops[i]!
		op.outcome = "finalized"
		forced[i]!({ outcome: "finalized" })
	}
	const internals = h.rec as unknown as Internals
	const counts = () => h.rec.diagnostics().counts
	/** A snapshot of nothing this recorder runs: its drain of the store waiters runs. */
	const snapshotTick = () => h.rec.closed("tick", snapshot("tick", 0, 10), null)
	/**
	 * A 3 s transmission, a shadow for its first second then classed analog-fm; with `close`, its
	 * close and the hang after it (the file finishes and the session ends).
	 */
	const voiced = async (
		id: string,
		close = true,
		each?: (sinceOnset: number) => void,
	) => {
		const onset = h.engine.liveEdge()
		const end = onset + 3 * h.fs
		await h.feed(3, true, () => {
			const edge = h.engine.liveEdge()
			each?.((edge - onset) / h.fs)
			if (edge - onset < 0.1 * h.fs) return
			const classed = edge - onset >= 1 * h.fs
			h.rec.track(
				input(
					id,
					snapshot(id, onset, Math.min(edge, end)),
					classed ? {} : SHADOW,
				),
			)
		})
		if (!close) return
		await h.feed(0.6, false)
		h.rec.closed(id, snapshot(id, onset, end), null)
		await h.feed(3, false)
		await h.fire()
	}
	/**
	 * A waiter of nothing real (done, no operation, never expiring): fills the waiters' cap. With
	 * `continuation`, it counts as a recording's own next file.
	 */
	const fakeWaiter = (
		seq: number,
		sourceId = "z",
		continuation = false,
	): WaiterView => {
		const w: WaiterView = {
			ops: 0,
			done: true,
			sourceId,
			waiting: [{ waitSeq: seq, storeSince: null, continuation }],
		}
		internals.storeWaiters.add(w)
		return w
	}
	/** The live session of observation `id`. */
	const session = (id: string) =>
		[...internals.sessions.values()].find(x => x.owner === id)!
	/**
	 * A second file of the live session `s` (its current file's copy, not begun), admitted: it
	 * waits behind the session's own file.
	 */
	const nextFile = (s: WaiterView): WaitingFile => {
		const f: WaitingFile = {
			...s.file!,
			waitSeq: 0,
			storeSince: null,
			continuation: false,
			decided: false,
			failed: false,
			handle: null,
		}
		s.files?.add(f)
		internals.admit(s, f)
		return f
	}
	return {
		h,
		state,
		internals,
		counts,
		snapshotTick,
		voiced,
		fakeWaiter,
		settle,
		session,
		nextFile,
	}
}

describe("store waiters: a voiced file waits for a free store operation", () => {
	it("a waiter whose transmission closed before an operation freed is written whole when one frees within the deadline", async () => {
		const { h, state, internals, counts, snapshotTick, voiced } = scene()
		await voiced("w")
		// The session ended; its file waits, holding its audio.
		expect(h.ops).toHaveLength(0)
		expect(h.rec.owns("w")).toBe(false)
		const [waiter] = [...internals.storeWaiters]
		expect(waiter?.done).toBe(true)
		expect(waiter?.waiting).toHaveLength(1)
		// Inside the deadline, one operation frees: the next snapshot begins it.
		state.m += WIDEBAND_MAX_BUFFERED_MS - 1_000
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		snapshotTick()
		expect(h.ops).toHaveLength(1)
		await h.fire()
		await h.rec.idle()
		const op = h.ops[0]!
		expect(op.denied).toBe(false)
		expect(op.outcome).toBe("finalized")
		expect(op.frames).toBeGreaterThanOrEqual(3 * 8000)
		expect(counts()["refused:store"]).toBeUndefined()
		expect(counts()["discarded:store-backlog"]).toBeUndefined()
		expect(internals.storeWaiters.size).toBe(0)
		expect(state.denied).toBe(0)
	}, 60_000)

	it("a store full for longer than the deadline: kept at it, dropped past it (memory freed, noted once), never begun later", async () => {
		const { h, state, internals, counts, snapshotTick, voiced } = scene()
		const since = state.m
		await voiced("w")
		const [waiter] = [...internals.storeWaiters]
		expect(waiter?.waiting[0]?.storeSince).toBe(since)
		// At the deadline: still waiting.
		state.m = since + WIDEBAND_MAX_BUFFERED_MS
		snapshotTick()
		expect(internals.storeWaiters.size).toBe(1)
		expect(counts()["discarded:store-backlog"]).toBeUndefined()
		// Past it: dropped with one terminal decision, its file and audio no longer held.
		state.m += 1
		snapshotTick()
		expect(internals.storeWaiters.size).toBe(0)
		expect(waiter?.waiting).toHaveLength(0)
		expect(waiter?.files?.size).toBe(0)
		expect(counts()["discarded:store-backlog"]).toBe(1)
		// Further snapshots and a freed store note nothing more and begin nothing.
		state.m += 10_000
		snapshotTick()
		state.all = 0
		snapshotTick()
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(counts()["discarded:store-backlog"]).toBe(1)
		expect(counts()["refused:store"]).toBeUndefined()
	}, 60_000)

	it("two waiters begin oldest first", async () => {
		const { h, state, internals, snapshotTick, voiced } = scene()
		await voiced("w1")
		state.m += 5_000
		await voiced("w2")
		expect(internals.storeWaiters.size).toBe(2)
		expect(h.ops).toHaveLength(0)
		// One operation frees: the older waiter takes it; the other still waits.
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		snapshotTick()
		expect(h.ops.map(op => op.input.observationId)).toEqual(["w1"])
		// Its operation ending frees it for the next one.
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(op => op.input.observationId)).toEqual(["w1", "w2"])
		expect(h.ops.every(op => op.outcome === "finalized")).toBe(true)
		expect(state.denied).toBe(0)
	}, 60_000)

	it("a freed operation goes to a continuation first, then to the oldest new waiter, whatever the waiters' insertion order", () => {
		const { state, internals } = scene()
		const begun: number[] = []
		internals.beginOp = (s, f) => {
			begun.push(f.waitSeq)
			s.ops++
			// The store holds it now.
			state.all++
		}
		// One source. A session's own next file (a roll-over) joined after two older new waiters
		// (waitSeq 3 and 4 < 5): it still takes the one freed operation.
		const rollOver: WaiterView = {
			ops: 0,
			done: false,
			sourceId: "rtl",
			waiting: [{ waitSeq: 5, storeSince: state.m, continuation: true }],
		}
		const newer: WaiterView = {
			ops: 0,
			done: true,
			sourceId: "rtl",
			waiting: [{ waitSeq: 4, storeSince: state.m }],
		}
		const older: WaiterView = {
			ops: 0,
			done: true,
			sourceId: "rtl",
			waiting: [{ waitSeq: 3, storeSince: state.m }],
		}
		internals.storeWaiters.add(newer)
		internals.storeWaiters.add(older)
		internals.storeWaiters.add(rollOver)
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		internals.drainStoreWaiters()
		expect(begun).toEqual([5])
		expect(internals.storeWaiters.has(rollOver)).toBe(false)
		// The next freed operations: the new waiters, oldest first.
		state.all--
		internals.drainStoreWaiters()
		expect(begun).toEqual([5, 3])
		state.all--
		internals.drainStoreWaiters()
		expect(begun).toEqual([5, 3, 4])
		expect(internals.storeWaiters.size).toBe(0)
	})

	it("a kept recording's next file, behind its operation, takes the operation it frees before an older shadow waiter on its source", async () => {
		const {
			h,
			state,
			internals,
			counts,
			voiced,
			fakeWaiter,
			settle,
			session,
			nextFile,
		} = scene()
		// A records (the store has room for it), then its next file waits behind its operation.
		state.all = 0
		await voiced("a", false)
		expect(h.ops).toHaveLength(1)
		const a = session("a")
		const next = nextFile(a)
		expect(a.waiting).toEqual([next])
		// The store fills; an older new waiter on the same source waits for an operation.
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		const w = fakeWaiter(-1, "rtl")
		w.waiting[0]!.storeSince = state.m
		const served: WaiterView[] = []
		const begin = internals.beginOp.bind(h.rec)
		internals.beginOp = (s, f) => {
			served.push(s)
			begin(s, f)
		}
		// A's operation ends: its next file is a continuation and takes the freed operation.
		settle(0)
		await flush()
		expect(next.continuation).toBe(true)
		expect(served).toEqual([a])
		expect(h.ops).toHaveLength(2)
		expect(internals.storeWaiters.has(w)).toBe(true)
		expect(w.waiting).toHaveLength(1)
		expect(counts()["discarded:store-backlog"]).toBeUndefined()
	}, 60_000)

	it("stop() with a waiter pending: one operation, one terminal decision (store still full: refused:store)", async () => {
		const { h, state, counts, voiced } = scene()
		await voiced("w", false)
		expect(h.ops).toHaveLength(0)
		await h.rec.stop()
		await h.fire()
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(state.denied).toBe(1)
		expect(counts()["refused:store"]).toBe(1)
		expect(counts()["discarded:aborted"]).toBeUndefined()
		expect(counts()["discarded:store-backlog"]).toBeUndefined()
		expect(counts()["finalized"]).toBeUndefined()
	}, 60_000)

	it("stop() with a waiter pending and a free operation: one operation, kept once", async () => {
		const { h, state, counts, voiced } = scene()
		await voiced("w", false)
		expect(h.ops).toHaveLength(0)
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		await h.rec.stop()
		await h.fire()
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(counts()["finalized"]).toBe(1)
		expect(counts()["refused:store"]).toBeUndefined()
		expect(counts()["discarded:aborted"]).toBeUndefined()
	}, 60_000)

	it("the waiters' cap: at it the file waits; past it the file is dropped, and a new shadow waits (refused:slots)", async () => {
		expect(MAX_STORE_WAITERS).toBe(MAX_ACTIVE_ANALOG_OPERATIONS)
		// At the bound: 7 already wait, the eighth joins.
		const at = scene()
		const fakes: WaiterView[] = []
		for (let i = 0; i < MAX_STORE_WAITERS - 1; i++)
			fakes.push(at.fakeWaiter(-100 + i))
		await at.voiced("w", false)
		expect(at.internals.storeWaiters.size).toBe(MAX_STORE_WAITERS)
		expect(at.counts()["discarded:store-backlog"]).toBeUndefined()
		expect(at.h.rec.owns("w")).toBe(true)
		// Past it: an eighth fills the cap while the shadow is not classed yet; once voiced its
		// file is dropped and the session ends.
		const past = scene()
		for (let i = 0; i < MAX_STORE_WAITERS - 1; i++) past.fakeWaiter(-100 + i)
		let filled = false
		await past.voiced("w", false, since => {
			if (!filled && since >= 0.5) {
				past.fakeWaiter(-1)
				filled = true
			}
		})
		expect(past.internals.storeWaiters.size).toBe(MAX_STORE_WAITERS)
		expect(past.counts()["discarded:store-backlog"]).toBe(1)
		expect(past.h.rec.owns("w")).toBe(false)
		expect(past.h.ops).toHaveLength(0)
		// A new shadow beside the full store with the cap reached waits; one under the cap starts.
		past.h.rec.track(
			input(
				"s2",
				snapshot("s2", 0, 10, { centreHz: CENTRE + 200_000 }),
				SHADOW,
			),
		)
		expect(past.h.rec.owns("s2")).toBe(false)
		expect(past.counts()["refused:slots"]).toBe(1)
		at.internals.storeWaiters.delete(fakes[0]!)
		at.h.rec.track(
			input(
				"s2",
				snapshot("s2", 0, 10, { centreHz: CENTRE + 200_000 }),
				SHADOW,
			),
		)
		expect(at.h.rec.owns("s2")).toBe(true)
	}, 60_000)

	it("an ended waiter counts as held: a new voice on another source waits behind it", async () => {
		const { h, state, internals, counts, voiced } = scene()
		// Source rtl at its 6 (another producer's); one operation free over all sources.
		state.on = MAX_ACTIVE_ANALOG_PER_SOURCE
		state.all = MAX_ACTIVE_ANALOG_OPERATIONS - 1
		await voiced("w")
		expect(internals.storeWaiters.size).toBe(1)
		expect(h.ops).toHaveLength(0)
		// 7 held + the waiter = 8: a classed voice on source b is not started ahead of it.
		h.rec.track(
			input("b0", snapshot("b0", 0, 10, { sourceId: "b" }), { sourceId: "b" }),
		)
		expect(h.rec.owns("b0")).toBe(false)
		expect(counts()["refused:slots"]).toBe(1)
	}, 60_000)

	it("a live waiter keeps at most MAX_WAITING_FILES files waiting (store-backlog past it)", async () => {
		const { h, internals, counts, voiced } = scene()
		await voiced("w", false)
		const s = [...internals.sessions.values()].find(x => x.owner === "w")!
		expect(s.waiting).toHaveLength(1)
		expect(MAX_WAITING_FILES).toBe(2)
		const clone = (): WaitingFile => ({
			...s.waiting[0]!,
			waitSeq: 0,
			storeSince: null,
			decided: false,
			failed: false,
		})
		// At the bound: a second file waits behind the first, in order.
		const second = clone()
		s.files?.add(second)
		internals.admit(s, second)
		expect(s.waiting).toHaveLength(2)
		expect(s.waiting[1]).toBe(second)
		expect(s.waiting[1]!.waitSeq).toBeGreaterThan(s.waiting[0]!.waitSeq)
		// Past it: a third is dropped, the session goes on.
		const third = clone()
		s.files?.add(third)
		internals.admit(s, third)
		expect(s.waiting).toHaveLength(MAX_WAITING_FILES)
		expect(third.failed).toBe(true)
		expect(counts()["discarded:store-backlog"]).toBe(1)
		expect(h.rec.owns("w")).toBe(true)
	}, 60_000)

	it("the store's per-source count: a source holding a channel-tier operation and 5 others waits instead of beginning its 6th", async () => {
		const { h, state, counts, snapshotTick, voiced } = scene()
		// 6 on rtl over all producers (one channel-tier), 6 overall: room over all sources only.
		state.all = MAX_ACTIVE_ANALOG_PER_SOURCE
		state.on = MAX_ACTIVE_ANALOG_PER_SOURCE
		await voiced("w")
		expect(h.ops).toHaveLength(0)
		expect(counts()["refused:store"]).toBeUndefined()
		// One under the source's limit: it begins and is kept.
		state.on = MAX_ACTIVE_ANALOG_PER_SOURCE - 1
		snapshotTick()
		await h.fire()
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(state.denied).toBe(0)
		expect(counts()["refused:store"]).toBeUndefined()
	}, 60_000)

	it("continuations are not capped by MAX_STORE_WAITERS: with the new waiters at and past the cap, a kept recording's next file still waits (not dropped)", async () => {
		for (const fakes of [MAX_STORE_WAITERS - 1, MAX_STORE_WAITERS]) {
			const {
				h,
				state,
				internals,
				counts,
				voiced,
				fakeWaiter,
				settle,
				session,
				nextFile,
			} = scene()
			state.all = 0
			await voiced("a", false)
			const a = session("a")
			const next = nextFile(a)
			for (let i = 0; i < fakes; i++) fakeWaiter(-100 + i)
			expect(internals.storeWaiting()).toBe(fakes)
			// The store is full when A's operation ends (another producer takes the freed one).
			state.all = MAX_ACTIVE_ANALOG_OPERATIONS
			settle(0)
			await flush()
			expect(internals.storeWaiters.has(a)).toBe(true)
			expect(internals.storeWaiters.size).toBe(fakes + 1)
			expect(a.waiting).toEqual([next])
			// The new waiters' count leaves the continuation out.
			expect(internals.storeWaiting()).toBe(fakes)
			expect(counts()["discarded:store-backlog"]).toBeUndefined()
			expect(h.rec.owns("a")).toBe(true)
		}
	}, 60_000)

	it("the true bound: this recorder's operations plus its waiting continuations never pass the store's 8, so at most 8 + 8 sessions wait (15.36 MB)", () => {
		// Each waiting session holds at most 60 s of 8 kHz 16-bit audio: 960 000 B.
		expect(WIDEBAND_MAX_BUFFERED_FRAMES * 2).toBe(960_000)
		expect(
			(MAX_STORE_WAITERS + MAX_ACTIVE_ANALOG_OPERATIONS) *
				WIDEBAND_MAX_BUFFERED_FRAMES *
				2,
		).toBe(15_360_000)
		for (const [continuations, served] of [
			[1, true],
			[2, false],
		] as const) {
			const { state, internals, fakeWaiter } = scene()
			// 6 operations of this recorder on source c (full there), none of other producers: the
			// store has room for 2 more over all sources.
			state.all = 0
			internals.unsettled.set("c", MAX_ACTIVE_ANALOG_PER_SOURCE)
			// Continuations of source c wait (their source is full), each keeping its operation.
			for (let i = 0; i < continuations; i++) fakeWaiter(i, "c", true)
			// A new waiter on another source begins only while 6 + continuations < 8.
			const w = fakeWaiter(10, "rtl")
			const begun: WaiterView[] = []
			internals.beginOp = s => {
				begun.push(s)
				s.ops++
			}
			internals.drainStoreWaiters()
			// At the bound (6 + 1 = 7): the new waiter takes the 8th. Past it (6 + 2 = 8): it waits.
			expect(begun).toEqual(served ? [w] : [])
			expect(internals.storeWaiters.has(w)).toBe(!served)
		}
	})

	it("a new voice holding no operation waits instead of beginning while operations plus waiting continuations take all 8", async () => {
		for (const [continuations, begins] of [
			[1, true],
			[2, false],
		] as const) {
			const { h, state, internals, fakeWaiter, session, voiced } = scene()
			state.all = 0
			internals.unsettled.set("c", MAX_ACTIVE_ANALOG_PER_SOURCE)
			for (let i = 0; i < continuations; i++) fakeWaiter(i, "c", true)
			await voiced("x", false)
			const x = session("x")
			// At the bound (6 + 1 = 7) it begins the 8th; past it (6 + 2 = 8) its file waits.
			expect(h.ops.length).toBe(begins ? 1 : 0)
			expect(internals.storeWaiters.has(x)).toBe(!begins)
			expect(x.waiting).toHaveLength(begins ? 0 : 1)
		}
	}, 60_000)

	it("the deadline is on the recorder's monotonic clock: a wall-clock step back or forward never moves it", async () => {
		const { h, state, internals, counts, snapshotTick, voiced } = scene()
		const since = state.m
		await voiced("w")
		const [waiter] = [...internals.storeWaiters]
		expect(waiter?.waiting[0]?.storeSince).toBe(since)
		// The wall clock steps back an hour, then forward two: nothing expires, nothing moves.
		state.t -= 3_600_000
		snapshotTick()
		expect(waiter?.waiting[0]?.storeSince).toBe(since)
		state.t += 7_200_000
		snapshotTick()
		expect(internals.storeWaiters.size).toBe(1)
		expect(waiter?.waiting[0]?.storeSince).toBe(since)
		expect(counts()["discarded:store-backlog"]).toBeUndefined()
		// The monotonic clock at the deadline: kept; past it: dropped.
		state.m = since + WIDEBAND_MAX_BUFFERED_MS
		snapshotTick()
		expect(internals.storeWaiters.size).toBe(1)
		state.m += 1
		snapshotTick()
		expect(internals.storeWaiters.size).toBe(0)
		expect(counts()["discarded:store-backlog"]).toBe(1)
		expect(h.ops).toHaveLength(0)
	}, 60_000)

	it("drainStoreWaiters returns at once when nothing waits", () => {
		const { internals } = scene()
		let counted = 0
		const storeWaiting = internals.storeWaiting.bind(internals)
		internals.storeWaiting = () => {
			counted++
			return storeWaiting()
		}
		internals.drainStoreWaiters()
		expect(counted).toBe(0)
		// With a waiter it does its work.
		internals.storeWaiters.add({
			ops: 0,
			done: true,
			sourceId: "z",
			waiting: [{ waitSeq: 1, storeSince: null }],
		})
		internals.drainStoreWaiters()
		expect(counted).toBe(1)
	})

	it("refused:slots' fix names both causes: the source's limit, the CPU budget's floor of slots (cpuBudgetCores) and the floor of 2 without a CPU reading", () => {
		const fix = RECORDER_STREAK_FIXES["refused:slots"]
		expect(fix).toContain("recording limit")
		expect(fix).toContain("raising cpuBudgetCores")
		expect(fix).toContain("without a CPU reading the limit is the floor of 2")
	})
})
