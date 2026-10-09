import type {
	AircraftState,
	AircraftTrackerStats,
	BranchTelemetry,
	ContainerResources,
	DecoderAssignment,
	DecoderCaps,
	DecoderLastError,
	DecoderOutput,
	DecoderStats,
	FanoutSnapshot,
	LiveAudioConfig,
	LiveAudioStatus,
	ResourceAlert,
	SdrHostDongleInfo,
	SdrHostRtlTcpStatus,
	SdrHostRtlmuxStatus,
	SdrHostSampling,
	SourceActivity,
	SourceBackpressure,
	SourceCaps,
	SourceRateMismatch,
	TunerRelayCommandHistoryEntry,
	TunerRelayStatus,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import type {
	AircraftSnapshot,
	AudioPreset,
	CoreComponent,
	CoreStatus,
	DecoderRow,
	PresetMap,
	ResourceView,
	SdrHostView,
	SourceRow,
	WsEvent,
	BandAssessment,
	DecoderSuspension,
	RowHealth,
} from "./types.js"

// ---------- primitives ----------

export type Obj = Record<string, unknown>
export function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}
export function isStr(v: unknown): v is string {
	return typeof v === "string"
}
export function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v)
}
export function isBool(v: unknown): v is boolean {
	return typeof v === "boolean"
}
function isStrOrNull(v: unknown): v is string | null {
	return v === null || isStr(v)
}
function isNumOrNull(v: unknown): v is number | null {
	return v === null || isNum(v)
}
function oneOf<T extends string>(values: readonly T[]): (v: unknown) => v is T {
	return (v: unknown): v is T =>
		isStr(v) && (values as readonly string[]).includes(v)
}

export interface Guarded<T> {
	value: T
	rejected: number
}

export function guardList<T>(
	v: unknown,
	guard: (x: unknown) => T | undefined,
): Guarded<T[]> | undefined {
	if (!Array.isArray(v)) return undefined
	const value: T[] = []
	let rejected = 0
	for (const x of v) {
		const g = guard(x)
		if (g === undefined) rejected++
		else value.push(g)
	}
	return { value, rejected }
}

function listOf<T>(v: unknown, guard: (x: unknown) => T | undefined): T[] {
	return guardList(v, guard)?.value ?? []
}

function strList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter(isStr) : []
}

/** Copy the listed keys whose values pass `test`; others are dropped (never fatal). */
function pick<K extends string, V>(
	o: Obj,
	keys: readonly K[],
	test: (v: unknown) => v is V,
): Partial<Record<K, V>> {
	const out: Partial<Record<K, V>> = {}
	for (const k of keys) {
		const v = o[k]
		if (test(v)) out[k] = v
	}
	return out
}

// ---------- decoders ----------

const isKnownHealth = oneOf<Exclude<RowHealth, "unknown">>([
	"running",
	"idle",
	"faulted",
	"restarting",
])
/** R70: a new or malformed health value keeps the row and reads "unknown" (rendered ?). */
function readHealth(v: unknown): RowHealth {
	return isKnownHealth(v) ? v : "unknown"
}
const isTransition = oneOf<"suspending" | "resuming">([
	"suspending",
	"resuming",
])

function guardSuspension(v: unknown): DecoderSuspension | undefined {
	if (!isObj(v)) return undefined
	const reasonCode = v["reasonCode"]
	const since = v["since"]
	return isStr(reasonCode) && isStr(since) ? { reasonCode, since } : undefined
}
const isInput = oneOf<DecoderCaps["input"]>(["audio_pcm", "iq", "external"])
const isOutFmt = oneOf<DecoderCaps["output"]>([
	"jsonl",
	"nmea",
	"beast",
	"text",
])
const isPattern = oneOf<DecoderCaps["integrationPattern"]>([
	"pure_consumer",
	"network_producer",
	"external_sdr",
])

export function guardDecoderCaps(v: unknown): DecoderCaps | undefined {
	if (!isObj(v)) return undefined
	const input = v["input"]
	const output = v["output"]
	const integrationPattern = v["integrationPattern"]
	if (!isInput(input) || !isOutFmt(output) || !isPattern(integrationPattern))
		return undefined
	const rates = v["preferredSampleRates"]
	return {
		input,
		output,
		integrationPattern,
		...pick(v, ["wantsExclusiveSource"] as const, isBool),
		...(Array.isArray(rates)
			? { preferredSampleRates: rates.filter(isNum) }
			: {}),
	}
}

function guardStats(v: unknown): DecoderStats | undefined {
	if (!isObj(v)) return undefined
	const bytesIn = v["bytesIn"]
	const eventsOut = v["eventsOut"]
	const errors = v["errors"]
	if (!isNum(bytesIn) || !isNum(eventsOut) || !isNum(errors)) return undefined
	return { bytesIn, eventsOut, errors }
}

const isFrequency = (v: unknown): v is number => isNum(v) && v > 0

const isVerdict = oneOf<BandAssessment["verdict"]>([
	"in-band",
	"out-of-band",
	"unknown",
])

/** R84: a string verdict this CLI does not know reads "unknown"; any other malformed field is dropped. */
function guardBandAssessment(v: unknown): BandAssessment | undefined {
	if (!isObj(v)) return undefined
	const verdict = v["verdict"]
	if (!isStr(verdict)) return undefined
	const targets = v["targetsHz"]
	return {
		verdict: isVerdict(verdict) ? verdict : "unknown",
		...pick(v, ["reasonCode", "basis"] as const, isStr),
		...(Array.isArray(targets) &&
		targets.length > 0 &&
		targets.every(isFrequency)
			? { targetsHz: targets }
			: {}),
		...pick(v, ["captureCenterHz", "windowHalfWidthHz"] as const, isFrequency),
	}
}

