/**
 * Receiver control REST calls, validated with Zod at the boundary: the tuner setting writes
 * (src/api/routes/tuner.ts, each answering the new TunerState), GET /api/receiver-capabilities/:id
 * (src/api/routes/receiver-capabilities.ts) and GET /api/tuner-relay (mounted only with a relay).
 * The schemas keep the fields the web app reads and tolerate additions from newer cores.
 */
import { z } from "zod/v4"
import type {
	TunerControlMode,
	TunerDirectSampling,
	TunerGainMode,
	TunerState,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError } from "./api-client.ts"

const int = z.number().int()

export const tunerStateSchema = z.object({
	sourceId: z.string().min(1),
	frequency: int,
	sampleRate: int,
	gainMode: z.enum(["manual", "agc"]),
	gain: int,
	ppm: int,
	agcMode: z.boolean(),
	biasTee: z.boolean(),
	directSampling: z.enum(["off", "i", "q"]),
	offsetTuning: z.boolean(),
	ifGain: int,
	tunerIfGain: z.object({ stage: int, gain: int }).nullable(),
	testMode: z.boolean(),
	rtlXtal: int.optional(),
	tunerXtal: int.optional(),
	tunerGainIndex: int.optional(),
	controlMode: z.enum(["internal", "external"]),
	lastCommandAt: z.string().optional(),
	lastError: z.string().optional(),
	commandCount: int,
	// Field names stay open strings: a newer core may list a field this build does not know.
	unknownFields: z.array(z.string()).optional(),
	declaredOnlyFields: z.array(z.string()).optional(),
})

const rangeSchema = z.object({ min: int, max: int })
const ruleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("integer-range"), min: int, max: int }),
	z.object({
		kind: z.literal("integer-ranges"),
		ranges: z.array(rangeSchema).min(1),
	}),
	z.object({ kind: z.literal("enum"), values: z.array(z.string()).min(1) }),
	z.object({ kind: z.literal("boolean") }),
	z.object({ kind: z.literal("uint16-pair") }),
])

const controlSchema = z.object({
	id: z.string(),
	unit: z.string(),
	command: z.object({
		state: z.literal("implemented"),
		validation: z.object({ rule: ruleSchema }),
	}),
	transport: z.object({
		state: z.enum(["applicable", "not-applicable"]),
		reason: z.string(),
	}),
})

const peerHeaderSchema = z.union([
	z.object({
		state: z.literal("advertised"),
		tunerType: int,
		gainCount: int,
	}),
	z.object({
		state: z.enum(["unknown", "not-applicable"]),
		reason: z.string(),
	}),
])

const gainTableSchema = z.union([
	z.object({
		state: z.literal("suggested"),
		tuner: z.string(),
		valuesTenthsDb: z.array(int).min(1),
	}),
	z.object({
		state: z.enum(["unknown", "not-applicable"]),
		reason: z.string(),
	}),
])

const sampleRatePresetsSchema = z.union([
	z.object({
		state: z.literal("suggested"),
		valuesHz: z.array(int.positive()),
	}),
	z.object({ state: z.literal("not-applicable"), reason: z.string() }),
])

export const receiverCapabilitiesSchema = z.object({
	schemaVersion: z.literal(1),
	sourceId: z.string().min(1),
	sessionId: z.string().nullable(),
	snapshotId: z.string(),
	capturedAt: z.string(),
	source: z.object({
		type: z.string(),
		kind: z.string(),
		format: z.string(),
	}),
	connection: z.enum(["connecting", "connected", "disconnected", "ended"]),
	peerHeader: peerHeaderSchema,
	controls: z.array(controlSchema),
	declaredStream: z.object({
		sampleRateHz: int.positive(),
		centerFrequencyHz: int.positive().nullable(),
	}),
	sampleRatePresets: sampleRatePresetsSchema.optional(),
	gainTable: gainTableSchema.optional(),
})

/** What the web app keeps of a capabilities snapshot. */
export type ReceiverCaps = z.infer<typeof receiverCapabilitiesSchema>
export type ReceiverControlCaps = z.infer<typeof controlSchema>
export type ReceiverGainTableCaps = z.infer<typeof gainTableSchema>

