/**
 * Offline snapshot decode plan: windows, channel offsets from the snapshot centre (the capture
 * tool's edge bound at and just past it), several channels, and the tool arguments the scanner's
 * own capture and replay use. Synthetic numbers only.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { IQ_SNAPSHOT_MAX_BYTES } from "../../../../src/api/routes/iq-snapshot.js"
import {
	buildRunArgs,
	realTimers,
} from "../../../../src/core/iq-capture/process.js"
import { spawn } from "node:child_process"
import {
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_MAX_RATE_HZ,
	SNAPSHOT_MIN_RATE_HZ,
	planSnapshotDecode,
	replayToolArgs,
} from "../../../../src/core/scanner/replay-snapshot.js"

const R = 1_024_000
const C = 133_600_000
const base = {
	fileBytes: 10 * R * 2,
	rateHz: R,
	centreHz: C,
	channelsHz: [133_550_000],
	decoder: "acarsdec" as const,
}

describe("planSnapshotDecode", () => {
	it("cuts 4 s windows (the capture bound) and keeps a 2 s tail", () => {
		const plan = planSnapshotDecode(base)
		expect(plan.windows).toEqual([
			{ index: 0, startByte: 0, bytes: 4 * R * 2, samples: 4 * R, maxMs: 4000 },
			{
				index: 1,
				startByte: 4 * R * 2,
				bytes: 4 * R * 2,
				samples: 4 * R,
				maxMs: 4000,
			},
			{
				index: 2,
				startByte: 8 * R * 2,
				bytes: 2 * R * 2,
				samples: 2 * R,
				maxMs: 2000,
			},
		])
		expect(plan.skippedTailBytes).toBe(0)
	})

	it("decodes a 100 ms tail, skips a shorter one", () => {
		const tenth = R / 10
		const at = planSnapshotDecode({ ...base, fileBytes: (4 * R + tenth) * 2 })
		expect(at.windows.at(-1)).toMatchObject({ samples: tenth, maxMs: 100 })
		const past = planSnapshotDecode({
			...base,
			fileBytes: (4 * R + tenth - 1) * 2,
		})
		expect(past.windows).toHaveLength(1)
		expect(past.skippedTailBytes).toBe((tenth - 1) * 2)
		expect(() =>
			planSnapshotDecode({ ...base, fileBytes: (tenth - 1) * 2 }),
		).toThrow("shorter than 100 ms")
	})

	it("offsets every channel from the centre; several channels in one plan", () => {
		const plan = planSnapshotDecode({
			...base,
			channelsHz: [133_550_000, 133_725_000, 133_825_000],
		})
		expect(plan.channels).toEqual([
			{ channelHz: 133_550_000, offsetHz: -50_000 },
			{ channelHz: 133_725_000, offsetHz: 125_000 },
			{ channelHz: 133_825_000, offsetHz: 225_000 },
		])
	})

	it("the capture reaches rate / 2 − capture bandwidth / 2 from the centre, inclusive", () => {
		// 47 424 Hz capture bandwidth: 512 000 − 23 712 = 488 288 Hz at 1.024 Msps
		const plan = planSnapshotDecode(base)
		expect(plan.captureBandwidthHz).toBe(47_424)
		expect(plan.maxOffsetHz).toBe(488_288)
		// the edge itself on a raster channel: centre = channel − 488 288 (whole Hz)
		const ch = 133_550_000
		expect(() =>
			planSnapshotDecode({ ...base, centreHz: ch - 488_288, channelsHz: [ch] }),
		).not.toThrow()
		expect(() =>
			planSnapshotDecode({ ...base, centreHz: ch - 488_289, channelsHz: [ch] }),
		).toThrow("the capture reaches ±488288 Hz")
		expect(() =>
			planSnapshotDecode({ ...base, centreHz: ch + 488_289, channelsHz: [ch] }),
		).toThrow("the capture reaches")
	})

	it("property: a planned channel's offset never exceeds the capture bound", () => {
		// Feature: ACARS and VDL2 replay identity, Property 2: snapshot channel offset bound
		// Validates: Requirements offline decode planning
		fc.assert(
			fc.property(
				fc.integer({ min: SNAPSHOT_MIN_RATE_HZ, max: 3_200_000 }),
				fc.integer({ min: -1_600_000, max: 1_600_000 }),
				(rateHz, delta) => {
					const ch = 133_550_000
					try {
						const plan = planSnapshotDecode({
							...base,
							fileBytes: rateHz * 2,
							rateHz,
							centreHz: ch - delta,
							channelsHz: [ch],
						})
						return Math.abs(plan.channels[0]!.offsetHz) <= plan.maxOffsetHz
					} catch {
						return Math.abs(delta) > rateHz / 2 - 47_424 / 2
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	it("refuses bad input naming the bound", () => {
		const bad = (over: Partial<typeof base> & { decoder?: never }) => () =>
			planSnapshotDecode({ ...base, ...over })
		expect(bad({ rateHz: SNAPSHOT_MIN_RATE_HZ - 1 })).toThrow("rate must be")
		expect(bad({ rateHz: SNAPSHOT_MAX_RATE_HZ + 1 })).toThrow("rate must be")
		expect(bad({ rateHz: 1_024_000.5 })).toThrow("rate must be")
		expect(bad({ centreHz: 0 })).toThrow("centre must be")
		expect(bad({ fileBytes: 3 })).toThrow("whole CU8 samples")
		expect(bad({ fileBytes: 0 })).toThrow("whole CU8 samples")
		expect(bad({ fileBytes: SNAPSHOT_MAX_BYTES + 2 })).toThrow("exceeds")
		expect(bad({ channelsHz: [] })).toThrow("at least one channel")
		expect(bad({ channelsHz: [133_550_000, 133_550_000] })).toThrow(
			"given twice",
		)
		expect(bad({ channelsHz: [133_551_000] })).toThrow(
			"not a 25 kHz ACARS channel",
		)
		expect(bad({ channelsHz: [446_100_000] })).toThrow("not a 25 kHz")
		expect(() =>
			planSnapshotDecode({ ...base, decoder: "readsb" as never }),
		).toThrow("decoder must be")
		// the largest file the snapshot API writes is accepted
		expect(SNAPSHOT_MAX_BYTES).toBe(IQ_SNAPSHOT_MAX_BYTES)
		expect(() =>
			planSnapshotDecode({
				...base,
				rateHz: 2_400_000,
				centreHz: 133_600_000,
				fileBytes: SNAPSHOT_MAX_BYTES,
			}),
		).not.toThrow()
	})
})

describe("tool arguments", () => {
	it("run: the service's ring, bound and capture bandwidth", () => {
		const plan = planSnapshotDecode(base)
		expect(plan.runArgs("/w/iq-captures", "/w")).toEqual(
			buildRunArgs({
				binaryPath: "x",
				sampleRateHz: R,
				ringMs: 2000,
				outDir: "/w/iq-captures",
				anchor: "/w",
				maxMs: 4000,
				bandwidthHz: 47_424,
				spawn,
				env: {},
				timers: realTimers,
			}),
		)
	})

	it("replay: acarsdec cf32 at 48 kHz; dumpvdl2 U8 at 105 kHz", () => {
		const acars = planSnapshotDecode(base)
		expect(acars.replayArgs("/w/c.cf32")).toEqual([
			"replay",
			"--in",
			"/w/c.cf32",
			"--bandwidth",
			"15200",
			"--transition",
			"4000",
		])
		// 4 s at 48 kHz cf32 = 1 536 000 B in, the same out
		expect(acars.replayOutput(1_536_000)).toEqual({
			rateHz: 48_000,
			format: "cf32",
			bytes: 1_536_000,
		})
		const vdl2 = planSnapshotDecode({
			...base,
			centreHz: 135_800_000,
			channelsHz: [135_975_000, 135_725_000],
			decoder: "dumpvdl2",
		})
		expect(vdl2.protocol).toBe("vdl2")
		expect(vdl2.replayArgs("/w/c.cf32")).toEqual([
			"replay",
			"--in",
			"/w/c.cf32",
			"--bandwidth",
			"25000",
			"--transition",
			"5000",
			"--out-rate",
			"105000",
			"--format",
			"cu8",
		])
		// 192 000 samples × 105 000 / 48 000 = 420 000 samples × 2 B = 840 000 B of U8
		expect(vdl2.replayOutput(1_536_000)).toEqual({
			rateHz: 105_000,
			format: "cu8",
			bytes: 840_000,
		})
		expect(() => vdl2.replayOutput(7)).toThrow("whole cf32 samples")
		expect(
			replayToolArgs("dumpvdl2", { bandwidthHz: 1, transitionHz: 2 }),
		).toEqual([
			"--bandwidth",
			"1",
			"--transition",
			"2",
			"--out-rate",
			"105000",
			"--format",
			"cu8",
		])
	})
})
