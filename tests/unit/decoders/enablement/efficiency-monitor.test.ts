import { expect, it } from "vitest"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { WantedPlacement } from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"

const setup = () => {
	let mono = 0
	let wall = 0
	let bytes = 0
	let chunks = 0
	let other = 0
	let topology: string | null = "a"
	let ids = ["s"]
	let throws = false
	let deliveryThrows = false
	let sourcesThrow = false
	let callback = () => {}
	let tick = () => {}
	let cancelled = false
	const monitor = createEfficiencyMonitor({
		sources: () => {
			if (sourcesThrow) throw new TypeError("sources")
			return ids
		},
		branchCounters: () => {
			if (throws) throw new TypeError("read")
			return new Map([
				["a", { droppedBytesTotal: bytes, droppedChunksTotal: chunks }],
				["b", { droppedBytesTotal: other, droppedChunksTotal: other }],
			])
		},
		topology: () => topology,
		cpu: { normalisedPercent: NaN },
		now: () => wall,
		monoNow: () => mono,
		setInterval(fn) {
			tick = fn
			return {
				cancel() {
					cancelled = true
				},
			}
		},
		onSample() {
			callback()
			if (deliveryThrows) throw new TypeError("display")
		},
	})
	monitor.start()
	return {
		monitor,
		tick(at = mono + 2000) {
			mono = at
			tick()
		},
		clean() {
			for (let n = 0; n < 31; n++) {
				mono += 2000
				tick()
			}
		},
		other(n: number) {
			other = n
		},
		bytes(n: number) {
			bytes = n
		},
		chunks(n: number) {
			chunks = n
		},
		wall(n: number) {
			wall = n
		},
		topology(n: string | null) {
			topology = n
		},
		ids(n: string[]) {
			ids = n
		},
		sourcesThrow(n: boolean) {
			sourcesThrow = n
		},
		throws(n: boolean) {
			throws = n
		},
		deliveryThrows(n: boolean) {
			deliveryThrows = n
		},
		callback(fn: () => void) {
			callback = fn
		},
		cancelled: () => cancelled,
		advance(ms: number) {
			mono += ms
		},
	}
}
it("first sample is unknown, second has deltas; NaN cpu is null", () => {
	const h = setup()
	expect(h.monitor.sampleNow().sources.get("s")?.droppedBytesDelta).toBeNull()
	h.advance(2000)
	expect(h.monitor.sampleNow()).toMatchObject({ cpuPercent: null })
	h.bytes(100)
	h.advance(2000)
	expect(h.monitor.sampleNow().sources.get("s")?.droppedBytesDelta).toBe(100)
})
it("stop cancels the interval and restart earns a fresh window", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
	h.monitor.stop()
	expect(h.cancelled()).toBe(true)
	h.monitor.start()
	h.tick()
	expect(h.monitor.dropState("s").state).toBe("unknown")
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})
it.each([
	"throw",
	"nan",
	"decrease",
	"topology",
	"late",
	"backwards",
	"invalid",
] as const)(
	"%s invalidates continuity and recovers after a full clean window",
	kind => {
		const h = setup()
		h.bytes(10)
		h.tick(0)
		h.clean()
		expect(h.monitor.dropState("s").state).toBe("ok")
		if (kind === "throw") h.throws(true)
		if (kind === "nan") h.chunks(NaN)
		if (kind === "decrease") h.bytes(0)
		if (kind === "topology") h.topology("b")
		h.tick(
			kind === "late"
				? 66001
				: kind === "backwards"
					? 10
					: kind === "invalid"
						? NaN
						: 64000,
		)
		expect(h.monitor.dropState("s").state).not.toBe("ok")
		h.throws(false)
		h.chunks(0)
		h.tick(68000)
		h.clean()
		expect(h.monitor.dropState("s").state).toBe("ok")
	},
)
it("re-baselining after unknown tick cannot earn an early clear", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.throws(true)
	h.tick(64000)
	h.throws(false)
	h.tick(66000)
	for (let at = 68000; at <= 126000; at += 2000) h.tick(at)
	expect(h.monitor.dropState("s").state).toBe("unknown")
	h.tick(128000)
	expect(h.monitor.dropState("s").state).toBe("ok")
})
it("prune deletes held drop and re-add starts unknown", () => {
	const h = setup()
	h.tick(0)
	h.bytes(1)
	h.tick()
	h.ids([])
	h.tick()
	h.ids(["s"])
	h.tick()
	expect(h.monitor.dropState("s").state).toBe("unknown")
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})
it("reentrant drop and reset during onSample cannot be acknowledged away", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.callback(() => {
		h.callback(() => {})
		h.bytes(100)
		h.monitor.sampleNow()
		h.bytes(0)
		h.monitor.sampleNow()
	})
	h.tick()
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	expect(h.monitor.droppedWithinMs("s", 0)).toBe(true)
})
it("(100, NaN) cannot be clean and requires re-baselining", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.bytes(100)
	h.chunks(NaN)
	h.tick()
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	expect(h.monitor.droppedWithinMs("s", 0)).toBe(true)
})
it("drop then two throwing display deliveries blocks at 64000 and 68000", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{ drops: h.monitor },
	)
	const p: WantedPlacement = {
		key: "p",
		decoderId: "p",
		sourceId: "s",
		reach: "raw",
		costCores: 0.1,
		sampleRateHz: 2400000,
		channelHz: null,
		origin: "band",
		primary: true,
	}
	h.bytes(1)
	h.deliveryThrows(true)
	h.tick(64000)
	expect(gate.admit(p, [], 64000).admit).toBe(false)
	expect(h.monitor.dropState("s").state).toBe("dropping")
	h.tick(68000)
	gate.forget("p")
	expect(gate.admit(p, [], 68000).admit).toBe(false)
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	h.deliveryThrows(false)
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})
it("huge wall timestamps and reordered display samples do not affect drop state", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.wall(Number.MAX_SAFE_INTEGER)
	h.tick()
	h.wall(0)
	h.tick()
	expect(h.monitor.dropState("s").state).toBe("ok")
	h.bytes(1)
	h.tick()
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})

