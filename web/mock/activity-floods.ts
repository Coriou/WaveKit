// Activity floods: the repeats a live receiver produces, so the web app's folding can be seen and tested
// against the mock. A pure schedule of absolute time (the same events for the same window on every run):
// - one synthetic aircraft (ICAO ABC123) at 2.5 decodes/s, as readsb sends 1-30 messages/s per aircraft;
//   every 10th decode carries its callsign and altitude, the rest are presence-only rows (no fields), as the
//   core stores them;
// - a POCSAG tone-only beacon (capcode 0042001, no content) every 45 s ± 3 s, as paging networks send
//   idle beacons every 30-60 s;
// - a DMR call (TG 99 from radio 4242) of 25 bursts 2.4 s apart (60 s), once every 3 min.
// Type stripping only: no enums, parameter properties or namespaces.
import type { ActivitySummary, JsonValue } from "@wavekit/api-types"

import { MOCK_SOURCE_ID } from "./data.ts"

/** 2.5 aircraft decodes per second (readsb's 1-30 msg/s range, kept low so the mock's store holds ~30 min). */
export const FLOOD_AIRCRAFT_INTERVAL_MS = 400
/** A paging idle beacon every 45 s (networks: 30-60 s), jittered ±3 s. */
export const FLOOD_BEACON_INTERVAL_MS = 45_000
const BEACON_JITTER_MS = 3_000
/** One DMR call every 3 min: 25 bursts 2.4 s apart (60 s on air), then 120 s of silence. */
export const FLOOD_CALL_PERIOD_MS = 180_000
export const FLOOD_CALL_BURSTS = 25
export const FLOOD_BURST_INTERVAL_MS = 2_400

export type FloodSummary = Omit<
	ActivitySummary,
	"eventId" | "commitSeq" | "producedAt" | "receivedAt"
>

export interface FloodEvent {
	at: number
	summary: FloodSummary
	/** The decoded JSON behind it (GET /api/activity/:eventId). */
	data: { readonly [key: string]: JsonValue }
}

const AIRCRAFT_HZ = 1_090_000_000
const PAGER_HZ = 160_450_000
const DMR_HZ = 161_150_000

/** A small deterministic jitter per beacon index, in [-BEACON_JITTER_MS, BEACON_JITTER_MS]. */
function jitter(n: number): number {
	const x = Math.sin(n * 12.9898) * 43758.5453
	return Math.round((x - Math.floor(x) - 0.5) * 2 * BEACON_JITTER_MS)
}

function aircraft(n: number): FloodEvent["summary"] {
	// a slow climb, so the latest state differs from the first
	const altitude = 12_000 + (n % 3000) * 5
	const full = n % 10 === 0
	return {
		kind: "decoder-reception",
		decoderId: "readsb",
		sourceId: null,
		protocol: "adsb",
		category: "aircraft",
		frequencyHz: AIRCRAFT_HZ,
		entityKey: "icao:ABC123",
		title: full ? "WKT101" : "ABC123",
		fields: full
			? [
					{ key: "callsign", label: "Callsign", value: "WKT101" },
					{ key: "altitude", label: "Altitude", value: altitude, unit: "ft" },
				]
			: [],
		position: {
			lat: 48.6 + (n % 600) * 0.0005,
			lon: -3.9,
			altM: Math.round(altitude * 0.3048),
		},
	}
}

const BEACON: FloodEvent["summary"] = {
	kind: "decoder-reception",
	decoderId: "multimon-ng",
	sourceId: MOCK_SOURCE_ID,
	protocol: "pocsag",
	category: "paging",
	frequencyHz: PAGER_HZ,
	entityKey: "capcode:0042001",
	title: "POCSAG1200 0042001 tone only",
	fields: [
		{ key: "label", label: "Label", value: "tone only" },
		{ key: "function", label: "Function", value: 0 },
		{ key: "messageType", label: "Message type", value: "unknown" },
	],
}

function burst(k: number): FloodEvent["summary"] {
	return {
		kind: "decoder-reception",
		decoderId: "dsd-fme",
		sourceId: MOCK_SOURCE_ID,
		protocol: "dmr",
		category: "voice",
		frequencyHz: DMR_HZ,
		entityKey: "talkgroup:99",
		title: "DMR TG 99 from 4242",
		fields: [
			{ key: "talkgroup", label: "Talkgroup", value: 99 },
			{ key: "source", label: "Radio", value: 4242 },
			{ key: "slot", label: "Slot", value: 1 },
			{
				key: "duration",
				label: "Duration",
				value: (k + 1) * FLOOD_BURST_INTERVAL_MS,
				unit: "ms",
			},
		],
	}
}

/** Every flood event with `from <= at < to`, oldest first; `aircraftFrom` starts the aircraft later (history). */
export function floodEvents(
	from: number,
	to: number,
	aircraftFrom = from,
): FloodEvent[] {
	const out: FloodEvent[] = []
	if (to <= from) return out
	const a0 = Math.max(from, aircraftFrom)
	for (
		let n = Math.ceil(a0 / FLOOD_AIRCRAFT_INTERVAL_MS);
		n * FLOOD_AIRCRAFT_INTERVAL_MS < to;
		n++
	) {
		const s = aircraft(n)
		out.push({
			at: n * FLOOD_AIRCRAFT_INTERVAL_MS,
			summary: s,
			data: {
				icao: "ABC123",
				...(s.fields.length > 0 ? { callsign: "WKT101" } : {}),
			},
		})
	}
	// a beacon index's jittered time can fall either side of the window edge: look one index out
	for (
		let n = Math.floor(from / FLOOD_BEACON_INTERVAL_MS) - 1;
		(n - 1) * FLOOD_BEACON_INTERVAL_MS < to;
		n++
	) {
		const at = n * FLOOD_BEACON_INTERVAL_MS + jitter(n)
		if (at >= from && at < to)
			out.push({
				at,
				summary: BEACON,
				data: {
					protocol: "POCSAG1200",
					address: 42001,
					function: 0,
					messageType: "unknown",
				},
			})
	}
	for (
		let p = Math.floor(from / FLOOD_CALL_PERIOD_MS);
		p * FLOOD_CALL_PERIOD_MS < to;
		p++
	)
		for (let k = 0; k < FLOOD_CALL_BURSTS; k++) {
			const at = p * FLOOD_CALL_PERIOD_MS + k * FLOOD_BURST_INTERVAL_MS
			if (at >= from && at < to)
				out.push({
					at,
					summary: burst(k),
					data: { protocol: "DMR", talkgroup: 99, source: 4242, slot: 1 },
				})
		}
	return out.sort((a, b) => a.at - b.at)
}