const isErrorKind = oneOf<DecoderLastError["kind"]>(["error", "exit"])

function guardLastError(v: unknown): DecoderLastError | undefined {
	if (!isObj(v)) return undefined
	const kind = v["kind"]
	const message = v["message"]
	const at = v["at"]
	if (!isErrorKind(kind) || !isStr(message) || !isStr(at)) return undefined
	return { kind, message, at }
}

/** Also the `decoder:status` payload. `rateAssessment` is deliberately not copied: the CLI prints no verdicts (spec §2, R13). */
export function guardDecoder(v: unknown): DecoderRow | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const type = v["type"]
	const running = v["running"]
	const health = readHealth(v["health"])
	const uptime = v["uptime"]
	const restartCount = v["restartCount"]
	const stats = guardStats(v["stats"])
	if (
		!isStr(id) ||
		!isStr(type) ||
		!isBool(running) ||
		!isNum(uptime) ||
		!isNum(restartCount) ||
		!stats
	) {
		return undefined
	}
	const lastOutputAt = v["lastOutputAt"]
	const caps = guardDecoderCaps(v["caps"])
	const targets = v["targetFrequenciesHz"]
	const lastError = guardLastError(v["lastError"])
	const suspension = guardSuspension(v["suspension"])
	const transition = v["transition"]
	const bandAssessment = guardBandAssessment(v["bandAssessment"])
	return {
		id,
		type,
		running,
		health,
		uptime,
		restartCount,
		stats,
		...pick(v, ["pid", "idleTimeoutMs"] as const, isNum),
		...pick(v, ["version", "sourceId", "deviceSerial"] as const, isStr),
		...(isStrOrNull(lastOutputAt) ? { lastOutputAt } : {}),
		// All or nothing: this list overrides the nominal band table (R15), so a
		// partial or empty one would give a confident wrong in-window answer.
		...(Array.isArray(targets) &&
		targets.length > 0 &&
		targets.every(isFrequency)
			? { targetFrequenciesHz: targets }
			: {}),
		...(lastError ? { lastError } : {}),
		...(caps ? { caps } : {}),
		// R70: core's proposed fields, each optional and typed defensively.
		...pick(v, ["nextRestartAt"] as const, isStr),
		...pick(v, ["desiredRunning", "suspended"] as const, isBool),
		...(suspension ? { suspension } : {}),
		...(bandAssessment ? { bandAssessment } : {}),
		...(transition !== undefined
			? {
					transition: isTransition(transition)
						? transition
						: ("unknown" as const),
				}
			: {}),
	}
}

// ---------- sources ----------

const isActivityState = oneOf<SourceActivity["state"]>([
	"disconnected",
	"waiting",
	"streaming",
	"stale",
	"paused",
	"ended",
])
const isKind = oneOf<SourceCaps["kind"]>(["audio_pcm", "iq", "recording"])
const isSourceFormat = oneOf<SourceCaps["format"]>([
	"S16LE",
	"FLOAT32LE",
	"U8_IQ",
	"S16_IQ",
	"auto",
])

function guardActivity(v: unknown): SourceActivity | undefined {
	if (!isObj(v)) return undefined
	const state = v["state"]
	const lastSampleAt = v["lastSampleAt"]
	const sampleAgeMs = v["sampleAgeMs"]
	const timeoutMs = v["timeoutMs"]
	if (
		!isActivityState(state) ||
		!isStrOrNull(lastSampleAt) ||
		!isNumOrNull(sampleAgeMs) ||
		!isNum(timeoutMs)
	) {
		return undefined
	}
	return { state, lastSampleAt, sampleAgeMs, timeoutMs }
}

export function guardSourceCaps(v: unknown): SourceCaps | undefined {
	if (!isObj(v)) return undefined
	const kind = v["kind"]
	const sampleRate = v["sampleRate"]
	const format = v["format"]
	const exclusive = v["exclusive"]
	if (
		!isKind(kind) ||
		!isNum(sampleRate) ||
		!isSourceFormat(format) ||
		!isBool(exclusive)
	)
		return undefined
	return {
		kind,
		sampleRate,
		format,
		exclusive,
		...pick(v, ["channels", "centerFreq"] as const, isNum),
	}
}

function guardAssignment(v: unknown): DecoderAssignment | undefined {
	if (!isObj(v)) return undefined
	const decoderId = v["decoderId"]
	const sourceId = v["sourceId"]
	const assignedAt = v["assignedAt"]
	if (!isStr(decoderId) || !isStr(sourceId) || !isStr(assignedAt))
		return undefined
	return { decoderId, sourceId, assignedAt }
}

/** R85: kept only when all four fields are valid; a bad one never rejects the row. */
function guardRateMismatch(v: unknown): SourceRateMismatch | undefined {
	if (!isObj(v)) return undefined
	const declaredSampleRateHz = v["declaredSampleRateHz"]
	const measuredSampleRateHz = v["measuredSampleRateHz"]
	const deviation = v["deviation"]
	const since = v["since"]
	if (
		!isNum(declaredSampleRateHz) ||
		!isNum(measuredSampleRateHz) ||
		!isNum(deviation) ||
		!isStr(since)
	)
		return undefined
	return { declaredSampleRateHz, measuredSampleRateHz, deviation, since }
}

