/**
 * Recordings (WG8 inventory, WG9 Keep and delete), served as a protected core serves them so the
 * Recordings drawer can be exercised (a real legacy core does not mount these routes: 404).
 *
 * - GET /api/recordings: newest `modifiedAt` first, ties by id; `limit` (1–200, default 50),
 *   opaque `cursor`, `kind`, `decoderId`; 400 RECORDINGS_QUERY_INVALID otherwise.
 * - GET /api/recordings/:id/file: the WAV (synthetic speech-like bursts, 8 kHz 16-bit mono),
 *   `Content-Disposition: attachment`, no ranges.
 * - PUT / DELETE /api/recordings/:id/keep, DELETE /api/recordings/:id with the core's codes:
 *   RECORDING_NOT_FOUND 404, RECORDING_KEPT and RECORDING_DELETE_UNSUPPORTED 409.
 * Seeds: dsd-fme YSF calls on the mock's talkgroups (a core serves no dsd-fme P25, NXDN, dPMR,
 * ProVoice or M17 call file), digital-voice recorder calls (kind `dv-call`:
 * a P25 call and a D-STAR call, each linked to its Activity row; a core lists no DMR call recording
 * yet) and scanner recordings of seeded
 * discoveries, over three days; a new call lands every NEW_CALL_MS so the drawer's refresh shows something.
 */
import type { FastifyInstance, FastifyReply } from "fastify"
import {
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	RECORDING_DSD_KEY,
	RECORDING_INVENTORY_ID,
	RECORDINGS_CHANNELS_MAX,
	RECORDINGS_NEAR_MAX_TOLERANCE_HZ,
	RECORDINGS_PAGE_LIMIT_DEFAULT,
	RECORDINGS_PAGE_LIMIT_MAX,
} from "@wavekit/api-types"
import type {
	RecordingCut,
	RecordingSpeech,
	RecordingInventoryItem,
	RecordingInventoryKind,
	RecordingInventoryPage,
} from "@wavekit/api-types"
import type {
	RecordingFacts,
	RecordingTone,
} from "../src/features/transmission/contract.ts"
import { DISCOVERY_SEEDS, seedDiscoveryId } from "./data.ts"

const RATE = 8000
export const NEW_CALL_MS = 60_000

interface Seed {
	kind: RecordingInventoryKind
	/** Minutes before the mock started. */
	agoMin: number
	durationS: number
	callType?: "group" | "private" | "unit"
	talkgroup?: string
	source?: string
	/** Scanner recordings: the seeded discovery's frequency (MHz). */
	mhz?: number
	kept?: boolean
	/** Scanner analog recordings: why the file ended early, and its roll-over part. */
	cut?: RecordingCut | null
	part?: number
	parts?: number
	/** Scanner analog recordings: the recorder's verdict at the finish (default heard, final). */
	speech?: RecordingSpeech
	keptBy?: string
	/**
	 * Scanner analog recordings: the facts sidecar's tone (the value, null: measured and none heard, "absent": the
	 * member left out), or `false` for a file with no facts at all (an older file). Default: facts without a tone.
	 */
	tone?: RecordingTone | null | "absent" | false
}

