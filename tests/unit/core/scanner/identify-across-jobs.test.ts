/** Identify says when `decoded` leans on a decode from before the job, and a run claims only what its mode covers. */
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_OWN_DECODES_MAX,
	IDENTIFY_PAIR_WAIT_MS,
	earlierMatchCounts,
	noteOwnDecode,
	pairPredatesJob,
} from "../../../../src/core/scanner/identify.js"
import {
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
	ConfirmMemory,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { linkProtocol } from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import {
	identifyHarness,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"
import { verifiedLinkLine } from "./verified-link-fake.js"

const ENDED = ["completed", "cancelled", "failed"]
const TICK_MS = 20
const SCOPE = "o:o_t1"

function harness(request: Record<string, unknown> = {}) {
	let memory: ConfirmMemory | null = null
	const h = identifyHarness({
		request: { protocols: ["dmr"], ...request },
		confirm: clock => {
			memory = new ConfirmMemory(() => clock.now)
			return { memory, scopeOf: req => `o:${req.observationId}` }
		},
	})
	return { h, memory: () => memory! }
}

type Harness = ReturnType<typeof harness>["h"]

async function probeOf(h: Harness): Promise<string> {
	await h.runner.start()
	h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99, trackId: "t1" })))
	await h.advance(100)
	await h.advance(100)
	await flushAsync()
	return [...h.decoders.created.values()][0]!.id
}

async function runTo(h: Harness, emitAt: (ms: number) => void): Promise<void> {
	for (let ms = TICK_MS; ms <= 30_000; ms += TICK_MS) {
		await h.advance(TICK_MS)
		if (ENDED.includes(h.record.state)) return
		emitAt(ms)
	}
}

describe("confirmedAcrossJobs", () => {
	it("a decode from before the job plus one burst is decoded, and says so", async () => {
		const { h, memory } = harness()
		memory().pair(SCOPE, "dmr:id", "1")
		h.clock.now += 10_000
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300) h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		})
		expect(h.last()?.verdict).toEqual({
			code: "decoded",
			protocol: "dmr",
			confirmedAcrossJobs: true,
		})
	})

	describe("an identity accepted before the job counts only within the 5 min window", () => {
		/** The identity's last occurrence lies `ageMs` before the job's first line. */
		const accept = (h: Harness, memory: ConfirmMemory, ageMs: number): void => {
			const now = h.clock.now
			h.clock.now = now - ageMs
			memory.markAccepted(SCOPE, "dmr:id", "1")
			h.clock.now = now
		}
		const oneLine = async (ageMs: number) => {
			const { h, memory } = harness()
			const id = await probeOf(h)
			await runTo(h, ms => {
				if (ms !== 300) return
				accept(h, memory(), ageMs)
				h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
			})
			return h
		}

		it.each([CONFIRM_MIN_SEPARATION_MS, 180_000, CONFIRM_WINDOW_MS])(
			"%i ms old: decoded across jobs, on one line",
			async ageMs => {
				const h = await oneLine(ageMs)
				expect(h.last()?.verdict).toEqual({
					code: "decoded",
					protocol: "dmr",
					confirmedAcrossJobs: true,
				})
			},
		)

		it.each([CONFIRM_WINDOW_MS + 1, 86_400_000, 30 * 86_400_000])(
			"%i ms old: one line is unconfirmed, and keeps the run for its pair",
			async ageMs => {
				const { h, memory } = harness()
				const id = await probeOf(h)
				const from = h.clock.now
				await runTo(h, ms => {
					if (ms !== 300) return
					accept(h, memory(), ageMs)
					h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
				})
				expect(h.last()?.state).not.toBe("identified")
				expect(h.last()?.verdict).toEqual({
					code: "heard-digital-unconfirmed",
					protocol: "dmr",
				})
				expect(h.clock.now - from).toBeGreaterThanOrEqual(
					300 + IDENTIFY_PAIR_WAIT_MS,
				)
				// The store's acceptance does not age: the same line is still accepted there.
				expect(memory().isAccepted(SCOPE, "dmr:id", "1")).toBe(true)
			},
		)

		it("under the 2 s separation it is one transmission heard twice: no match", async () => {
			const h = await oneLine(CONFIRM_MIN_SEPARATION_MS - 1)
			expect(h.last()?.verdict?.code).toBe("heard-digital-unconfirmed")
		})

		it("too old: the job's own pair still decodes, and does not claim another job", async () => {
			const { h, memory } = harness()
			const id = await probeOf(h)
			await runTo(h, ms => {
				if (ms === 300) accept(h, memory(), CONFIRM_WINDOW_MS + 1)
				if (ms === 300 || ms === 660 || ms === 2300)
					h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
			})
			expect(h.last()).toMatchObject({
				state: "identified",
				result: { protocol: "dmr", identity: { value: "1" } },
			})
			expect(h.last()?.verdict).toEqual({ code: "decoded", protocol: "dmr" })
		})

		it("too old: a call record after the one line adds nothing", async () => {
			const { h, memory } = harness()
			const id = await probeOf(h)
			await runTo(h, ms => {
				if (ms === 300) {
					accept(h, memory(), CONFIRM_WINDOW_MS + 1)
					h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
				}
				if (ms === 2500)
					h.decoders.emitOutput(id, {
						type: "call_start",
						timestamp: new Date(h.clock.now),
						data: {
							callId: "c1",
							protocol: "dmr",
							startedAt: new Date(h.clock.now).toISOString(),
							talkgroup: null,
							source: null,
						},
					})
			})
			expect(h.last()?.verdict?.code).toBe("heard-digital-unconfirmed")
		})

		it("a clean occurrence refreshes the age, so a repeat within the window counts again", async () => {
			const { h, memory } = harness()
			const id = await probeOf(h)
			await runTo(h, ms => {
				if (ms === 300) {
					accept(h, memory(), CONFIRM_WINDOW_MS)
					h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
				}
			})
			expect(memory().acceptedAgeMs(SCOPE, "dmr:id", "1")).toBeLessThan(
				CONFIRM_WINDOW_MS,
			)
		})

		it("the bound and the separation, at and past each", () => {
			expect(earlierMatchCounts(CONFIRM_MIN_SEPARATION_MS - 1)).toBe(false)
			expect(earlierMatchCounts(CONFIRM_MIN_SEPARATION_MS)).toBe(true)
			expect(earlierMatchCounts(CONFIRM_WINDOW_MS)).toBe(true)
			expect(earlierMatchCounts(CONFIRM_WINDOW_MS + 1)).toBe(false)
			expect(earlierMatchCounts(Number.POSITIVE_INFINITY)).toBe(false)
			expect(earlierMatchCounts(-1)).toBe(false)
		})
	})

	it("one burst with no earlier decode stays unconfirmed", async () => {
		const { h } = harness()
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300) h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		})
		expect(h.last()?.verdict).toEqual({
			code: "heard-digital-unconfirmed",
			protocol: "dmr",
		})
	})

	it("an earlier decode past the 5 min window confirms nothing", async () => {
		const { h, memory } = harness()
		memory().pair(SCOPE, "dmr:id", "1")
		h.clock.now += 300_001
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300) h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		})
		expect(h.last()?.verdict?.code).toBe("heard-digital-unconfirmed")
	})

	it("two decodes inside the job do not carry the field", async () => {
		const { h } = harness()
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300 || ms === 2460)
				h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		})
		expect(h.last()?.verdict).toEqual({ code: "decoded", protocol: "dmr" })
	})

	it("a job burst too close to confirm alone, completing an older decode, says so", async () => {
		const { h, memory } = harness()
		const id = await probeOf(h)
		// Seeded just before the job's first line, so that line is under 2 s from it and does not pair.
		h.clock.now += 200
		memory().pair(SCOPE, "dmr:id", "1")
		await runTo(h, ms => {
			if (ms === 200 || ms === 2100)
				h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		})
		// 1 900 ms between the job's two lines: only the seed is 2 s or more before the second.
		expect(h.last()?.verdict).toEqual({
			code: "decoded",
			protocol: "dmr",
			confirmedAcrossJobs: true,
		})
	})

	it("the separation decides: a first decode here 2 000 ms back is the pair, 1 999 ms is not", () => {
		expect(pairPredatesJob(undefined, 5000)).toBe(true)
		expect(pairPredatesJob(3001, 5000)).toBe(true)
		expect(pairPredatesJob(3000, 5000)).toBe(false)
	})

	it("remembers the first time, and at most IDENTIFY_OWN_DECODES_MAX values, oldest out", () => {
		const seen = new Map<string, number>()
		noteOwnDecode(seen, "first", 1)
		noteOwnDecode(seen, "first", 2)
		expect(seen.get("first")).toBe(1)
		for (let i = 1; i < IDENTIFY_OWN_DECODES_MAX; i++)
			noteOwnDecode(seen, `v${i}`, 10 + i)
		expect(seen.size).toBe(IDENTIFY_OWN_DECODES_MAX)
		expect(seen.has("first")).toBe(true)
		noteOwnDecode(seen, "one-past", 9999)
		expect(seen.size).toBe(IDENTIFY_OWN_DECODES_MAX)
		expect(seen.has("first")).toBe(false)
	})
})

