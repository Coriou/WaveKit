import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { ResumeScan } from "../../src/features/scanner/ResumeScan.tsx"

let services: AppServices | null = null
afterEach(() => {
	services?.dispose()
	services = null
})

function render(
	job: Pick<ScanJob, "id" | "state" | "reason"> &
		Partial<Pick<ScanJob, "impact">>,
): string {
	// no core: every read fails, nothing is fetched while rendering
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
			createElement(ResumeScan, { job: job as ScanJob }),
		),
	)
}

describe("Resume in the plan and drawer footers", () => {
	it("is offered for every paused reason Resume can move", () => {
		for (const reason of [
			"operator",
			"preempted-operator",
			"preempted-relay",
			"core-restart",
			"resume-blocked",
			"resumed-without-retune",
		] as const) {
			const html = render({ id: "j1", state: "paused", reason })
			expect(html).toContain(">Resume</button>")
			expect(html).not.toContain("disabled")
		}
	})

	it("names who a blocked scan interrupts on the first button, and reads plain Resume when the job names nobody", () => {
		const impact = {
			liveAudioClients: 1,
			digitalVoiceListeners: 0,
			runningDecoders: [],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}
		const named = render({
			id: "j1",
			state: "paused",
			reason: "resume-blocked",
			impact,
		})
		expect(named).toContain(">Resume and interrupt 1 listener</button>")
		const nobody = render({
			id: "j1",
			state: "paused",
			reason: "resume-blocked",
			impact: { ...impact, liveAudioClients: 0, unrestorable: ["gain"] },
		})
		expect(nobody).toContain(">Resume</button>")
		const two = render({
			id: "j1",
			state: "paused",
			reason: "resume-blocked",
			impact: {
				...impact,
				liveAudioClients: 0,
				runningDecoders: ["aprs-1", "aprs-2"],
			},
		})
		expect(two).toContain("Resume and interrupt aprs-1, aprs-2</button>")
	})

	it("is not offered where the core would only refuse, or on a scan that is not paused", () => {
		expect(render({ id: "j1", state: "paused", reason: "source-down" })).toBe(
			"",
		)
		expect(render({ id: "j1", state: "paused", reason: "preempted-job" })).toBe(
			"",
		)
		expect(render({ id: "j1", state: "running" })).toBe("")
	})
})
