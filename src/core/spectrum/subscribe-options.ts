/**
 * Frozen WG1 contract (docs/specs/web-gaps-1): `options.spectrum` of a WS `subscribe` and its bounds.
 * spectrum-service.ts re-exports these names. Changing anything here is a Main-only contract change.
 */
import { z } from "zod"

export const PROFILE_LIMITS = {
	hz: { min: 0.5, max: 25, step: 0.5 },
	bins: { min: 128, max: 2048 },
	/** Frames of exponential averaging; 1 = off (the default). */
	averaging: { min: 1, max: 32 },
} as const

/**
 * Backfill bounds per subscribe: the window, the frame count and the summed JSON length of the
 * backfill `spectrum:frame` messages (the WS outbound queue holds 256 messages / 1 MiB per client).
 */
export const BACKFILL_LIMITS = {
	maxMs: 10_000,
	maxFrames: 64,
	maxBytes: 512 * 1024,
} as const

export const SpectrumSubscribeOptionsSchema = z
	.object({
		sourceId: z.string().min(1).max(128),
		hz: z.number().finite().optional(),
		bins: z.number().finite().optional(),
		/** Rounded and clamped to PROFILE_LIMITS.averaging (adjusted "averaging"). */
		averaging: z.number().finite().optional(),
		/** Rounded and clamped to 0..BACKFILL_LIMITS.maxMs (adjusted "backfillMs"). */
		backfillMs: z.number().finite().optional(),
	})
	.strict()

export type SpectrumSubscribeOptionsInput = z.infer<
	typeof SpectrumSubscribeOptionsSchema
>
