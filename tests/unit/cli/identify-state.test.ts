import { describe, expect, it } from "vitest"
import {
	guardScan,
	guardSpectrumFrame,
} from "../../../cli/source/data/scanner-guards.js"
import {
	initialScan,
	scanFrame,
	scanProfile,
} from "../../../cli/source/data/scan-state.js"
import {
	identifyConsentLayout,
	identifyFrameKey,
	identifyPromptMatches,
	identifyReadiness,
	identifyReceiptCanPrepare,
	identifyReceiptOutcome,
	identifyReceiptRead,
	identifyReceiptReconnect,
	identifySourceIdentity,
	type IdentifyContext,
	type IdentifyEvidence,
	type IdentifyPrompt,
	type IdentifyReceipt,
	type IdentifyRequest,
} from "../../../cli/source/data/identify-state.js"
import {
	SCAN_DISCOVERY,
	SCAN_FRAME,
	SCAN_JOB,
	SCAN_PROFILE,
	SCAN_STATUS,
} from "../../../cli/source/test/fixtures.js"

const now = 20_000
const context: IdentifyContext = {
	sourceId: "rtl",
	discoveryId: "disc1",
	key: "scan:rtl:disc1",
	active: true,
	columns: 60,
	rows: 16,
	contentRows: 12,
}
const request: IdentifyRequest = {
	sourceId: "rtl",
	target: {
		frequencyHz: SCAN_DISCOVERY.frequencyHz,
		bandwidthHz: SCAN_DISCOVERY.bandwidthHz,
	},
	timeoutMs: 15000,
	exhaustive: false,
	record: false,
}
function evidence(): IdentifyEvidence {
	const frame = guardSpectrumFrame(SCAN_FRAME)!
	const scan = scanFrame(
		scanProfile({ ...initialScan(), sourceId: "rtl" }, SCAN_PROFILE),
		frame,
		now,
	)
	return {
		destination: "http://core",
		session: 1,
		revision: 2,
		profileGeneration: 3,
		context: { ...context },
		connected: true,
		authBlocked: false,
		source: {
			id: "rtl",
			connected: true,
			available: true,
			consumers: 0,
			bytesReceived: 1,
			dataRate: 1,
			reconnectAttempts: 0,
			assignments: [],
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: frame.sampleRateHz,
				centerFreq: frame.centerHz,
				exclusive: false,
			},
			activity: {
				state: "streaming",
				lastSampleAt: null,
				sampleAgeMs: 0,
				timeoutMs: 1000,
			},
		},
		sourceAt: now,
		sourceDirty: false,
		scan,
		frame: { frame, receivedAt: now },
		detail: guardScan("discovery", SCAN_DISCOVERY)!,
		detailAt: now,
		detailDirty: false,
		status: guardScan("status", SCAN_STATUS)!,
		statusAt: now,
		statusDirty: false,
	}
}
function receipt(): IdentifyReceipt {
	return {
		phase: "preparing",
		destination: "http://core",
		session: 1,
		request,
		status: null,
		jobId: null,
		job: null,
		error: null,
		terminalAt: null,
		readGeneration: 1,
	}
}
function prompt(e: IdentifyEvidence): IdentifyPrompt {
	const r = identifyReadiness(e, null, now)
	return {
		token: 1,
		destination: e.destination!,
		session: e.session,
		revision: e.revision,
		profileGeneration: e.profileGeneration,
		contextKey: e.context.key,
		discoveryId: e.context.discoveryId!,
		request: r.request!,
		frameKey: identifyFrameKey(e.frame!.frame),
		layout: r.layout!,
	}
}