export function guardSource(v: unknown): SourceRow | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const connected = v["connected"]
	const consumers = v["consumers"]
	const bytesReceived = v["bytesReceived"]
	const dataRate = v["dataRate"]
	const reconnectAttempts = v["reconnectAttempts"]
	const available = v["available"]
	const caps = guardSourceCaps(v["caps"])
	const assignments = guardList(v["assignments"], guardAssignment)
	if (
		!isStr(id) ||
		!isBool(connected) ||
		!isNum(consumers) ||
		!isNum(bytesReceived) ||
		!isNum(dataRate) ||
		!isNum(reconnectAttempts) ||
		!isBool(available) ||
		!caps ||
		!assignments
	) {
		return undefined
	}
	const rawActivity = v["activity"]
	const activity = guardActivity(rawActivity)
	const rateMismatch = guardRateMismatch(v["rateMismatch"])
	return {
		id,
		connected,
		consumers,
		bytesReceived,
		dataRate,
		reconnectAttempts,
		available,
		caps,
		assignments: assignments.value,
		...pick(v, ["type", "url", "lastError"] as const, isStr),
		...(activity ? { activity } : {}),
		...(!activity && rawActivity !== undefined
			? { activityUnrecognised: true as const }
			: {}),
		...(rateMismatch ? { rateMismatch } : {}),
	}
}

// ---------- tuner + relay ----------

const isGainMode = oneOf<TunerState["gainMode"]>(["manual", "agc"])
const isDirect = oneOf<TunerState["directSampling"]>(["off", "i", "q"])
const isControl = oneOf<TunerState["controlMode"]>(["internal", "external"])
const isStateField = oneOf<TunerStateField>([
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"agcMode",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
])

export function guardTuner(v: unknown): TunerState | undefined {
	if (!isObj(v)) return undefined
	const sourceId = v["sourceId"]
	const frequency = v["frequency"]
	const sampleRate = v["sampleRate"]
	const gainMode = v["gainMode"]
	const gain = v["gain"]
	const ppm = v["ppm"]
	const agcMode = v["agcMode"]
	const biasTee = v["biasTee"]
	const directSampling = v["directSampling"]
	const offsetTuning = v["offsetTuning"]
	const ifGain = v["ifGain"]
	const testMode = v["testMode"]
	const controlMode = v["controlMode"]
	const commandCount = v["commandCount"]
	const unknownFields = Array.isArray(v["unknownFields"])
		? [...new Set(v["unknownFields"].filter(isStateField))]
		: []
	const tig = v["tunerIfGain"]
	const tunerIfGain =
		tig === null
			? null
			: isObj(tig) && isNum(tig["stage"]) && isNum(tig["gain"])
				? { stage: tig["stage"], gain: tig["gain"] }
				: undefined
	if (
		!isStr(sourceId) ||
		!isNum(frequency) ||
		!isNum(sampleRate) ||
		!isGainMode(gainMode) ||
		!isNum(gain) ||
		!isNum(ppm) ||
		!isBool(agcMode) ||
		!isBool(biasTee) ||
		!isDirect(directSampling) ||
		!isBool(offsetTuning) ||
		!isNum(ifGain) ||
		!isBool(testMode) ||
		!isControl(controlMode) ||
		!isNum(commandCount) ||
		tunerIfGain === undefined
	) {
		return undefined
	}
	return {
		sourceId,
		frequency,
		sampleRate,
		gainMode,
		gain,
		ppm,
		agcMode,
		biasTee,
		directSampling,
		offsetTuning,
		ifGain,
		tunerIfGain,
		testMode,
		controlMode,
		commandCount,
		...pick(v, ["rtlXtal", "tunerXtal", "tunerGainIndex"] as const, isNum),
		...pick(v, ["lastCommandAt", "lastError"] as const, isStr),
		// R85: names this CLI does not know are dropped; the rest render as unknown.
		...(unknownFields.length > 0 ? { unknownFields } : {}),
	}
}

const isPolicy = oneOf<TunerRelayStatus["controlPolicy"]>([
	"exclusive",
	"shared",
])
const isCompat = oneOf<NonNullable<TunerRelayStatus["compatibility"]>>([
	"ok",
	"missing-source",
	"unsupported-type",
	"unsupported-kind",
	"unsupported-format",
])

function guardHistoryEntry(
	v: unknown,
): TunerRelayCommandHistoryEntry | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const name = v["name"]
	const value = v["value"]
	const at = v["at"]
	if (!isNum(id) || !isStr(name) || !isNum(value) || !isStr(at))
		return undefined
	return {
		id,
		name,
		value,
		at,
		...pick(v, ["clientId", "clientRemote"] as const, isStr),
	}
}

export function guardRelay(v: unknown): TunerRelayStatus | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const listening = v["listening"]
	const host = v["host"]
	const port = v["port"]
	const clientsConnected = v["clientsConnected"]
	const controlPolicy = v["controlPolicy"]
	const bytesSent = v["bytesSent"]
	const bytesReceived = v["bytesReceived"]
	if (
		!isBool(enabled) ||
		!isBool(listening) ||
		!isStr(host) ||
		!isNum(port) ||
		!isNum(clientsConnected) ||
		!isPolicy(controlPolicy) ||
		!isNum(bytesSent) ||
		!isNum(bytesReceived)
	) {
		return undefined
	}
	const compatibility = v["compatibility"]
	const history = v["commandHistory"]
	const header = v["rtlTcpHeader"]
	return {
		enabled,
		listening,
		host,
		port,
		clientsConnected,
		controlPolicy,
		bytesSent,
		bytesReceived,
		...pick(
			v,
			[
				"sourceId",
				"sourceKind",
				"sourceFormat",
				"compatibilityMessage",
				"controlClientId",
				"controlClientRemote",
				"lastCommand",
				"lastCommandAt",
				"lastError",
			] as const,
			isStr,
		),
		...pick(
			v,
			[
				"maxClients",
				"lastCommandValue",
				"lastFrequency",
				"lastSampleRate",
				"lastGain",
				"lastPpm",
				"commandHistoryLimit",
			] as const,
			isNum,
		),
		...pick(v, ["sourceConnected"] as const, isBool),
		...(isCompat(compatibility) ? { compatibility } : {}),
		...(Array.isArray(history)
			? { commandHistory: listOf(history, guardHistoryEntry) }
			: {}),
		...(isObj(header) &&
		isStr(header["magic"]) &&
		isNum(header["tunerType"]) &&
		isNum(header["gainCount"])
			? {
					rtlTcpHeader: {
						magic: header["magic"],
						tunerType: header["tunerType"],
						gainCount: header["gainCount"],
					},
				}
			: {}),
	}
}

