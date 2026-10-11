import { describe, it, expect } from "vitest"
import {
	initialState,
	PLAIN_SUMMARY,
} from "../../../cli/source/data/reducers.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	scanModel,
	scanDetail,
	identifyDisclosure,
	scanIdentifyReady,
	scanRowIds,
} from "../../../cli/source/view-models/scan.js"
import {
	identifySourceIdentity,
	type IdentifyRequest,
	type IdentifyReceipt,
} from "../../../cli/source/data/identify-state.js"
import { chromeRows } from "../../../cli/source/ui/frame.js"
import {
	selectScan,
	scanProfile,
	scanFrame,
	scanRead,
} from "../../../cli/source/data/scan-state.js"
import { guardScan } from "../../../cli/source/data/scanner-guards.js"
import {
	scenarioState,
	SCAN_FRAME,
	SCAN_PROFILE,
	SCAN_JOB,
} from "../../../cli/source/test/fixtures.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { decoderConfirm } from "../../../cli/source/view-models/decoders.js"

const identifyRequest: IdentifyRequest = {
	sourceId: "rtl",
	target: { frequencyHz: 446056250, bandwidthHz: 12500 },
	timeoutMs: 15000,
	exhaustive: false,
	record: false,
}

describe("identify disclosure and independent receipt", () => {
	it.each([
		[60, 16],
		[80, 24],
		[200, 50],
	])(
		"pins every disclosure at %sx%s with banner and scrolled detail",
		(cols, rows) => {
			for (const banner of [false, true]) {
				const state = initialState(1000),
					ui = initialUi("scan")
				const height = chromeRows(rows, banner).content
				const request = { ...identifyRequest, sourceId: "R".repeat(128) }
				const layout = identifyDisclosure(request, cols - 1, height)
				expect(layout.fits).toBe(true)
				ui.detail.scan = { open: true, scroll: 4000 }
				ui.confirm = {
					kind: "identify",
					token: 1,
					request,
					prompt: "Identify",
					yes: "confirm",
					no: "cancel",
					layout: { width: cols - 1, height, rows: layout.lines },
				}
				const model = scanModel(state, ui, cols - 1, height)
				expect(model.lines.slice(0, layout.lines.length).map(lineText)).toEqual(
					layout.lines,
				)
				expect(model.lines.length).toBeLessThanOrEqual(height)
				expect(model.lines.every(l => cellWidth(lineText(l)) <= cols - 3)).toBe(
					true,
				)
				const text = layout.lines.join("")
				for (const value of [
					"Identify this frequency",
					`Source: ${request.sourceId}`,
					"Frequency: 446056250 Hz",
					"Width: 12500 Hz",
					"Wait up to 15s for signal; trials may take longer.",
					"May preempt scanner probes.",
					"Updates scanner discoveries and observations.",
					"No trial recordings; other scanner activity may record.",
				])
					expect(text).toContain(value)
			}
		},
	)
	it("preserves identity whitespace, controls, Unicode and exact exponent numbers without rounding", () => {
		const sourceId = " leading  spaces\\literal\n\t\u001b\u202e📡 trailing "
		const request = {
			...identifyRequest,
			sourceId,
			target: { frequencyHz: 1e100, bandwidthHz: 1e-100 },
		}
		const layout = identifyDisclosure(request, 59, 12)
		expect(layout.fits).toBe(true)
		expect(layout.lines.join("")).toContain(
			`Source: ${identifySourceIdentity(sourceId)}`,
		)
		expect(layout.lines.join("")).toContain("Frequency: 1e+100 Hz")
		expect(layout.lines.join("")).toContain("Width: 1e-100 Hz")
		expect(layout.lines.join("")).not.toMatch(/[^\x20-\x7e]/)
		expect(identifySourceIdentity("\\u000a")).not.toBe(
			identifySourceIdentity("\n"),
		)
	})
	it("denies oversized consent, changed layout and hidden help while keeping inspection", () => {
		const state = initialState(1000),
			ui = initialUi("scan")
		const request = { ...identifyRequest, sourceId: "📡".repeat(100) }
		expect(identifyDisclosure(request, 59, 12).fits).toBe(false)
		expect(identifyDisclosure(identifyRequest, 58, 12).fits).toBe(false)
		expect(identifyDisclosure(identifyRequest, 59, 7).fits).toBe(false)
		const layout = identifyDisclosure(identifyRequest, 79, 20)
		ui.confirm = {
			kind: "identify",
			token: 1,
			request: identifyRequest,
			prompt: "Identify",
			yes: "confirm",
			no: "cancel",
			layout: { width: 79, height: 20, rows: layout.lines },
		}
		expect(
			scanModel(state, ui, 59, 12).lines.map(lineText).join("\n"),
		).toContain("Confirmation cannot fit")
		ui.help = true
		expect(
			scanModel(state, ui, 79, 20).lines.map(lineText).join("\n"),
		).toContain("Confirmation cannot fit")
		expect(scanIdentifyReady(state, ui, 79, 20)).toBe(false)
	})
	it("shows retained off-list result without source admission and keeps unresolved inspection-only", () => {
		const state = initialState(1000),
			ui = initialUi("scan")
		const receipt: IdentifyReceipt = {
			phase: "known",
			destination: "http://localhost:3000",
			session: 1,
			request: identifyRequest,
			status: 201,
			jobId: SCAN_JOB.id,
			job: guardScan("job", SCAN_JOB)!,
			error: null,
			terminalAt: null,
			readGeneration: 1,
		}
		state.identify = {
			prompt: null,
			receipt,
			readiness: {
				ready: false,
				reason: "Inspect the previous identify receipt",
				request: null,
				layout: null,
			},
			inspection: true,
		}
		ui.scan.receipt = true
		ui.detail.scan.open = true
		for (const tab of ["spectrum", "discoveries", "jobs"] as const) {
			ui.scan.tab = tab
			expect(scanRowIds(state, ui)).toEqual([])
			const text = scanDetail(state, ui, 199).join("\n")
			expect(text).toContain(`job ID: ${SCAN_JOB.id}`)
			expect(text).toContain("unsupported (needs-channelizer)")
			expect(text).toContain("peak ? dBFS")
		}
		receipt.phase = "unresolved"
		receipt.job = null
		receipt.jobId = null
		expect(scanDetail(state, ui, 199).join("\n")).toContain(
			"Inspection only for this session; no retry.",
		)
	})
})

