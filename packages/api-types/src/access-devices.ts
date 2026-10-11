import { z } from "zod"

export const ACCESS_DEVICES_LIMITS = Object.freeze({ maxDevices: 32 })

const clockSchema = z.number().int().nonnegative().safe()

/** Existing canonical 32-byte base64url device identity; no new identity format. */
export const accessDeviceDtoSchema = z
	.object({
		deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
		createdAt: clockSchema,
		renewedAt: clockSchema,
		expiresAt: clockSchema,
		current: z.boolean(),
	})
	.strict()
	.refine(
		value =>
			value.createdAt <= value.renewedAt && value.renewedAt < value.expiresAt,
		"Invalid device clocks",
	)

export const accessDevicesDtoSchema = z
	.object({
		devices: z
			.array(accessDeviceDtoSchema)
			.min(1)
			.max(ACCESS_DEVICES_LIMITS.maxDevices),
	})
	.strict()
	.superRefine(({ devices }, ctx) => {
		const ids = new Set<string>()
		let current = 0
		for (let i = 0; i < devices.length; i++) {
			const device = devices[i]
			if (!device) continue
			if (device.current) current++
			const previous = devices[i - 1]
			if (
				ids.has(device.deviceId) ||
				(previous &&
					(previous.createdAt > device.createdAt ||
						(previous.createdAt === device.createdAt &&
							previous.deviceId >= device.deviceId)))
			)
				ctx.addIssue({
					code: "custom",
					message: "Invalid device ordering or identity",
				})
			ids.add(device.deviceId)
		}
		if (current !== 1)
			ctx.addIssue({ code: "custom", message: "Invalid current device" })
	})

export type AccessDeviceDto = z.infer<typeof accessDeviceDtoSchema>
export type AccessDevicesDto = z.infer<typeof accessDevicesDtoSchema>