// ---------- fanout ----------

function pickStrOrNull<K extends string>(
	o: Obj,
	keys: readonly K[],
): Partial<Record<K, string | null>> {
	return pick(o, keys, isStrOrNull)
}

function guardBranch(v: unknown): BranchTelemetry | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const backpressureActive = v["backpressureActive"]
	const backpressureEnterCount = v["backpressureEnterCount"]
	const droppedBytesTotal = v["droppedBytesTotal"]
	const droppedChunksTotal = v["droppedChunksTotal"]
	const bufferBytes = v["bufferBytes"]
	const highWaterMark = v["highWaterMark"]
	if (
		!isStr(id) ||
		!isBool(backpressureActive) ||
		!isNum(backpressureEnterCount) ||
		!isNum(droppedBytesTotal) ||
		!isNum(droppedChunksTotal) ||
		!isNum(bufferBytes) ||
		!isNum(highWaterMark)
	) {
		return undefined
	}
	return {
		id,
		backpressureActive,
		backpressureEnterCount,
		droppedBytesTotal,
		droppedChunksTotal,
		bufferBytes,
		highWaterMark,
		...pick(v, ["decoderId", "sourceId"] as const, isStr),
		...pick(v, ["totalBytesWritten"] as const, isNum),
		...pickStrOrNull(v, [
			"backpressureSince",
			"lastBackpressureAt",
			"lastDrainAt",
		] as const),
	}
}

export function guardFanout(v: unknown): FanoutSnapshot | undefined {
	if (!isObj(v)) return undefined
	const timestamp = v["timestamp"]
	const branches = guardList(v["branches"], guardBranch)
	const backpressureActiveCount = v["backpressureActiveCount"]
	const droppedBytesTotal = v["droppedBytesTotal"]
	const droppedChunksTotal = v["droppedChunksTotal"]
	if (
		!isStr(timestamp) ||
		!branches ||
		!isNum(backpressureActiveCount) ||
		!isNum(droppedBytesTotal) ||
		!isNum(droppedChunksTotal)
	) {
		return undefined
	}
	return {
		timestamp,
		branches: branches.value,
		backpressureActiveCount,
		droppedBytesTotal,
		droppedChunksTotal,
		...pick(v, ["totalBytesWritten"] as const, isNum),
	}
}

// ---------- resources ----------

const isCgroup = oneOf<ContainerResources["cgroupVersion"]>([
	"v1",
	"v2",
	"unknown",
])

function guardContainer(v: unknown): ContainerResources | undefined {
	if (!isObj(v)) return undefined
	const available = v["available"]
	const cgroupVersion = v["cgroupVersion"]
	const n = (k: string): number | null | undefined => {
		const x = v[k]
		return isNumOrNull(x) ? x : undefined
	}
	const cpuUsagePercent = n("cpuUsagePercent")
	const cpuThrottledPercent = n("cpuThrottledPercent")
	const memoryUsageBytes = n("memoryUsageBytes")
	const memoryLimitBytes = n("memoryLimitBytes")
	const memoryUsagePercent = n("memoryUsagePercent")
	const oomKillCount = n("oomKillCount")
	if (
		!isBool(available) ||
		!isCgroup(cgroupVersion) ||
		cpuUsagePercent === undefined ||
		cpuThrottledPercent === undefined ||
		memoryUsageBytes === undefined ||
		memoryLimitBytes === undefined ||
		memoryUsagePercent === undefined ||
		oomKillCount === undefined
	) {
		return undefined
	}
	return {
		available,
		cgroupVersion,
		cpuUsagePercent,
		cpuThrottledPercent,
		memoryUsageBytes,
		memoryLimitBytes,
		memoryUsagePercent,
		oomKillCount,
	}
}

function guardRtlTcp(v: unknown): SdrHostRtlTcpStatus | null {
	if (!isObj(v)) return null
	const running = v["running"]
	const pid = v["pid"]
	const restartCount = v["restartCount"]
	const lastRestartAt = v["lastRestartAt"]
	const c = v["config"]
	if (
		!isBool(running) ||
		!isNumOrNull(pid) ||
		!isNum(restartCount) ||
		!isStrOrNull(lastRestartAt)
	)
		return null
	const config =
		isObj(c) &&
		isNum(c["sampleRate"]) &&
		isNum(c["frequency"]) &&
		isNum(c["gain"]) &&
		isBool(c["agc"])
			? {
					sampleRate: c["sampleRate"],
					frequency: c["frequency"],
					gain: c["gain"],
					agc: c["agc"],
				}
			: null
	return { running, pid, restartCount, lastRestartAt, config }
}

function guardRtlmux(v: unknown): SdrHostRtlmuxStatus | null {
	if (!isObj(v)) return null
	const running = v["running"]
	const pid = v["pid"]
	const restartCount = v["restartCount"]
	const lastRestartAt = v["lastRestartAt"]
	const clients = v["clients"]
	const bytesPerSec = v["bytesPerSec"]
	const totalBytesSent = v["totalBytesSent"]
	if (
		!isBool(running) ||
		!isNumOrNull(pid) ||
		!isNum(restartCount) ||
		!isStrOrNull(lastRestartAt) ||
		!isNum(clients) ||
		!isNum(bytesPerSec) ||
		!isNum(totalBytesSent)
	) {
		return null
	}
	const clientDetails = listOf(v["clientDetails"], (x: unknown) =>
		isObj(x) &&
		isNum(x["id"]) &&
		isStr(x["address"]) &&
		isNum(x["bytesDropped"])
			? { id: x["id"], address: x["address"], bytesDropped: x["bytesDropped"] }
			: undefined,
	)
	return {
		running,
		pid,
		restartCount,
		lastRestartAt,
		clients,
		bytesPerSec,
		totalBytesSent,
		clientDetails,
	}
}

