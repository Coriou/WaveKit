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
	expect(h.monitor.sampleNow()).toMatchObject({ cpuPercent: null })
	h.bytes(100)
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
	h.tick(0)
	expect(h.monitor.dropState("s").state).toBe("unknown")
	h.clean()
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
		h.clean()
		expect(gate.probation(running, 10000000 + shift + 4000)).toEqual([])
	},
)
