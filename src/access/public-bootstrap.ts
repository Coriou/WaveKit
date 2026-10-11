import { accessBootstrapDtoSchema } from "@wavekit/api-types"
import type { AccessBootstrapDto } from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"

function unavailable(): never {
	throw new WaveKitError(
		"Access bootstrap is unavailable",
		"ACCESS_UNAVAILABLE",
	)
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return unavailable()
	return value as Record<string, unknown>
}

/** Copies a fixed allowlist, never enumerating internal config or invoking toJSON. */
export function projectAccessBootstrap(source: unknown): AccessBootstrapDto {
	try {
		const input = record(source)
		const access = record(input["access"])
		const capabilities = record(input["capabilities"])
		const projected = accessBootstrapDtoSchema.safeParse({
			version: input["version"],
			apiOrigin: input["apiOrigin"],
			webSocketUrl: input["webSocketUrl"],
			analogAudioOrigin: input["analogAudioOrigin"],
			digitalAudioOrigin: input["digitalAudioOrigin"],
			access: {
				mode: access["mode"],
				sessionAvailable: access["sessionAvailable"],
				pairingAvailable: access["pairingAvailable"],
			},
			capabilities: {
				analogAudioAvailable: capabilities["analogAudioAvailable"],
				digitalAudioAvailable: capabilities["digitalAudioAvailable"],
				operatorDataAvailable: capabilities["operatorDataAvailable"],
			},
		})
		if (!projected.success) return unavailable()
		return projected.data
	} catch {
		return unavailable()
	}
}

/** The canonical schema measures the complete encoded body before delivery. */
export function encodeAccessBootstrap(source: unknown): string {
	return JSON.stringify(projectAccessBootstrap(source))
}