const SEEDS: readonly Seed[] = [
	// The digital-voice call recorder's files (synthetic ids and callsigns): a P25 call, and a
	// D-STAR call, whose file names UR as TGT and MY as SRC.
	{
		kind: "dv-call",
		agoMin: 6,
		durationS: 14,
		callType: "group",
		talkgroup: "2081",
		source: "2081045",
	},
	{
		kind: "dv-call",
		agoMin: 17,
		durationS: 9,
		callType: "group",
		talkgroup: "CQCQCQ",
		source: "N0CALL",
	},
	{
		kind: "dsd-fme-call",
		agoMin: 3,
		durationS: 24,
		callType: "group",
		talkgroup: "2081",
		source: "2081012",
	},
	{
		kind: "dsd-fme-call",
		agoMin: 11,
		durationS: 8,
		callType: "group",
		talkgroup: "9",
		source: "2081045",
	},
	// An unsaved channel heard with its carrier 0.3 kHz off the raster, rolled over before its chain is known:
	// it reads "FM voice", "145.5625" and "Continues…" (naming.ts, recordingCutLabel).
	{
		kind: "scanner-analog",
		agoMin: 20,
		durationS: 90,
		mhz: 145.5628,
		cut: "duration-rollover",
		tone: { kind: "ctcss", hz: 123 },
	},
	// The tone states of the facts sidecar (Transmission view, Tone row): CTCSS, DCS, measured none, not measured,
	// and no facts at all.
	{
		kind: "scanner-analog",
		agoMin: 26,
		durationS: 42,
		mhz: 156.8,
		kept: true,
		keptBy: "own-tone",
		tone: { kind: "ctcss", hz: 88.5 },
	},
	// One long transmission split by roll-overs, its last part cut when the sweep moved on.
	{
		kind: "scanner-analog",
		agoMin: 32,
		durationS: 60,
		mhz: 156.8,
		cut: "duration-rollover",
		part: 1,
		parts: 3,
		tone: { kind: "dcs", code: "023" },
	},
	{
		kind: "scanner-analog",
		agoMin: 31,
		durationS: 60,
		mhz: 156.8,
		cut: "duration-rollover",
		part: 2,
		parts: 3,
		tone: { kind: "dcs", code: "023" },
	},
	{
		kind: "scanner-analog",
		agoMin: 30,
		durationS: 21,
		mhz: 156.8,
		cut: "scanner-moved",
		part: 3,
		parts: 3,
		tone: { kind: "dcs", code: "023" },
	},
	{
		kind: "scanner-analog",
		agoMin: 40,
		durationS: 12,
		mhz: 156.8,
		cut: "source-lost",
		tone: null,
	},
	{
		kind: "scanner-analog",
		agoMin: 44,
		durationS: 9,
		mhz: 156.8,
		cut: "shutdown",
		tone: "absent",
	},
	// Kept with no voice prior and no speech heard in it (the "No speech found" case).
	{
		kind: "scanner-analog",
		agoMin: 52,
		durationS: 30,
		mhz: 156.8,
		speech: "not-heard",
		keptBy: "prior-none",
		tone: false,
	},
	{
		kind: "dsd-fme-call",
		agoMin: 48,
		durationS: 15,
		callType: "group",
		talkgroup: "1201",
		source: "4410022",
	},
	{ kind: "scanner-dv", agoMin: 75, durationS: 19, mhz: 161.15 },
	{
		kind: "dsd-fme-call",
		agoMin: 130,
		durationS: 6,
		callType: "private",
		talkgroup: "2081045",
		source: "2081012",
	},
	{
		kind: "dsd-fme-call",
		agoMin: 205,
		durationS: 31,
		callType: "group",
		talkgroup: "2081",
		source: "2081045",
		kept: true,
	},
	{
		kind: "dsd-fme-call",
		agoMin: 22 * 60,
		durationS: 12,
		callType: "group",
		talkgroup: "9",
		source: "2081012",
	},
	{ kind: "scanner-dv", agoMin: 26 * 60, durationS: 27, mhz: 163.0875 },
	{
		kind: "dsd-fme-call",
		agoMin: 29 * 60,
		durationS: 44,
		callType: "group",
		talkgroup: "1201",
		source: "4410022",
	},
	{
		kind: "dsd-fme-call",
		agoMin: 31 * 60,
		durationS: 9,
		callType: "unit",
		talkgroup: "2081",
		source: "2081099",
	},
	{
		kind: "dsd-fme-call",
		agoMin: 50 * 60,
		durationS: 18,
		callType: "group",
		talkgroup: "2081",
		source: "2081012",
		kept: true,
	},
	{
		kind: "scanner-analog",
		agoMin: 53 * 60,
		durationS: 36,
		mhz: 156.8,
		tone: false,
	},
	{
		kind: "dsd-fme-call",
		agoMin: 55 * 60,
		durationS: 21,
		callType: "group",
		talkgroup: "9",
		source: "2081045",
	},
]

