import { ACCESS_DEVICES_LIMITS, accessDevicesDtoSchema } from "@wavekit/api-types"
import type { AccessDevicesDto } from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"

/** Explicit projection: private session records and caller serializers never escape. */
export function projectAccessDevices(input: unknown): AccessDevicesDto {
	try {
		if (
			!Array.isArray(input) ||
			input.length < 1 ||
			input.length > ACCESS_DEVICES_LIMITS.maxDevices
		)
			throw new WaveKitError("Device inventory unavailable", "ACCESS_UNAVAILABLE")
		const devices = input.map((value: unknown) => {
			if (!value || typeof value !== "object")
				throw new WaveKitError("Device inventory unavailable", "ACCESS_UNAVAILABLE")
			const row = value as Record<string, unknown>
			return {
				deviceId: row["deviceId"],
				createdAt: row["createdAt"],
				renewedAt: row["renewedAt"],
				expiresAt: row["expiresAt"],
				current: row["current"],
			}
		})
		const parsed = accessDevicesDtoSchema.safeParse({ devices })
		if (!parsed.success)
			throw new WaveKitError("Device inventory unavailable", "ACCESS_UNAVAILABLE")
		return parsed.data
	} catch {
		throw new WaveKitError("Device inventory unavailable", "ACCESS_UNAVAILABLE")
	}
}