function guardDongle(v: unknown): SdrHostDongleInfo | null {
	if (!isObj(v)) return null
	const found = v["found"]
	const vendor = v["vendor"]
	const product = v["product"]
	const serial = v["serial"]
	if (
		!isBool(found) ||
		!isStrOrNull(vendor) ||
		!isStrOrNull(product) ||
		!isStrOrNull(serial)
	)
		return null
	return { found, vendor, product, serial }
}

const isSamplingState = oneOf<SdrHostSampling["state"]>([
	"disconnected",
	"waiting",
	"streaming",
	"stale",
	"unknown",
])
const isRateBasis = oneOf<SdrHostSampling["upstream"]["rateBasis"]>([
	"configured",
	"client-controlled",
])
const isRateStatus = oneOf<SdrHostSampling["upstream"]["rateStatus"]>([
	"nominal",
	"low",
	"unknown",
])
const isReadingState = oneOf<SdrHostSampling["stats"]["state"]>([
	"ok",
	"stale",
	"unavailable",
])
const isResetReason = oneOf<"rtlmux-restart" | "counter-decrease">([
	"rtlmux-restart",
	"counter-decrease",
])
const isStatsError = oneOf<"timeout" | "unreachable" | "http" | "invalid">([
	"timeout",
	"unreachable",
	"http",
	"invalid",
])

/** Spec §6.5 sampling slot: accept only a complete, well-typed SdrHostSampling. */
export function readHostSampling(v: unknown): SdrHostSampling | undefined {
	if (!isObj(v)) return undefined
	const up = v["upstream"]
	const ep = v["epoch"]
	const st = v["stats"]
	if (!isObj(up) || !isObj(ep) || !isObj(st)) return undefined
	const state = v["state"]
	const reason = v["reason"]
	const timeoutMs = v["timeoutMs"]
	const lastSampleAt = v["lastSampleAt"]
	const sampleAgeMs = v["sampleAgeMs"]
	const bytesTotal = up["bytesTotal"]
	const bytesPerSec = up["bytesPerSec"]
	const windowMs = up["windowMs"]
	const expectedBytesPerSec = up["expectedBytesPerSec"]
	const rateBasis = up["rateBasis"]
	const rateStatus = up["rateStatus"]
	const rtlmuxPid = ep["rtlmuxPid"]
	const rtlTcpPid = ep["rtlTcpPid"]
	const startedAt = ep["startedAt"]
	const resets = ep["resets"]
	const lastResetReason = ep["lastResetReason"]
	const statsState = st["state"]
	const observedAt = st["observedAt"]
	const ageMs = st["ageMs"]
	const lastError = st["lastError"]
	if (
		!isSamplingState(state) ||
		!isStrOrNull(reason) ||
		!isNum(timeoutMs) ||
		!isStrOrNull(lastSampleAt) ||
		!isNumOrNull(sampleAgeMs) ||
		!isNumOrNull(bytesTotal) ||
		!isNumOrNull(bytesPerSec) ||
		!isNumOrNull(windowMs) ||
		!isNumOrNull(expectedBytesPerSec) ||
		!isRateBasis(rateBasis) ||
		!isRateStatus(rateStatus) ||
		!isNumOrNull(rtlmuxPid) ||
		!isNumOrNull(rtlTcpPid) ||
		!isStrOrNull(startedAt) ||
		!isNum(resets) ||
		!(lastResetReason === null || isResetReason(lastResetReason)) ||
		!isReadingState(statsState) ||
		!isStrOrNull(observedAt) ||
		!isNumOrNull(ageMs) ||
		!(lastError === null || isStatsError(lastError))
	) {
		return undefined
	}
	return {
		state,
		reason,
		timeoutMs,
		lastSampleAt,
		sampleAgeMs,
		upstream: {
			bytesTotal,
			bytesPerSec,
			windowMs,
			expectedBytesPerSec,
			rateBasis,
			rateStatus,
		},
		epoch: { rtlmuxPid, rtlTcpPid, startedAt, resets, lastResetReason },
		stats: { state: statsState, observedAt, ageMs, lastError },
	}
}

function guardHost(v: unknown): SdrHostView | undefined {
	if (!isObj(v)) return undefined
	const available = v["available"]
	const sourceId = v["sourceId"]
	const apiUrl = v["apiUrl"]
	const uptime = v["uptime"]
	const lastFetchedAt = v["lastFetchedAt"]
	const fetchError = v["fetchError"]
	if (
		!isBool(available) ||
		!isStr(sourceId) ||
		!isStr(apiUrl) ||
		!isNumOrNull(uptime) ||
		!isStrOrNull(lastFetchedAt) ||
		!isStrOrNull(fetchError)
	) {
		return undefined
	}
	const sampling = readHostSampling(v["sampling"])
	return {
		available,
		sourceId,
		apiUrl,
		uptime,
		rtlTcp: guardRtlTcp(v["rtlTcp"]),
		rtlmux: guardRtlmux(v["rtlmux"]),
		dongle: guardDongle(v["dongle"]),
		warnings: strList(v["warnings"]),
		errors: strList(v["errors"]),
		lastFetchedAt,
		fetchError,
		...(sampling ? { sampling } : {}),
	}
}