interface Rec {
	item: RecordingInventoryItem
	seed: number
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
const localStamp = (d: Date) =>
	`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const localIso = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

let serial = 0

function makeRec(s: Seed, at: Date): Rec {
	const n = ++serial
	const bytes = 44 + s.durationS * RATE * 2
	const modifiedAt = new Date(at.getTime() + s.durationS * 1000).toISOString()
	if (s.kind === "dsd-fme-call" || s.kind === "dv-call") {
		const type = (s.callType ?? "group").toUpperCase()
		// dsd-fme names its own files; the recorder writes the decoder id in their place. The
		// dsd-fme seeds are YSF: a core lists and plays no dsd-fme P25, NXDN, dPMR, ProVoice or M17
		// call file (dsdFmeCallRecordable), whose name does not carry the call's clear print.
		const name =
			s.kind === "dv-call"
				? `${localStamp(at)}_${pad(n, 5)}_dsd-fme_${type}_TGT_${s.talkgroup ?? "0"}_SRC_${s.source ?? "0"}.wav`
				: `${localStamp(at)}_${pad(n, 5)}_YSF_${type}_TGT_${s.talkgroup ?? "0"}_SRC_${s.source ?? "0"}.wav`
		return {
			seed: n,
			item: {
				// The recorder's directory is the core's last dsd source.
				id: `dsd:${s.kind === "dv-call" ? 1 : 0}~${name}`,
				key: `dsd~${name}`,
				activityEventId: null,
				kind: s.kind,
				decoderId: "dsd-fme",
				discoveryId: null,
				startedAtLocal: localIso(at),
				modifiedAt,
				bytes,
				durationMs: s.durationS * 1000,
				callType: s.callType ?? null,
				talkgroup: s.talkgroup ?? null,
				source: s.source ?? null,
				frequencyHz: null,
				kept: s.kept === true,
				startedAt: null,
				observationId: null,
				speech: "unchecked",
				keptBy: null,
			},
		}
	}
	const hz = Math.round((s.mhz ?? 0) * 1e6)
	const index = DISCOVERY_SEEDS.findIndex(d => Math.round(d.mhz * 1e6) === hz)
	const discoveryId =
		index >= 0 ? seedDiscoveryId(index, hz) : `d_01JBRZMOCK${n}`
	const prefix = s.kind === "scanner-dv" ? "dv" : "analog"
	return {
		seed: n,
		item: {
			id: `scan:${discoveryId}~${prefix}-${localStamp(at)}.wav`,
			key: `scan:${discoveryId}~${prefix}-${localStamp(at)}.wav`,
			activityEventId: null,
			kind: s.kind,
			decoderId: null,
			discoveryId,
			startedAtLocal: null,
			modifiedAt,
			bytes,
			durationMs: s.durationS * 1000,
			callType: null,
			talkgroup: null,
			source: null,
			frequencyHz: hz,
			kept: s.kept === true,
			...(s.kind === "scanner-analog"
				? {
						cut: s.cut ?? null,
						part: s.part ?? null,
						parts: s.parts ?? null,
					}
				: {}),
			// The receipt's verdict facts (scanner analog only); roll-over parts share an observation.
			startedAt: s.kind === "scanner-analog" ? at.toISOString() : null,
			observationId:
				s.kind === "scanner-analog"
					? s.parts === undefined
						? `o_MOCK${n}`
						: `o_MOCKROLL${hz}`
					: null,
			speech: s.kind === "scanner-analog" ? (s.speech ?? "heard") : "unchecked",
			keptBy: s.kind === "scanner-analog" ? (s.keptBy ?? "final") : null,
			...(s.kind === "scanner-analog"
				? {
						facts:
							s.tone === false
								? null
								: factsOf(s, n, discoveryId, hz, at, modifiedAt),
					}
				: {}),
		},
	}
}

/** The store's cut code of a file the item says ended so (facts `finish.cut`). */
const FINISH_CUT: Record<RecordingCut, string> = {
	"scanner-moved": "epoch-changed",
	"duration-rollover": "duration-limit",
	"source-lost": "source-lost",
	shutdown: "shutdown",
}

/** A kept analog file's facts sidecar, as the core writes it (its tone member per `s.tone`). */
function factsOf(
	s: Seed,
	n: number,
	discoveryId: string,
	hz: number,
	at: Date,
	modifiedAt: string,
): RecordingFacts {
	const durationMs = s.durationS * 1000
	const facts: RecordingFacts = {
		version: 1,
		operationId: `00000000-0000-4000-8000-${pad(n, 12)}`,
		discoveryId,
		observationId: s.parts === undefined ? `o_MOCK${n}` : `o_MOCKROLL${hz}`,
		// the demodulated centre sits a little off the channel
		frequencyHz: hz + 180,
		startedAt: at.toISOString(),
		endedAt: new Date(at.getTime() + durationMs).toISOString(),
		keptAt: modifiedAt,
		durationMs,
		finish: {
			cut: s.cut ? FINISH_CUT[s.cut] : "completed",
			keptBy: s.keptBy ?? "final",
			speechHeard: s.speech === undefined ? true : s.speech === "heard",
			cutActive: s.cut === "scanner-moved" ? true : null,
		},
		admission: {
			frequencyHz: hz + 180,
			reason: null,
			strength: "strong",
			levelFrames: 42,
			spreadDb: 18.4,
			p10Dbfs: -61.2,
			periodicShare: 0.12,
			burstFrames: 7,
		},
	}
	if (s.tone !== undefined && s.tone !== "absent" && s.tone !== false)
		facts.tone = s.tone
	return facts
}

/** Speech-like bursts: a few harmonics of a wandering pitch under a syllable envelope, plus hiss. */
export function synthWav(durationS: number, seed: number): Buffer {
	const frames = Math.round(durationS * RATE)
	const buf = Buffer.alloc(44 + frames * 2)
	buf.write("RIFF", 0, "ascii")
	buf.writeUInt32LE(36 + frames * 2, 4)
	buf.write("WAVE", 8, "ascii")
	buf.write("fmt ", 12, "ascii")
	buf.writeUInt32LE(16, 16)
	buf.writeUInt16LE(1, 20)
	buf.writeUInt16LE(1, 22)
	buf.writeUInt32LE(RATE, 24)
	buf.writeUInt32LE(RATE * 2, 28)
	buf.writeUInt16LE(2, 32)
	buf.writeUInt16LE(16, 34)
	buf.write("data", 36, "ascii")
	buf.writeUInt32LE(frames * 2, 40)
	let x = (seed * 9301 + 49297) % 233280
	const rnd = () => {
		x = (x * 9301 + 49297) % 233280
		return x / 233280
	}
	let phase = 0
	let talk = true
	let left = Math.round(RATE * (0.6 + rnd() * 1.6))
	for (let i = 0; i < frames; i++) {
		if (--left <= 0) {
			talk = !talk
			left = Math.round(RATE * (talk ? 0.8 + rnd() * 2.2 : 0.4 + rnd() * 1.2))
		}
		const t = i / RATE
		const pitch = 120 + 40 * Math.sin(t * 2.1 + seed) + 25 * Math.sin(t * 7.3)
		phase += (2 * Math.PI * pitch) / RATE
		const syll = Math.max(0, Math.sin(t * Math.PI * 4.2 + seed))
		const env = talk ? 0.15 + 0.85 * syll : 0
		const voice =
			Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase)
		const v = env * voice * 0.28 + (rnd() - 0.5) * 0.02
		buf.writeInt16LE(
			Math.max(-32768, Math.min(32767, Math.round(v * 32767))),
			44 + i * 2,
		)
	}
	return buf
}

const KINDS: readonly string[] = [
	"dsd-fme-call",
	"dv-call",
	"scanner-dv",
	"scanner-analog",
]

/** The channel scope of a recordings query, as the core checks it; null when none. */
function recordingsChannelScope(q: {
	channelHz?: string
	nearHz?: string
	toleranceHz?: string
}): { minHz: number; maxHz: number } | null | "invalid" {
	const hz = (v: string | undefined) =>
		v === undefined ? undefined : /^\d{1,13}$/.test(v) ? Number(v) : Number.NaN
	const channel = hz(q.channelHz)
	const near = hz(q.nearHz)
	const tolerance = hz(q.toleranceHz)
	if ([channel, near, tolerance].some(v => Number.isNaN(v))) return "invalid"
	if (channel !== undefined && near !== undefined) return "invalid"
	if (tolerance !== undefined && near === undefined) return "invalid"
	if (tolerance !== undefined && tolerance > RECORDINGS_NEAR_MAX_TOLERANCE_HZ)
		return "invalid"
	if (channel !== undefined) return { minHz: channel, maxHz: channel }
	if (near === undefined) return null
	const t = tolerance ?? DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ
	return { minHz: near - t, maxHz: near + t }
}

/** `matchedByChannel` of a `nearHz` listing, as the core orders and bounds it. */
function matchedByChannel(
	list: readonly RecordingInventoryItem[],
): { frequencyHz: number; count: number }[] {
	const counts = new Map<number, number>()
	for (const r of list)
		if (r.frequencyHz !== null)
			counts.set(r.frequencyHz, (counts.get(r.frequencyHz) ?? 0) + 1)
	return [...counts]
		.map(([frequencyHz, count]) => ({ frequencyHz, count }))
		.sort((a, b) => b.count - a.count || a.frequencyHz - b.frequencyHz)
		.slice(0, RECORDINGS_CHANNELS_MAX)
}

function compare(a: RecordingInventoryItem, b: RecordingInventoryItem): number {
	if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function error(
	reply: FastifyReply,
	status: number,
	code: string,
	message: string,
	err: string,
) {
	return reply
		.code(status)
		.header("Cache-Control", "no-store")
		.send({ error: err, code, message })
}

export interface RecordingsMock {
	/** Adds one fresh call now (also run by the timer). */
	addCall(): RecordingInventoryItem
	stop(): void
}

/** The seeded recordings, made before the routes so Activity history can link them. */
export interface RecordingsState {
	readonly started: number
	readonly recs: Map<string, Rec>
}

export function createRecordingsState(
	now: () => number = Date.now,
): RecordingsState {
	const started = now()
	const recs = new Map<string, Rec>()
	for (const s of SEEDS) {
		const r = makeRec(s, new Date(started - s.agoMin * 60_000))
		recs.set(r.item.id, r)
	}
	return { started, recs }
}

/** The seeded recordings, oldest first. */
export function recordingSeeds(
	state: RecordingsState,
): readonly RecordingInventoryItem[] {
	return [...state.recs.values()]
		.map(r => r.item)
		.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
}

/** As the core's link index: the recording's Activity row (`activityEventId`). */
export function linkRecordingActivity(
	state: RecordingsState,
	id: string,
	eventId: string,
): void {
	const r = state.recs.get(id)
	if (r) r.item = { ...r.item, activityEventId: eventId }
}

export function registerRecordingsMock(
	app: FastifyInstance,
	options: {
		now?: () => number
		newCallMs?: number
		state?: RecordingsState
		/** A new call's Activity row (a `call_end` with its link); returns its eventId. */
		onRecording?: (item: RecordingInventoryItem) => string | null
	} = {},
): RecordingsMock {
	const now = options.now ?? Date.now
	const state = options.state ?? createRecordingsState(now)
	const recs = state.recs
	const files = new Map<string, Buffer>()
	const sorted = () => [...recs.values()].map(r => r.item).sort(compare)

	const NEW_CALLS: readonly Seed[] = [
		{
			kind: "dsd-fme-call",
			agoMin: 0,
			durationS: 11,
			callType: "group",
			talkgroup: "2081",
			source: "2081045",
		},
		{
			kind: "dsd-fme-call",
			agoMin: 0,
			durationS: 7,
			callType: "group",
			talkgroup: "9",
			source: "2081012",
		},
		{
			kind: "dsd-fme-call",
			agoMin: 0,
			durationS: 16,
			callType: "group",
			talkgroup: "1201",
			source: "4410022",
		},
	]
	let fresh = 0
	const addCall = () => {
		const s = NEW_CALLS[fresh++ % NEW_CALLS.length] ?? NEW_CALLS[0]
		if (!s) throw new Error("no new call seed")
		const r = makeRec(s, new Date(now() - s.durationS * 1000 - 2000))
		recs.set(r.item.id, r)
		const eventId = options.onRecording?.(r.item) ?? null
		if (eventId !== null) r.item = { ...r.item, activityEventId: eventId }
		return r.item
	}
	const timer = setInterval(addCall, options.newCallMs ?? NEW_CALL_MS)
	timer.unref()

	const lookup = (id: unknown): Rec | null =>
		typeof id === "string" &&
		id.length <= 100 &&
		RECORDING_INVENTORY_ID.test(id)
			? (recs.get(id) ?? null)
			: null
	/** The file route also takes a dsd-fme call's stable key (an Activity row's recording id). */
	const lookupFile = (id: unknown): Rec | null => {
		const r = lookup(id)
		if (r !== null || typeof id !== "string" || !RECORDING_DSD_KEY.test(id))
			return r
		for (const x of recs.values()) if (x.item.key === id) return x
		return null
	}
	const notFound = (reply: FastifyReply) =>
		error(reply, 404, "RECORDING_NOT_FOUND", "Recording not found", "Not Found")

	app.get<{
		Querystring: {
			limit?: string
			cursor?: string
			kind?: string
			decoderId?: string
			kept?: string
			discoveryId?: string
			talkgroup?: string
			source?: string
			minHz?: string
			maxHz?: string
			channelHz?: string
			nearHz?: string
			toleranceHz?: string
			since?: string
			until?: string
			q?: string
		}
	}>("/api/recordings", async (request, reply) => {
		const q = request.query
		const known = new Set([
			"limit",
			"cursor",
			"kind",
			"decoderId",
			"kept",
			"discoveryId",
			"talkgroup",
			"source",
			"minHz",
			"maxHz",
			"channelHz",
			"nearHz",
			"toleranceHz",
			"since",
			"until",
			"q",
		])
		const invalid = () =>
			error(
				reply,
				400,
				"RECORDINGS_QUERY_INVALID",
				"The recordings query is invalid",
				"Bad Request",
			)
		if (Object.keys(q).some(k => !known.has(k))) return invalid()
		let limit = RECORDINGS_PAGE_LIMIT_DEFAULT
		if (q.limit !== undefined) {
			if (!/^\d{1,3}$/.test(q.limit)) return invalid()
			limit = Number(q.limit)
			if (limit < 1 || limit > RECORDINGS_PAGE_LIMIT_MAX) return invalid()
		}
		if (q.kind !== undefined && !KINDS.includes(q.kind)) return invalid()
		let after: { m: string; i: string } | null = null
		if (q.cursor !== undefined) {
			try {
				const parsed = JSON.parse(
					Buffer.from(q.cursor, "base64url").toString("utf8"),
				) as unknown
				const c = parsed as { m?: unknown; i?: unknown }
				if (typeof c.m !== "string" || typeof c.i !== "string") return invalid()
				after = { m: c.m, i: c.i }
			} catch {
				return invalid()
			}
		}
		if (q.kept !== undefined && q.kept !== "true" && q.kept !== "false")
			return invalid()
		const text = q.q?.trim().toLowerCase()
		const minHz = q.minHz === undefined ? null : Number(q.minHz)
		const maxHz = q.maxHz === undefined ? null : Number(q.maxHz)
		const scope = recordingsChannelScope(q)
		if (scope === "invalid") return invalid()
		const all = sorted()
		let list = all.filter(
			r =>
				(q.kind === undefined || r.kind === q.kind) &&
				(q.decoderId === undefined || r.decoderId === q.decoderId) &&
				(q.kept === undefined || (r.kept === true) === (q.kept === "true")) &&
				(q.discoveryId === undefined || r.discoveryId === q.discoveryId) &&
				(q.talkgroup === undefined || r.talkgroup === q.talkgroup) &&
				(q.source === undefined || r.source === q.source) &&
				(minHz === null || (r.frequencyHz ?? -1) >= minHz) &&
				(maxHz === null ||
					(r.frequencyHz !== null && r.frequencyHz <= maxHz)) &&
				(scope === null ||
					(r.frequencyHz !== null &&
						r.frequencyHz >= scope.minHz &&
						r.frequencyHz <= scope.maxHz)) &&
				(q.since === undefined || r.modifiedAt >= q.since) &&
				(q.until === undefined || r.modifiedAt <= q.until) &&
				(text === undefined ||
					`${r.talkgroup ?? ""} ${r.source ?? ""} ${r.decoderId ?? ""} ${r.kind} ${
						r.frequencyHz === null ? "" : String(r.frequencyHz / 1e6)
					}`
						.toLowerCase()
						.includes(text)),
		)
		const matched = list.length
		if (after) {
			const a = after
			list = list.filter(
				r => compare(r, { ...r, modifiedAt: a.m, id: a.i }) > 0,
			)
		}
		const items = list.slice(0, limit)
		const last = items[items.length - 1]
		const page: RecordingInventoryPage = {
			items,
			nextCursor:
				list.length > limit && last
					? Buffer.from(
							JSON.stringify({ m: last.modifiedAt, i: last.id }),
						).toString("base64url")
					: null,
			scannedFiles: recs.size,
			truncated: false,
			scannedAt: new Date(now()).toISOString(),
			revision: recs.size,
			indexing: false,
			matched,
			...(q.nearHz === undefined
				? {}
				: { matchedByChannel: matchedByChannel(list) }),
			counts: {
				total: all.length,
				kept: all.filter(r => r.kept === true).length,
				bytes: all.reduce((n, r) => n + r.bytes, 0),
				byKind: {
					"dsd-fme-call": all.filter(r => r.kind === "dsd-fme-call").length,
					"scanner-dv": all.filter(r => r.kind === "scanner-dv").length,
					"scanner-analog": all.filter(r => r.kind === "scanner-analog").length,
					"dv-call": all.filter(r => r.kind === "dv-call").length,
				},
			},
			truncatedBefore: null,
		}
		return reply.header("Cache-Control", "no-store").send(page)
	})

	app.get<{ Params: { id: string } }>(
		"/api/recordings/:id/file",
		async (request, reply) => {
			const r = lookupFile(request.params.id)
			if (!r) return notFound(reply)
			let wav = files.get(r.item.id)
			if (!wav) {
				wav = synthWav((r.item.durationMs ?? 0) / 1000, r.seed)
				files.set(r.item.id, wav)
			}
			const name = r.item.id.slice(r.item.id.indexOf("~") + 1)
			return reply
				.type("audio/wav")
				.header("Content-Disposition", `attachment; filename="${name}"`)
				.header("Accept-Ranges", "none")
				.header("Cache-Control", "no-store")
				.send(wav)
		},
	)

	const keep =
		(kept: boolean) =>
		async (request: { params: { id: string } }, reply: FastifyReply) => {
			const r = lookup(request.params.id)
			if (!r) return notFound(reply)
			const changed = r.item.kept !== kept
			r.item = { ...r.item, kept }
			return reply
				.header("Cache-Control", "no-store")
				.send({ id: r.item.id, kept, changed })
		}
	app.put<{ Params: { id: string } }>("/api/recordings/:id/keep", keep(true))
	app.delete<{ Params: { id: string } }>(
		"/api/recordings/:id/keep",
		keep(false),
	)

	app.delete<{ Params: { id: string } }>(
		"/api/recordings/:id",
		async (request, reply) => {
			const r = lookup(request.params.id)
			if (!r) return notFound(reply)
			if (r.item.kept)
				return error(
					reply,
					409,
					"RECORDING_KEPT",
					"Recording is kept; unkeep it first",
					"Conflict",
				)
			if (r.item.kind !== "dsd-fme-call" && r.item.kind !== "dv-call")
				return error(
					reply,
					409,
					"RECORDING_DELETE_UNSUPPORTED",
					"This recording cannot be deleted",
					"Conflict",
				)
			recs.delete(r.item.id)
			files.delete(r.item.id)
			return reply
				.header("Cache-Control", "no-store")
				.send({ id: r.item.id, deleted: true })
		},
	)

	return {
		addCall,
		stop: () => clearInterval(timer),
	}
}
