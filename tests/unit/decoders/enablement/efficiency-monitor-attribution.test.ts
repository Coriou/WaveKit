import { expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"

const setupAttribution = (
	overrides: Partial<Parameters<typeof createEfficiencyMonitor>[0]> = {},
) => {
	let mono = 0
	let gap = 200
	let loop = 0
	let shortfall: boolean | null = false
	let upstream: number | null = 0
	let broken = false
	const branches = new Map<
		string,
		{ droppedBytesTotal: number; droppedChunksTotal: number; active?: boolean }
	>([
		["a", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
		["b", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
	])
	const info = vi.fn()
	const ingest = vi.fn(() =>
		broken ? null : { maxGapMs: gap, catchupBytes: 0, chunks: 1 },
	)
	const loopDelay = vi.fn(() => ({ maxMs: loop, p99Ms: 0 }))
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => branches,
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => 0,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
		ingest,
		loopDelay,
		shortfall: () => shortfall,
		upstreamDroppedTotal: () => upstream,
		log: { info } as unknown as Logger,
		...overrides,
	})
	return {
		monitor,
		branches,
		info,
		ingest,
		loopDelay,
		tick(at: number) {
			mono = at
			return monitor.sampleNow()
		},
		clock(at: number) {
			mono = at
		},
		evidence(g: number, l = 0, s: boolean | null = false) {
			gap = g
			loop = l
			shortfall = s
		},
		upstream(n: number | null) {
			upstream = n
		},
		broken(value: boolean) {
			broken = value
		},
		drop(all = true) {
			for (const [key, value] of branches) {
				if (all || key === "a") {
					value.droppedBytesTotal++
					value.droppedChunksTotal++
				}
			}
		},
	}
}

it("inactive branch does not make a burst a strict subset", () => {
	const h = setupAttribution()
	h.branches.set("inactive", {
		droppedBytesTotal: 0,
		droppedChunksTotal: 0,
		active: false,
	})
	h.tick(0)
	h.tick(2000)
	h.branches.delete("inactive")
	h.drop()
	h.branches.set("inactive", {
		droppedBytesTotal: 0,
		droppedChunksTotal: 0,
		active: false,
	})
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("link")
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(false)
	expect(h.monitor.linkDropsSince("s", 4000)).toBe(true)
	expect(h.monitor.coveredSinceMono("s", 2000)).toBe(0)
})

it("upstream decrease yields unknown not link", () => {
	const h = setupAttribution()
	h.upstream(10)
	h.tick(0)
	h.tick(2000)
	h.upstream(0)
	h.drop()
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
	expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
})

it("discontinuity discards the ingest window", () => {
	const h = setupAttribution()
	h.tick(10000)
	h.tick(12000)
	h.drop()
	expect(h.tick(0).sources.get("s")?.attribution).toBe("unknown")
	h.drop()
	expect(h.tick(2000).sources.get("s")?.attribution).not.toBe("link")
	expect(h.monitor.lateWindows("s")).toEqual([])
})

it("link drops preserve clean time and break both adjacent coverage intervals", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	const clean = h.monitor.cleanAtMono("s")
	h.drop()
	h.tick(4000)
	expect(h.monitor.cleanAtMono("s")).toBe(clean)
	h.tick(6000)
	expect(h.monitor.coveredSinceMono("s", 2000)).toBe(0)
	h.tick(8000)
	expect(h.monitor.coveredSinceMono("s", 2000)).toBe(2000)
})

it.each(["link", "unknown", "consumer", "host"] as const)(
	"late windows classify %s drops",
	code => {
		const h = setupAttribution()
		if (code === "unknown") h.evidence(0)
		if (code === "host") h.evidence(0, 50)
		h.tick(0)
		for (let at = 2000; at <= 20000; at += 2000) {
			h.drop(code !== "consumer")
			h.tick(at)
		}
		expect(h.monitor.lateWindows("s")).toEqual([
			{
				startMono: 10000,
				endMono: 20000,
				condemning: code === "consumer" || code === "host",
				linkOrUnknownDrops: code === "link" || code === "unknown",
			},
		])
	},
)

