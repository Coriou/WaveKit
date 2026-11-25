// The Activity detail of a transmission's event speaks in words: a kept recording's card shows its channel on the
// raster in MHz, local times and durations in seconds, never its raw ids, Hz with decimals or ISO times (those sit
// in the collapsed expert section); a live analog transmission's codes are sentences; the detail offers Details,
// the door to the Transmission view.
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { ActivityRecord } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import {
	messageView,
	rawOf,
	summaryOfRecord,
} from "../../src/features/messages/card.ts"
import { PlayerDock } from "../../src/features/playback/PlayerDock.tsx"
import { recordingChangeDetails } from "../../src/features/transmission/words.ts"
import { playerCompactForced } from "../../src/shell/layout/stores.ts"

const KEPT: Extract<ActivityRecord, { kind: "recording-change" }> = {
	version: 1,
	eventId: "evt_k",
	commitSeq: "7",
	producedAt: "2026-11-23T17:30:40.000Z",
	receivedAt: "2026-11-23T17:30:40.000Z",
	kind: "recording-change",
	payload: {
		change: "finalized",
		recordingId: "scan:d_A~analog-1.wav",
		recordingKind: "scanner-analog",
		discoveryId: "d_A",
		observationId: "o_A",
		sourceId: "rx-1",
		frequencyHz: 145_562_753.21,
		channel: { discoveryId: "d_B", frequencyHz: 145_562_500 },
		observationStartedAt: "2026-11-23T17:30:21.000Z",
		durationMs: 8181,
		finalizedAt: "2026-11-23T17:30:40.000Z",
	},
} as Extract<ActivityRecord, { kind: "recording-change" }>

const RAW = [
	"scan:d_A",
	"d_A",
	"o_A",
	"rx-1",
	"145562753",
	"562 753",
	".21",
	"2026-11-23T",
	"8181",
	"finalized",
]

describe("a kept recording's event in words", () => {
	it("rebuilt from its record: on its channel, voice, its file linked", () => {
		const s = summaryOfRecord(KEPT)
		expect(s).toMatchObject({
			category: "voice",
			protocol: "analog",
			frequencyHz: 145_562_500,
			recording: { id: "scan:d_A~analog-1.wav", durationMs: 8181 },
			channel: { discoveryId: "d_B", frequencyHz: 145_562_500 },
		})
	})

	it("shows Channel, Transmission started, Duration and Kept at, and no raw id, Hz or ISO time", () => {
		const v = messageView(summaryOfRecord(KEPT), KEPT)
		expect(v.fields.map(f => f.label)).toEqual([
			"Channel",
			"Transmission started",
			"Duration",
			"Kept at",
		])
		expect(v.fields.find(f => f.label === "Channel")?.value).toBe(
			"145.5625 MHz",
		)
		expect(v.fields.find(f => f.label === "Duration")?.value).toBe("8 s")
		const shown = JSON.stringify(v.fields)
		for (const raw of RAW) expect(shown).not.toContain(raw)
		// the JSON toggle moves to the expert section
		expect(v.raw).toBeNull()
		expect(rawOf(KEPT)).toBeNull()
	})

	it("in words from its list row alone, before its record loads", () => {
		const s = summaryOfRecord(KEPT)
		const listed = {
			...s,
			fields: [
				{ key: "durationMs", label: "Duration", value: 8181, unit: "ms" },
			],
		}
		const v = messageView(listed, null)
		expect(v.fields).toEqual([
			{ key: "channel", label: "Channel", value: "145.5625 MHz" },
			{ key: "duration", label: "Duration", value: "8 s" },
		])
	})

	it("keeps every id and raw number for the expert section, the measured centre in MHz", () => {
		const d = recordingChangeDetails(KEPT.payload)
		const by = Object.fromEntries(d.map(r => [r.term, r.value]))
		expect(by).toMatchObject({
			Recording: "scan:d_A~analog-1.wav",
			Discovery: "d_A",
			"Owner discovery": "d_B",
			Observation: "o_A",
			Receiver: "rx-1",
			Measured: "145.562753 MHz (+253 Hz)",
			Duration: "8 s",
		})
		const started = d.find(r => r.term === "Transmission started")
		expect(started?.iso).toBe("2026-11-23T17:30:21.000Z")
		expect(started?.code).toBe(false)
		expect(started?.value).not.toContain("T17")
		expect(`${started?.value ?? ""} ${started?.hint ?? ""}`).toContain(
			"17:30:21",
		)
		expect(d.some(r => r.term.includes("ms") || r.term.includes("(UTC)"))).toBe(
			false,
		)
	})

	it("a live analog transmission's duration and close are words", () => {
		const live = {
			version: 1,
			eventId: "evt_l",
			commitSeq: "8",
			producedAt: "2026-11-23T17:30:40.000Z",
			receivedAt: "2026-11-23T17:30:40.000Z",
			kind: "analog-transmission",
			payload: {
				transmissionId: "t1",
				sourceId: "rx",
				modulation: "nfm",
				frequency: { hz: 145_562_500 },
				startedAt: "2026-11-23T17:30:21.000Z",
				endedAt: "2026-11-23T17:30:29.000Z",
				durationMs: 8181,
				bandwidthHz: 12_500,
				squelchMode: "carrier",
				peakChannelPowerDbfs: -20,
				closeReason: "squelch",
			},
		} as unknown as ActivityRecord
		const v = messageView(summaryOfRecord(live), live)
		expect(v.fields.find(f => f.key === "duration")?.value).toBe("8 s")
		expect(v.fields.find(f => f.key === "closed")).toMatchObject({
			label: "Ended",
			value: "The transmission ended",
		})
	})

	it("the detail offers Details, the door to the Transmission view, and a collapsed expert section", () => {
		const detail = readFileSync(
			new URL(
				"../../src/features/activity/ActivityDetail.tsx",
				import.meta.url,
			),
			"utf8",
		)
		expect(detail).toContain("isTransmissionRow(item)")
		expect(detail).toContain('{ host: "activity", label: "Activity" }')
		expect(detail).toContain('<details className="wka-expert">')
	})
})

// ---- the player's compact line (Insufficient height) names what plays and can close it

let services: AppServices | null = null
afterEach(() => {
	playerCompactForced.set(false)
	services?.dispose()
	services = null
})

function renderDock(): string {
	services = createServices()
	services.playback.play("scan:d_A~a.wav", undefined, 0, "Club net")
	return renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			createElement(PlayerDock),
		),
	)
}

describe("the one player", () => {
	it("the compact line keeps the title and the close control", () => {
		playerCompactForced.set(true)
		const html = renderDock()
		expect(html).toContain("data-compact")
		expect(html).toContain("Club net")
		expect(html).toContain("This transmission&#x27;s details")
		expect(html).toContain('aria-label="Close player and unmute live audio"')
	})

	it("is full whenever the layout has the height, whatever row is open", () => {
		const html = renderDock()
		expect(html).not.toContain("data-compact")
		expect(html).toContain('aria-label="Next"')
		expect(html).toContain("Club net")
	})
})
