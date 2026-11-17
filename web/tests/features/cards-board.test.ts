// Activity › Cards › Expand: a card with audio carries the play disc (the drawer's list queue, or its own
// recording alone when the list folds the card away); a card without audio has none.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import type { QueueRef } from "../../src/features/playback/service.ts"
import {
	BoardCard,
	boardQueue,
} from "../../src/features/messages/CardsBoard.tsx"

let services: AppServices | null = null
afterEach(() => {
	services?.dispose()
	services = null
})

let seq = 0
const card = (over: Partial<ActivitySummary> = {}): ActivitySummary => {
	seq += 1
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: "2026-10-17T12:00:00.000Z",
		receivedAt: "2026-10-17T12:00:00.000Z",
		decoderId: "dsd-fme",
		sourceId: "rtl-0",
		protocol: "dmr",
		category: "voice",
		frequencyHz: 446_006_250,
		entityKey: null,
		title: `TG ${seq}`,
		fields: [],
		...over,
	}
}

const Q: QueueRef = {
	source: "activity",
	list: "list-9",
	ids: ["dsd~a.wav"],
	titles: { "dsd~a.wav": "TG a" },
}

function render(item: ActivitySummary): string {
	services = createServices({
		fetch: async () => {
			throw new TypeError("offline")
		},
		createSocket: () => ({
			readyState: 0,
			onopen: null,
			onclose: null,
			onerror: null,
			onmessage: null,
			send: () => undefined,
			close: () => undefined,
		}),
	})
	return renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			createElement(BoardCard, {
				item,
				readOnly: false,
				onOpen: () => undefined,
				queue: () => Q,
			}),
		),
	)
}

describe("Cards board play disc", () => {
	it("draws the disc on a card with a recording, none on one without", () => {
		const html = render(
			card({ recording: { id: "dsd~a.wav", durationMs: 4000 } }),
		)
		expect(html).toContain('data-playback-id="dsd~a.wav"')
		expect(html).toContain("wka-cardstack")
		expect(html).toContain('aria-label="Play TG')
		const plain = render(card())
		expect(plain).not.toContain("wkp-disc")
		expect(plain).not.toContain("wka-cardstack")
	})

	it("plays from the list's queue, or alone when the list folds the card away", () => {
		const shown = card({ recording: { id: "dsd~a.wav", durationMs: 4000 } })
		expect(boardQueue(Q, shown)).toBe(Q)
		const folded = card({ recording: { id: "dsd~b.wav", durationMs: 2000 } })
		expect(boardQueue(Q, folded)).toEqual({
			source: "activity",
			list: "list-9",
			ids: ["dsd~b.wav"],
			titles: { "dsd~b.wav": folded.title },
		})
		expect(boardQueue(Q, card())).toBe(Q)
	})
})
