import type { ExtendedSourceStatus } from "@wavekit/api-types"
import type {
	ApiView,
	ConnState,
	GlyphRole,
	IqView,
	Lane,
	LaneError,
	LaneOrigin,
	MetricBeat,
} from "./types.js"

export const LANE_TTL_MS = 15_000

export function emptyLane<T>(origin: LaneOrigin = "rest"): Lane<T> {
	return { value: undefined, receivedAt: null, origin }
}

/** A success replaces the value and clears any error. */
export function laneOk<T>(value: T, at: number, origin: LaneOrigin): Lane<T> {
	return { value, receivedAt: at, origin }
}

/** An error never clears a cached value. */
export function laneFail<T>(lane: Lane<T>, error: LaneError): Lane<T> {
	return {
		value: lane.value,
		receivedAt: lane.receivedAt,
		origin: lane.origin,
		error,
	}
}

export function laneAge<T>(lane: Lane<T>, now: number): number | null {
	return lane.receivedAt === null ? null : Math.max(0, now - lane.receivedAt)
}

export function isOld<T>(lane: Lane<T>, now: number): boolean {
	const age = laneAge(lane, now)
	return age !== null && age > LANE_TTL_MS
}

export function isFresh<T>(lane: Lane<T>, now: number): boolean {
	const age = laneAge(lane, now)
	return age !== null && age <= LANE_TTL_MS
}

export function hasData<T>(lane: Lane<T>): boolean {
	return lane.value !== undefined
}

export function restFresh(conn: ConnState, now: number): boolean {
	const ok = conn.rest.lastOkAt
	return ok !== null && now - ok <= LANE_TTL_MS
}

export function apiView(conn: ConnState, now: number): ApiView {
	const ws = conn.ws.state === "open"
	const rest = restFresh(conn, now)
	const restAgeMs =
		conn.rest.lastOkAt === null ? null : Math.max(0, now - conn.rest.lastOkAt)
	if (ws && rest) return { kind: "ok", restAgeMs: restAgeMs ?? 0 }
	if (!ws && !rest) {
		if (
			conn.rest.lastOkAt === null &&
			conn.rest.firstFailAt === null &&
			conn.ws.state !== "closed"
		) {
			return { kind: "connecting" }
		}
		const since = conn.rest.lastOkAt ?? conn.rest.firstFailAt
		return {
			kind: "down",
			sinceMs: since === null ? null : Math.max(0, now - since),
		}
	}
	return { kind: "split", ws, rest, restAgeMs }
}

const UNKNOWN: IqView = {
	glyph: "unknown",
	word: "unknown",
	ageMs: null,
	rateBytesPerSec: null,
}

function beatFresh(
	beat: MetricBeat | undefined,
	now: number,
): beat is MetricBeat {
	return beat !== undefined && now - beat.at <= LANE_TTL_MS
}

/** T2: the word follows the evidence (activity → transport flag → WS heartbeat → unknown). */
export function iqView(
	source: ExtendedSourceStatus | undefined,
	sourceFresh: boolean,
	beat: MetricBeat | undefined,
	now: number,
): IqView {
	const liveBeat = beatFresh(beat, now) ? beat : undefined
	const rate = liveBeat
		? liveBeat.dataRateKiB * 1024
		: source && sourceFresh
			? source.dataRate * 1024
			: null
	if (source && sourceFresh) {
		const view = (
			glyph: GlyphRole,
			word: string,
			ageMs: number | null = null,
		): IqView => ({
			glyph,
			word,
			ageMs,
			rateBytesPerSec: rate,
		})
		const a = source.activity
		if (a) {
			switch (a.state) {
				case "streaming":
					return view("live", "streaming")
				case "waiting":
					return view("neutral", "connected · no samples")
				case "stale":
					return view("fault", "no samples", a.sampleAgeMs)
				case "paused":
					return view("neutral", "paused")
				case "ended":
					return view("neutral", "ended")
				case "disconnected":
					return view("fault", "disconnected")
			}
		}
		return source.connected
			? view("live", "connected")
			: view("fault", "disconnected")
	}
	if (liveBeat && liveBeat.dataRateKiB > 0) {
		return {
			glyph: "live",
			word: "receiving",
			ageMs: null,
			rateBytesPerSec: rate,
		}
	}
	return UNKNOWN
}

const GLYPH_RANK: Readonly<Record<GlyphRole, number>> = {
	live: 0,
	neutral: 1,
	unknown: 2,
	fault: 3,
}

export function iqSummary(
	sources: Lane<ExtendedSourceStatus[]>,
	metrics: Record<string, MetricBeat>,
	now: number,
): IqView {
	const fresh = isFresh(sources, now)
	const list = sources.value ?? []
	if (list.length === 0) {
		const beats = Object.values(metrics)
		return beats.length === 1
			? iqView(undefined, false, beats[0], now)
			: UNKNOWN
	}
	const views = list.map(s => iqView(s, fresh, metrics[s.id], now))
	const first = views[0]
	if (views.length === 1 && first) return first
	let worst: IqView = first ?? UNKNOWN
	for (const v of views)
		if (GLYPH_RANK[v.glyph] > GLYPH_RANK[worst.glyph]) worst = v
	const allSame = views.every(v => v.word === first?.word)
	const streaming = views.filter(v => v.word === "streaming").length
	const word =
		allSame && first
			? `${views.length}/${views.length} ${first.word}`
			: `${streaming}/${views.length} streaming`
	const rates = views
		.map(v => v.rateBytesPerSec)
		.filter((r): r is number => r !== null)
	return {
		glyph: worst.glyph,
		word,
		ageMs: null,
		rateBytesPerSec: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null,
	}
}
