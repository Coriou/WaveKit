/**
 * Every session the wideband analog recorder starts (started or shadow) ends with exactly one
 * terminal decision (finalized, evicted, refused:* or discarded:*), its store failures included:
 * a finishing file whose last push fails, a readiness rejected after the file finished, an
 * admission that throws for a file admitted only at its finish or at a parked shadow's close.
 * Synthetic signals only.
 */
import { describe, expect, it } from "vitest"
import type { ScannerRecorderDecision } from "@wavekit/api-types"
import type {
	WidebandCloseInfo,
	WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type {
	AnalogError,
	AnalogHandle,
	AnalogInput,
} from "../../../../src/core/scanner/store/analog-operations.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>
type Begin = (input: AnalogInput) => AnalogHandle

const terminal = (code: ScannerRecorderDecision): boolean =>
	code === "finalized" ||
	code === "evicted" ||
	code.startsWith("refused:") ||
	code.startsWith("discarded:")

const codesOf = (h: Harness, id: string): ScannerRecorderDecision[] =>
	h.rec
		.diagnostics()
		.recent.filter(e => e.observationId === id)
		.map(e => e.code)

/**
 * Each started or shadow opens a session and exactly one terminal decision closes it before the
 * next one opens; a refusal with no open session is a snapshot refusal (no session started).
 * Single-file sessions: one terminal each.
 */
function expectOneTerminalPerSession(
	codes: readonly ScannerRecorderDecision[],
) {
	let open = false
	let sessions = 0
	for (const code of codes) {
		if (code === "started" || code === "shadow") {
			expect(open, `${codes.join(" ")}: a session opened twice`).toBe(false)
			open = true
			sessions++
		} else if (terminal(code)) {
			if (!open && code.startsWith("refused:")) continue
			expect(open, `${codes.join(" ")}: a terminal without a session`).toBe(
				true,
			)
			open = false
		}
	}
	expect(open, `${codes.join(" ")}: a session without a terminal`).toBe(false)
	expect(sessions).toBeGreaterThan(0)
}

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}
const CLASSED: WidebandCloseInfo = { analogFm: true, discoveryId: "d_1" }

/** beginAnalog always throws (a synchronous store failure). */
const throwing = (): Begin => () => {
	throw new Error("store unavailable")
}

/** Pushes made while `held()` stay pending until `rejectAll` rejects them. */
function holdPushes(held: () => boolean) {
	const rejects: ((e: Error) => void)[] = []
	const wrap =
		(begin: Begin): Begin =>
		input => {
			const h = begin(input)
			return {
				...h,
				push: pcm =>
					held()
						? new Promise<void>((_, reject) => rejects.push(reject))
						: h.push(pcm),
			}
		}
	const rejectAll = () => {
		for (const r of rejects.splice(0)) r(new Error("write-failed"))
	}
	return { wrap, rejectAll, count: () => rejects.length }
}

interface Scenario {
	name: string
	last: ScannerRecorderDecision
	run(): Promise<{ h: Harness; id: string }>
}

