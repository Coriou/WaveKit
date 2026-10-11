import { describe, it, expect } from "vitest"
import {
	initialState,
	PLAIN_SUMMARY,
} from "../../../cli/source/data/reducers.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { scanModel, scanDetail } from "../../../cli/source/view-models/scan.js"
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
