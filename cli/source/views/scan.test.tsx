import { describe, it, expect, afterEach } from "vitest"
import { renderApp } from "../test/app-harness.js"
import {
	scenarioState,
	SCAN_FRAME,
	SCAN_PROFILE,
	SCAN_STATUS,
	SCAN_JOB,
	SCAN_DISCOVERY,
} from "../test/fixtures.js"
import { formatMessage } from "../ui/messages/index.js"
import { initialUi } from "../ui/ui-state.js"
import { setGlyphMode } from "../ui/theme.js"
import { VIEWS } from "./registry.js"
import {
	selectScan,
	scanProfile,
	scanFrame,
	scanRead,
} from "../data/scan-state.js"
import { guardScan } from "../data/scanner-guards.js"
import { scanView } from "./scan.js"
import { KEYS, renderAt } from "../test/harness.js"
import { Spectrum } from "../components/spectrum.js"
import { ColorContext } from "../components/lines.js"

function state() {
	const s = scenarioState("live", { summarize: formatMessage })
	const first = s.sources.value![0]!
	s.sources.value = [{ ...first, id: "rtl" }]
	s.scan = scanFrame(
		scanProfile(selectScan(s.scan, "rtl"), SCAN_PROFILE),
		SCAN_FRAME,
		s.now,
	)
	s.scan = scanRead(
		s.scan,
		"status",
		guardScan("status", SCAN_STATUS)!,
		null,
		s.now,
	)
	s.scan = scanRead(s.scan, "jobs", guardScan("jobs", [SCAN_JOB])!, null, s.now)
	s.scan = scanRead(
		s.scan,
		"discoveries",
		guardScan("discoveries", { items: [SCAN_DISCOVERY], nextCursor: "next" })!,
		null,
		s.now,
	)
	return s
}
afterEach(() => setGlyphMode("utf8"))
describe("additive read-only Scan", () => {
	it("golden spectrum with truthful units and profiles", async () => {
		const h = await renderApp({
			state: state(),
			views: VIEWS,
			view: "scan",
			cols: 120,
			rows: 40,
			strict: true,
		})
		try {
			expect(h.text()).toMatchSnapshot()
		} finally {
			h.unmount()
		}
	})
	it("lists discoveries/jobs, opens existing results, and never writes", async () => {
		const s = state()
		s.scan = scanRead(s.scan, "job", guardScan("job", SCAN_JOB)!, null, s.now)
		const h = await renderApp({
			state: s,
			views: VIEWS,
			view: "scan",
			cols: 120,
			rows: 40,
			strict: true,
		})
		try {
			await h.press("d")
			expect(h.text()).toContain("446056250 Hz")
			await h.press("b")
			await h.press(KEYS.down)
			await h.press(KEYS.enter)
			expect(h.text()).toContain("needs-channelizer")
			expect(h.text()).toContain("peak ? dBFS")
			await h.press(KEYS.esc)
			for (const key of ["x", "i", "c", "a"])
				await h.press(key, { expectWrite: false })
			expect(h.runtime.sent).toEqual([])
		} finally {
			h.unmount()
		}
	})
	it("ASCII/no-color fallback fits compact sizes and errors", async () => {
		setGlyphMode("ascii")
		for (const [cols, rows] of [
			[60, 16],
			[80, 24],
			[200, 50],
		]) {
			const h = await renderApp({
				state: state(),
				views: VIEWS,
				view: "scan",
				cols: cols!,
				rows: rows!,
				strict: true,
			})
			try {
				expect(h.text()).not.toMatch(/[^\x00-\x7f]/)
				expect(h.text()).not.toContain("render error")
			} finally {
				h.unmount()
			}
		}
	})
	it("switches sources/tabs locally and bounds page navigation", () => {
		const s = state(),
			ui = initialUi("scan")
		ui.scan.sourceId = "rtl"
		ui.scan.tab = "discoveries"
		expect(
			scanView.onAction?.({ type: "scan-next-page" }, s, ui)?.ui.scan.cursor,
		).toBe("next")
		expect(
			scanView.onAction?.({ type: "scan-tab", tab: "jobs" }, s, ui)?.ui.scan
				.tab,
		).toBe("jobs")
	})
})

it("renders bounded truecolor half-block pairs on a simulated capable terminal", async () => {
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
	const oldColor = process.env["COLORTERM"],
		oldLocale = process.env["LC_ALL"],
		oldAscii = process.env["WAVEKIT_ASCII"],
		oldNoColor = process.env["NO_COLOR"]
	Object.defineProperty(process.stdout, "isTTY", {
		value: true,
		configurable: true,
	})
	process.env["COLORTERM"] = "truecolor"
	process.env["LC_ALL"] = "en_US.UTF-8"
	delete process.env["WAVEKIT_ASCII"]
	delete process.env["NO_COLOR"]
	try {
		const s = state()
		s.scan = scanFrame(s.scan, SCAN_FRAME, s.now)
		const h = await renderAt(
			<ColorContext.Provider value={true}>
				<Spectrum scan={s.scan} width={58} height={4} now={s.now} />
			</ColorContext.Provider>,
			{ cols: 60, rows: 8 },
		)
		try {
			expect(h.text()).toContain("▀")
			expect(h.frame().every(l => [...l].length <= 60)).toBe(true)
		} finally {
			h.unmount()
		}
	} finally {
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty)
		else Reflect.deleteProperty(process.stdout, "isTTY")
		for (const [key, value] of [
			["COLORTERM", oldColor],
			["LC_ALL", oldLocale],
			["WAVEKIT_ASCII", oldAscii],
			["NO_COLOR", oldNoColor],
		] as const) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})