it("sources throwing invalidates all evidence and recovers after re-baselining", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.sourcesThrow(true)
	h.tick()
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	expect(h.monitor.droppedWithinMs("s", 0)).toBe(true)
	h.sourcesThrow(false)
	h.tick()
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})
it("missing topology and stale queries fail closed without changing evidence", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.topology(null)
	h.tick()
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	h.topology("a")
	h.tick()
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
})

it("stale read and probation fail closed at 6001 ms without another tick", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	h.advance(6000)
	expect(h.monitor.dropState("s").state).toBe("ok")
	h.advance(1)
	expect(h.monitor.dropState("s")).toEqual({
		state: "unknown",
		dropBytesPerSecond: null,
	})
	expect(h.monitor.droppedWithinMs("s", 0)).toBe(true)
})
it("throwing read yields unknown for that source only", () => {
	let mono = 0
	let broken = false
	const monitor = createEfficiencyMonitor({
		sources: () => ["a", "b"],
		branchCounters: id => {
			if (broken && id === "a") throw new TypeError("read")
			return new Map([["a", { droppedBytesTotal: 0, droppedChunksTotal: 0 }]])
		},
		topology: () => "branches",
		monoNow: () => mono,
		now: () => 0,
		cpu: { normalisedPercent: null },
		setInterval: () => ({ cancel() {} }),
	})
	for (mono = 0; mono <= 62000; mono += 2000) monitor.sampleNow()
	broken = true
	monitor.sampleNow()
	expect(monitor.dropState("a").state).toBe("unknown")
	expect(monitor.dropState("b").state).toBe("ok")
})

it("a drop before a backwards clock cannot poison probation after recovery", () => {
	const h = setup()
	h.tick(1000000)
	h.bytes(1)
	h.tick(1002000)
	// Evidence time continues across the rollback, so the drop keeps its place.
	h.tick(0)
	expect(h.monitor.dropState("s").state).toBe("dropping")
	// The rollback sample is not a complete endpoint: the clean run starts one
	// sample later.
	h.clean()
	h.tick()
	h.tick()
	expect(h.monitor.dropState("s").state).toBe("ok")
	expect(h.monitor.droppedWithinMs("s", 0)).toBe(false)
})

