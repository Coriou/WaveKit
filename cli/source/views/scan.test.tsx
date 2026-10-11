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
import { Lines, StrictFitContext } from "../components/lines.js"
import { ConfirmBar } from "../components/confirm-bar.js"
import { Box } from "ink"
import { identifyDisclosure } from "../view-models/scan.js"
import {
	identifySourceIdentity,
	type IdentifyRequest,
} from "../data/identify-state.js"
import { chromeRows, heightClass, widthClass } from "../ui/frame.js"

describe("native identify disclosure", () => {
	it.each([
		[60, 16],
		[80, 24],
		[200, 50],
	])(
		"shows pinned exact consent and all three keys at %sx%s in ASCII/no-color",
		async (cols, rows) => {
			setGlyphMode("ascii")
			for (const banner of [false, true]) {
				for (const { sourceId, target } of [
					{
						sourceId: "receiver\\named\n\u202e📡",
						target: { frequencyHz: 446056250, bandwidthHz: 12500 },
					},
					{
						sourceId: "R".repeat(128),
						target: { frequencyHz: 1e100, bandwidthHz: 1e-100 },
					},
				]) {
					const width = cols - 1,
						height = chromeRows(rows, banner).content
					const request: IdentifyRequest = {
						sourceId,
						target,
						timeoutMs: 15000,
						exhaustive: false,
						record: false,
					}
					const layout = identifyDisclosure(request, width, height)
					expect(layout.fits).toBe(true)
					const ui = initialUi("scan")
					ui.detail.scan = { open: true, scroll: 4095 }
					const confirm = {
						kind: "identify" as const,
						token: 1,
						request,
						prompt: "Identify",
						yes: "confirm",
						no: "cancel",
						layout: { width, height, rows: layout.lines },
					}
					ui.confirm = confirm
					const Component = scanView.Component
					const chromeHeight = rows - 2 - height
					const h = await renderAt(
						<StrictFitContext.Provider value={{ cols }}>
							<ColorContext.Provider value={false}>
								<Box flexDirection="column" height={rows - 1} width={cols}>
									<Lines
										lines={Array.from({ length: chromeHeight }, () => [])}
										width={cols}
										height={chromeHeight}
									/>
									<Component
										state={state()}
										ui={ui}
										width={width}
										height={height}
										heightClass={heightClass(rows)}
										widthClass={widthClass(cols)}
									/>
									<ConfirmBar confirm={confirm} width={width} />
								</Box>
							</ColorContext.Provider>
						</StrictFitContext.Provider>,
						{ cols, rows },
					)
					try {
						const joined = h
							.frame()
							.map(row => row.slice(1))
							.join("")
						for (const required of [
							"Identify this frequency",
							`Source: ${identifySourceIdentity(sourceId)}`,
							`Frequency: ${String(target.frequencyHz)} Hz`,
							`Width: ${String(target.bandwidthHz)} Hz`,
							"Wait up to 15s for signal; trials may take longer.",
							"May preempt scanner probes.",
							"Updates scanner discoveries and observations.",
							"No trial recordings; other scanner activity may record.",
							"y confirm  n cancel  Esc cancel",
						])
							expect(joined).toContain(required)
						expect(h.text()).not.toMatch(/[^\x00-\x7f]/)
						expect(h.text()).not.toContain("render error")
					} finally {
						h.unmount()
					}
				}
			}
		},
	)
	it("keeps receipt inspection reachable when the selected source is gone", () => {
		const s = state(),
			ui = initialUi("scan")
		s.sources.value = []
		for (const tab of ["spectrum", "discoveries", "jobs"] as const) {
			ui.scan.tab = tab
			const next = scanView.onAction?.({ type: "scan-receipt" }, s, ui)
			expect(next?.ui.scan.receipt).toBe(true)
			expect(next?.ui.detail.scan).toEqual({ open: true, scroll: 0 })
			expect(next?.effects).toEqual([])
		}
	})
	it("renders a fit denial instead of partial consent after a layout change", async () => {
		const request: IdentifyRequest = {
			sourceId: "rtl",
			target: { frequencyHz: 446056250, bandwidthHz: 12500 },
			timeoutMs: 15000,
			exhaustive: false,
			record: false,
		}
		const ui = initialUi("scan")
		ui.confirm = {
			kind: "identify",
			token: 1,
			request,
			prompt: "Identify",
			yes: "confirm",
			no: "cancel",
			layout: {
				width: 79,
				height: 20,
				rows: identifyDisclosure(request, 79, 20).lines,
			},
		}
		const Component = scanView.Component
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<Component
					state={state()}
					ui={ui}
					width={59}
					height={12}
					heightClass="compact"
					widthClass="narrow"
				/>
			</ColorContext.Provider>,
			{ cols: 60, rows: 16 },
		)
		try {
			expect(h.text()).toContain("Confirmation cannot fit; widen terminal")
			expect(h.text()).not.toContain("Identify this frequency")
		} finally {
			h.unmount()
		}
	})
})

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

it("exposes complete narrow details and RF masks through keyboard scroll and resize", async () => {
	const s = state()
	s.scan = scanProfile(s.scan, {
		...SCAN_PROFILE,
		outcome: "nearest",
		adjusted: ["profile-limit"],
	})
	s.scan = scanFrame(
		s.scan,
		{
			...SCAN_FRAME,
			masks: {
				...SCAN_FRAME.masks,
				spurRanges: [{ startHz: 445100000, endHz: 445110000 }],
			},
		},
		s.now,
	)
	s.scan = scanRead(s.scan, "job", guardScan("job", SCAN_JOB)!, null, s.now)
	const h = await renderApp({
		state: s,
		views: VIEWS,
		view: "scan",
		cols: 60,
		rows: 16,
		strict: true,
	})
	try {
		expect(h.text()).toContain("nearest")
		expect(h.text()).toContain("profile-limit")
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		let inspected = h.text()
		for (let i = 0; i < 22; i++) {
			await h.press(KEYS.pgdn, { expectWrite: false })
			inspected += "\n" + h.text()
		}
		expect(inspected).toContain("spur 1: 445100000..445110000 Hz")
		expect(inspected).toContain("DC:")
		await h.resize(80, 24)
		await h.press(KEYS.pgup)
		expect(h.text()).not.toContain("render error")
		await h.press(KEYS.esc)
		await h.press("b")
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		inspected = h.text()
		for (let i = 0; i < 22; i++) {
			await h.press(KEYS.pgdn, { expectWrite: false })
			inspected += "\n" + h.text()
		}
		expect(inspected).toContain("needs-channelizer")
		expect(inspected).toContain("peak ? dBFS")
		expect(inspected).toContain("SNR ? dB")
		expect(h.runtime.sent).toEqual([])
	} finally {
		h.unmount()
	}
})
