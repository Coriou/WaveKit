/**
 * Property 7: protobuf round trip and robustness.
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	readPosition,
	readUser,
	type MeshPositionFields,
	type MeshUserFields,
} from "../../../src/core/meshtastic-protobuf.js"
import {
	encodePosition,
	encodeUser,
	type PositionFixture,
	type UserFixture,
} from "../../mocks/fixtures/meshtastic/encode.js"

function ascii(maxLength: number) {
	return fc
		.array(fc.integer({ min: 0x20, max: 0x7e }), {
			minLength: 0,
			maxLength,
		})
		.map(codes => String.fromCharCode(...codes))
}

const positionArb: fc.Arbitrary<PositionFixture> = fc.record({
	latitudeI: fc.integer({ min: -900_000_000, max: 900_000_000 }),
	longitudeI: fc.integer({ min: -1_800_000_000, max: 1_800_000_000 }),
	altitudeM: fc.option(fc.integer({ min: -5_000, max: 50_000 }), {
		nil: undefined,
	}),
	timeS: fc.option(fc.integer({ min: 0, max: 0xffffffff }), { nil: undefined }),
})

const userArb: fc.Arbitrary<UserFixture> = fc.record({
	id: fc.option(ascii(24), { nil: undefined }),
	longName: fc.option(ascii(40), { nil: undefined }),
	shortName: fc.option(ascii(8), { nil: undefined }),
	hwModel: fc.option(fc.integer({ min: 0, max: 2_000 }), { nil: undefined }),
	isLicensed: fc.option(fc.boolean(), { nil: undefined }),
	role: fc.option(fc.integer({ min: -5, max: 20 }), { nil: undefined }),
})

function positionShape(value: MeshPositionFields): boolean {
	const altitude = value.altitudeM === null || Number.isInteger(value.altitudeM)
	const time =
		value.timeS === null ||
		(Number.isInteger(value.timeS) &&
			value.timeS >= 0 &&
			value.timeS <= 0xffffffff)
	return (
		Number.isFinite(value.lat) && Number.isFinite(value.lon) && altitude && time
	)
}

function userShape(value: MeshUserFields): boolean {
	const text = (textValue: string | null, max: number) => {
		if (textValue === null) return true
		if (Buffer.byteLength(textValue) > max) return false
		for (let i = 0; i < textValue.length; i++) {
			const code = textValue.charCodeAt(i)
			if (code < 0x20 || code === 0x7f) return false
		}
		return true
	}
	return (
		text(value.id, 512) &&
		text(value.longName, 40) &&
		text(value.shortName, 8) &&
		(value.hwModel === null || Number.isInteger(value.hwModel)) &&
		(value.role === null || Number.isInteger(value.role)) &&
		(value.isLicensed === null || typeof value.isLicensed === "boolean")
	)
}

describe("protobuf properties", () => {
	it("round-trips Position and User and never throws on arbitrary bytes", () => {
		// Feature: web-gaps-2, Property 7: Protobuf round trip and robustness
		// Validates: Requirements 5.2, 5.3
		fc.assert(
			fc.property(
				positionArb,
				userArb,
				fc.uint8Array({ minLength: 0, maxLength: 256 }),
				(position, user, bytes) => {
					const readPos = readPosition(encodePosition(position))
					expect(readPos).not.toBeNull()
					expect(
						Math.abs(
							(readPos?.lat ?? 0) * 10_000_000 - (position.latitudeI ?? 0),
						),
					).toBeLessThan(1)
					expect(
						Math.abs(
							(readPos?.lon ?? 0) * 10_000_000 - (position.longitudeI ?? 0),
						),
					).toBeLessThan(1)
					expect(readPos?.altitudeM ?? null).toBe(position.altitudeM ?? null)
					expect(readPos?.timeS ?? null).toBe(position.timeS ?? null)

					const read = readUser(encodeUser(user))
					expect(read).not.toBeNull()
					expect(read?.id).toBe(user.id ?? "")
					expect(read?.longName ?? null).toBe(user.longName ?? null)
					expect(read?.shortName ?? null).toBe(user.shortName ?? null)
					expect(read?.hwModel ?? null).toBe(user.hwModel ?? null)
					expect(read?.isLicensed ?? null).toBe(user.isLicensed ?? null)
					expect(read?.role ?? null).toBe(user.role ?? null)

					expect(() => readPosition(bytes)).not.toThrow()
					expect(() => readUser(bytes)).not.toThrow()
					const garbagePos = readPosition(bytes)
					const garbageUser = readUser(bytes)
					if (garbagePos) expect(positionShape(garbagePos)).toBe(true)
					if (garbageUser) expect(userShape(garbageUser)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})