function guardSourceBackpressure(v: unknown): SourceBackpressure | undefined {
	if (!isObj(v)) return undefined
	const sourceId = v["sourceId"]
	const available = v["available"]
	const bytesDroppedUpstream = v["bytesDroppedUpstream"]
	const totalBytesSent = v["totalBytesSent"]
	const dropRate = v["dropRate"]
	const dropPercent = v["dropPercent"]
	const lastCheckedAt = v["lastCheckedAt"]
	if (
		!isStr(sourceId) ||
		!isBool(available) ||
		!isNum(bytesDroppedUpstream) ||
		!isNum(totalBytesSent) ||
		!isNum(dropRate) ||
		!isNum(dropPercent) ||
		!isStr(lastCheckedAt)
	) {
		return undefined
	}
	return {
		sourceId,
		available,
		bytesDroppedUpstream,
		totalBytesSent,
		dropRate,
		dropPercent,
		lastCheckedAt,
	}
}

export function guardResources(v: unknown): ResourceView | undefined {
	if (!isObj(v)) return undefined
	const timestamp = v["timestamp"]
	const container = guardContainer(v["container"])
	if (!isStr(timestamp) || !container) return undefined
	return {
		timestamp,
		container,
		sdrHosts: listOf(v["sdrHosts"], guardHost),
		sourceBackpressure: listOf(
			v["sourceBackpressure"],
			guardSourceBackpressure,
		),
	}
}

const isAlertType = oneOf<ResourceAlert["type"]>([
	"upstream-drops",
	"container-memory",
	"container-cpu",
	"sdr-host-error",
])
const isSeverity = oneOf<ResourceAlert["severity"]>(["warning", "critical"])

export function guardAlert(v: unknown): ResourceAlert | undefined {
	if (!isObj(v)) return undefined
	const type = v["type"]
	const severity = v["severity"]
	const message = v["message"]
	const timestamp = v["timestamp"]
	if (
		!isAlertType(type) ||
		!isSeverity(severity) ||
		!isStr(message) ||
		!isStr(timestamp)
	)
		return undefined
	return {
		type,
		severity,
		message,
		timestamp,
		...pick(v, ["sourceId"] as const, isStr),
	}
}

// ---------- live audio ----------

const isModulation = oneOf<LiveAudioConfig["modulation"]>([
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
])
const isNoise = oneOf<LiveAudioConfig["noiseReduction"]>([
	"off",
	"voice",
	"noaa-apt",
	"narrow-band",
])
const isAudioFormat = oneOf<LiveAudioConfig["audioFormat"]>(["s16le", "f32le"])
const isTau = (v: unknown): v is 50 | 75 => v === 50 || v === 75
const isPipeline = oneOf<LiveAudioStatus["pipelineHealth"]>([
	"running",
	"starting",
	"stopped",
	"error",
])

export function guardLiveAudioConfig(v: unknown): LiveAudioConfig | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const httpPort = v["httpPort"]
	const modulation = v["modulation"]
	const bandwidth = v["bandwidth"]
	const squelch = v["squelch"]
	const noiseReduction = v["noiseReduction"]
	const lowPass = v["lowPass"]
	const highPass = v["highPass"]
	const gain = v["gain"]
	const deEmphasis = v["deEmphasis"]
	const deEmphasisTau = v["deEmphasisTau"]
	const audioFormat = v["audioFormat"]
	const iqDcBlock = v["iqDcBlock"]
	if (
		!isBool(enabled) ||
		!isNum(httpPort) ||
		!isModulation(modulation) ||
		!isNum(bandwidth) ||
		!isNum(squelch) ||
		!isNoise(noiseReduction) ||
		!isNum(lowPass) ||
		!isNum(highPass) ||
		!isNum(gain) ||
		!isBool(deEmphasis) ||
		!isTau(deEmphasisTau) ||
		!isAudioFormat(audioFormat) ||
		!isBool(iqDcBlock)
	) {
		return undefined
	}
	return {
		enabled,
		httpPort,
		modulation,
		bandwidth,
		squelch,
		noiseReduction,
		lowPass,
		highPass,
		gain,
		deEmphasis,
		deEmphasisTau,
		audioFormat,
		iqDcBlock,
		...pick(v, ["sourceId"] as const, isStr),
	}
}

export function guardLiveAudioStatus(v: unknown): LiveAudioStatus | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const running = v["running"]
	const sourceId = v["sourceId"]
	const sourceConnected = v["sourceConnected"]
	const sourceIqSampleRate = v["sourceIqSampleRate"]
	const config = guardLiveAudioConfig(v["config"])
	const effectiveSampleRate = v["effectiveSampleRate"]
	const decimationFactor = v["decimationFactor"]
	const httpUrl = v["httpUrl"]
	const clientCount = v["clientCount"]
	const bytesStreamed = v["bytesStreamed"]
	const pipelineHealth = v["pipelineHealth"]
	if (
		!isBool(enabled) ||
		!isBool(running) ||
		!isStr(sourceId) ||
		!isBool(sourceConnected) ||
		!isNum(sourceIqSampleRate) ||
		!config ||
		!isNum(effectiveSampleRate) ||
		!isNum(decimationFactor) ||
		!isStr(httpUrl) ||
		!isNum(clientCount) ||
		!isNum(bytesStreamed) ||
		!isPipeline(pipelineHealth)
	) {
		return undefined
	}
	return {
		enabled,
		running,
		sourceId,
		sourceConnected,
		sourceIqSampleRate,
		config,
		effectiveSampleRate,
		decimationFactor,
		httpUrl,
		clientCount,
		bytesStreamed,
		pipelineHealth,
		...pick(v, ["lastError"] as const, isStr),
	}
}

// ---------- decoder output, aircraft ----------

