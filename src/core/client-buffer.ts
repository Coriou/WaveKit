// Allow brief network stalls while keeping each streaming client's queue bounded.
export const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024

/** Up to two seconds of CU8 IQ, capped at 8 MiB per client. */
export function iqClientBufferLimit(sampleRate = 2048000): number {
	return Math.max(
		MAX_CLIENT_BUFFER_BYTES,
		Math.min(8 * 1024 * 1024, Math.ceil(sampleRate * 2 * 2)),
	)
}