describe("identify readiness and synchronous evidence", () => {
	it("uses inclusive whole-width usable-window equality and exact width without rounding", () => {
		const e = evidence()
		e.detail = {
			...e.detail!,
			frequencyHz: SCAN_FRAME.centerHz + SCAN_FRAME.sampleRateHz * 0.4 - 6250,
		}
		expect(identifyReadiness(e, null, now).ready).toBe(true)
		e.detail.frequencyHz += 0.001
		expect(identifyReadiness(e, null, now).ready).toBe(false)
	})
	it.each([0, -1, Infinity, NaN, 1_000_001])(
		"rejects invalid width %s",
		bandwidthHz => {
			const e = evidence()
			e.detail = { ...e.detail!, bandwidthHz }
			expect(identifyReadiness(e, null, now).ready).toBe(false)
		},
	)
	it("checks live clock even when rendered time and all evidence have not changed", () => {
		const e = evidence()
		const p = prompt(e)
		expect(identifyPromptMatches(p, e, receipt(), now + 15000)).toBe(true)
		expect(identifyPromptMatches(p, e, receipt(), now + 15001)).toBe(false)
	})
	it.each([
		(e: IdentifyEvidence) => {
			e.detailDirty = true
		},
		(e: IdentifyEvidence) => {
			e.sourceDirty = true
		},
		(e: IdentifyEvidence) => {
			e.statusDirty = true
		},
		(e: IdentifyEvidence) => {
			e.connected = false
		},
		(e: IdentifyEvidence) => {
			e.authBlocked = true
		},
		(e: IdentifyEvidence) => {
			e.source = null
		},
		(e: IdentifyEvidence) => {
			e.source!.connected = false
		},
		(e: IdentifyEvidence) => {
			e.source!.activity!.state = "waiting"
		},
		(e: IdentifyEvidence) => {
			e.source!.caps.format = "S16_IQ"
		},
		(e: IdentifyEvidence) => {
			e.source!.caps.centerFreq = 1
		},
		(e: IdentifyEvidence) => {
			e.status!.enabled = false
		},
		(e: IdentifyEvidence) => {
			e.status!.engines[0]!.state = "error"
		},
		(e: IdentifyEvidence) => {
			e.detail!.operator = { lockout: true }
		},
		(e: IdentifyEvidence) => {
			e.detail!.sourceIds = ["other"]
		},
		(e: IdentifyEvidence) => {
			e.detail!.id = "merged-survivor"
		},
		(e: IdentifyEvidence) => {
			e.frame!.frame.tuningTrust = "unverified"
		},
		(e: IdentifyEvidence) => {
			e.scan.profile = null
		},
		(e: IdentifyEvidence) => {
			e.context.active = false
		},
		(e: IdentifyEvidence) => {
			e.context.columns = 0
		},
	])(
		"fails closed on changed ingress evidence %# before a render tick",
		invalidate => {
			const e = evidence()
			const p = prompt(e)
			invalidate(e)
			expect(identifyPromptMatches(p, e, receipt(), now)).toBe(false)
		},
	)
	it("equivalent frames refresh age without changing authorization; material layouts and revisions revoke", () => {
		const e = evidence()
		const p = prompt(e)
		e.frame!.receivedAt += 1
		expect(identifyPromptMatches(p, e, receipt(), now + 1)).toBe(true)
		for (const patch of [
			{ revision: 3 },
			{ session: 2 },
			{ profileGeneration: 4 },
			{ destination: "http://other" },
		])
			expect(
				identifyPromptMatches(p, { ...e, ...patch }, receipt(), now + 1),
			).toBe(false)
		e.frame!.frame.epoch++
		expect(identifyPromptMatches(p, e, receipt(), now + 1)).toBe(false)
	})
	it("dirty detail cannot be authorized by a cached pre-fence fetch", () => {
		const e = evidence()
		e.detailDirty = true
		e.detailAt = now
		expect(identifyReadiness(e, null, now).ready).toBe(false)
	})
	it("does not confuse old lastSeen or capacity pressure with live source/admission", () => {
		const e = evidence()
		e.detail!.lastSeenAt = "2000-01-01T00:00:00Z"
		e.status!.budgets.probesInUse.offset = 100
		expect(identifyReadiness(e, null, now).ready).toBe(true)
	})
})