export function guardOutput(v: unknown): DecoderOutput | undefined {
	if (!isObj(v)) return undefined
	const type = v["type"]
	const decoder = v["decoder"]
	const timestamp = v["timestamp"]
	if (!isStr(type) || !isStr(decoder) || !isStr(timestamp)) return undefined
	return { type, decoder, timestamp, data: v["data"] }
}

const isEmergency = oneOf<NonNullable<AircraftState["emergency"]>>([
	"none",
	"general",
	"lifeguard",
	"minfuel",
	"nordo",
	"unlawful",
	"downed",
	"reserved",
])

export function guardAircraftState(v: unknown): AircraftState | undefined {
	if (!isObj(v)) return undefined
	const icao = v["icao"]
	const seen = v["seen"]
	const messages = v["messages"]
	const firstSeen = v["firstSeen"]
	const lastUpdated = v["lastUpdated"]
	if (
		!isStr(icao) ||
		!isNum(seen) ||
		!isNum(messages) ||
		!isNum(firstSeen) ||
		!isNum(lastUpdated)
	)
		return undefined
	const pos = v["position"]
	const vel = v["velocity"]
	const alt = v["altitude"]
	const ident = v["identification"]
	const sig = v["signalQuality"]
	const emergency = v["emergency"]
	const baro = isObj(alt) ? alt["baro"] : undefined
	return {
		icao,
		seen,
		messages,
		firstSeen,
		lastUpdated,
		...pick(v, ["callsign", "squawk"] as const, isStr),
		...pick(v, ["seenPos"] as const, isNum),
		...(isEmergency(emergency) ? { emergency } : {}),
		...(isObj(pos) && isNum(pos["lat"]) && isNum(pos["lon"])
			? { position: { lat: pos["lat"], lon: pos["lon"] } }
			: {}),
		...(isObj(vel)
			? {
					velocity: pick(
						vel,
						["gs", "tas", "ias", "track", "trueHeading"] as const,
						isNum,
					),
				}
			: {}),
		...(isObj(alt)
			? {
					altitude: {
						...pick(alt, ["geom", "baroRate", "geomRate"] as const, isNum),
						...pick(alt, ["onGround"] as const, isBool),
						...(isNumOrNull(baro) ? { baro } : {}),
					},
				}
			: {}),
		...(isObj(ident)
			? {
					identification: pick(
						ident,
						[
							"registration",
							"typeCode",
							"typeDescription",
							"operator",
							"operatorCode",
							"country",
						] as const,
						isStr,
					),
				}
			: {}),
		...(isObj(sig)
			? { signalQuality: pick(sig, ["rssi"] as const, isNum) }
			: {}),
	}
}

export function guardAircraftStats(
	v: unknown,
): AircraftTrackerStats | undefined {
	if (!isObj(v)) return undefined
	const cache = v["enrichmentCache"]
	const keys = [
		"aircraftCount",
		"withPosition",
		"withCallsign",
		"enrichedCount",
		"messagesProcessed",
		"messagesPerSecond",
	] as const
	const nums = pick(v, keys, isNum)
	const aircraftCount = nums.aircraftCount
	const withPosition = nums.withPosition
	const withCallsign = nums.withCallsign
	const enrichedCount = nums.enrichedCount
	const messagesProcessed = nums.messagesProcessed
	const messagesPerSecond = nums.messagesPerSecond
	if (
		aircraftCount === undefined ||
		withPosition === undefined ||
		withCallsign === undefined ||
		enrichedCount === undefined ||
		messagesProcessed === undefined ||
		messagesPerSecond === undefined ||
		!isObj(cache) ||
		!isNum(cache["hits"]) ||
		!isNum(cache["misses"]) ||
		!isNum(cache["size"])
	) {
		return undefined
	}
	return {
		aircraftCount,
		withPosition,
		withCallsign,
		enrichedCount,
		messagesProcessed,
		messagesPerSecond,
		enrichmentCache: {
			hits: cache["hits"],
			misses: cache["misses"],
			size: cache["size"],
		},
	}
}

export function guardAircraftSnapshot(
	v: unknown,
): AircraftSnapshot | undefined {
	if (!isObj(v)) return undefined
	const stats = guardAircraftStats(v["stats"])
	const timestamp = v["timestamp"]
	const aircraft = guardList(v["aircraft"], guardAircraftState)
	if (!stats || !isNum(timestamp) || !aircraft) return undefined
	return { aircraft: aircraft.value, stats, timestamp }
}

// ---------- status, presets ----------

export function guardCoreStatus(v: unknown): CoreStatus | undefined {
	if (!isObj(v)) return undefined
	const status = v["status"]
	const uptime = v["uptime"]
	const version = v["version"]
	if (!isStr(status) || !isNum(uptime) || !isStr(version)) return undefined
	const health = v["health"]
	const comps = isObj(health) ? health["components"] : undefined
	const components: CoreComponent[] = []
	if (isObj(comps)) {
		for (const [name, c] of Object.entries(comps)) {
			if (name === "decoders" || !isObj(c)) continue
			const cs = c["status"]
			if (!isStr(cs)) continue
			const message = c["message"]
			components.push({
				name,
				status: cs,
				...(isStr(message) ? { message } : {}),
			})
		}
	}
	return { status, uptime, version, components }
}

export function guardPresets(v: unknown): PresetMap | undefined {
	if (!isObj(v)) return undefined
	const out: PresetMap = {}
	for (const [name, p] of Object.entries(v)) {
		// JSON.parse makes "__proto__" an own key; assigning it would swap the prototype.
		if (name === "__proto__" || !isObj(p)) continue
		const bandwidth = p["bandwidth"]
		if (!isNum(bandwidth)) continue
		const tau = p["deEmphasisTau"]
		const preset: AudioPreset = {
			bandwidth,
			...pick(p, ["deEmphasis"] as const, isBool),
			...(isTau(tau) ? { deEmphasisTau: tau } : {}),
		}
		out[name] = preset
	}
	return out
}