export const tunerRelaySchema = z.object({
	enabled: z.boolean(),
	listening: z.boolean(),
	port: int,
	sourceId: z.string().optional(),
	clientsConnected: int,
	controlClientId: z.string().optional(),
	controlClientRemote: z.string().optional(),
	controlPolicy: z.enum(["exclusive", "shared"]),
})

export type TunerRelayView = z.infer<typeof tunerRelaySchema>

/** The tuner writes the Receiver island makes, by route. */
export type ReceiverSetting =
	| { key: "gain"; value: number }
	| { key: "gainMode"; value: TunerGainMode }
	| { key: "agcMode"; value: boolean }
	| { key: "sampleRate"; value: number }
	| { key: "ppm"; value: number }
	| { key: "biasTee"; value: boolean }
	| { key: "directSampling"; value: TunerDirectSampling }
	| { key: "offsetTuning"; value: boolean }
	| { key: "controlMode"; value: TunerControlMode }

export type ReceiverSettingKey = ReceiverSetting["key"]

/** Route and body of each write (the core's request shapes, src/api/routes/tuner.ts). */
export function settingRequest(setting: ReceiverSetting): {
	route: string
	body: Record<string, unknown>
} {
	switch (setting.key) {
		case "gain":
			return { route: "gain", body: { tenthsDb: setting.value } }
		case "gainMode":
			return { route: "gain-mode", body: { mode: setting.value } }
		case "agcMode":
			return { route: "agc", body: { enabled: setting.value } }
		case "sampleRate":
			return { route: "sample-rate", body: { hz: setting.value } }
		case "ppm":
			return { route: "ppm", body: { ppm: setting.value } }
		case "biasTee":
			return { route: "bias-tee", body: { enabled: setting.value } }
		case "directSampling":
			return { route: "direct-sampling", body: { mode: setting.value } }
		case "offsetTuning":
			return { route: "offset-tuning", body: { enabled: setting.value } }
		case "controlMode":
			return { route: "control-mode", body: { mode: setting.value } }
	}
}

function invalid(method: string, path: string, body: unknown): ApiError {
	return new ApiError({
		status: 200,
		code: "RESPONSE_INVALID",
		message: `Unexpected answer from ${path}`,
		body,
		method,
		path,
	})
}

export interface ReceiverApi {
	/** Sends one setting; resolves with the core's validated new TunerState. */
	write(sourceId: string, setting: ReceiverSetting): Promise<TunerState>
	capabilities(sourceId: string, signal?: AbortSignal): Promise<ReceiverCaps>
	/** Null when the core runs without a relay (the route is not mounted: 404). */
	relay(signal?: AbortSignal): Promise<TunerRelayView | null>
}

export function createReceiverApi(api: ApiClient): ReceiverApi {
	return {
		async write(sourceId, setting) {
			const { route, body } = settingRequest(setting)
			const path = `/api/tuner/${encodeURIComponent(sourceId)}/${route}`
			const answer = await api.post<unknown>(path, body)
			const parsed = tunerStateSchema.safeParse(answer)
			if (!parsed.success) throw invalid("POST", path, answer)
			return parsed.data as TunerState
		},
		async capabilities(sourceId, signal) {
			const path = `/api/receiver-capabilities/${encodeURIComponent(sourceId)}`
			const answer = await api.get<unknown>(path, signal ? { signal } : {})
			const parsed = receiverCapabilitiesSchema.safeParse(answer)
			if (!parsed.success || parsed.data.sourceId !== sourceId)
				throw invalid("GET", path, answer)
			return parsed.data
		},
		async relay(signal) {
			const path = "/api/tuner-relay"
			try {
				const answer = await api.get<unknown>(path, signal ? { signal } : {})
				const parsed = tunerRelaySchema.safeParse(answer)
				if (!parsed.success) throw invalid("GET", path, answer)
				return parsed.data
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null
				throw error
			}
		},
	}
}