it("attribution log is rate-limited at one minute and one past", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	for (let at = 4000; at <= 62000; at += 2000) {
		h.drop()
		h.tick(at)
	}
	const intervals = () =>
		h.info.mock.calls.filter(call => call[1] === "Drop interval attributed")
	expect(intervals()).toHaveLength(1)
	h.drop()
	h.tick(63999)
	expect(intervals()).toHaveLength(1)
	h.drop()
	h.tick(64000)
	expect(intervals()).toHaveLength(2)
	h.drop()
	h.tick(64001)
	expect(intervals()).toHaveLength(2)
	expect(
		h.info.mock.calls.filter(call => call[1] === "Drop attribution changed"),
	).toHaveLength(2)
})

it("malformed and missing supplied evidence cannot excuse drops or earn clean coverage", () => {
	for (const gap of [NaN, Infinity, -1]) {
		const h = setupAttribution()
		h.tick(0)
		h.tick(2000)
		h.evidence(gap)
		h.drop()
		expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
		expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
	}
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	h.broken(true)
	h.tick(4000)
	expect(h.monitor.coveredSinceMono("s", 2000)).toBe(0)
	expect(h.monitor.cleanAtMono("s")).toBeNull()
})

it.each([10000, 10001])("a timely sample closes the late window at %s", end => {
	const h = setupAttribution()
	for (let at = 0; at <= 18000; at += 2000) h.tick(at)
	h.drop(false)
	h.tick(10000 + end)
	expect(h.monitor.lateWindows("s").at(-1)).toMatchObject({
		startMono: 10000,
		endMono: 20000,
		condemning: true,
	})
})

it("late windows retain three complete windows, and discard incomplete windows", () => {
	const h = setupAttribution()
	for (let at = 0; at <= 40000; at += 2000) h.tick(at)
	expect(h.monitor.lateWindows("s").map(w => w.startMono)).toEqual([
		10000, 20000, 30000,
	])
	for (let at = 42000; at <= 50000; at += 2000) h.tick(at)
	expect(h.monitor.lateWindows("s").map(w => w.startMono)).toEqual([
		20000, 30000, 40000,
	])
	h.broken(true)
	h.tick(52000)
	h.broken(false)
	for (let at = 54000; at <= 60000; at += 2000) h.tick(at)
	expect(h.monitor.lateWindows("s").map(w => w.startMono)).toEqual([
		30000, 40000,
	])
	const copy = h.monitor.lateWindows("s")
	if (copy[0]) copy[0].condemning = true
	expect(h.monitor.lateWindows("s")[0]?.condemning).toBe(false)
})

it("link history supports inclusive lookbacks at 32 and 33 samples", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	for (let n = 0; n < 32; n++) {
		h.drop()
		h.tick(4000 + n * 2000)
	}
	expect(h.monitor.linkDropsSince("s", 4000)).toBe(true)
	h.drop()
	h.tick(68000)
	const historyLookup = vi.spyOn(Array.prototype, "some")
	try {
		expect(h.monitor.linkDropsSince("s", 0)).toBe(true)
		expect(historyLookup.mock.contexts.at(-1)).toHaveLength(32)
		expect(historyLookup.mock.contexts.at(-1)).not.toContain(4000)
	} finally {
		historyLookup.mockRestore()
	}
	expect(h.monitor.linkDropsSince("s", 68000)).toBe(true)
	expect(h.monitor.linkDropsSince("s", 68001)).toBe(false)
	expect(h.monitor.linkDropsSince("s", NaN)).toBe(false)
})

it("attribution counts retain 300 entries and age out at ten minutes plus one", () => {
	const h = setupAttribution()
	for (let n = 0; n < 300; n++) h.tick(n * 2000)
	const count = () =>
		Object.values(h.monitor.attributionCounts("s")?.counts10m ?? {}).reduce(
			(a, b) => a + b,
			0,
		)
	expect(count()).toBe(300)
	h.tick(600000)
	expect(count()).toBe(300)
	h.clock(1200000)
	expect(count()).toBe(1)
	h.clock(1200001)
	expect(count()).toBe(0)
})

