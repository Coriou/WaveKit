/**
 * Telemetry and NeighborInfo reader: round trip, robustness and examples.
 * The encoder below is a tiny inline proto3 writer, local to this file.
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	MAX_NEIGHBORS_PER_REPORT,
	readNeighborInfo,
	readTelemetry,
	type MeshDeviceMetricsFields,
	type MeshNeighborFields,
} from "../../../src/core/meshtastic-protobuf.js"

function varint(value: number): number[] {
	const out: number[] = []
	let v = value >>> 0
	while (v > 0x7f) {
		out.push((v & 0x7f) | 0x80)
		v >>>= 7
	}
	out.push(v)
	return out
}

function tag(field: number, wire: number): number[] {
	return varint((field << 3) | wire)
}

function float(field: number, value: number): number[] {
	const buf = new Uint8Array(4)
	new DataView(buf.buffer).setFloat32(0, value, true)
	return [...tag(field, 5), ...buf]
}

function uint(field: number, value: number): number[] {
	return [...tag(field, 0), ...varint(value)]
}

function sub(field: number, body: number[]): number[] {
	return [...tag(field, 2), ...varint(body.length), ...body]
}

function encodeMetrics(m: MeshDeviceMetricsFields): number[] {
	const out: number[] = []
	if (m.batteryLevel !== null) out.push(...uint(1, m.batteryLevel))
	if (m.voltage !== null) out.push(...float(2, m.voltage))
	if (m.channelUtilization !== null) out.push(...float(3, m.channelUtilization))
	if (m.airUtilTx !== null) out.push(...float(4, m.airUtilTx))
	if (m.uptimeSeconds !== null) out.push(...uint(5, m.uptimeSeconds))
	return out
}

function encodeTelemetry(
	m: MeshDeviceMetricsFields,
	time?: number,
): Uint8Array {
	const out: number[] = []
	if (time !== undefined) {
		const buf = new Uint8Array(4)
		new DataView(buf.buffer).setUint32(0, time, true)
		out.push(...tag(1, 5), ...buf)
	}
	out.push(...sub(2, encodeMetrics(m)))
	return Uint8Array.from(out)
}

function encodeNeighbor(n: MeshNeighborFields): number[] {
	const body = uint(1, n.nodeNum)
	if (n.snr !== null) body.push(...float(2, n.snr))
	return sub(4, body)
}

function encodeNeighborInfo(
	nodeNum: number | null,
	neighbors: MeshNeighborFields[],
): Uint8Array {
	const out: number[] = []
	if (nodeNum !== null) out.push(...uint(1, nodeNum))
	out.push(...uint(2, 7), ...uint(3, 900))
	for (const n of neighbors) out.push(...encodeNeighbor(n))
	return Uint8Array.from(out)
}

const u32 = fc.integer({ min: 0, max: 0xffffffff })
const f32 = fc
	.float({ noNaN: true, noDefaultInfinity: true })
	.map(v => Math.fround(v))
const metricsArb: fc.Arbitrary<MeshDeviceMetricsFields> = fc.record({
	batteryLevel: fc.option(u32, { nil: null }),
	voltage: fc.option(f32, { nil: null }),
	channelUtilization: fc.option(f32, { nil: null }),
	airUtilTx: fc.option(f32, { nil: null }),
	uptimeSeconds: fc.option(u32, { nil: null }),
})
const neighborArb: fc.Arbitrary<MeshNeighborFields> = fc.record({
	nodeNum: u32,
	snr: fc.option(f32, { nil: null }),
})

function same(a: number | null, b: number | null): boolean {
	return Object.is(a, b) || (a === 0 && b === 0)
}

describe("meshtastic telemetry and neighbour reader", () => {
	// Feature: web-gaps-3, Property 11: Mesh telemetry round trip
	// Validates: Requirements 8.1, 8.2, 8.3
	it("round trips device metrics", () => {
		fc.assert(
			fc.property(metricsArb, fc.option(u32, { nil: undefined }), (m, t) => {
				const got = readTelemetry(encodeTelemetry(m, t))?.deviceMetrics
				expect(got).toBeTruthy()
				if (!got) return
				for (const key of Object.keys(m) as (keyof MeshDeviceMetricsFields)[])
					expect(same(got[key], m[key])).toBe(true)
			}),
			{ numRuns: 200 },
		)
	})

	it("round trips neighbour lists up to the cap", () => {
		fc.assert(
			fc.property(
				fc.option(u32, { nil: null }),
				fc.array(neighborArb, { maxLength: MAX_NEIGHBORS_PER_REPORT }),
				(nodeNum, neighbors) => {
					const got = readNeighborInfo(encodeNeighborInfo(nodeNum, neighbors))
					expect(got?.nodeNum).toBe(nodeNum)
					expect(got?.neighbors.length).toBe(neighbors.length)
					got?.neighbors.forEach((n, i) => {
						expect(n.nodeNum).toBe(neighbors[i]?.nodeNum)
						expect(same(n.snr, neighbors[i]?.snr ?? null)).toBe(true)
					})
				},
			),
			{ numRuns: 200 },
		)
	})

	it("rejects 65 neighbours", () => {
		fc.assert(
			fc.property(
				fc.array(neighborArb, {
					minLength: MAX_NEIGHBORS_PER_REPORT + 1,
					maxLength: MAX_NEIGHBORS_PER_REPORT + 3,
				}),
				neighbors => {
					expect(readNeighborInfo(encodeNeighborInfo(1, neighbors))).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("rejects truncation of a non-empty payload", () => {
		fc.assert(
			fc.property(
				metricsArb,
				fc.array(neighborArb, { minLength: 1, maxLength: 8 }),
				fc.nat(),
				(m, neighbors, cut) => {
					const t = encodeTelemetry(m)
					const n = encodeNeighborInfo(5, neighbors)
					// Cutting inside the length-delimited sub-message always breaks it.
					const tc = t.subarray(0, 2 + (cut % Math.max(1, t.length - 2)))
					if (tc.length < t.length && t.length > 2)
						expect(readTelemetry(tc)).toBeNull()
					const last = n.length - 1 - (cut % 3)
					if (last > n.length - encodeNeighbor(neighbors.at(-1)!).length)
						expect(readNeighborInfo(n.subarray(0, last))).toBeNull()
				},
			),
			{ numRuns: 200 },
		)
	})

	it("never throws on garbage", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 600 }), bytes => {
				expect(() => readTelemetry(bytes)).not.toThrow()
				expect(() => readNeighborInfo(bytes)).not.toThrow()
			}),
			{ numRuns: 500 },
		)
	})

	it("rejects a wrong wire type for every known field", () => {
		const bad = [
			Uint8Array.from(tag(2, 0).concat(varint(1))), // device_metrics as varint
			Uint8Array.from(sub(2, tag(1, 5).concat([0, 0, 0, 0]))), // battery as fixed32
			Uint8Array.from(sub(2, uint(2, 3))), // voltage as varint
			Uint8Array.from(sub(2, uint(3, 3))),
			Uint8Array.from(sub(2, uint(4, 3))),
			Uint8Array.from(sub(2, sub(5, []))), // uptime as bytes
		]
		for (const b of bad) expect(readTelemetry(b)).toBeNull()
		const badN = [
			Uint8Array.from(float(1, 1)), // node_id as fixed32
			Uint8Array.from(uint(4, 1)), // neighbors as varint
			Uint8Array.from(sub(4, float(1, 1))),
			Uint8Array.from(sub(4, uint(1, 1).concat(uint(2, 1)))), // snr as varint
		]
		for (const b of badN) expect(readNeighborInfo(b)).toBeNull()
	})

	it("decodes NaN and infinite floats as null", () => {
		const bytes = Uint8Array.from(
			sub(2, [...float(2, NaN), ...float(3, Infinity), ...float(4, 1.5)]),
		)
		expect(readTelemetry(bytes)?.deviceMetrics).toEqual({
			batteryLevel: null,
			voltage: null,
			channelUtilization: null,
			airUtilTx: 1.5,
			uptimeSeconds: null,
		})
		const n = readNeighborInfo(
			Uint8Array.from(sub(4, [...uint(1, 9), ...float(2, NaN)])),
		)
		expect(n?.neighbors).toEqual([{ nodeNum: 9, snr: null }])
	})

	it("lets a later oneof variant replace device_metrics", () => {
		// device_metrics { battery_level: 50 } then an empty environment_metrics
		const bytes = Uint8Array.from([0x12, 0x02, 0x08, 0x32, 0x1a, 0x00])
		expect(readTelemetry(bytes)).toEqual({ deviceMetrics: null })
		const reversed = Uint8Array.from([0x1a, 0x00, 0x12, 0x02, 0x08, 0x32])
		expect(readTelemetry(reversed)?.deviceMetrics?.batteryLevel).toBe(50)
	})

	it("treats environment_metrics as a recognised other variant", () => {
		const bytes = Uint8Array.from(sub(3, float(1, 21.5)))
		expect(readTelemetry(bytes)).toEqual({ deviceMetrics: null })
		expect(readTelemetry(new Uint8Array(0))).toEqual({ deviceMetrics: null })
	})

	it("decodes uint32 maxima unsigned and skips a neighbour without node_id", () => {
		const t = readTelemetry(
			Uint8Array.from(sub(2, [...uint(1, 0xffffffff), ...uint(5, 0x80000000)])),
		)
		expect(t?.deviceMetrics?.batteryLevel).toBe(0xffffffff)
		expect(t?.deviceMetrics?.uptimeSeconds).toBe(0x80000000)
		const n = readNeighborInfo(
			Uint8Array.from([
				...uint(1, 3),
				...sub(4, float(2, 2)),
				...sub(4, uint(1, 4)),
			]),
		)
		expect(n).toEqual({ nodeNum: 3, neighbors: [{ nodeNum: 4, snr: null }] })
	})

	// R1 7: uint32 fields decode 5- to 10-byte varints to their low 32 bits; an
	// over-long, overflowing or truncated varint rejects the message.
	it.each([
		["0", [0x00], 0],
		["2^31", [0x80, 0x80, 0x80, 0x80, 0x08], 0x80000000],
		["2^32 - 1", [0xff, 0xff, 0xff, 0xff, 0x0f], 0xffffffff],
		["2^32 (low bits 0)", [0x80, 0x80, 0x80, 0x80, 0x10], 0],
		["2^35 + 5", [0x85, 0x80, 0x80, 0x80, 0x80, 0x01], 5],
		["non-minimal 1", [0x81, 0x80, 0x80, 0x80, 0x00], 1],
		["2^64 - 1", [...Array<number>(9).fill(0xff), 0x01], 0xffffffff],
		["10th byte above bit 63", [...Array<number>(9).fill(0xff), 0x02], null],
		["11 bytes", [...Array<number>(10).fill(0x80), 0x00], null],
		["truncated", [0xff, 0xff, 0xff, 0xff, 0xff], null],
	] as const)("decodes a node_id varint of %s", (_name, bytes, expected) => {
		const n = readNeighborInfo(Uint8Array.from([0x08, ...bytes]))
		expect(n === null ? null : n.nodeNum).toBe(expected)
	})

	it("decodes any uint32 node_id written as a 5-byte varint", () => {
		fc.assert(
			fc.property(u32, value => {
				const bytes = [0, 7, 14, 21].map(
					shift => ((value >>> shift) & 0x7f) | 0x80,
				)
				bytes.push((value >>> 28) & 0x0f)
				const n = readNeighborInfo(Uint8Array.from([0x08, ...bytes]))
				return n?.nodeNum === value
			}),
			{ numRuns: 200 },
		)
	})
})
