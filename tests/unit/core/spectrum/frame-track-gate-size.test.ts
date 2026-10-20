import { describe, expect, it } from "vitest"
import {
	SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES,
	SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES,
} from "@wavekit/api-types"
import {
	FRAME_TRACK_AGE_MS_MAX,
	FRAME_TRACK_BLOCKS_MAX,
	FRAME_TRACK_DB_ABS_MAX,
	FRAME_TRACK_DISCOVERY_ID_MAX_CHARS,
	FRAME_TRACK_ID_MAX_CHARS,
} from "../../../../src/core/spectrum/frame-tracks.js"

/**
 * WebSocket outbound cap (`src/api/websocket/events.ts` MAX_OUTBOUND_BYTES).
 * A spectrum:frame is one message: `{ type, channel, data }`.
 */
const FRAME_BOUND_BYTES = 1024 * 1024

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

/** WG11 worst accepted track, the 260-byte growth case, without gate fields. */
function worstTrack(gate: boolean) {
	const track = {
		startHz: 446_000_000,
		endHz: 446_012_500,
		flags: { burst: false, iqImage: false, edge: false, spur: false },
		trackId: "t".repeat(FRAME_TRACK_ID_MAX_CHARS),
		snrDb: -FRAME_TRACK_DB_ABS_MAX,
		peakDbfs: -FRAME_TRACK_DB_ABS_MAX,
		blocks: FRAME_TRACK_BLOCKS_MAX,
		ageMs: FRAME_TRACK_AGE_MS_MAX,
		surfaced: false,
		scanner: {
			discoveryId: "d".repeat(FRAME_TRACK_DISCOVERY_ID_MAX_CHARS),
			protocol: "digital-unknown",
			confidence: "classified",
		},
	}
	if (!gate) return track
	return { ...track, gate: "passed" as const, channelSnrDb: -123.5 }
}

function frameMessage(tracks: readonly object[]) {
	const binCount = 2048
	return {
		type: "spectrum:frame",
		channel: "spectrum",
		data: {
			sourceId: "rtl",
			profile: "10:2048",
			epoch: 1,
			tuningTrust: "commanded",
			centerHz: 446_100_000,
			sampleRateHz: 2_048_000,
			binHz: 1_000,
			nativeBinHz: 1_000,
			startHz: 445_076_000,
			binCount,
			bins: "A".repeat(Math.ceil(binCount / 3) * 4),
			binEncoding: "u8-halfdb-127.5",
			floorDbfs: -90,
			thresholdDb: 10,
			tracks,
			masks: { dcHz: 446_100_000, dcGuardHz: 1_500, spurRanges: [] },
			at: "2026-10-18T12:00:00.000Z",
		},
	}
}

describe("frame track gate size (R 2.6)", () => {
	it("gate and channelSnrDb add at most SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES (40) per track", () => {
		expect(SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES).toBe(40)
		const plain = { startHz: 446_000_000, endHz: 446_012_500, flags: {} }
		const withGate = { ...plain, gate: "passed" as const, channelSnrDb: -123.5 }
		expect(bytes(withGate) - bytes(plain)).toBeLessThanOrEqual(
			SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES,
		)
		// The same two keys on a track that already holds every WG11 field.
		const bare = worstTrack(false)
		const gated = worstTrack(true)
		const diff = bytes(gated) - bytes(bare)
		expect(diff).toBeLessThanOrEqual(SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES)
		expect(diff).toBeGreaterThan(0)
		// `"pending"` is one byte longer than `"passed"` and still fits.
		const pending = { ...bare, gate: "pending" as const, channelSnrDb: -999.5 }
		expect(bytes(pending) - bytes(bare)).toBeLessThanOrEqual(
			SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES,
		)
	})

	it("256 tracks still fit the frame bound", () => {
		const n = 256
		const without = Array.from({ length: n }, () => worstTrack(false))
		const withGate = Array.from({ length: n }, () => worstTrack(true))
		expect(withGate).toHaveLength(256)
		const growth = bytes(withGate) - bytes(without)
		expect(growth).toBeLessThanOrEqual(
			n * SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES,
		)
		const message = bytes(frameMessage(withGate))
		expect(message).toBeLessThanOrEqual(FRAME_BOUND_BYTES)
		// The WG11 extra plus the gate extra is what one worst track may add.
		const segment = {
			startHz: 446_000_000,
			endHz: 446_012_500,
			flags: { burst: false, iqImage: false, edge: false },
		}
		expect(bytes(worstTrack(true)) - bytes(segment)).toBeLessThanOrEqual(
			SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES +
				SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES,
		)
	})
})