// ---------- WS frames ----------

/** Turn one parsed WS frame into a typed event; undefined for unknown or malformed frames. */
export function parseServerMessage(raw: unknown): WsEvent | undefined {
	if (!isObj(raw)) return undefined
	const type = raw["type"]
	const d = raw["data"]
	if (!isStr(type)) return undefined
	const data: Obj = isObj(d) ? d : {}
	const s = (k: string): string | undefined => {
		const x = data[k]
		return isStr(x) ? x : undefined
	}
	const n = (k: string): number | undefined => {
		const x = data[k]
		return isNum(x) ? x : undefined
	}
	switch (type) {
		case "subscribed":
		case "unsubscribed":
			return { type, channels: strList(data["channels"]) }
		case "error": {
			const message = s("message")
			return message === undefined
				? undefined
				: { type: "server-error", message }
		}
		case "decoder:output": {
			const decoderId = s("decoderId")
			const output = guardOutput(data["output"])
			return decoderId !== undefined && output
				? { type, decoderId, output }
				: undefined
		}
		case "decoder:started":
		case "decoder:stopped": {
			const decoderId = s("decoderId")
			return decoderId !== undefined ? { type, decoderId } : undefined
		}
		case "decoder:error": {
			const decoderId = s("decoderId")
			const error = s("error")
			return decoderId !== undefined && error !== undefined
				? { type, decoderId, error }
				: undefined
		}
		case "decoder:status": {
			const decoder = guardDecoder(d)
			return decoder ? { type, decoder } : undefined
		}
		case "decoder:health": {
			const decoderId = s("decoderId")
			// R70: an unknown health value is carried as "unknown", never dropped.
			const health = readHealth(data["health"])
			return decoderId !== undefined ? { type, decoderId, health } : undefined
		}
		case "source:status": {
			const source = guardSource(d)
			return source ? { type, source } : undefined
		}
		case "source:connected": {
			const sourceId = s("sourceId")
			return sourceId !== undefined ? { type, sourceId } : undefined
		}
		case "source:disconnected": {
			const sourceId = s("sourceId")
			const error = s("error")
			if (sourceId === undefined) return undefined
			return error !== undefined
				? { type, sourceId, error }
				: { type, sourceId }
		}
		case "source:error": {
			const sourceId = s("sourceId")
			const error = s("error")
			return sourceId !== undefined && error !== undefined
				? { type, sourceId, error }
				: undefined
		}
		case "source:caps-changed": {
			const sourceId = s("sourceId")
			const caps = guardSourceCaps(data["caps"])
			return sourceId !== undefined && caps
				? { type, sourceId, caps }
				: undefined
		}
		case "metrics": {
			const sourceId = s("sourceId")
			const bytesReceived = n("bytesReceived")
			const dataRate = n("dataRate")
			return sourceId !== undefined &&
				bytesReceived !== undefined &&
				dataRate !== undefined
				? { type, sourceId, bytesReceived, dataRate }
				: undefined
		}
		case "fanout:snapshot": {
			const snapshot = guardFanout(d)
			return snapshot ? { type, snapshot } : undefined
		}
		case "fanout:backpressure": {
			const branchId = s("branchId")
			const bufferedBytes = n("bufferedBytes")
			const timestamp = s("timestamp")
			return branchId !== undefined &&
				bufferedBytes !== undefined &&
				timestamp !== undefined
				? { type, branchId, bufferedBytes, timestamp }
				: undefined
		}
		case "fanout:drain": {
			const branchId = s("branchId")
			const durationMs = n("durationMs")
			const timestamp = s("timestamp")
			return branchId !== undefined &&
				durationMs !== undefined &&
				timestamp !== undefined
				? { type, branchId, durationMs, timestamp }
				: undefined
		}
		case "live-audio:status": {
			const status = guardLiveAudioStatus(d)
			return status ? { type, status } : undefined
		}
		case "live-audio:config": {
			const config = guardLiveAudioConfig(d)
			return config ? { type, config } : undefined
		}
		case "live-audio:started":
		case "live-audio:stopped":
			return { type }
		case "live-audio:error": {
			const message = s("message")
			return message !== undefined ? { type, message } : undefined
		}
		case "resources:snapshot": {
			const snapshot = guardResources(d)
			return snapshot ? { type, snapshot } : undefined
		}
		case "resources:alert": {
			const alert = guardAlert(d)
			return alert ? { type, alert } : undefined
		}
		case "tuner:state-changed": {
			const sourceId = s("sourceId")
			const state = guardTuner(data["state"])
			return sourceId !== undefined && state
				? { type, sourceId, state }
				: undefined
		}
		case "tuner:command-sent": {
			const sourceId = s("sourceId")
			const command = s("command")
			return sourceId !== undefined && command !== undefined
				? { type, sourceId, command, value: data["value"] }
				: undefined
		}
		case "tuner:control-mode-changed": {
			const sourceId = s("sourceId")
			const mode = data["mode"]
			return sourceId !== undefined && isControl(mode)
				? { type, sourceId, mode }
				: undefined
		}
		case "tuner:error": {
			const sourceId = s("sourceId")
			const error = s("error")
			return sourceId !== undefined && error !== undefined
				? { type, sourceId, error }
				: undefined
		}
		case "aircraft:new":
		case "aircraft:update": {
			const aircraft = guardAircraftState(d)
			return aircraft ? { type, aircraft } : undefined
		}
		case "aircraft:lost": {
			const icao = s("icao")
			return icao !== undefined ? { type, icao } : undefined
		}
		case "aircraft:stats": {
			const stats = guardAircraftStats(d)
			return stats ? { type, stats } : undefined
		}
		default:
			return undefined
	}
}