describe("read-only Scan presentation", () => {
	it("shows requested/served widths, cadence, units, trust and stale state", () => {
		const state = initialState(1000),
			ui = initialUi("scan")
		ui.scan.sourceId = "rtl"
		state.scan = scanFrame(
			scanProfile(selectScan(state.scan, "rtl"), {
				...SCAN_PROFILE,
				outcome: "nearest",
				adjusted: ["profile-limit"],
			}),
			SCAN_FRAME,
			1000,
		)
		const m = scanModel(state, ui, 199, 30)
		const text = m.lines.map(lineText).join("\n")
		expect(text).toContain("requested 5Hz x 512")
		expect(text).toContain("profile-limit")
		expect(text).toContain("width 6400 Hz (native 1000)")
		expect(text).toContain("dBFS")
		expect(scanModel({ ...state, now: 7000 }, ui, 199, 30).plotHeight).toBe(0)
		expect(
			scanModel({ ...state, now: 7000 }, ui, 199, 30)
				.lines.map(lineText)
				.join("\n"),
		).toContain("stale")
	})
	it("keeps null measurements unknown and unsupported trials distinct from decode failure", () => {
		const state = initialState(1000),
			ui = initialUi("scan")
		ui.scan.tab = "jobs"
		state.scan = scanRead(
			state.scan,
			"job",
			guardScan("job", SCAN_JOB)!,
			null,
			1000,
		)
		const text = scanDetail(state, ui, 199).join("\n")
		expect(text).toContain("unsupported (needs-channelizer)")
		expect(text).toContain("peak ? dBFS")
		expect(text).toContain("unrestorable: gain")
		expect(text).toContain("does not establish settled")
		state.now = 17000
		expect(scanDetail(state, ui)[0]).toBe("Cached job: cached data is stale")
		state.scan = scanRead(
			state.scan,
			"job",
			null,
			"HTTP 503 SCANNER_STATE_UNAVAILABLE",
			1000,
		)
		expect(scanDetail(state, ui)).toEqual([
			"HTTP 503 SCANNER_STATE_UNAVAILABLE",
		])
	})
	it("fits bounded output in compact terminals and distinguishes errors from empty", () => {
		const state = initialState(1000),
			ui = initialUi("scan")
		ui.scan.tab = "jobs"
		state.scan = scanRead(
			state.scan,
			"jobs",
			null,
			"HTTP 503 SCANNER_STATE_UNAVAILABLE",
			1000,
		)
		const m = scanModel(state, ui, 59, 11)
		expect(m.lines.every(l => cellWidth(lineText(l)) <= 59)).toBe(true)
		expect(m.lines.map(lineText).join("\n")).toContain("HTTP 503")
	})
	it("refuses manual confirms for owned and ephemeral scanner probes", () => {
		const s = scenarioState("live", PLAIN_SUMMARY)
		const d = s.decoders.value![0]!
		for (const patch of [
			{ owner: "scanner" as const },
			{ ephemeral: true as const },
		]) {
			s.decoders.value = [{ ...d, ...patch }]
			for (const op of ["start", "stop", "restart", "unpin"] as const)
				expect(decoderConfirm(s, d.id, op)).toBeNull()
		}
	})
})

