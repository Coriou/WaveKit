/**
 * Longevity: Activity store growth per traffic profile (measure only, not CI). Feeds synthetic
 * decoder outputs through the production path (createActivityIngress → coalescing → admission →
 * SQLite, inline execution) on a fake clock, then reports stored rows per hour, on-disk bytes per
 * row (table, indexes and FTS together), the WAL, the hours until the default byte cap, and how
 * long a reopen of that store takes. Also measures one "Decoded Message" info line as the core
 * logs it for every decoder output.
 *
 *   pnpm exec esbuild scripts/longevity/activity-growth.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/longevity/activity-growth.mjs
 *   node output/longevity/activity-growth.mjs --profile busy --minutes 30 --dir <tmp> [--keep]
 *
 * Profiles (synthetic ids and text only):
 *   busy:  150 aircraft at 1 reception/s each, 1 page/3 s, 30 sensors every 45 s
 *   quiet: 10 aircraft at 1 reception/s each, 100 pages/h, 10 sensors every 60 s
 *   adsb | paging | ism: one part of busy alone
 */
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { Writable } from "node:stream"
import pino from "pino"
import { createActivityIngress } from "../../src/core/activity/ingress.js"
import { openSqliteFile } from "../../src/core/activity/storage/probe.js"
import { openActivityStore } from "../../src/core/activity/storage/store.js"
import { ACTIVITY_LIMIT_DEFAULTS } from "../../src/core/activity/storage/limits.js"
import type { DecoderOutput } from "../../src/decoders/types.js"
import { createComponentLogger } from "../../src/utils/logger.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}
const argText = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

interface Profile {
	aircraft: number
	pagesPerHour: number
	sensors: number
	sensorPeriodS: number
}
const PROFILES: Record<string, Profile> = {
	busy: { aircraft: 150, pagesPerHour: 1200, sensors: 30, sensorPeriodS: 45 },
	quiet: { aircraft: 10, pagesPerHour: 100, sensors: 10, sensorPeriodS: 60 },
	adsb: { aircraft: 150, pagesPerHour: 0, sensors: 0, sensorPeriodS: 45 },
	paging: { aircraft: 0, pagesPerHour: 1200, sensors: 0, sensorPeriodS: 45 },
	ism: { aircraft: 0, pagesPerHour: 0, sensors: 30, sensorPeriodS: 45 },
}
const profileName = argText("profile", "busy")
const profile = PROFILES[profileName]
if (!profile) throw new RangeError(`unknown profile ${profileName}`)
const MINUTES = arg("minutes", 30)
const KEEP = process.argv.includes("--keep")
const T0 = Date.parse("2026-01-01T00:00:00.000Z")

const silent = pino({ level: "silent" })
const clock = { t: T0 }
const dir = await mkdtemp(
	join(argText("dir", os.tmpdir()), "wavekit-longevity-activity-"),
)

/** Deterministic pseudo-random text so FTS sees realistic token counts. */
let seed = 7
const rand = (): number => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff
	return seed / 0x7fffffff
}
const WORDS = ["alpha", "bravo", "unit", "call", "test", "route", "team", "ok"]
const sentence = (n: number): string =>
	Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)])
		.join(" ")
		.toUpperCase()

const aircraftOutput = (a: number, s: number): DecoderOutput => ({
	timestamp: new Date(clock.t),
	decoder: "readsb",
	type: "aircraft",
	data: {
		icao: (0xa00000 + a).toString(16).toUpperCase(),
		callsign: `WKA${100 + a}`,
		squawk: "1000",
		lat: 50 + a / 100 + s / 1e5,
		lon: 4 + a / 100 + s / 1e5,
		altitude: 30_000 + ((s * 7 + a) % 400),
		groundSpeed: 420 + (s % 9),
		track: (a * 3 + s) % 360,
		verticalRate: (s % 5) * 64 - 128,
		readsbFormat: "sbs",
		messageCount: s,
		lastSeen: clock.t,
	},
})
const pageOutput = (n: number): DecoderOutput => ({
	timestamp: new Date(clock.t),
	decoder: "multimon-ng",
	type: "message",
	data: {
		protocol: "POCSAG1200",
		address: 1_000_000 + (n % 400),
		function: n % 4,
		message: sentence(6 + Math.floor(rand() * 10)),
	},
})
const sensorOutput = (k: number): DecoderOutput => ({
	timestamp: new Date(clock.t),
	decoder: "rtl433",
	type: "signal",
	data: {
		time: new Date(clock.t).toISOString(),
		model: "Synthetic-TH",
		id: 100 + k,
		channel: 1 + (k % 3),
		battery_ok: 1,
		temperature_C: 10 + (k % 7) + rand(),
		humidity: 40 + (k % 20),
	},
})

