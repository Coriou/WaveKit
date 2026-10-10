/**
 * Runtime scanner settings (spec § 12.1 GET/PATCH /api/scanner/settings,
 * plan D4): config merged with persisted runtime overrides, with the
 * provenance of every leaf and the bounds the UI may offer.
 */
import {
	RuntimeSettingsOverridesSchema,
	type RuntimeSettingsOverrides,
} from "./store/persistence.js"
import {
	ScannerConfigSchema,
	sourceScannerConfig,
	type SourceConfig,
} from "../../config.js"
import type { ScannerSettings } from "./types.js"

export type ScannerSettingProvenance = "config" | "runtime" | "default"

export interface ScannerSettingBounds {
	type: "number" | "integer" | "boolean" | "string"
	min?: number
	max?: number
	enum?: string[]
}

interface NumericBounds {
	type: "number" | "integer"
	min: number
	max: number
}

/** Runtime-safe numeric keys (spec § 12.1); the config schema uses the same limits. */
const NUMERIC_BOUNDS = {
	cpuBudgetCores: { type: "number", min: 0.1, max: 64 },
	"maxProbes.offset": { type: "integer", min: 0, max: 16 },
	"maxProbes.channel": { type: "integer", min: 0, max: 64 },
	"detection.integrationMs": { type: "number", min: 5, max: 1000 },
	"detection.faTargetPerMhzMin": { type: "number", min: 0.01, max: 1000 },
	"detection.hysteresisDb": { type: "number", min: 0, max: 20 },
	"detection.minSurfaceBlocks": { type: "integer", min: 1, max: 20 },
	"storage.maxRecordingsMb": { type: "integer", min: 1, max: 1_000_000 },
	"storage.maxEvidenceMb": { type: "integer", min: 1, max: 100_000 },
	"storage.maxJournalMb": { type: "integer", min: 1, max: 10_000 },
	"storage.maxAgeDays": { type: "integer", min: 1, max: 3650 },
	"storage.discoveryMaxAgeDays": { type: "integer", min: 1, max: 3650 },
	"storage.minFreeDiskMb": { type: "integer", min: 0, max: 1_000_000 },
	"storage.maxDiscoveries": { type: "integer", min: 1, max: 1_000_000 },
	"storage.maxCapturesMb": { type: "integer", min: 1, max: 100_000 },
	"ws.maxMessagesPerSecond": { type: "integer", min: 1, max: 100 },
	"ws.spectrumHz": { type: "number", min: 0.5, max: 25 },
	"ws.spectrumBins": { type: "integer", min: 128, max: 2048 },
} as const satisfies Record<string, NumericBounds>

export const SCANNER_SETTINGS_BOUNDS: Readonly<
	Record<string, ScannerSettingBounds>
> = {
	...NUMERIC_BOUNDS,
	"detection.sensitivity": { type: "string", enum: ["low", "normal", "high"] },
	"passive.<sourceId>": { type: "boolean" },
}

/**
 * PATCH /api/scanner/settings body. It is Task 16's RuntimeSettingsOverridesSchema (settings.json)
 * itself, not a copy: whatever settings.json loads, a later PATCH re-parses without error, and
 * every accepted PATCH reloads. NUMERIC_BOUNDS above mirrors its limits for the GET view; the
 * "SCANNER_SETTINGS_BOUNDS agree" test fails if they drift.
 */
export const ScannerSettingsPatchSchema = RuntimeSettingsOverridesSchema

export interface EffectiveScannerSettings {
	settings: ScannerSettings
	passiveBySource: Record<string, boolean>
	/** Dotted leaf path ("detection.integrationMs", "passive.<sourceId>") → origin. */
	provenance: Record<string, ScannerSettingProvenance>
}

type Tree = Record<string, unknown>

function isTree(value: unknown): value is Tree {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Leaf [path, value] pairs of a plain object tree (arrays and null are leaves). */
function leaves(value: unknown, prefix = ""): [string, unknown][] {
	if (!isTree(value)) return [[prefix, value]]
	return Object.entries(value).flatMap(([key, child]) =>
		leaves(child, prefix ? `${prefix}.${key}` : key),
	)
}

function readPath(tree: Tree, path: string): unknown {
	let node: unknown = tree
	for (const part of path.split(".")) {
		if (!isTree(node)) return undefined
		node = node[part]
	}
	return node
}

function writePath(tree: Tree, path: string, value: unknown): void {
	const parts = path.split(".")
	const leaf = parts.pop()
	if (leaf === undefined) return
	let node = tree
	for (const part of parts) {
		const child = node[part]
		if (isTree(child)) {
			node = child
		} else {
			const created: Tree = {}
			node[part] = created
			node = created
		}
	}
	node[leaf] = value
}

const DEFAULTS: ScannerSettings = ScannerConfigSchema.parse({})

/**
 * Config + runtime overrides. A configured value equal to its default is
 * reported as "default": it is indistinguishable after parsing and behaves
 * identically.
 */
export function mergeScannerSettings(input: {
	config: ScannerSettings
	sources: readonly Pick<SourceConfig, "id" | "scanner">[]
	overrides: RuntimeSettingsOverrides
}): EffectiveScannerSettings {
	const settings = structuredClone(input.config)
	const tree = settings as unknown as Tree
	const provenance: Record<string, ScannerSettingProvenance> = {}
	for (const [path, value] of leaves(input.config)) {
		provenance[path] =
			value === readPath(DEFAULTS as unknown as Tree, path)
				? "default"
				: "config"
	}
	const { passive, ...rest } = input.overrides
	for (const [path, value] of leaves(rest)) {
		if (value === undefined || path === "") continue
		writePath(tree, path, value)
		provenance[path] = "runtime"
	}
	const passiveBySource: Record<string, boolean> = {}
	for (const source of input.sources) {
		const override = passive?.[source.id]
		const configured = sourceScannerConfig(source).passive
		passiveBySource[source.id] =
			settings.passive.enabled && (override ?? configured)
		provenance[`passive.${source.id}`] =
			override !== undefined
				? "runtime"
				: source.scanner !== undefined
					? "config"
					: "default"
	}
	return { settings, passiveBySource, provenance }
}

/** Applies a validated PATCH to the persisted overrides; throws ZodError when invalid. */
export function applySettingsPatch(
	current: RuntimeSettingsOverrides,
	patch: RuntimeSettingsOverrides,
): RuntimeSettingsOverrides {
	const valid = ScannerSettingsPatchSchema.parse(patch)
	const { passive, ...rest } = valid
	const next = structuredClone(current) as Tree
	for (const [path, value] of leaves(rest)) {
		if (value !== undefined && path !== "") writePath(next, path, value)
	}
	if (passive !== undefined) {
		next["passive"] = { ...(current.passive ?? {}), ...passive }
	}
	return ScannerSettingsPatchSchema.parse(next)
}
