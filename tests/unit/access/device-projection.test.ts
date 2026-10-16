import { describe, expect, it } from "vitest"
import { accessDevicesDtoSchema } from "@wavekit/api-types"
import { projectAccessDevices } from "../../../src/access/device-projection.js"

const row = {
	deviceId: `device_${"A".repeat(43)}`,
	createdAt: 1,
	renewedAt: 2,
	expiresAt: 3,
	current: true,
	name: null,
	kind: null,
	lastSeenAt: null,
}

describe("public device projection", () => {
	it("detaches an allowlist and ignores private fields and caller serialization", () => {
		const toJSON = () => {
			throw new Error("private serializer")
		}
		const input = { ...row, tokenHash: "secret", csrfToken: "secret", toJSON }
		const result = projectAccessDevices([input])
		expect(result).toEqual({ devices: [row] })
		input.createdAt = 0
		expect(result.devices[0]?.createdAt).toBe(1)
		expect(JSON.stringify(result)).not.toContain("secret")
	})

	it.each(
		[
			[],
			Array.from({ length: 33 }, () => row),
			[{ ...row, current: false }],
			[row, row],
			[{ ...row, deviceId: `device_${"A".repeat(42)}B` }],
			[{ ...row, createdAt: 4 }],
			[{ ...row, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
			[{ ...row, renewedAt: -1 }],
			[{ ...row, renewedAt: 1.5 }],
		].map(input => ({ input })),
	)("rejects invalid authority output with a fixed fault (%#)", ({ input }) => {
		expect(() => projectAccessDevices(input)).toThrow(
			"Device inventory unavailable",
		)
	})

	it("rejects ordering violations and nonclosed public DTOs", () => {
		const second = {
			...row,
			deviceId: `device_${"B".repeat(42)}A`,
			current: false,
		}
		expect(() => projectAccessDevices([second, row])).toThrow()
		expect(
			accessDevicesDtoSchema.safeParse({
				devices: [{ ...row, csrfToken: "secret" }],
			}).success,
		).toBe(false)
		expect(
			accessDevicesDtoSchema.safeParse({ devices: [row], online: true })
				.success,
		).toBe(false)
	})

	it("always emits name, kind and lastSeenAt, including when the record omitted them", () => {
		const legacy = {
			deviceId: row.deviceId,
			createdAt: row.createdAt,
			renewedAt: row.renewedAt,
			expiresAt: row.expiresAt,
			current: row.current,
		}
		expect(projectAccessDevices([legacy])).toEqual({
			devices: [{ ...legacy, name: null, kind: null, lastSeenAt: null }],
		})
		expect(() =>
			projectAccessDevices([{ ...row, name: `bad\u202ename` }]),
		).toThrow("Device inventory unavailable")
		expect(() => projectAccessDevices([{ ...row, kind: "laptop" }])).toThrow(
			"Device inventory unavailable",
		)
		expect(() => projectAccessDevices([{ ...row, lastSeenAt: 1 }])).toThrow(
			"Device inventory unavailable",
		)
	})

	it("sanitizes throwing getters rather than leaking their error", () => {
		const input = {
			...row,
			get expiresAt(): number {
				throw new Error("private path")
			},
		}
		expect(() => projectAccessDevices([input])).toThrow(
			"Device inventory unavailable",
		)
	})
})
