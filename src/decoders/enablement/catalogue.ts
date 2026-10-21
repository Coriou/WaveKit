import type { DecoderConfig } from "../../config.js"
import type { BandRegion } from "../band-region.js"
import type { LoraRegion } from "../builtin/lora-meshtastic.js"
import { CATALOGUE_TYPES } from "./contract.js"
import type { CatalogueType } from "./contract.js"

const catalogueConfigs = new WeakSet<DecoderConfig>()

// Band-plan regions and Meshtastic regulatory regions use different names.
const loraRegions = {
	EU: "EU_868",
	US: "US",
	CA: "US",
	AU: "ANZ",
	NZ: "ANZ",
	JP: "JP",
	CN: "CN",
} as const satisfies Readonly<Record<BandRegion, LoraRegion>>

// LongFast: N = floor((band max - min) / 250 kHz), zero-based slot =
// djb2("LongFast") % N = 130429955 % N; centre = min + 125 kHz + slot * 250 kHz.
// Min MHz / N / slot: EU_868 869.4/1/0; US 902/104/19;
// ANZ 915/52/19; JP 920.5/12/11; CN 470/160/35.
const loraPrimaryFrequencies: Readonly<
	Record<(typeof loraRegions)[BandRegion], number>
> = {
	EU_868: 869_525_000,
	US: 906_875_000,
	ANZ: 919_875_000,
	JP: 923_375_000,
	CN: 478_875_000,
}

/** Fresh options keep mutations of one derived config isolated from later builds. */
export function CATALOGUE_DEFAULT_OPTIONS(
	region: BandRegion,
): Readonly<Record<CatalogueType, Record<string, unknown>>> {
	return {
		readsb: {},
		"ais-catcher": {},
		acarsdec: { frequencies: [131_550_000, 131_725_000] },
		dumpvdl2: { frequencies: [136_650_000, 136_700_000, 136_975_000] },
		rtl433: {},
		direwolf: {},
		"multimon-ng": {},
		"dsd-fme": {},
		"lora-meshtastic": {
			region: loraRegions[region],
			preset: "LongFast",
			frequency: loraPrimaryFrequencies[loraRegions[region]],
			channelKey: "AQ==",
		},
	}
}

export function buildDecoderCatalogue(
	configs: readonly DecoderConfig[],
	opts: { enabled: boolean; region: BandRegion },
): DecoderConfig[] {
	const result = [...configs]
	if (!opts.enabled) return result
	const claimed = new Set(configs.flatMap(config => [config.id, config.type]))
	const defaults = CATALOGUE_DEFAULT_OPTIONS(opts.region)
	for (const type of CATALOGUE_TYPES) {
		if (claimed.has(type)) continue
		const config: DecoderConfig = {
			id: type,
			type,
			enabled: true,
			options: defaults[type],
			useChannelizer: false,
		}
		catalogueConfigs.add(config)
		result.push(config)
	}
	return result
}

export function isCatalogueConfig(config: DecoderConfig): boolean {
	return catalogueConfigs.has(config)
}