const scenarios: Scenario[] = [
	{
		name: "a voice written whole",
		last: "finalized",
		async run() {
			const h = harness()
			await h.feed(0.5, false)
			await transmission(h, "o", 2)
			await h.feed(3.5, false)
			return { h, id: "o" }
		},
	},
	{
		name: "a classed carrier never voiced",
		last: "discarded:unvoiced",
		async run() {
			const h = harness({
				fs: LOW_FS,
				offset: LOW_OFFSET,
				source: { voice: false },
			})
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(10, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge(), LOW))),
			)
			return { h, id: "o" }
		},
	},
	{
		name: "a recording closed encrypted",
		last: "refused:encrypted",
		async run() {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(2, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
			)
			h.rec.closed("o", snapshot("o", onset, h.engine.liveEdge()), null, {
				...CLASSED,
				encrypted: true,
			})
			await h.feed(1, false)
			return { h, id: "o" }
		},
	},
	{
		name: "every push of the current file fails",
		last: "discarded:write-failed",
		async run() {
			const h = harness({
				beginWrap: begin => input => {
					const op = begin(input)
					return {
						...op,
						push: () => Promise.reject(new Error("write-failed")),
					}
				},
			})
			await h.feed(0.5, false)
			await transmission(h, "o", 2)
			await h.feed(3.5, false)
			return { h, id: "o" }
		},
	},
	{
		name: "the final push of a finishing file fails",
		last: "discarded:write-failed",
		async run() {
			let hold = false
			const pushes = holdPushes(() => hold)
			const h = harness({ beginWrap: pushes.wrap })
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(2, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
			)
			hold = true
			h.rec.closed("o", snapshot("o", onset, h.engine.liveEdge()), null)
			// Hang (2 s) and holdback (1 s): the file finishes while its push is pending.
			await h.feed(3.5, false)
			expect(pushes.count()).toBeGreaterThan(0)
			expect(h.rec.diagnostics().sessions).toEqual([])
			pushes.rejectAll()
			return { h, id: "o" }
		},
	},
	{
		name: "the store's readiness is rejected after the file finished",
		last: "refused:store",
		async run() {
			let reject!: (e: Error) => void
			const readyHold = new Promise<void>((_, r) => {
				reject = r
			})
			readyHold.catch(() => undefined)
			const h = harness({ readyHold })
			await h.feed(0.5, false)
			await transmission(h, "o", 2)
			await h.feed(3.5, false)
			expect(h.ops).toHaveLength(1)
			expect(h.rec.diagnostics().sessions).toEqual([])
			reject(new Error("disk-low"))
			return { h, id: "o" }
		},
	},
	{
		name: "the store throws admitting a short voice judged only at its finish",
		last: "refused:store",
		async run() {
			const h = harness({ beginWrap: throwing })
			// As in the short-over test: 600 ms, voiced only on the whole of it (no 500 ms window).
			await h.feed(0.9, false)
			await transmission(h, "o", 0.6)
			await h.feed(3.5, false)
			return { h, id: "o" }
		},
	},
	{
		name: "the store throws admitting a parked shadow promoted at its close",
		last: "refused:store",
		async run() {
			const h = harness({ beginWrap: throwing })
			await h.feed(1, false)
			const onset = h.engine.liveEdge()
			await h.feed(3, true, () =>
				h.rec.track(
					input("o", snapshot("o", onset, h.engine.liveEdge()), SHADOW),
				),
			)
			const end = h.engine.liveEdge()
			h.engine.epoch = {
				...h.engine.epoch,
				epoch: h.engine.epoch.epoch + 1,
				startSample: end,
			}
			await h.feed(0.3, false)
			expect(h.rec.owns("o")).toBe(true)
			h.rec.closed("o", snapshot("o", onset, end), "epoch-changed", CLASSED)
			await h.feed(0.5, false)
			return { h, id: "o" }
		},
	},
	{
		name: "the store refuses admission (retried once, then refused)",
		last: "refused:store",
		async run() {
			const h = harness({ refuse: true })
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(6, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
			)
			expect(h.ops).toHaveLength(2)
			return { h, id: "o" }
		},
	},
]

describe("WidebandAnalogRecorder terminal decisions", () => {
	// Invariant: every session that reached started or shadow ends with exactly one terminal
	// decision (finalized | discarded:* | refused:* | evicted), whatever path ends it.
	for (const sc of scenarios)
		it(`${sc.name}: one terminal decision per session, the last ${sc.last}`, async () => {
			const { h, id } = await sc.run()
			await h.rec.idle()
			const codes = codesOf(h, id)
			expect(codes.at(-1)).toBe(sc.last)
			expectOneTerminalPerSession(codes)
			// Nothing was kept where the decision says nothing was written.
			if (sc.last !== "finalized")
				expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
		}, 60_000)

	it("a short voice the store failed to admit is not called no-discovery", async () => {
		const h = harness({ beginWrap: throwing })
		await h.feed(0.9, false)
		await transmission(h, "o", 0.6)
		await h.feed(3.5, false)
		await h.rec.idle()
		const codes = codesOf(h, "o")
		expect(codes).toContain("voiced")
		expect(codes).not.toContain("discarded:no-discovery")
		expect(h.rec.discoveryDecisions("d_1")?.last.code).toBe("refused:store")
	}, 60_000)
})

it.each([
	{ outcome: "failed", errorCode: "write-failed", expected: "write-failed" },
	{ outcome: "aborted", errorCode: null, expected: null },
	{ outcome: "failed", errorCode: "untrusted detail", expected: null },
] as const)(
	"retains $outcome receipt details with safe code $expected",
	async ({ outcome, errorCode, expected }) => {
		const h = harness({
			beginWrap: begin => input => {
				const handle = begin(input)
				const settled = handle.settled.then(receipt => ({
					...receipt,
					outcome,
					errorCode: errorCode as AnalogError | null,
				}))
				return { ...handle, settled }
			},
		})
		await h.feed(0.5, false)
		await transmission(h, "receipt-test", 2)
		await h.feed(3.5, false)
		expect(
			h.rec.diagnostics().recent.find(e => e.code === "discarded:aborted")
				?.receipt,
		).toEqual({
			outcome,
			errorCode: expected,
		})
	},
	60_000,
)
