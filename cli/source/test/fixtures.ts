import { REST_GUARDS } from "../data/api-client.js"
import { parseServerMessage } from "../data/guards.js"
import {
	PLAIN_SUMMARY,
	initialState,
	reduce,
	type ReduceDeps,
} from "../data/reducers.js"
import {
	ENDPOINT_PATHS,
	POLL_ENDPOINTS,
	type AppState,
	type Endpoint,
	type Inbound,
	type LaneError,
	type RestInbound,
} from "../data/types.js"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"
import { loadScenario, mergeById } from "./scenarios.js"

export const FIXTURE_BASE = "http://127.0.0.1:9000"
const FIXTURE_WS = "ws://127.0.0.1:9000/ws"
const WINDOW_MS = 600_000

const PATH_TO_ENDPOINT = new Map<string, Endpoint>(
	(Object.entries(ENDPOINT_PATHS) as Array<[Endpoint, string]>).map(
		([e, p]) => [p, e],
	),
)

function restItem(path: string, body: unknown, at: number): Inbound | null {
	const endpoint = PATH_TO_ENDPOINT.get(path)
	if (!endpoint) return null
	const guarded = REST_GUARDS[endpoint](body)
	const outcome = guarded
		? { ok: true as const, value: guarded.value, rejected: guarded.rejected }
		: {
				ok: false as const,
				error: {
					kind: "invalid" as const,
					message: `fixture ${path} failed its guard`,
					at,
				},
			}
	return { kind: "rest", endpoint, outcome, at } as RestInbound
}

function wsItem(f: ScenarioFrame, at: number): Inbound {
	const event = parseServerMessage({
		type: f.type,
		channel: f.channel,
		data: f.data,
	})
	if (!event)
		throw new Error(`fixture frame ${f.type} failed parseServerMessage`)
	return { kind: "ws", event, at }
}

function restError(sc: Scenario, at: number): LaneError {
	const reason = sc.conn.restError ?? "ECONNREFUSED"
	return reason === "timeout"
		? { kind: "timeout", message: "timeout 2s", at }
		: { kind: "network", message: reason, at }
}

/** Turn a resolved scenario into the inbound items a live runtime would have queued, oldest first. */
export function scenarioInbound(sc: Scenario): {
	items: Inbound[]
	now: number
} {
	const now = Date.parse(sc.now)
	const c = sc.conn
	const restAt = now - (c.restAgoMs ?? 2000)
	const wsBase = now - (c.wsAgoMs ?? c.restAgoMs ?? 2000)
	const downFor = c.downForMs ?? 1000
	const timed: Inbound[] = []
	if (c.cached) {
		// Earlier REST answers, anchored to the last REST success so they stay older than it.
		for (const h of sc.restHistory ?? []) {
			const item = restItem(
				h.path,
				mergeById(sc.rest[h.path]?.body, h.merge),
				restAt + h.offsetMs,
			)
			if (item) timed.push(item)
		}
		for (const [path, r] of Object.entries(sc.rest)) {
			if (r.status !== 200) continue
			const item = restItem(path, r.body, restAt)
			if (item) timed.push(item)
		}
		for (const f of [...sc.ws, ...(sc.wsAppend ?? [])])
			timed.push(wsItem(f, wsBase + f.offsetMs))
		timed.push({ kind: "rest:cycle", at: restAt, nextAt: restAt + 5000 })
	}
	timed.sort((a, b) => a.at - b.at)
	const items: Inbound[] = [
		{
			kind: "target",
			at: now - WINDOW_MS,
			base: FIXTURE_BASE,
			ws: FIXTURE_WS,
			discovery: { mode: "explicit", tried: [] },
		},
		// A cold start with the API down never had an open socket, so it must not open a gap.
		...(c.cached || c.ws === "open"
			? [{ kind: "ws:open" as const, at: now - WINDOW_MS + 1 }]
			: []),
		...timed,
	]
	if (c.ws === "closed") {
		items.push({
			kind: "ws:close",
			at: now - (c.wsClosedAgoMs ?? downFor),
			code: c.closeCode ?? 1006,
			reason: "",
			nextRetryAt: now + 8000,
		})
	}
	if (c.rest === "down") {
		for (const at of [now - downFor, now - 1000]) {
			for (const endpoint of POLL_ENDPOINTS) {
				items.push({
					kind: "rest",
					endpoint,
					outcome: { ok: false, error: restError(sc, at) },
					at,
				} as RestInbound)
			}
		}
		items.push({ kind: "rest:cycle", at: now - 1000, nextAt: now + 4000 })
	}
	items.sort((a, b) => a.at - b.at)
	return { items, now }
}