it("latest attribution expires on the pull clock at stale bound plus one", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	h.tick(4000)
	h.clock(10000)
	expect(h.monitor.latestAttribution("s")).toBe("none")
	h.clock(10001)
	expect(h.monitor.latestAttribution("s")).toBeNull()
})

it("ingest reads use raw samples spanning this and the previous interval", () => {
	const h = setupAttribution()
	h.tick(10000)
	h.tick(12000)
	h.tick(14000)
	expect(h.ingest).toHaveBeenLastCalledWith("s", 10000, 14000)
	h.tick(16000)
	expect(h.ingest).toHaveBeenLastCalledWith("s", 12000, 16000)
	h.clock(NaN)
	h.monitor.latestAttribution("s")
	h.tick(18000)
	h.drop()
	expect(h.tick(20000).sources.get("s")?.attribution).toBe("unknown")
})

it.each(["ingest", "loopDelay", "shortfall", "upstreamDroppedTotal"] as const)(
	"throwing %s never excuses drops or credits coverage",
	key => {
		const h = setupAttribution({
			[key]: () => {
				throw new TypeError("untrusted")
			},
		})
		h.tick(0)
		h.tick(2000)
		h.drop()
		expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
		expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
		expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
		expect(h.monitor.cleanAtMono("s")).toBeNull()
	},
)

it.each([NaN, Infinity, -1])(
	"malformed evidence %s is never converted to a missing field",
	invalid => {
		const overrides: Partial<Parameters<typeof createEfficiencyMonitor>[0]>[] =
			[
				{ loopDelay: () => ({ maxMs: invalid, p99Ms: 0 }) },
				{ loopDelay: () => ({ maxMs: 0, p99Ms: invalid }) },
				{ cpu: { normalisedPercent: invalid } },
				{ cpuGuardPercent: invalid },
				{ upstreamDroppedTotal: () => invalid },
				{ ingest: () => ({ maxGapMs: 100, catchupBytes: invalid, chunks: 1 }) },
			]
		for (const override of overrides) {
			const h = setupAttribution(override)
			h.tick(0)
			h.tick(2000)
			h.drop()
			expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
			expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
			expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
		}
	},
)

it("malformed counters and active flags fail closed without throwing", () => {
	for (const value of [
		null,
		{},
		{ droppedBytesTotal: 0, droppedChunksTotal: 0, active: "false" },
	]) {
		const h = setupAttribution({
			branchCounters: () =>
				new Map([["a", value]]) as unknown as ReturnType<
					Parameters<typeof createEfficiencyMonitor>[0]["branchCounters"]
				>,
		})
		h.tick(0)
		h.tick(2000)
		expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
		expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
	}
})

it("CPU and resetting loop evidence are read once before multiple sources", () => {
	let reads = 0
	const loopDelay = vi.fn(() => ({ maxMs: 0, p99Ms: 0 }))
	const h = setupAttribution({
		sources: () => ["s", "t"],
		loopDelay,
		cpu: {
			get normalisedPercent() {
				reads++
				return 10
			},
		},
	})
	h.tick(0)
	h.tick(2000)
	h.tick(4000)
	expect(reads).toBe(3)
	expect(loopDelay).toHaveBeenCalledTimes(3)
})

it("stale windows are withheld at the stale bound plus one", () => {
	const h = setupAttribution()
	for (let at = 0; at <= 20000; at += 2000) h.tick(at)
	h.clock(26000)
	expect(h.monitor.lateWindows("s")).toHaveLength(1)
	h.clock(26001)
	expect(h.monitor.lateWindows("s")).toEqual([])
})

it("logging failures do not change link evidence", () => {
	const h = setupAttribution({
		log: {
			info() {
				throw new TypeError("log")
			},
		} as unknown as Logger,
	})
	h.tick(0)
	h.tick(2000)
	h.drop()
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("link")
	expect(h.monitor.linkDropsSince("s", 4000)).toBe(true)
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(false)
})