it.each([59, 79])(
	"preserves narrow profile, result and RF semantics with bounded detail wrapping at%s",
	width => {
		const state = initialState(1000),
			ui = initialUi("scan")
		ui.scan.sourceId = "rtl"
		state.scan = scanFrame(
			scanProfile(selectScan(state.scan, "rtl"), {
				...SCAN_PROFILE,
				outcome: "nearest",
				adjusted: ["profile-limit"],
			}),
			{
				...SCAN_FRAME,
				tuningTrust: "unverified",
				masks: {
					...SCAN_FRAME.masks,
					spurRanges: [{ startHz: 445100000, endHz: 445110000 }],
				},
			},
			1000,
		)
		const text = scanModel(state, ui, width, 11).lines.map(lineText).join("\n")
		for (const essential of [
			"nearest",
			"profile-limit",
			"effective",
			"native 1000",
			"DC",
		])
			expect(text).toContain(essential)
		const rows = scanDetail(state, ui, width)
		for (const essential of [
			"effective: 5Hz",
			"unverified",
			"DC:",
			"spur 1: 445100000..445110000 Hz",
		])
			expect(rows.join("")).toContain(essential)
		expect(rows.every(r => cellWidth(r) <= width)).toBe(true)
		const oldFrame = state.scan.rows.at(-1)!.frame
		state.scan = scanFrame(
			state.scan,
			{
				...SCAN_FRAME,
				masks: {
					...oldFrame.masks,
					spurRanges: [{ startHz: 445300000, endHz: 445310000 }],
				},
			},
			1000,
		)
		expect(scanDetail(state, ui, width).join("")).toContain(
			"spur 1: 445300000..445310000 Hz",
		)
		expect(scanDetail(state, ui, width).join("")).not.toContain(
			"445100000..445110000",
		)
		ui.scan.tab = "jobs"
		const job = structuredClone(SCAN_JOB)
		job.identify!.targets[0]!.trials[0]!.protocol = "long-protocol".repeat(6)
		state.scan = scanRead(state.scan, "job", guardScan("job", job)!, null, 1000)
		const jobRows = scanDetail(state, ui, width)
		for (const essential of [
			"unsupported (needs-channelizer)",
			"peak ? dBFS",
			"SNR ? dB",
			"floor ? dBFS",
			"OBW ? Hz",
		])
			expect(jobRows.join("")).toContain(essential)
		expect(jobRows.every(r => cellWidth(r) <= width)).toBe(true)
		ui.detail.scan.open = true
		expect(scanModel(state, ui, width, 11).detailRows).toBe(jobRows.length)
	},
)

it.each([0, 10000])(
	"shows truthful signed unverified axis and masks at centre%s",
	centerHz => {
		const state = initialState(1000),
			ui = initialUi("scan")
		ui.scan.sourceId = "rtl"
		state.scan = scanFrame(
			scanProfile(selectScan(state.scan, "rtl"), SCAN_PROFILE),
			{
				...SCAN_FRAME,
				centerHz,
				startHz: centerHz - 819500,
				binHz: 4000,
				binCount: 410,
				bins: Buffer.from(new Uint8Array(410).fill(70)).toString("base64"),
				tuningTrust: "unverified",
				masks: {
					dcHz: centerHz,
					dcGuardHz: 1500,
					spurRanges: [{ startHz: -30500, endHz: -20500 }],
				},
			},
			1000,
		)
		const text = scanModel(state, ui, 79, 20).lines.map(lineText).join("\n")
		expect(text).toContain(`axis ${centerHz - 819500}..${centerHz + 820500} Hz`)
		expect(text).toContain("unverified")
		const detail = scanDetail(state, ui, 59).join("")
		expect(detail).toContain(
			`axis: ${centerHz - 819500}..${centerHz + 820500} Hz`,
		)
		expect(detail).toContain(`DC: ${centerHz} +/-1500 Hz`)
		expect(detail).toContain("spur 1: -30500..-20500 Hz")
		expect(detail).toContain("trust: unverified")
	},
)