it("offsetting branch reset and drop cannot remain clean", () => {
	const h = setup()
	h.bytes(100)
	h.chunks(100)
	h.tick(0)
	h.clean()
	expect(h.monitor.dropState("s").state).toBe("ok")
	h.bytes(0)
	h.chunks(0)
	h.other(100)
	h.tick()
	expect(h.monitor.dropState("s").state).not.toBe("ok")
	expect(h.monitor.droppedSinceMono("s", 62000)).toBe(true)
})
it.each([-7200000, 7200000])(
	"probation follows monotonic admissions across wall shift %s",
	shift => {
		const h = setup()
		h.tick(0)
		h.clean()
		const gate = createEfficiencyGate(
			{ budgetCores: 1.5, cpuGuardPercent: 90 },
			{ drops: h.monitor },
		)
		const old: WantedPlacement = {
			key: "old",
			decoderId: "old",
			sourceId: "s",
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: 2400000,
			channelHz: null,
			origin: "band",
			primary: true,
		}
		expect(gate.admit(old, [], 10000000)).toEqual({ admit: true })
		h.tick()
		const newer = { ...old, key: "new" }
		expect(gate.admit(newer, [], 10000000 + shift)).toEqual({ admit: true })
		h.bytes(1)
		h.tick()
		const running = [
			{ ...old, admittedAtMs: 10000000 },
			{ ...newer, admittedAtMs: 10000000 + shift },
		]
		expect(gate.probation(running, 10000000 + shift + 2000)).toEqual([
			{ key: "new", detail: "drops" },
		])
		// A drop during probation means it never graduates.
		h.clean()
		expect(gate.probation(running, 10000000 + shift + 4000)).toEqual([
			{ key: "new", detail: "drops" },
		])
	},
)