it.each([3000, 3001])(
	"attribution requires a complete interval within %s ms",
	gap => {
		const h = setupAttribution()
		h.tick(0)
		h.tick(2000)
		h.tick(4000)
		h.drop()
		expect(h.tick(4000 + gap).sources.get("s")?.attribution).toBe(
			gap === 3000 ? "link" : "unknown",
		)
	},
)

it("changing activity or reporting loss on an inactive branch is incomplete", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	const branch = h.branches.get("b")
	if (branch) branch.active = false
	h.drop(false)
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
	if (branch) branch.droppedBytesTotal++
	h.drop(false)
	expect(h.tick(6000).sources.get("s")?.attribution).toBe("unknown")
})

it("configured upstream disappearance is unknown and requires consecutive totals again", () => {
	const h = setupAttribution()
	h.tick(0)
	h.tick(2000)
	h.upstream(null)
	h.drop()
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
	expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
	h.upstream(0)
	h.drop()
	expect(h.tick(6000).sources.get("s")?.attribution).toBe("unknown")
	h.drop()
	expect(h.tick(8000).sources.get("s")?.attribution).toBe("link")
})

it("missing attribution inputs and null CPU never earn clean coverage", () => {
	for (const override of [
		{ ingest: undefined },
		{ loopDelay: undefined },
		{ shortfall: undefined },
		{ cpu: { normalisedPercent: null } },
	]) {
		const h = setupAttribution(
			override as Partial<Parameters<typeof createEfficiencyMonitor>[0]>,
		)
		for (let at = 0; at <= 20000; at += 2000) h.tick(at)
		expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
		expect(h.monitor.cleanAtMono("s")).toBeNull()
		expect(h.monitor.lateWindows("s")).toEqual([])
		h.drop()
		expect(h.tick(22000).sources.get("s")?.attribution).toBe("unknown")
	}
})

it("a supplied null CPU guard is malformed, not the default", () => {
	const h = setupAttribution({
		cpuGuardPercent: null as unknown as number,
	})
	h.tick(0)
	h.tick(2000)
	h.drop()
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
	expect(h.monitor.droppedSinceMono("s", 4000)).toBe(true)
	expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
	expect(h.monitor.lateWindows("s")).toEqual([])
})

it.each([
	"ingest",
	"loopDelay",
	"shortfall",
	"upstreamDroppedTotal",
	"cpu",
	"cpuGuardPercent",
	"topology",
	"monoNow",
] as const)("a supplied null %s invalidates evidence", key => {
	const h = setupAttribution({
		[key]: null,
	} as unknown as Partial<Parameters<typeof createEfficiencyMonitor>[0]>)
	h.tick(0)
	h.tick(2000)
	h.drop()
	expect(h.tick(4000).sources.get("s")?.attribution).toBe("unknown")
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(true)
	for (let at = 6000; at <= 20000; at += 2000) h.tick(at)
	expect(h.monitor.coveredSinceMono("s", 0)).toBe(0)
	expect(h.monitor.linkDropsSince("s", 0)).toBe(false)
	expect(h.monitor.lateWindows("s")).toEqual([])
})

it("an absent upstream counter permits network coverage and link attribution", () => {
	const h = setupAttribution({ upstreamDroppedTotal: () => undefined })
	h.tick(0)
	h.tick(2000)
	h.tick(4000)
	expect(h.monitor.cleanAtMono("s")).not.toBeNull()
	h.drop()
	expect(h.tick(6000).sources.get("s")?.attribution).toBe("link")
})

it("local dongles and loopback sources retain counter-only coverage", () => {
	const h = setupAttribution({
		attributionApplies: () => false,
		upstreamDroppedTotal: () => null,
		shortfall: () => null,
		ingest: () => null,
	})
	for (let at = 0; at <= 10000; at += 2000) h.tick(at)
	expect(h.monitor.cleanAtMono("s")).not.toBeNull()
	expect(h.monitor.coveredSinceMono("s", 2000)).toBe(8000)
	h.drop()
	h.tick(12000)
	expect(h.monitor.droppedSinceMono("s", 12000)).toBe(true)
})

