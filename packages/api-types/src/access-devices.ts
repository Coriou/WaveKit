import { z } from "zod"

export const ACCESS_DEVICES_LIMITS = Object.freeze({
	maxDevices: 32,
	/** WG2: operator-set device name, characters after trimming (at most 128 UTF-8 bytes). */
	nameMaxLength: 64,
	nameMaxBytes: 128,
	/** WG2: lastSeenAt is the start of a UTC hour. */
	lastSeenResolutionMs: 3_600_000,
})

/** WG2 (access amendment 4.9): operator-chosen device kind, never derived from a user agent. */
export const ACCESS_DEVICE_KINDS = [
	"browser",
	"phone",
	"tablet",
	"desktop",
	"cli",
	"other",
] as const
export type AccessDeviceKind = (typeof ACCESS_DEVICE_KINDS)[number]

const clockSchema = z.number().int().nonnegative().safe()
const deviceIdSchema = z
	.string()
	.regex(/^device_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
/** Trimmed, 1–64 characters, at most 128 bytes, no C0/C1 controls or bidi overrides. */
export const accessDeviceNameSchema = z
	.string()
	.refine(
		value =>
			value === value.trim() &&
			value.length >= 1 &&
			[...value].length <= ACCESS_DEVICES_LIMITS.nameMaxLength &&
			new TextEncoder().encode(value).length <=
				ACCESS_DEVICES_LIMITS.nameMaxBytes &&
			!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value),
		"Invalid device name",
	)
export const accessDeviceKindSchema = z.enum(ACCESS_DEVICE_KINDS)
const lastSeenSchema = clockSchema.refine(
	value => value % ACCESS_DEVICES_LIMITS.lastSeenResolutionMs === 0,
	"lastSeenAt must be hour-aligned",
)

/** Existing canonical 32-byte base64url device identity; no new identity format. */
export const accessDeviceDtoSchema = z
	.object({
		deviceId: deviceIdSchema,
		createdAt: clockSchema,
		renewedAt: clockSchema,
		expiresAt: clockSchema,
		current: z.boolean(),
		/** WG2: optional so rows from older cores parse; current projections always set them. */
		name: accessDeviceNameSchema.nullable().optional(),
		kind: accessDeviceKindSchema.nullable().optional(),
		lastSeenAt: lastSeenSchema.nullable().optional(),
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

/**
 * WG2: body of `POST /api/access/devices/label` (session only, CSRF). At least one of
 * `name` and `kind`; null clears, absent keeps. The client trims the name first.
 */
export const accessDeviceLabelRequestSchema = z
	.object({
		deviceId: deviceIdSchema,
		name: accessDeviceNameSchema.nullable().optional(),
		kind: accessDeviceKindSchema.nullable().optional(),
	})
	.strict()
	.refine(
		value => value.name !== undefined || value.kind !== undefined,
		"Nothing to update",
	)

export type AccessDeviceLabelRequest = z.infer<
	typeof accessDeviceLabelRequestSchema
>

/** `POST /api/access/devices/label` 200 body; false when the device is not remembered. */
export interface AccessDeviceLabelResponse {
	updated: boolean
}
