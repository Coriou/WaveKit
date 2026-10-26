import { z } from "zod"
import type { DecoderOutput } from "../../../decoders/types.js"
import type { ActivityDecoderBinding, DecodeProvenance } from "../types.js"

/** Largest accepted frequency (req 5.4): 1 THz. */
export const MAX_PROVENANCE_HZ = 1e12

/** AIS channel 1 (87B) and 2 (88B) carriers. */
export const AIS_CHANNEL_A_HZ = 161_975_000
export const AIS_CHANNEL_B_HZ = 162_025_000

/** Output types whose payload `frequency` is the decoder-reported channel in Hz. */
const PAYLOAD_HZ_TYPES: ReadonlySet<string> = new Set([
	"acars",
	"vdl2",
	"meshtastic",
])

/** ADS-B (readsb `aircraft`): 1090 MHz Mode S / extended squitter carrier. */
export const ADSB_CARRIER_HZ = 1_090_000_000

/**
 * Plausible rtl_433 `freq` range in Hz: the RTL-SDR R820T/R828D tuning range,
 * 24 MHz to 1766 MHz. A value outside it is not a reception frequency.
 */
export const RTL433_FREQ_MIN_HZ = 24_000_000
export const RTL433_FREQ_MAX_HZ = 1_766_000_000

/**
 * Usable fraction of rtl_433's input span: `freq` must lie within
 * 0.8 × inputSampleRate / 2 of the binding's single target (1.024 Msps: ±409 600 Hz).
 * Unknown rate or target: the estimate is ignored and the target is used.
 */
export const RTL433_FREQ_USABLE_FRACTION = 0.8

/** rtl_433 reports `freq` in MHz (`-M level`); finite number only. */
const Rtl433FreqMhz = z.number().finite()

/** AIS output types whose payload may carry the radio channel letter or number. */
const AIS_TYPES: ReadonlySet<string> = new Set(["ship"])

/** Rounded Hz in (0, 10^12], else undefined (req 5.4). */
export function validHz(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined
	const hz = Math.round(value)
	return hz > 0 && hz <= MAX_PROVENANCE_HZ ? hz : undefined
}

/**
 * AIS radio channel to carrier. Accepted spellings: `A`/`a`/`1`/`87B` and
 * `B`/`b`/`2`/`88B` (strings), and the numbers 1 and 2.
 */
export function aisChannelHz(value: unknown): number | undefined {
	switch (value) {
		case "A":
		case "a":
		case "1":
		case "87B":
		case 1:
			return AIS_CHANNEL_A_HZ
		case "B":
		case "b":
		case "2":
		case "88B":
		case 2:
			return AIS_CHANNEL_B_HZ
		default:
			return undefined
	}
}

function payloadField(data: unknown, key: string): unknown {
	if (data === null || typeof data !== "object") return undefined
	return (data as Record<string, unknown>)[key]
}

function singleTarget(
	binding: ActivityDecoderBinding | null,
): number | undefined {
	const targets = binding?.targetFrequenciesHz
	if (!Array.isArray(targets) || targets.length !== 1) return undefined
	return validHz(targets[0])
}

/**
 * rtl_433's `freq` (MHz) in Hz, or undefined when absent, malformed, outside
 * [RTL433_FREQ_MIN_HZ, RTL433_FREQ_MAX_HZ], or when the target or input rate is unknown or
 * `freq` lies farther than RTL433_FREQ_USABLE_FRACTION × rate / 2 from the target.
 */
export function rtl433PayloadHz(
	data: unknown,
	targetHz: number | undefined,
	inputSampleRateHz?: number,
): number | undefined {
	const parsed = Rtl433FreqMhz.safeParse(payloadField(data, "freq"))
	if (!parsed.success) return undefined
	const hz = Math.round(parsed.data * 1e6)
	if (hz < RTL433_FREQ_MIN_HZ || hz > RTL433_FREQ_MAX_HZ) return undefined
	if (
		targetHz === undefined ||
		inputSampleRateHz === undefined ||
		!Number.isFinite(inputSampleRateHz) ||
		!(inputSampleRateHz > 0)
	)
		return undefined
	const reach = (RTL433_FREQ_USABLE_FRACTION * inputSampleRateHz) / 2
	if (Math.abs(hz - targetHz) > reach) return undefined
	return hz
}

/**
 * Pure provenance per the WG3 design table (req 5.1-5.5): a frequency the
 * decoder reports in its payload wins, else the binding's single target.
 * A bound readsb (`aircraft`) is the 1090 MHz carrier; rtl_433 (`signal`) uses
 * its `freq` estimate (rtl433PayloadHz). A scanner probe names its channel as
 * its single target. At most one payload read; never inspects other decoded content. May throw on a
 * hostile payload (throwing getter); the ingress guards it.
 */
export function resolveProvenance(
	output: DecoderOutput,
	binding: ActivityDecoderBinding | null,
): DecodeProvenance {
	let hz: number | undefined
	const type = output.type
	if (PAYLOAD_HZ_TYPES.has(type))
		hz = validHz(payloadField(output.data, "frequency"))
	else if (AIS_TYPES.has(type))
		hz = aisChannelHz(payloadField(output.data, "channel"))
	// A bound readsb (a decoder WaveKit runs) hears 1090 MHz; unbound stays unknown.
	else if (type === "aircraft" && binding !== null) hz = ADSB_CARRIER_HZ
	else if (type === "signal")
		hz = rtl433PayloadHz(
			output.data,
			singleTarget(binding),
			binding?.inputSampleRateHz,
		)
	hz ??= singleTarget(binding)
	if (binding === null && hz === undefined)
		return { sourceId: null, frequency: null }
	const sourceId =
		binding !== null && typeof binding.sourceId === "string"
			? binding.sourceId
			: null
	if (hz === undefined) return { sourceId, frequency: null }
	const trust = binding?.tuningTrust
	return {
		sourceId,
		frequency: {
			hz,
			basis: "channel",
			tuningTrust:
				trust === "commanded" || trust === "relay" ? trust : "unverified",
		},
	}
}