try {
	const store = await openActivityStore({
		stateDir: dir,
		logger: silent,
		execution: "inline",
		now: () => clock.t,
	})
	const ingress = createActivityIngress({
		sink: (envelope, present) => {
			store.admit(envelope, present)
		},
		logger: silent,
		now: () => new Date(clock.t),
	})

	// "Decoded Message" line size (src/index.ts logs every decoder output at debug; info before 2026-11-01).
	let logBytes = 0
	let logLines = 0
	const counter = new Writable({
		write(chunk: Buffer, _enc, done) {
			logBytes += chunk.length
			logLines += 1
			done()
		},
	})
	const mainLog = createComponentLogger(
		pino({ level: "info" }, counter),
		"Main",
	)

	const f0 = performance.now()
	let receptions = 0
	let pages = 0
	const pageEveryS =
		profile.pagesPerHour > 0 ? 3600 / profile.pagesPerHour : Infinity
	let nextPage = 0
	for (let s = 0; s < MINUTES * 60; s++) {
		clock.t = T0 + s * 1_000
		for (let a = 0; a < profile.aircraft; a++) {
			const out = aircraftOutput(a, s)
			ingress.publish("readsb", "readsb", out)
			if (s < 10)
				mainLog.info({ decoderId: "readsb", output: out }, "Decoded Message")
			receptions++
		}
		while (s >= nextPage) {
			const out = pageOutput(pages++)
			ingress.publish("multimon-ng", "multimon-ng", out)
			receptions++
			nextPage += pageEveryS
		}
		for (let k = 0; k < profile.sensors; k++) {
			if ((s + k * 7) % profile.sensorPeriodS !== 0) continue
			ingress.publish("rtl433", "rtl433", sensorOutput(k))
			receptions++
		}
		// Let the inline writer commit (batch timers are real).
		if (s % 5 === 0) await new Promise(resolve => setTimeout(resolve, 2))
	}
	await new Promise(resolve => setTimeout(resolve, 200))
	const feedMs = performance.now() - f0
	const st = store.stats()
	await store.close()

	const dbPath = join(dir, "activity", "activity.db")
	const walBytes = await stat(`${dbPath}-wal`)
		.then(x => x.size)
		.catch(() => 0)
	const db = await openSqliteFile(dbPath, true)
	const n = (sql: string): number => Number(db.prepare(sql).get()?.["n"] ?? 0)
	const rows = n("SELECT count(*) AS n FROM activity")
	const pageSize = n("SELECT page_size AS n FROM pragma_page_size")
	const pages_ = n("SELECT page_count AS n FROM pragma_page_count")
	const free = n("SELECT freelist_count AS n FROM pragma_freelist_count")
	const byProtocol = db
		.prepare(
			"SELECT coalesce(protocol, '-') AS p, count(*) AS n, round(avg(length(summary_json) + length(record_json))) AS b FROM activity GROUP BY 1",
		)
		.all()
	db.close()

	const liveBytes = (pages_ - free) * pageSize
	const bytesPerRow = rows > 0 ? liveBytes / rows : 0
	const rowsPerHour = (rows * 60) / MINUTES
	const mbPerDay = (rowsPerHour * 24 * bytesPerRow) / 1e6
	const capRows = Math.min(
		ACTIVITY_LIMIT_DEFAULTS.maxRows,
		bytesPerRow > 0
			? ACTIVITY_LIMIT_DEFAULTS.maxDbBytes / bytesPerRow
			: Infinity,
	)

	// Startup: reopen the store at this size (lock, schema check, seed).
	const o0 = performance.now()
	const reopened = await openActivityStore({
		stateDir: dir,
		logger: silent,
		execution: "inline",
		now: () => clock.t,
	})
	const reopenMs = performance.now() - o0
	await reopened.close()

	console.log(
		JSON.stringify({
			profile: profileName,
			simulatedMinutes: MINUTES,
			receptions,
			rows,
			coalesced: st.coalescedPositions,
			dropped: st.dropped,
			rowsPerHour: Math.round(rowsPerHour),
			bytesPerRowOnDisk: Math.round(bytesPerRow),
			byProtocol,
			dbMiB: Number((liveBytes / 2 ** 20).toFixed(1)),
			walMiB: Number((walBytes / 2 ** 20).toFixed(1)),
			mbPerDayUncapped: Number(mbPerDay.toFixed(1)),
			hoursToCap: Number((capRows / rowsPerHour).toFixed(1)),
			capBinds:
				capRows < ACTIVITY_LIMIT_DEFAULTS.maxRows ? "maxDbBytes" : "maxRows",
			reopenMs: Math.round(reopenMs),
			decodedMessageLineBytes:
				logLines > 0 ? Math.round(logBytes / logLines) : null,
			feedWallMs: Math.round(feedMs),
			dir: KEEP ? dir : null,
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
		}),
	)
} finally {
	if (!KEEP) await rm(dir, { recursive: true, force: true })
}