it("holds a gap loss without credit or condemnation until byte recovery", () => {
	let shortfall: boolean | null = null
	const h = setupAttribution({
		recovery: () => ({
			sequence: 1,
			completedSequence: 0,
			failedSequence: 0,
			maxGapMs: 5042,
			shortfall,
		}),
	})
	h.tick(0)
	h.tick(2000)
	h.tick(4000)
	const clean = h.monitor.cleanAtMono("s")
	const covered = h.monitor.coveredSinceMono("s", 0)
	h.evidence(5042, 16, true)
	h.drop()
	h.tick(6000)
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(false)
	expect(h.monitor.coveredSinceMono("s", 0)).toBe(covered)
	expect(h.monitor.dropState("s").state).toBe("unknown")
	shortfall = false
	expect(h.tick(8000).sources.get("s")?.attribution).toBe("link")
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(false)
	expect(h.monitor.cleanAtMono("s")).toBe(clean)
})

it("a sustained shortfall resolves a held loss without link credit", () => {
	let shortfall: boolean | null = null
	const h = setupAttribution({
		recovery: () => ({
			sequence: 1,
			completedSequence: 0,
			failedSequence: 0,
			maxGapMs: 5042,
			shortfall,
		}),
	})
	h.tick(0)
	h.tick(2000)
	h.evidence(5042, 16, true)
	h.drop()
	h.tick(4000)
	shortfall = true
	expect(h.tick(6000).sources.get("s")?.attribution).toBe("unknown")
	expect(h.monitor.droppedSinceMono("s", 0)).toBe(true)
})

it("a consumer drop during pending recovery is condemned immediately", () => {
	let shortfall: boolean | null = null
	const h = setupAttribution({
		recovery: () => ({
			sequence: 1,
			completedSequence: 0,
			failedSequence: 0,
			maxGapMs: 5042,
			shortfall,
		}),
	})
	h.tick(0)
	h.tick(2000)
	h.evidence(5042, 16, true)
	h.drop()
	h.tick(4000)
	h.drop(false)
	expect(h.tick(6000).sources.get("s")?.attribution).toBe("consumer")
	expect(h.monitor.droppedSinceMono("s", 6000)).toBe(true)
	expect(h.monitor.cleanAtMono("s")).toBeNull()
	shortfall = false
	h.tick(8000)
	expect(h.monitor.droppedSinceMono("s", 6000)).toBe(true)
})

it.each([false, true])(
	"pending loop history stays local to its source, reverse=%s",
	reverse => {
		let mono = 0
		let loop = 0
		let total = 0
		const h = setupAttribution({
			sources: () => (reverse ? ["b", "a"] : ["a", "b"]),
			monoNow: () => mono,
			branchCounters: () =>
				new Map([
					[
						"@absorber",
						{ droppedBytesTotal: total, droppedChunksTotal: total },
					],
				]),
			loopDelay: () => ({ maxMs: loop, p99Ms: loop }),
			ingest: id => ({
				maxGapMs: id === "a" ? 5042 : 240,
				catchupBytes: 0,
				chunks: 1,
			}),
			recovery: id => ({
				sequence: 1,
				completedSequence: 0,
				failedSequence: 0,
				maxGapMs: id === "a" ? 5042 : 240,
				shortfall: id === "a" ? null : false,
			}),
		})
		for (mono = 0; mono <= 4000; mono += 2000) h.monitor.sampleNow()
		mono = 6000
		loop = 40
		total++
		h.monitor.sampleNow()
		mono = 8000
		loop = 16
		total++
		expect(h.monitor.sampleNow().sources.get("b")?.attribution).toBe("link")
	},
)

it("incomplete windows cannot preserve old late evidence beyond three window periods", () => {
	const h = setupAttribution()
	for (let at = 0; at <= 20000; at += 2000) h.tick(at)
	h.broken(true)
	for (let at = 22000; at <= 48000; at += 2000) h.tick(at)
	expect(h.monitor.lateWindows("s").map(w => w.endMono)).toEqual([20000])
	// end 20000 + 3 × 10000 = 50000: excluded at the bound and past it.
	for (const at of [50000, 52000]) {
		h.tick(at)
		expect(h.monitor.lateWindows("s")).toEqual([])
	}
})
