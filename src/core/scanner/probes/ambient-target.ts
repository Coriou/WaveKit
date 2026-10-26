/**
 * Configured target of an ambient decoder (web-gaps-7 design "Ambient identify", Targets).
 * Pure: reproduces ScannerService.ambientTarget (cccf665f, scanner-service.ts:3119-3143)
 * exactly for the existing ambient types and adds every target frequency (`targetsHz`) and
 * whether the decoder hears its own device (`external`).
 */
import { SCANNER_AIS_CHANNEL_HZ } from "@wavekit/api-types"
import type {
	DecoderConfig,
	DecoderInputType,
} from "../../../decoders/types.js"
import type { AmbientTarget } from "./ambient.js"
import { ADSB_HZ } from "./confirm/readsb.js"

export interface AmbientTargetDeps {
	/** Source used when the config names none (SourceFanoutRouter.getDefaultSourceId). */
	defaultSourceId: () => string | null | undefined
	/** Current centre of a source (SourceManager.getCaps(sourceId)?.centerFreq). */
	caps: (sourceId: string) => { centerFreq?: number | undefined } | undefined
	/** Input kind of the running decoder (DecoderManager.getDecoder(id)?.caps.input). */
	inputKind: (decoderId: string) => DecoderInputType | undefined
}

/** acarsdec adapter default (src/decoders/builtin/acarsdec.ts:282-285). */
const ACARS_DEFAULT_HZ: readonly number[] = [131_550_000, 131_725_000]
/** dumpvdl2 adapter default (src/decoders/builtin/dumpvdl2.ts:416-420). */
const VDL2_DEFAULT_HZ: readonly number[] = [
	136_650_000, 136_700_000, 136_975_000,
]

const NEW_TYPES = new Set([
	"ais-catcher",
	"acarsdec",
	"dumpvdl2",
	"lora-meshtastic",
	"readsb",
])

/**
 * Most target frequencies a new-type decoder may name. Each decode costs one tolerance scan of
 * the list (16 compares) plus one trust lookup at the decode's own frequency, so per-message
 * work stays O(16) regardless of config; a longer list is no target at all (fail closed).
 */
export const AMBIENT_MAX_TARGETS = 16

const isHz = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v > 0

/** undefined: no list; null: oversized (refused before any element is read, no default). */
function numberList(v: unknown): number[] | null | undefined {
	if (!Array.isArray(v) || v.length === 0) return undefined
	if (v.length > AMBIENT_MAX_TARGETS) return null
	const out = v.filter(isHz)
	return out.length === v.length ? out : undefined
}

/** Target frequencies of a new ambient type; null when none can be known. */
function newTypeTargets(
	cfg: DecoderConfig,
	centre: () => number | undefined,
): number[] | null {
	const own = numberList(cfg.frequencies)
	if (own === null) return null
	const listed = own ?? numberList(cfg.options["frequencies"])
	if (listed !== undefined) return listed
	const pinned = cfg.options["channelHz"]
	if (isHz(pinned)) return [pinned]
	if (cfg.options["followCenter"] === true) {
		const actual = cfg.options["inputCenterFreq"] ?? centre()
		if (isHz(actual)) return [actual]
	}
	const single = cfg.options["frequency"]
	if (cfg.type === "lora-meshtastic") {
		// followCenter decodes the capture centre (lora-meshtastic.ts:155-158, 334-361).
		if (cfg.options["followCenter"] === true) {
			const injected = cfg.options["inputCenterFreq"]
			if (isHz(injected)) return [injected]
			const c = centre()
			return c !== undefined ? [c] : null
		}
		return isHz(single) ? [single] : null
	}
	if (isHz(single)) return [single]
	if (cfg.type === "ais-catcher") return Object.values(SCANNER_AIS_CHANNEL_HZ)
	if (cfg.type === "acarsdec") return [...ACARS_DEFAULT_HZ]
	if (cfg.type === "dumpvdl2") return [...VDL2_DEFAULT_HZ]
	// readsb listens on the Mode S downlink only.
	if (cfg.type === "readsb") return [ADSB_HZ]
	return null
}

export function resolveAmbientTargets(
	cfg: DecoderConfig,
	deps: AmbientTargetDeps,
): AmbientTarget | null {
	const sourceId = cfg.sourceId ?? deps.defaultSourceId()
	if (!sourceId) return null
	// Only a positively known non-external input kind is a WaveKit source (unknown: fail closed).
	const kind = deps.inputKind(cfg.id)
	const external = kind === undefined || kind === "external"
	if (NEW_TYPES.has(cfg.type)) {
		const targetsHz = newTypeTargets(cfg, () => deps.caps(sourceId)?.centerFreq)
		const hz = targetsHz?.[0]
		if (!targetsHz || hz === undefined) return null
		if (targetsHz.length > AMBIENT_MAX_TARGETS) return null
		return { sourceId, hz, targetsHz, external }
	}
	// Existing types: scanner-service.ts:3119-3143 (cccf665f), unchanged.
	const nxdn =
		cfg.type === "dsd-fme"
			? cfg.options["mode"] === "nxdn48"
				? ("nxdn48" as const)
				: ("nxdn96" as const)
			: undefined
	const withNxdn = (hz: number): AmbientTarget =>
		nxdn
			? { sourceId, hz, nxdn, targetsHz: [hz], external }
			: { sourceId, hz, targetsHz: [hz], external }
	const listed =
		cfg.frequencies?.[0] ??
		(typeof cfg.options["frequency"] === "number"
			? cfg.options["frequency"]
			: undefined)
	if (listed !== undefined) return withNxdn(listed)
	const centre = deps.caps(sourceId)?.centerFreq
	if (centre === undefined) return null
	const offset =
		typeof cfg.options["offsetHz"] === "number" ? cfg.options["offsetHz"] : 0
	return withNxdn(centre + offset)
}