export function scenarioState(
	name: ScenarioName,
	deps: ReduceDeps = PLAIN_SUMMARY,
): AppState {
	const { items, now } = scenarioInbound(loadScenario(name))
	return reduce(initialState(now - WINDOW_MS - 1000), items, now, deps)
}

/** Accepted S1 wire examples used by guards, state and render regressions. */
export const SCAN_FRAME = {
	sourceId: "rtl",
	profile: "5:512",
	epoch: 4,
	tuningTrust: "commanded" as const,
	centerHz: 446000000,
	sampleRateHz: 2048000,
	startHz: 445180800,
	binHz: 6400,
	nativeBinHz: 1000,
	binCount: 256,
	bins: Buffer.from(
		Array.from({ length: 256 }, (_, i) => (i === 128 ? 180 : 60)),
	).toString("base64"),
	binEncoding: "u8-halfdb-127.5" as const,
	floorDbfs: -92.5,
	thresholdDb: 9.2,
	tracks: [
		{
			startHz: 446000000,
			endHz: 446012500,
			flags: { burst: false, iqImage: false, edge: false },
		},
	],
	masks: { dcHz: 446000000, dcGuardHz: 1500, spurRanges: [] },
	at: "2026-10-11T12:00:00Z",
}
export const SCAN_PROFILE = {
	selection: "source" as const,
	sourceId: "rtl",
	profile: { key: "5:512", hz: 5, bins: 512 },
	effectiveHz: 5,
	outcome: "exact" as const,
	adjusted: [],
}
export const SCAN_STATUS = {
	enabled: true,
	channelizerAvailable: false,
	disk: "ok",
	jobs: { active: 1, total: 1 },
	budgets: {
		cpuBudgetCores: 1,
		cpuCoresInUse: 0.5,
		maxProbes: { offset: 1, channel: 4 },
		probesInUse: { offset: 0, channel: 0 },
	},
	cpuGuard: { percent: null, limitPercent: 90, source: "os" },
	engines: [
		{
			sourceId: "rtl",
			state: "running",
			passive: { enabled: true },
			blankedFrames: 0,
			broadbandRfi: null,
		},
	],
}
export const SCAN_JOB = {
	id: "job1",
	name: "Existing identify",
	state: "completed",
	passive: false,
	spec: { sourceId: "rtl", kind: "identify", mode: "in-window" },
	unrestorable: ["gain"],
	createdAt: "2026-10-11T12:00:00Z",
	updatedAt: "2026-10-11T12:00:01Z",
	progress: {
		sweepIndex: 0,
		hopIndex: 0,
		hopCount: 0,
		coverage: 0,
		probes: [],
	},
	identify: {
		targets: [
			{
				jobId: "job1",
				targetHz: 446000000,
				state: "unidentified",
				trials: [
					{
						protocol: "ism",
						decoder: "rtl433",
						mode: null,
						transport: null,
						outcome: "unsupported",
						reason: "needs-channelizer",
					},
				],
				result: {
					confidence: "activity",
					metadata: {
						talkgroups: [],
						sources: [],
						slots: [],
						callsigns: [],
						capcodes: [],
						ismModels: [],
					},
					measurements: {
						source: "spectrum",
						centreHz: 446000000,
						obwHz: null,
						peakDbfs: null,
						snrDb: null,
						floorDbfs: null,
						dutyCycle: null,
						class: "unknown",
					},
				},
			},
		],
	},
}
export const SCAN_DISCOVERY = {
	id: "disc1",
	frequencyHz: 446056250,
	bandwidthHz: 12500,
	protocol: "dmr",
	confidence: "decoded",
	encrypted: false,
	identity: { kind: "dmr-cc", value: "1" },
	tuningTrust: "commanded",
	lastSeenAt: "2026-10-11T12:00:00Z",
	observationCount: 2,
	airtimeMs: 300,
	sourceIds: ["rtl"],
	jobIds: ["job1"],
	signal: {
		best: { peakDbfs: -40, meanDbfs: -45, snrDb: 30, floorDbfs: -90 },
		last: { peakDbfs: -41, meanDbfs: -46, snrDb: 29, floorDbfs: -90 },
	},
	metadata: {
		talkgroups: ["9"],
		sources: ["2060945"],
		slots: [1],
		callsigns: [],
		capcodes: [],
		ismModels: [],
	},
	evidence: { recordings: 0, psd: true, iq: false },
}