describe("a run claims only the protocols its mode covers", () => {
	it("one verified NXDN line in a DMR auto run claims nothing and extends nothing", async () => {
		const { h } = harness()
		const id = await probeOf(h)
		const started = h.clock.now
		await runTo(h, ms => {
			if (ms === 300)
				h.decoders.emitLink(id, {
					...verifiedLinkLine(1, h.clock.now),
					protocol: "nxdn",
					ran: 1,
				})
		})
		expect(h.last()?.verdict).toEqual({ code: "undecodable", protocol: "dmr" })
		// Hold 1 800 + start latency 400; the pair wait would have ended at 300 + 3 080.
		expect(h.clock.now - started).toBeLessThan(300 + IDENTIFY_PAIR_WAIT_MS)
		expect(h.clock.now - started).toBeLessThanOrEqual(2200 + 200)
	})

	it("an unverified NXDN sync in a DMR auto run claims nothing either", async () => {
		const { h } = harness()
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300)
				h.decoders.emitLink(id, {
					protocol: "nxdn",
					crcErr: false,
					at: h.clock.now,
				})
		})
		expect(h.last()?.verdict?.protocol).toBe("dmr")
		expect(h.last()?.verdict?.code).not.toBe("heard-digital-unconfirmed")
	})

	it("a covered protocol other than the one named is still heard", async () => {
		const { h } = harness({ protocols: ["dmr"] })
		const id = await probeOf(h)
		await runTo(h, ms => {
			if (ms === 300)
				h.decoders.emitLink(id, {
					protocol: "ysf",
					dgid: 1,
					verified: true,
					crcErr: false,
					at: h.clock.now,
				})
		})
		expect(h.last()?.verdict).toEqual({
			code: "heard-digital-unconfirmed",
			protocol: "ysf",
		})
	})

	it("the pool reads the interpreter's own line mapping", () => {
		const state = createInterpreterState({
			epoch: 1,
			origin: "probe",
			nxdn: "nxdn48",
		})
		expect(linkProtocol("p25", state)).toBe("p25p1")
		expect(linkProtocol("nxdn", state)).toBe("nxdn48")
		expect(linkProtocol("dpmr", state)).toBe("dpmr")
	})
})
