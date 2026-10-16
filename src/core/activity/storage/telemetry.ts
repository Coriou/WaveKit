/**
 * Output types excluded from Activity. This is an exclusion list, not a list of
 * types Activity accepts: a type not listed here is admitted as a reception.
 *
 * Justified from src/decoders (see the lane report):
 * - sync: dsd-fme debug protocol sync (emitDebugEvents only); named by the spec
 * - stats: DecoderOutputType member, fixture-used; named by the spec
 * - rates: named by the spec and design; no current emitter
 * - status: replaceable health output named by the lane brief; health itself is
 *   a separate decoder event and never reaches admit()
 * - error: dsd-fme debug CRC/error lines (emitDebugEvents only)
 */
export const TELEMETRY_OUTPUT_TYPES = [
	"sync",
	"rates",
	"stats",
	"status",
	"error",
] as const

export type TelemetryOutputType = (typeof TELEMETRY_OUTPUT_TYPES)[number]

const TELEMETRY = new Set<string>(TELEMETRY_OUTPUT_TYPES)

export function isTelemetryOutput(outputType: string): boolean {
	return TELEMETRY.has(outputType)
}