describe("full pinned consent layout", () => {
	it.each([
		[60, 16, 12],
		[80, 24, 20],
		[200, 50, 46],
	])("retains all disclosures at %sx%s", (columns, rows, contentRows) => {
		const l = identifyConsentLayout(request, {
			...context,
			columns,
			rows,
			contentRows,
		})
		expect(l.fits).toBe(true)
		const text = l.lines.join("")
		for (const field of [
			"Identify this frequency",
			"Source: rtl",
			`Frequency: ${request.target.frequencyHz} Hz`,
			"Width: 12500 Hz",
			"Wait up to 15s for signal; trials may take longer.",
			"May preempt scanner probes.",
			"Updates scanner discoveries and observations.",
			"No trial recordings; other scanner activity may record.",
		])
			expect(text).toContain(field)
		expect(l.lines.every(line => line.length <= columns - 3)).toBe(true)
	})
	it("preserves every source character and whitespace through wrapping", () => {
		const sourceId = "a  ".repeat(40) + "\\\n\u00e9\ud800"
		const identity = identifySourceIdentity(sourceId)
		expect(identity).toContain("\\\\\\u000a\\u00e9\\ud800")
		const l = identifyConsentLayout(
			{ ...request, sourceId },
			{ ...context, columns: 80, rows: 24, contentRows: 20 },
		)
		expect(l.fits).toBe(true)
		expect(l.lines.join("")).toContain(`Source: ${identity}`)
	})
	it("fails closed for oversized identity, unknown size, insufficient budget or shrink/grow", () => {
		for (const c of [
			{ columns: 59 },
			{ rows: 15 },
			{ columns: NaN },
			{ rows: 0 },
			{ contentRows: 7 },
		])
			expect(identifyConsentLayout(request, { ...context, ...c }).fits).toBe(
				false,
			)
		expect(
			identifyConsentLayout(
				{ ...request, sourceId: "\u00e9".repeat(128) },
				context,
			).fits,
		).toBe(false)
		const e = evidence()
		const p = prompt(e)
		e.context.columns = 80
		expect(identifyPromptMatches(p, e, receipt(), now)).toBe(false)
	})
	it("retains exact numeric strings, including exponents", () => {
		const r = {
			...request,
			target: { frequencyHz: 1e-20, bandwidthHz: 0.000000001 },
		}
		expect(identifyConsentLayout(r, context).lines.join("")).toContain(
			`Frequency: ${String(r.target.frequencyHz)} Hz`,
		)
	})
})

describe("finite exact-ID receipt lifecycle", () => {
	const job = guardScan("job", SCAN_JOB)!
	const read = {
		destination: "http://core",
		session: 1,
		readGeneration: 1,
		now,
	}
	it("201 terminal state cannot unlock; exact-ID direct GET can", () => {
		const known = identifyReceiptOutcome(receipt(), {
			kind: "accepted",
			status: 201,
			job,
		})
		expect(known.phase).toBe("known")
		expect(identifyReceiptCanPrepare(known, "http://core", 1, now)).toBe(false)
		const terminal = identifyReceiptRead(known, job, null, read)
		expect(
			identifyReceiptCanPrepare(terminal, "http://core", 1, now + 15000),
		).toBe(true)
		expect(
			identifyReceiptCanPrepare(terminal, "http://core", 1, now + 15001),
		).toBe(false)
		for (const next of [
			identifyReceiptRead(terminal, null, "404", read),
			identifyReceiptRead(terminal, { ...job, state: "running" }, null, read),
			identifyReceiptReconnect(terminal, 2),
		])
			expect(next.phase).toBe("known")
	})
	it("never accepts another ID/destination/session/read generation as terminal proof", () => {
		const known = identifyReceiptOutcome(receipt(), {
			kind: "accepted",
			status: 201,
			job,
		})
		for (const c of [
			{ ...read, destination: "http://other" },
			{ ...read, session: 2 },
			{ ...read, readGeneration: 2 },
		])
			expect(identifyReceiptRead(known, job, null, c)).toBe(known)
		expect(
			identifyReceiptRead(known, { ...job, id: "candidate" }, null, read).phase,
		).toBe("known")
		expect(
			identifyReceiptRead(
				known,
				{ ...job, spec: { ...job.spec, sourceId: "other" } },
				null,
				read,
			).phase,
		).toBe("known")
	})
	it("unresolved remains inspection-only across reconnect, candidate reads and late POST completion", () => {
		const unresolved = identifyReceiptOutcome(receipt(), {
			kind: "unresolved",
			status: 201,
			acceptedResponse: true,
		})
		expect(
			identifyReceiptOutcome(unresolved, {
				kind: "accepted",
				status: 201,
				job,
			}),
		).toBe(unresolved)
		expect(identifyReceiptRead(unresolved, job, null, read)).toBe(unresolved)
		expect(
			identifyReceiptCanPrepare(
				identifyReceiptReconnect(unresolved, 2),
				"http://core",
				2,
				now,
			),
		).toBe(false)
	})
	it("unsent or reviewed refusal permits only a new deliberate preparation", () => {
		for (const outcome of [
			{ kind: "unsent", status: null, reason: "eligibility" },
			{ kind: "refused", status: 409, code: "OUT_OF_WINDOW" },
		] as const)
			expect(
				identifyReceiptCanPrepare(
					identifyReceiptOutcome(receipt(), outcome),
					"http://core",
					1,
					now,
				),
			).toBe(true)
	})
})
