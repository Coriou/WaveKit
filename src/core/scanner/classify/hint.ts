import type { BandRegion } from "@wavekit/api-types"
import { LORA_REGION_RANGES_HZ } from "../../../decoders/band-defaults.js"
import type { ScannerClass, ScannerHint, ScanRange } from "../types.js"
import { CLASS_HYPOTHESES, familyOf } from "./classifier.js"

/**
 * Scanner-redesign requirement 3.11: a display-only hint for a weak discovery. Pure, computed on
 * read, never stored and never a label. First matching rule wins; any invalid input gives none.
 */
export interface HintInput {
	frequencyHz: number | undefined
	bandwidthHz: number | undefined
	class: ScannerClass | string | undefined
	/** The latest observation's track had `flags.burst` or at most 4 blocks. */
	short: boolean | undefined
	region: BandRegion | undefined
	ranges: readonly ScanRange[] | undefined
}

const REGIONS: ReadonlySet<string> = new Set<BandRegion>([
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
])
const NARROW_MAX_HZ = 25_000
const LORA_MIN_HZ = 100_000
const LORA_MAX_HZ = 150_000
const EU_LORA_SLOTS = [
	LORA_REGION_RANGES_HZ.EU_433,
	LORA_REGION_RANGES_HZ.EU_868,
] as const
const EU_ISM_DEVICE: readonly (readonly [number, number])[] = [
	[433_050_000, 434_790_000],
	[863_000_000, 870_000_000],
]
const LPD_FIRST_HZ = 433_075_000
const LPD_SPACING_HZ = 25_000
const LPD_LAST_INDEX = 68
const LPD_TOLERANCE_HZ = 3000
const VOICE_CLASSES: ReadonlySet<string> = new Set([
	"analog-fm",
	"fsk4-12k5",
	"wideband",
])

function finitePositive(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x) && x > 0
}

function isClass(x: unknown): x is ScannerClass {
	return (
		typeof x === "string" &&
		x !== "unknown" &&
		Object.hasOwn(CLASS_HYPOTHESES, x)
	)
}

function onLpdRaster(f: number): boolean {
	const n = Math.round((f - LPD_FIRST_HZ) / LPD_SPACING_HZ)
	if (n < 0 || n > LPD_LAST_INDEX) return false
	return Math.abs(f - (LPD_FIRST_HZ + n * LPD_SPACING_HZ)) <= LPD_TOLERANCE_HZ
}

function coveringRangeLists(
	ranges: readonly ScanRange[],
	f: number,
	protocol: string,
): boolean {
	for (const r of ranges) {
		if (typeof r !== "object" || r === null) continue
		if (!(f >= r.startHz && f <= r.endHz)) continue
		const list = r.protocols
		if (Array.isArray(list) && list.includes(protocol as never)) return true
	}
	return false
}

export function hintOf(input: HintInput): ScannerHint | undefined {
	if (typeof input !== "object" || input === null) return undefined
	const { frequencyHz: f, bandwidthHz: w, class: cls, short } = input
	if (!finitePositive(f) || !finitePositive(w)) return undefined
	if (!isClass(cls) || typeof short !== "boolean") return undefined
	if (typeof input.region !== "string" || !REGIONS.has(input.region))
		return undefined
	if (!Array.isArray(input.ranges)) return undefined
	const ranges = input.ranges
	if (input.region === "EU") {
		if (w >= LORA_MIN_HZ && w <= LORA_MAX_HZ && short) {
			const lo = f - w / 2
			const hi = f + w / 2
			if (EU_LORA_SLOTS.some(s => lo >= s.minHz && hi <= s.maxHz)) return "lora"
		}
		if (w <= NARROW_MAX_HZ) {
			if (
				(cls === "ook-burst" || short) &&
				EU_ISM_DEVICE.some(([a, b]) => f >= a && f <= b)
			)
				return "ism-device"
			if (VOICE_CLASSES.has(cls) && !short && onLpdRaster(f))
				return "analog-voice"
		}
	}
	const first = CLASS_HYPOTHESES[cls][0]
	if (
		first !== undefined &&
		familyOf(first.protocol) === "digital-voice" &&
		!coveringRangeLists(ranges, f, first.protocol)
	)
		return undefined
	return cls
}
