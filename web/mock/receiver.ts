/**
 * Receiver controls for the mock core, kept apart from server.ts: the tuner setting writes
 * (src/api/routes/tuner.ts), GET /api/receiver-capabilities[/:sourceId]
 * (src/api/routes/receiver-capabilities.ts) and GET /api/tuner-relay, as a real core answers them
 * for an RTL-SDR with an R820T tuner behind rtl_tcp. Writes validate like TunerController (same
 * codes, statuses and messages) and emit what the core emits: `tuner:command-sent` (origin `rest`),
 * then `tuner:state-changed`; a control-mode change sends `tuner:control-mode-changed` first.
 * A sample-rate change restarts the stream (server.ts bumps the spectrum epoch).
 * GET/PUT /api/tuner-band-gain serve the per-band gain table (the core's defaults, kept in memory).
 * Type stripping only: no enums, parameter properties or namespaces.
 */
import { randomBytes } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import {
	BAND_GAIN_LABEL_MAX_LENGTH,
	BAND_GAIN_MAX_ENTRIES,
	BAND_GAIN_MAX_HZ,
	BAND_GAIN_MAX_TENTHS_DB,
	BAND_GAIN_MIN_HZ,
	BAND_GAIN_MIN_TENTHS_DB,
	RECEIVER_SAMPLE_RATE_PRESETS_HZ,
	RTL_TUNER_GAIN_TABLES,
} from "@wavekit/api-types"
import type {
	BandGainEntry,
	BandGainSettings,
	BandGainSettingsView,
	ReceiverCapabilities,
	ReceiverControlEvidence,
	TunerControlMode,
	TunerDirectSampling,
	TunerGainMode,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"

export interface ReceiverMockContext {
	sourceId: string
	tuner: TunerState
	broadcast: (channel: string, type: string, data: unknown) => void
	/** The core restarted the IQ stream at a new rate. */
	restartStream: () => void
	/** Retunes through the mock's frequency route logic (PATCH config with `frequency`). */
	retune: (hz: number) => Promise<void>
	/** An operator (REST) tuner write was sent: the scanner mock pauses a running sweep. */
	onCommand?: () => void
}

export interface ReceiverMockControls {
	/**
	 * Simulates an rtl_tcp client (SDR++) on the relay taking the tuner (`active`) or leaving.
	 * Like TunerController.syncExternalControl: leaving gives control back only if the relay took it.
	 */
	relayClient(active: boolean, remote?: string): void
	/** The current capabilities snapshot (tests). */
	capabilities(): ReceiverCapabilities
	/**
	 * After an operator frequency write (POST frequency, PATCH config): with "apply to my tuning"
	 * on, writes the band gain at `hz` (snapped to the R820T table) and reports it as
	 * TunerState.bandGain, or puts the operator's own gain back on leaving the bands, as
	 * TunerController.applyOperatorBandGain does. Scanner hops in the mock never apply band gains.
	 */
	operatorRetuned(hz: number): void
}

/** R820T on rtl_tcp: tuner type 5 in the header, 29 gains (RTL_TUNER_GAIN_TABLES[5]). */
const TUNER_TYPE = 5
const R820T = RTL_TUNER_GAIN_TABLES[TUNER_TYPE]
const RELAY_PORT = 1234

const RANGES = {
	frequency: { min: 24_000_000, max: 1_900_000_000 },
	sampleRate: { min: 225_001, max: 3_200_000 },
	gain: { min: 0, max: 500 },
	ppm: { min: -500, max: 500 },
	uint32: { min: 0, max: 0xffffffff },
} as const
const RTL_RATE_RANGES = [
	{ min: 225_001, max: 300_000 },
	{ min: 900_001, max: 3_200_000 },
] as const

type Rule = ReceiverControlEvidence["command"]["validation"]["rule"]
type ControlRow = [
	ReceiverControlEvidence["id"],
	ReceiverControlEvidence["unit"],
	number,
	Rule,
]

/** TUNER_REST_COMMAND_POLICY (src/core/tuner-controller.ts), in its order. */
const POLICY: readonly ControlRow[] = [
	["frequency", "Hz", 0x01, { kind: "integer-range", ...RANGES.frequency }],
	[
		"sampleRate",
		"Hz",
		0x02,
		{
			kind: "integer-ranges",
			ranges: [{ ...RTL_RATE_RANGES[0] }, { ...RTL_RATE_RANGES[1] }],
		},
	],
	["gainMode", "enum", 0x03, { kind: "enum", values: ["manual", "agc"] }],
	["gain", "tenthsDb", 0x04, { kind: "integer-range", ...RANGES.gain }],
	["ppm", "ppm", 0x05, { kind: "integer-range", ...RANGES.ppm }],
	["ifGain", "rawInteger", 0x06, { kind: "integer-range", ...RANGES.uint32 }],
	["testMode", "boolean", 0x07, { kind: "boolean" }],
	["agcMode", "boolean", 0x08, { kind: "boolean" }],
	["directSampling", "enum", 0x09, { kind: "enum", values: ["off", "i", "q"] }],
	["offsetTuning", "boolean", 0x0a, { kind: "boolean" }],
	["rtlXtal", "Hz", 0x0b, { kind: "integer-range", ...RANGES.uint32 }],
	["tunerXtal", "Hz", 0x0c, { kind: "integer-range", ...RANGES.uint32 }],
	["gainIndex", "index", 0x0d, { kind: "integer-range", ...RANGES.uint32 }],
	["biasTee", "boolean", 0x0e, { kind: "boolean" }],
	["tunerIfGain", "stageRawPair", 0x0f, { kind: "uint16-pair" }],
]

const token = () => randomBytes(16).toString("hex")

class MockTunerError extends Error {
	readonly statusCode: number
	readonly code: string
	readonly errorName: string
	constructor(
		message: string,
		code: string,
		statusCode: number,
		errorName: string,
	) {
		super(message)
		this.code = code
		this.statusCode = statusCode
		this.errorName = errorName
	}
}

const validation = (message: string) =>
	new MockTunerError(
		message,
		"TUNER_VALIDATION_ERROR",
		400,
		"TunerValidationError",
	)

function checkRange(
	name: string,
	value: number,
	range: { min: number; max: number },
): void {
	if (!Number.isFinite(value) || !Number.isInteger(value))
		throw validation(`${name} must be an integer`)
	if (value < range.min || value > range.max)
		throw validation(
			`${name} out of range: ${value} (expected ${range.min}-${range.max})`,
		)
}

const intBody = (key: string) => ({
	type: "object",
	properties: { [key]: { type: "integer" } },
	required: [key],
	additionalProperties: false,
})
const boolBody = {
	type: "object",
	properties: { enabled: { type: "boolean" } },
	required: ["enabled"],
	additionalProperties: false,
}
const enumBody = (values: readonly string[]) => ({
	type: "object",
	properties: { mode: { type: "string", enum: [...values] } },
	required: ["mode"],
	additionalProperties: false,
})

export function registerReceiverMock(
	app: FastifyInstance,
	ctx: ReceiverMockContext,
): ReceiverMockControls {
	const { tuner, sourceId } = ctx
	const sourceIncarnation = token()
	let sessionId = token()
	let headerAt = new Date().toISOString()
	let controlOrigin: "user" | "relay" = "user"
	const relay = {
		clients: 0,
		remote: undefined as string | undefined,
		bytesSent: 0,
	}

	const notFound = (reply: FastifyReply, id: string) =>
		reply.code(404).send({
			error: "TunerSourceNotFoundError",
			code: "TUNER_SOURCE_NOT_FOUND",
			message: `Tuner source not found: ${id}`,
		})

	const stateChanged = () =>
		ctx.broadcast("tuner", "tuner:state-changed", {
			sourceId,
			state: { ...tuner },
		})

	const setControlMode = (mode: TunerControlMode, origin: "user" | "relay") => {
		controlOrigin = origin
		if (tuner.controlMode === mode) return
		tuner.controlMode = mode
		delete tuner.bandGain
		ctx.broadcast("tuner", "tuner:control-mode-changed", { sourceId, mode })
		stateChanged()
	}

	const forControl = () => {
		if (tuner.controlMode === "external")
			throw new MockTunerError(
				`Cannot send commands: control released to external tuner for ${sourceId}`,
				"TUNER_CONTROL_EXTERNAL",
				409,
				"TunerControlModeError",
			)
	}

	/** One rtl_tcp command written: the core's bookkeeping and events (sendCommand). */
	const sent = (command: string, value: number, apply: () => void) => {
		apply()
		tuner.commandCount += 1
		tuner.lastCommandAt = new Date().toISOString()
		delete tuner.lastError
		ctx.broadcast("tuner", "tuner:command-sent", {
			sourceId,
			command,
			value,
			origin: "rest",
		})
		stateChanged()
		ctx.onCommand?.()
	}

	const known = (field: NonNullable<TunerState["unknownFields"]>[number]) => {
		if (!tuner.unknownFields) return
		const rest = tuner.unknownFields.filter(f => f !== field)
		if (rest.length > 0) tuner.unknownFields = rest
		else delete tuner.unknownFields
	}

	/** The operator's gain from before a band changed it; null when it was unknown. */
	let gainBeforeBand:
		| { gainMode: TunerGainMode; gain: number }
		| null
		| undefined
	let applyingBand = false
	/** Any gain write drops the reported band gain; an operator's own also the saved gain. */
	const gainWritten = () => {
		delete tuner.bandGain
		if (!applyingBand) gainBeforeBand = undefined
	}

	const writers = {
		gain(tenthsDb: number) {
			forControl()
			checkRange("gain", tenthsDb, RANGES.gain)
			sent("set-gain", tenthsDb, () => {
				gainWritten()
				tuner.gain = tenthsDb
				known("gain")
			})
		},
		gainMode(mode: TunerGainMode) {
			forControl()
			sent("set-gain-mode", mode === "manual" ? 1 : 0, () => {
				gainWritten()
				tuner.gainMode = mode
				known("gainMode")
			})
		},
		agcMode(enabled: boolean) {
			forControl()
			sent("set-agc-mode", enabled ? 1 : 0, () => {
				tuner.agcMode = enabled
				known("agcMode")
			})
		},
		sampleRate(hz: number) {
			forControl()
			checkRange("sampleRate", hz, RANGES.sampleRate)
			if (!RTL_RATE_RANGES.some(r => hz >= r.min && hz <= r.max))
				throw validation(
					`sampleRate ${hz} is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
				)
			const changed = hz !== tuner.sampleRate
			sent("set-sample-rate", hz, () => {
				tuner.sampleRate = hz
				if (tuner.declaredOnlyFields) {
					const rest = tuner.declaredOnlyFields.filter(f => f !== "sampleRate")
					if (rest.length > 0) tuner.declaredOnlyFields = rest
					else delete tuner.declaredOnlyFields
				}
				known("sampleRate")
			})
			if (changed) {
				// the stream restarts: a new session, its header seen again
				sessionId = token()
				headerAt = new Date().toISOString()
				ctx.restartStream()
			}
		},
		ppm(ppm: number) {
			forControl()
			checkRange("ppm", ppm, RANGES.ppm)
			sent("set-freq-correction", ppm < 0 ? 0xffffffff + ppm + 1 : ppm, () => {
				tuner.ppm = ppm
				known("ppm")
			})
		},
		ifGain(gain: number) {
			forControl()
			checkRange("ifGain", gain, RANGES.uint32)
			sent("set-if-gain", gain, () => {
				tuner.ifGain = gain
				known("ifGain")
			})
		},
		testMode(enabled: boolean) {
			forControl()
			sent("set-test-mode", enabled ? 1 : 0, () => {
				tuner.testMode = enabled
				known("testMode")
			})
		},
		biasTee(enabled: boolean) {
			forControl()
			sent("set-bias-tee", enabled ? 1 : 0, () => {
				tuner.biasTee = enabled
				known("biasTee")
			})
		},
		directSampling(mode: TunerDirectSampling) {
			forControl()
			sent(
				"set-direct-sampling",
				mode === "off" ? 0 : mode === "i" ? 1 : 2,
				() => {
					tuner.directSampling = mode
					known("directSampling")
				},
			)
		},
		offsetTuning(enabled: boolean) {
			forControl()
			sent("set-offset-tuning", enabled ? 1 : 0, () => {
				tuner.offsetTuning = enabled
				known("offsetTuning")
			})
		},
	}

	type Params = { Params: { sourceId: string } }
	const route = <B>(
		path: string,
		body: object,
		apply: (body: B) => void | Promise<void>,
	) =>
		app.post<Params & { Body: B }>(
			`/api/tuner/:sourceId/${path}`,
			{ schema: { body } },
			async (request, reply) => {
				if (request.params.sourceId !== sourceId)
					return notFound(reply, request.params.sourceId)
				try {
					await apply(request.body as B)
					return { ...tuner }
				} catch (error) {
					return sendError(reply, error)
				}
			},
		)

	const sendError = (reply: FastifyReply, error: unknown) => {
		if (error instanceof MockTunerError)
			return reply.code(error.statusCode).send({
				error: error.errorName,
				code: error.code,
				message: error.message,
			})
		throw error
	}

	// `gain` (tenths of a dB); `tenthsDb` is the core's deprecated alias, both different is a 400
	route<{ gain?: number; tenthsDb?: number }>(
		"gain",
		{
			type: "object",
			properties: { gain: { type: "integer" }, tenthsDb: { type: "integer" } },
			minProperties: 1,
			additionalProperties: false,
		},
		b => {
			if (
				b.gain !== undefined &&
				b.tenthsDb !== undefined &&
				b.gain !== b.tenthsDb
			)
				throw validation(
					'Invalid request body; expected {"gain": integer, gain in tenths of a dB (0-500, e.g. 372 = 37.2 dB)}',
				)
			writers.gain(b.gain ?? b.tenthsDb ?? 0)
		},
	)
	route<{ mode: TunerGainMode }>("gain-mode", enumBody(["manual", "agc"]), b =>
		writers.gainMode(b.mode),
	)
	route<{ enabled: boolean }>("agc", boolBody, b => writers.agcMode(b.enabled))
	route<{ hz: number }>("sample-rate", intBody("hz"), b =>
		writers.sampleRate(b.hz),
	)
	route<{ ppm: number }>("ppm", intBody("ppm"), b => writers.ppm(b.ppm))
	route<{ gain: number }>("if-gain", intBody("gain"), b =>
		writers.ifGain(b.gain),
	)
	route<{ enabled: boolean }>("test-mode", boolBody, b =>
		writers.testMode(b.enabled),
	)
	route<{ enabled: boolean }>("bias-tee", boolBody, b =>
		writers.biasTee(b.enabled),
	)
	route<{ mode: TunerDirectSampling }>(
		"direct-sampling",
		enumBody(["off", "i", "q"]),
		b => writers.directSampling(b.mode),
	)
	route<{ enabled: boolean }>("offset-tuning", boolBody, b =>
		writers.offsetTuning(b.enabled),
	)
	// The core's control-mode route never refuses: releasing or reclaiming is always allowed.
	route<{ mode: TunerControlMode }>(
		"control-mode",
		enumBody(["internal", "external"]),
		b => setControlMode(b.mode, "user"),
	)

	type ConfigBody = Partial<{
		frequency: number
		sampleRate: number
		gainMode: TunerGainMode
		gain: number
		ppm: number
		agcMode: boolean
		biasTee: boolean
		directSampling: TunerDirectSampling
		offsetTuning: boolean
		ifGain: number
		testMode: boolean
		controlMode: TunerControlMode
	}>
	const integer = { type: "integer" }
	const boolean = { type: "boolean" }
	app.patch<Params & { Body: ConfigBody }>(
		"/api/tuner/:sourceId/config",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: {
						frequency: integer,
						sampleRate: integer,
						gainMode: { type: "string", enum: ["manual", "agc"] },
						gain: integer,
						ppm: integer,
						agcMode: boolean,
						biasTee: boolean,
						directSampling: { type: "string", enum: ["off", "i", "q"] },
						offsetTuning: boolean,
						ifGain: integer,
						testMode: boolean,
						controlMode: { type: "string", enum: ["internal", "external"] },
					},
				},
			},
		},
		async (request, reply) => {
			if (request.params.sourceId !== sourceId)
				return notFound(reply, request.params.sourceId)
			const u = request.body
			try {
				// TunerController.configure: command fields need internal control unless the same
				// body reclaims it; equal values are skipped; the order is the controller's.
				const commands = Object.keys(u).some(k => k !== "controlMode")
				if (
					commands &&
					tuner.controlMode === "external" &&
					u.controlMode !== "internal"
				)
					forControl()
				if (u.controlMode === "internal") setControlMode("internal", "user")
				if (u.frequency !== undefined && u.frequency !== tuner.frequency) {
					checkRange("frequency", u.frequency, RANGES.frequency)
					// the frequency route applies the band gain (operatorRetuned)
					await ctx.retune(u.frequency)
				}
				if (u.sampleRate !== undefined && u.sampleRate !== tuner.sampleRate)
					writers.sampleRate(u.sampleRate)
				if (u.gainMode !== undefined && u.gainMode !== tuner.gainMode)
					writers.gainMode(u.gainMode)
				if (u.gain !== undefined && u.gain !== tuner.gain) writers.gain(u.gain)
				if (u.ppm !== undefined && u.ppm !== tuner.ppm) writers.ppm(u.ppm)
				if (u.ifGain !== undefined && u.ifGain !== tuner.ifGain)
					writers.ifGain(u.ifGain)
				if (u.testMode !== undefined && u.testMode !== tuner.testMode)
					writers.testMode(u.testMode)
				if (u.agcMode !== undefined && u.agcMode !== tuner.agcMode)
					writers.agcMode(u.agcMode)
				if (u.biasTee !== undefined && u.biasTee !== tuner.biasTee)
					writers.biasTee(u.biasTee)
				if (
					u.directSampling !== undefined &&
					u.directSampling !== tuner.directSampling
				)
					writers.directSampling(u.directSampling)
				if (
					u.offsetTuning !== undefined &&
					u.offsetTuning !== tuner.offsetTuning
				)
					writers.offsetTuning(u.offsetTuning)
				if (u.controlMode === "external") setControlMode("external", "user")
				return { ...tuner }
			} catch (error) {
				return sendError(reply, error)
			}
		},
	)

	// --- receiver capabilities: one coherent rtl_tcp item, as the core's provider builds it ---

	const capabilities = (): ReceiverCapabilities => {
		const capturedAt = new Date()
		const lastSampleAt = new Date(capturedAt.getTime() - 12)
		return {
			schemaVersion: 1,
			sourceId,
			sourceIncarnation,
			sessionId,
			snapshotId: token(),
			capturedAt: capturedAt.toISOString(),
			source: { type: "rtl_tcp", kind: "iq", format: "U8_IQ" },
			connection: "connected",
			delivery: {
				state: "streaming",
				lastSampleAt: lastSampleAt.toISOString(),
				sampleAgeMs: 12,
				timeoutMs: 10000,
			},
			peerHeader: {
				state: "advertised",
				provenance: "rtl-peer-header",
				sessionId,
				observedAt: headerAt,
				tunerType: TUNER_TYPE,
				gainCount: R820T?.valuesTenthsDb.length ?? 0,
			},
			controls: POLICY.map(([id, unit, opcode, rule]) => ({
				id,
				unit,
				command: {
					state: "implemented",
					opcode,
					validation: { authority: "admitted-rest-argument-policy", rule },
				},
				transport: { state: "applicable", reason: "rtl-tcp" },
				physical: { state: "unknown", reason: "no-qualified-readback" },
				currentValue: {
					state: "unknown",
					reason: "session-qualified-command-evidence-not-provided",
				},
			})),
			declaredStream: {
				provenance: "source-config-or-core-metadata",
				sampleRateHz: tuner.sampleRate,
				centerFrequencyHz: tuner.frequency,
			},
			sampleRatePresets: {
				state: "suggested",
				provenance: "wavekit-rtl-rate-presets",
				valuesHz: [...RECEIVER_SAMPLE_RATE_PRESETS_HZ],
			},
			gainTable: R820T
				? {
						state: "suggested",
						provenance: "librtlsdr-tuner-gains",
						tuner: R820T.tuner,
						valuesTenthsDb: [...R820T.valuesTenthsDb],
					}
				: { state: "unknown", reason: "unlisted-tuner-type" },
		}
	}

	const capsError = (
		reply: FastifyReply,
		status: number,
		code: string,
		message: string,
	) =>
		reply
			.code(status)
			.header("Cache-Control", "no-store")
			.send({ error: "ReceiverCapabilitiesError", code, message })

	app.get<{ Params: { sourceId: string } }>(
		"/api/receiver-capabilities/:sourceId",
		async (request, reply) => {
			reply.header("Cache-Control", "no-store")
			if (request.params.sourceId !== sourceId)
				return capsError(
					reply,
					404,
					"RECEIVER_CAPABILITIES_NOT_FOUND",
					"Receiver source not found",
				)
			return capabilities()
		},
	)
	app.get<{ Querystring: { after?: string; limit?: string } }>(
		"/api/receiver-capabilities",
		async (request, reply) => {
			reply.header("Cache-Control", "no-store")
			const { after, limit } = request.query
			if (limit !== undefined && !/^(?:[1-9]|1[0-6])$/.test(limit))
				return capsError(
					reply,
					400,
					"RECEIVER_CAPABILITIES_INVALID_REQUEST",
					"Invalid receiver capabilities request",
				)
			const items =
				after !== undefined && after >= sourceId ? [] : [capabilities()]
			return { schemaVersion: 1, items, nextAfter: null }
		},
	)

	// --- per-band gain: the core's defaults (src/core/band-gain-schema.ts), replaced by each PUT ---

	let bandGain: BandGainSettings = defaultBandGain()
	let bandGainProvenance: BandGainSettingsView["provenance"] = "config"
	const bandGainView = (): BandGainSettingsView => ({
		settings: structuredClone(bandGain),
		provenance: bandGainProvenance,
		limits: {
			maxEntries: BAND_GAIN_MAX_ENTRIES,
			minHz: BAND_GAIN_MIN_HZ,
			maxHz: BAND_GAIN_MAX_HZ,
			minGainTenthsDb: BAND_GAIN_MIN_TENTHS_DB,
			maxGainTenthsDb: BAND_GAIN_MAX_TENTHS_DB,
			labelMaxLength: BAND_GAIN_LABEL_MAX_LENGTH,
		},
	})
	app.get("/api/tuner-band-gain", async () => bandGainView())
	app.put<{ Body: unknown }>(
		"/api/tuner-band-gain",
		{ schema: { body: { type: "object" } } },
		async (request, reply) => {
			const parsed = parseBandGain(request.body)
			if (typeof parsed === "string")
				return reply.code(400).send({
					error: "BandGainSettingsError",
					code: "BAND_GAIN_INVALID",
					message: parsed,
				})
			bandGain = parsed
			bandGainProvenance = "runtime"
			return bandGainView()
		},
	)

	// --- per-band gain on operator retunes (TunerController.applyOperatorBandGain) ---

	const operatorRetuned = (hz: number) => {
		if (!bandGain.applyToMyTuning || tuner.controlMode !== "internal") return
		applyingBand = true
		try {
			applyBandGain(hz)
		} finally {
			applyingBand = false
		}
	}
	const applyBandGain = (hz: number) => {
		const entry = bandGain.entries.find(e => hz >= e.minHz && hz <= e.maxHz)
		const target =
			entry && entry.gain !== "keep"
				? nearestStep(entry.gain, R820T?.valuesTenthsDb ?? null)
				: null
		if (target !== null) {
			const unknown = tuner.unknownFields ?? []
			gainBeforeBand ??=
				unknown.includes("gain") || unknown.includes("gainMode")
					? null
					: { gainMode: tuner.gainMode, gain: tuner.gain }
			if (tuner.gainMode !== "manual" || unknown.includes("gainMode"))
				writers.gainMode("manual")
			if (tuner.gain !== target || unknown.includes("gain"))
				writers.gain(target)
			tuner.bandGain = {
				tenthsDb: target,
				owner: "user",
				...(entry?.label !== undefined ? { label: entry.label } : {}),
			}
			stateChanged()
			return
		}
		const saved = gainBeforeBand
		gainBeforeBand = undefined
		if (!saved) return
		if (saved.gainMode === "agc") {
			writers.gain(saved.gain)
			writers.gainMode("agc")
		} else {
			if (tuner.gainMode !== "manual") writers.gainMode("manual")
			writers.gain(saved.gain)
		}
	}

	// --- tuner relay: listening on 1234, exclusive control, nobody connected unless simulated ---

	app.get("/api/tuner-relay", async (): Promise<TunerRelayStatus> => {
		const status: TunerRelayStatus = {
			enabled: true,
			listening: true,
			host: "0.0.0.0",
			port: RELAY_PORT,
			sourceId,
			sourceConnected: true,
			sourceKind: "iq",
			sourceFormat: "U8_IQ",
			compatibility: "ok",
			clientsConnected: relay.clients,
			controlPolicy: "exclusive",
			bytesSent: relay.bytesSent,
			bytesReceived: 0,
			rtlTcpHeader: {
				magic: "RTL0",
				tunerType: TUNER_TYPE,
				gainCount: R820T?.valuesTenthsDb.length ?? 0,
			},
		}
		if (relay.remote !== undefined) {
			status.controlClientId = "relay-1"
			status.controlClientRemote = relay.remote
		}
		return status
	})

	return {
		operatorRetuned,
		relayClient(active, remote = "192.168.1.23:51544") {
			if (active) {
				relay.clients = 1
				relay.remote = remote
				if (tuner.controlMode !== "external")
					setControlMode("external", "relay")
				return
			}
			relay.clients = 0
			relay.remote = undefined
			if (tuner.controlMode === "external" && controlOrigin === "relay")
				setControlMode("internal", "relay")
		},
		capabilities,
	}
}

/** The core's default table (DEFAULT_BAND_GAIN_ENTRIES): 868 and 915 MHz ISM at 37.2 dB, the rest keep. */
export function defaultBandGain(): BandGainSettings {
	return {
		applyToMyTuning: false,
		entries: [
			{ minHz: 144_000_000, maxHz: 148_000_000, gain: "keep", label: "2 m" },
			{ minHz: 420_000_000, maxHz: 450_000_000, gain: "keep", label: "70 cm" },
			{
				minHz: 863_000_000,
				maxHz: 870_000_000,
				gain: 372,
				label: "868 MHz ISM",
			},
			{
				minHz: 902_000_000,
				maxHz: 928_000_000,
				gain: 372,
				label: "915 MHz ISM",
			},
			{
				minHz: 1_085_000_000,
				maxHz: 1_095_000_000,
				gain: "keep",
				label: "ADS-B",
			},
		],
	}
}

/** The supported step nearest `tenthsDb` (the lower on a tie), as the core's nearestGainStep. */
function nearestStep(
	tenthsDb: number,
	steps: readonly number[] | null,
): number {
	if (!steps || steps.length === 0) return tenthsDb
	let best = steps[0] ?? tenthsDb
	for (const step of steps)
		if (
			Math.abs(step - tenthsDb) < Math.abs(best - tenthsDb) ||
			(Math.abs(step - tenthsDb) === Math.abs(best - tenthsDb) && step < best)
		)
			best = step
	return best
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

const isHz = (v: unknown): v is number =>
	Number.isInteger(v) &&
	(v as number) >= BAND_GAIN_MIN_HZ &&
	(v as number) <= BAND_GAIN_MAX_HZ

/** PUT /api/tuner-band-gain's rules (BandGainSettingsSchema); the core's 400 message on a refusal. */
function parseBandGain(body: unknown): BandGainSettings | string {
	const bad = (where: string) =>
		`Invalid band gain settings at ${where}; expected {"applyToMyTuning": boolean, "entries": [{"minHz": integer Hz, "maxHz": integer Hz, "gain": tenths of a dB or "keep", "label"?: string}]}. ` +
		`Ranges are inclusive (${BAND_GAIN_MIN_HZ}-${BAND_GAIN_MAX_HZ} Hz), minHz < maxHz, no overlaps, at most ${BAND_GAIN_MAX_ENTRIES} entries, gain ` +
		`${BAND_GAIN_MIN_TENTHS_DB}-${BAND_GAIN_MAX_TENTHS_DB} tenths, label at most ${BAND_GAIN_LABEL_MAX_LENGTH} printable characters`
	if (
		!isObject(body) ||
		Object.keys(body).some(k => k !== "applyToMyTuning" && k !== "entries")
	)
		return bad("body")
	if (typeof body["applyToMyTuning"] !== "boolean")
		return bad("applyToMyTuning")
	const raw = body["entries"]
	if (!Array.isArray(raw) || raw.length > BAND_GAIN_MAX_ENTRIES)
		return bad("entries")
	const entries: BandGainEntry[] = []
	for (const [i, e] of raw.entries()) {
		if (
			!isObject(e) ||
			Object.keys(e).some(k => !["minHz", "maxHz", "gain", "label"].includes(k))
		)
			return bad(`entries.${i}`)
		const { minHz, maxHz, gain, label } = e
		if (!isHz(minHz)) return bad(`entries.${i}.minHz`)
		if (!isHz(maxHz) || minHz >= maxHz) return bad(`entries.${i}.maxHz`)
		if (
			gain !== "keep" &&
			!(
				Number.isInteger(gain) &&
				(gain as number) >= BAND_GAIN_MIN_TENTHS_DB &&
				(gain as number) <= BAND_GAIN_MAX_TENTHS_DB
			)
		)
			return bad(`entries.${i}.gain`)
		if (
			label !== undefined &&
			(typeof label !== "string" ||
				label.length < 1 ||
				label.length > BAND_GAIN_LABEL_MAX_LENGTH ||
				!/^[\x20-\x7e]+$/.test(label))
		)
			return bad(`entries.${i}.label`)
		for (const [j, other] of entries.entries())
			if (minHz <= other.maxHz && other.minHz <= maxHz)
				return bad(
					`${i}: entries ${j} and ${i} overlap (ranges are inclusive and must not overlap)`,
				)
		entries.push({
			minHz,
			maxHz,
			gain: gain as BandGainEntry["gain"],
			...(label === undefined ? {} : { label: label as string }),
		})
	}
	return { applyToMyTuning: body["applyToMyTuning"], entries }
}
