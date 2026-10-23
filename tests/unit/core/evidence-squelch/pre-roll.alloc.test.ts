import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	EvidencePcmFormat,
	PreRollTag,
} from "../../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"

type Step =
	| { kind: "process"; chunk: Buffer; tag: PreRollTag }
	| { kind: "latch" | "abandon" }

/** Deterministic schedule: 10 000 chunks of 1..2 048 bytes covering every tag, latch, abandon. */
function buildSchedule(): Step[] {
	const steps: Step[] = []
	let seed = 12_345
	const rand = (): number => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
		return seed / 2_147_483_648
	}
	const cycle: (PreRollTag | "latch" | "abandon")[] = [
		"drop",
		"pending",
		"latch",
		"pass",
		"guard",
		"drop",
		"pending",
		"abandon",
		"drop",
		"pass",
	]
	let chunks = 0
	let c = 0
	while (chunks < 10_000) {
		const what = cycle[c++ % cycle.length] ?? "drop"
		if (what === "latch" || what === "abandon") {
			steps.push({ kind: what })
			continue
		}
		// Long enough phases to fill and overflow the FIFO, with odd sizes splitting samples.
		const count = 20 + Math.floor(rand() * 80)
		for (let i = 0; i < count && chunks < 10_000; i++, chunks++) {
			const chunk = Buffer.alloc(1 + Math.floor(rand() * 2_048), 0x5a)
			steps.push({ kind: "process", chunk, tag: what })
		}
	}
	return steps
}

function runAll(pre: PreRoll, steps: readonly Step[]): void {
	for (const step of steps) {
		if (step.kind === "process")
			pre.process(step.chunk, 0, step.chunk.length, step.tag)
		else if (step.kind === "latch") pre.latch()
		else pre.abandon()
	}
}

const CONSTRUCTORS = [
	"Int32Array",
	"Uint8Array",
	"Float32Array",
	"Float64Array",
] as const

describe("PreRoll allocation", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	for (const format of ["s16le", "f32le"] as EvidencePcmFormat[]) {
		it(`no allocation after construction (${format})`, () => {
			const pre = new PreRoll({ rate: 25_000, format })
			const steps = buildSchedule()
			const spies = [
				vi.spyOn(Buffer, "alloc"),
				vi.spyOn(Buffer, "allocUnsafe"),
				vi.spyOn(Buffer, "from"),
				vi.spyOn(Buffer, "concat"),
				vi.spyOn(Buffer.prototype, "subarray"),
				vi.spyOn(Buffer.prototype, "slice"),
			]
			let constructed = 0
			for (const name of CONSTRUCTORS) {
				const Original = globalThis[name]
				vi.stubGlobal(
					name,
					new Proxy(Original, {
						construct(target, args, newTarget) {
							constructed++
							return Reflect.construct(target, args, newTarget) as object
						},
					}),
				)
			}
			runAll(pre, steps)
			const calls = spies.map(s => s.mock.calls.length)
			const constructedByRun = constructed
			// Control: the instrumentation sees an allocation of each kind.
			Buffer.alloc(1).subarray(0, 1)
			void new globalThis.Int32Array(1)
			const controlAlloc = spies[0]?.mock.calls.length ?? 0
			const controlSubarray = spies[4]?.mock.calls.length ?? 0
			vi.unstubAllGlobals()
			expect(calls).toEqual([0, 0, 0, 0, 0, 0])
			expect(constructedByRun).toBe(0)
			expect(controlAlloc).toBe(1)
			expect(controlSubarray).toBe(1)
			expect(constructed).toBeGreaterThan(0)
			expect(pre.delaySamples).toBeLessThanOrEqual(pre.capacitySamples)
		})
	}
})
