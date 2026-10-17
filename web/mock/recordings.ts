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
 * Seeds: dsd-fme calls on the mock's talkgroups and scanner recordings of seeded discoveries, over
 * three days; a new call lands every NEW_CALL_MS so the drawer's refresh shows something.
 */
import type { FastifyInstance, FastifyReply } from "fastify"
import {
	RECORDING_INVENTORY_ID,
	RECORDINGS_PAGE_LIMIT_DEFAULT,
	RECORDINGS_PAGE_LIMIT_MAX,
} from "@wavekit/api-types"
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
	RecordingInventoryPage,
} from "@wavekit/api-types"
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
}

const SEEDS: readonly Seed[] = [
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
	{ kind: "scanner-analog", agoMin: 26, durationS: 42, mhz: 156.8, kept: true },
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
	{ kind: "scanner-analog", agoMin: 53 * 60, durationS: 36, mhz: 156.8 },
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
	if (s.kind === "dsd-fme-call") {
		const type = (s.callType ?? "group").toUpperCase()
		const name = `${localStamp(at)}_${pad(n, 5)}_DMR_SLOT1_${type}_TGT_${s.talkgroup ?? "0"}_SRC_${s.source ?? "0"}.wav`
		return {
			seed: n,
			item: {
				id: `dsd:0~${name}`,
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
		},
	}
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
	"scanner-dv",
	"scanner-analog",
]

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

export function registerRecordingsMock(
	app: FastifyInstance,
	options: { now?: () => number; newCallMs?: number } = {},
): RecordingsMock {
	const now = options.now ?? Date.now
	const started = now()
	const recs = new Map<string, Rec>()
	const files = new Map<string, Buffer>()
	for (const s of SEEDS) {
		const r = makeRec(s, new Date(started - s.agoMin * 60_000))
		recs.set(r.item.id, r)
	}
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
	const notFound = (reply: FastifyReply) =>
		error(reply, 404, "RECORDING_NOT_FOUND", "Recording not found", "Not Found")

	app.get<{
		Querystring: {
			limit?: string
			cursor?: string
			kind?: string
			decoderId?: string
		}
	}>("/api/recordings", async (request, reply) => {
		const q = request.query
		const known = new Set(["limit", "cursor", "kind", "decoderId"])
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
		let list = sorted().filter(
			r =>
				(q.kind === undefined || r.kind === q.kind) &&
				(q.decoderId === undefined || r.decoderId === q.decoderId),
		)
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
		}
		return reply.header("Cache-Control", "no-store").send(page)
	})

	app.get<{ Params: { id: string } }>(
		"/api/recordings/:id/file",
		async (request, reply) => {
			const r = lookup(request.params.id)
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
			if (r.item.kind !== "dsd-fme-call")
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