/** Per-branch counters on a scripted clock, feeding the real gate. */
const branchSetup = () => {
	let mono = 0
	let throws = false
	let removals = 0
	const branches = new Map([
		["raw#1", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
		["old#2", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
	])
	let tick = () => {}
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => {
			if (throws) throw new TypeError("read")
			return new Map(branches)
		},
		topology: () => String(removals),
		cpu: { normalisedPercent: 10 },
		now: () => mono,
		monoNow: () => mono,
		setInterval(fn) {
			tick = fn
			return { cancel() {} }
		},
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	monitor.start()
	const placement: WantedPlacement = {
		key: "q",
		decoderId: "q",
		sourceId: "s",
		reach: "raw",
		costCores: 0.1,
		sampleRateHz: 2_400_000,
		channelHz: null,
		origin: "band",
		primary: true,
	}
	return {
		monitor,
		gate,
		branches,
		running: [{ ...placement, admittedAtMs: 0 }],
		admit: () => gate.admit(placement, [], mono),
		throws(value: boolean) {
			throws = value
		},
		remove(key: string) {
			branches.delete(key)
			removals++
		},
		tickAt(at: number) {
			mono = at
			tick()
		},
		clockAt(at: number) {
			mono = at
		},
		earn(until = 66_000) {
			for (let at = 0; at <= until; at += 2000) this.tickAt(at)
		},
	}
}

it("a positive total on a branch added together with a removal condemns the probationer", () => {
	const f = branchSetup()
	f.earn()
	expect(f.admit()).toEqual({ admit: true })
	f.remove("old#2")
	f.branches.set("new#3", { droppedBytesTotal: 4096, droppedChunksTotal: 1 })
	f.tickAt(68_000)
	expect(f.monitor.droppedSinceMono("s", 66_000)).toBe(true)
	expect(f.monitor.dropState("s").state).not.toBe("ok")
	expect(f.gate.probation(f.running, 68_000)).toEqual([
		{ key: "q", detail: "drops" },
	])
})

it("drops counted across an unreadable read condemn the probationer", () => {
	const f = branchSetup()
	f.earn()
	expect(f.admit()).toEqual({ admit: true })
	f.throws(true)
	f.branches.set("raw#1", { droppedBytesTotal: 512, droppedChunksTotal: 1 })
	f.tickAt(68_000)
	f.throws(false)
	f.tickAt(70_000)
	expect(f.monitor.droppedSinceMono("s", 66_000)).toBe(true)
	expect(f.gate.probation(f.running, 70_000)).toEqual([
		{ key: "q", detail: "drops" },
	])
})

it("probation is not served by unreadable time: a drop after a long gap still condemns", () => {
	const f = branchSetup()
	f.earn()
	expect(f.admit()).toEqual({ admit: true })
	f.throws(true)
	for (let at = 68_000; at <= 98_000; at += 2000) f.tickAt(at)
	f.throws(false)
	for (let at = 100_000; at <= 104_000; at += 2000) f.tickAt(at)
	expect(f.gate.probation(f.running, 104_000)).toEqual([])
	expect(
		f.gate.view(f.running, [], 104_000).sources[0]?.admitted[0]?.probation,
	).toBe(true)
	f.branches.set("raw#1", { droppedBytesTotal: 1, droppedChunksTotal: 0 })
	f.tickAt(106_000)
	expect(f.monitor.droppedSinceMono("s", 66_000)).toBe(true)
	expect(f.gate.probation(f.running, 106_000)).toEqual([
		{ key: "q", detail: "drops" },
	])
	// Graduation needs 30 s of covered evidence since admission.
	const g = branchSetup()
	g.earn()
	g.admit()
	for (let at = 68_000; at <= 94_000; at += 2000) g.tickAt(at)
	expect(
		g.gate.view(g.running, [], 94_000).sources[0]?.admitted[0]?.probation,
	).toBe(true)
	g.tickAt(96_000)
	expect(
		g.gate.view(g.running, [], 96_000).sources[0]?.admitted[0]?.probation,
	).toBe(false)
})

const probationOf = (f: ReturnType<typeof branchSetup>, at: number) =>
	f.gate.view(f.running, [], at).sources[0]?.admitted[0]?.probation

it("alternating incomplete reads earn no probation coverage (62 s to 122 s)", () => {
	const f = branchSetup()
	f.earn(62_000)
	expect(f.admit()).toEqual({ admit: true })
	for (let at = 64_000; at <= 122_000; at += 2000) {
		f.branches.set("raw#1", {
			droppedBytesTotal: (at / 2000) % 2 === 0 ? NaN : 0,
			droppedChunksTotal: 0,
		})
		f.tickAt(at)
	}
	expect(f.monitor.coveredSinceMono("s", 62_000)).toBe(0)
	expect(f.gate.probation(f.running, 122_000)).toEqual([])
	expect(probationOf(f, 122_000)).toBe(true)
})

it("a drop on the sample that completes coverage condemns instead of graduating", () => {
	const f = branchSetup()
	f.earn(62_000)
	expect(f.admit()).toEqual({ admit: true })
	for (let at = 64_000; at <= 90_000; at += 2000) f.tickAt(at)
	expect(f.gate.probation(f.running, 90_000)).toEqual([])
	f.branches.set("raw#1", { droppedBytesTotal: 4096, droppedChunksTotal: 1 })
	f.tickAt(92_000)
	expect(f.monitor.coveredSinceMono("s", 62_000)).toBe(30_000)
	expect(f.gate.probation(f.running, 92_000)).toEqual([
		{ key: "q", detail: "drops" },
	])
	expect(probationOf(f, 92_000)).toBe(true)
})

it("a clock rollback restarts probation coverage instead of counting it twice", () => {
	const f = branchSetup()
	f.earn(62_000)
	expect(f.admit()).toEqual({ admit: true })
	for (let at = 64_000; at <= 80_000; at += 2000) f.tickAt(at)
	expect(f.monitor.coveredSinceMono("s", 62_000)).toBe(18_000)
	for (let at = 62_000; at <= 74_000; at += 2000) f.tickAt(at)
	// Raw 62 s reads as evidence time 80 s (a discontinuity); credit resumes
	// between the complete reads that follow it.
	expect(f.monitor.coveredSinceMono("s", 62_000)).toBe(10_000)
	expect(probationOf(f, 74_000)).toBe(true)
	// Drops seen before the rollback still condemn the current probationer.
	const g = branchSetup()
	g.earn(62_000)
	g.admit()
	g.branches.set("raw#1", { droppedBytesTotal: 1, droppedChunksTotal: 0 })
	g.tickAt(64_000)
	for (let at = 50_000; at <= 54_000; at += 2000) g.tickAt(at)
	expect(g.gate.probation(g.running, 54_000)).toEqual([
		{ key: "q", detail: "drops" },
	])
})

it("CPU over the limit on the sample that completes coverage condemns", () => {
	const f = branchSetup()
	f.earn(62_000)
	expect(f.admit()).toEqual({ admit: true })
	for (let at = 64_000; at <= 92_000; at += 2000) f.tickAt(at)
	expect(f.monitor.coverageCompleteAtMono("s", 62_000, 30_000)).toBe(92_000)
	// The sample's CPU reading is delivered just after the clock moved on.
	f.clockAt(92_000.1)
	f.gate.record({ atMs: 92_000, cpuPercent: 99, sources: new Map() })
	expect(f.gate.probation(f.running, 92_000)).toEqual([
		{ key: "q", detail: "cpu" },
	])
})

it("a clock rollback closes admission until a fresh clean window", () => {
	const f = branchSetup()
	f.earn(62_000)
	expect(f.monitor.dropState("s").state).toBe("ok")
	f.clockAt(1000)
	expect(f.admit()).toMatchObject({ admit: false, detail: "unknown" })
})

// One positive sample must age out; unchanged cumulative totals are not new loss.
it("ages positive drops out and admits after clean hysteresis without cached rejection", () => {
	const h = setup()
	h.tick(0)
	h.clean()
	const gate = createEfficiencyGate(
		{ budgetCores: 3, cpuGuardPercent: 90 },
		{ drops: h.monitor },
	)
	const placement: WantedPlacement = {
		key: "candidate",
		decoderId: "candidate",
		sourceId: "s",
		reach: "channel",
		costCores: 0.1,
		sampleRateHz: 2400000,
		channelHz: 100,
		origin: "band",
		primary: false,
	}
	h.bytes(100)
	h.tick(64000)
	expect(gate.admit(placement, [], 64000)).toMatchObject({
		admit: false,
		detail: "drops",
	})
	for (let at = 66000; at <= 72000; at += 2000) h.tick(at)
	h.advance(1999)
	expect(h.monitor.dropState("s")).toEqual({
		state: "dropping",
		dropBytesPerSecond: 0,
	})
	h.tick(74000)
	expect(h.monitor.dropState("s").state).toBe("clearing")
	h.advance(1)
	expect(h.monitor.dropState("s").state).toBe("clearing")
	for (let at = 76000; at <= 124000; at += 2000) h.tick(at)
	expect(gate.admit(placement, [], 124000).admit).toBe(false)
	h.tick(126000)
	expect(h.monitor.dropState("s").state).toBe("ok")
	expect(gate.admit(placement, [], 126000).admit).toBe(true)
	h.advance(1)
	expect(h.monitor.dropState("s").state).toBe("ok")
	h.bytes(101)
	h.tick(128000)
	expect(h.monitor.dropState("s").state).toBe("dropping")
})

it("requires sampled coverage at the clean deadline despite an off-sample read", () => {
	const h = setup()
	try {
		h.tick(0)
		for (let at = 2000; at <= 60000; at += 2000) h.tick(at)
		expect(h.monitor.cleanAtMono("s")).toBe(62000)
		h.advance(2000)
		expect(h.monitor.dropState("s").state).not.toBe("ok")
		expect(h.monitor.droppedWithinMs("s", 0)).toBe(true)
		h.tick(62000)
		for (const offset of [0, 1, 999, 999]) {
			h.advance(offset)
			expect(h.monitor.dropState("s").state).toBe("ok")
			expect(h.monitor.droppedWithinMs("s", 0)).toBe(false)
		}
	} finally {
		h.monitor.stop()
	}
})
