import { Box } from "ink"
import { describe, expect, it } from "vitest"
import { LineView, Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { SCENARIO_NAMES } from "../test/scenario-types.js"
import { EMPTY_VIEW_CTX, VIEW_ORDER, type ViewId } from "../ui/actions.js"
import { findBanned } from "../ui/copy-rules.js"
import { chromeRows } from "../ui/frame.js"
import { sp } from "../ui/line.js"
import { formatMessage } from "../ui/messages/index.js"
import { cellWidth } from "../ui/text.js"
import { initialUi } from "../ui/ui-state.js"
import { VIEWS } from "./registry.js"
import type { ViewModule } from "./types.js"

const SIZES = [
	[60, 16],
	[60, 20],
	[80, 24],
	[120, 40],
	[200, 50],
] as const

/**
 * Every problem one rendered frame has. Strict fit turns any line wider than its
 * box, or block taller than its height, into a render error, which Ink would
 * otherwise clip silently.
 */
async function frameProblems(
	state: AppState,
	views: Partial<Record<ViewId, ViewModule>>,
	view: ViewId,
	cols: number,
	rows: number,
): Promise<string[]> {
	const out: string[] = []
	const at = `${view} ${cols}x${rows}`
	const h = await renderApp({ state, views, view, cols, rows, strict: true })
	try {
		const frame = h.frame()
		if (h.exited()) out.push(`${at}: exited`)
		if (frame.length > rows - 1)
			out.push(`${at}: ${frame.length} rows > ${rows - 1}`)
		// The strip's api lane always leads the frame (spec §4).
		if (!/^ api /.test(frame[0] ?? "")) out.push(`${at}: no strip on line 0`)
		const text = h.text()
		if (text.includes("render error"))
			out.push(
				`${at}: ${text.split("\n").find(l => l.includes("render error"))}`,
			)
		for (const line of frame) {
			if (cellWidth(line) > cols) out.push(`${at}: wide: ${line}`)
			for (const b of findBanned(line)) out.push(`${at}: banned ${b}: ${line}`)
		}
	} finally {
		h.unmount()
	}
	// app.tsx masks keyInfo throws with safe(); call it directly.
	const m = views[view]
	if (m) {
		try {
			m.keyInfo(
				state,
				initialUi(view),
				cols - 1,
				chromeRows(rows, false).content,
			)
		} catch (err: unknown) {
			out.push(`${at}: keyInfo threw ${String(err)}`)
		}
	}
	return out
}

// Feature: cli-dashboard-overhaul, Property 22: render bound
// Validates: spec §5.1, §9
describe("P22: every view × scenario × size fits rows−1 × cols with no banned copy", () => {
	for (const scenario of SCENARIO_NAMES) {
		for (const view of VIEW_ORDER) {
			it(`${scenario} · ${view}`, async () => {
				const state = scenarioState(scenario, { summarize: formatMessage })
				const problems: string[] = []
				for (const [cols, rows] of SIZES)
					problems.push(
						...(await frameProblems(state, VIEWS, view, cols, rows)),
					)
				expect(problems).toEqual([])
			})
		}
	}
})

const fake = (Component: ViewModule["Component"]): ViewModule => ({
	id: "overview",
	title: "Fake",
	Component,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
})

describe("P22 check is not vacuous", () => {
	const state = scenarioState("live", { summarize: formatMessage })
	const check = (v: ViewModule) =>
		frameProblems(state, { overview: v }, "overview", 80, 24)
	it("an over-wide line inside a box fails", async () => {
		const wide = fake(({ width, height }) => (
			<Lines
				lines={[[sp("x".repeat(500))]]}
				width={width + 1}
				height={height}
			/>
		))
		expect((await check(wide)).join("\n")).toMatch(/strict fit: line/)
	})
	it("more lines than the box height fails", async () => {
		const tall = fake(({ width, height }) => (
			<Lines
				lines={Array.from({ length: 500 }, () => [sp("x")])}
				width={width + 1}
				height={height}
			/>
		))
		expect((await check(tall)).join("\n")).toMatch(/strict fit: 500 lines/)
	})
	it("a bare line wider than the terminal fails", async () => {
		const bare = fake(() => (
			<Box>
				<LineView line={[sp("y".repeat(200))]} />
			</Box>
		))
		expect((await check(bare)).join("\n")).toMatch(/strict fit: line/)
	})
	it("a keyInfo that throws fails even though the app masks it", async () => {
		const throws: ViewModule = {
			...fake(({ width, height }) => (
				<Lines lines={[]} width={width + 1} height={height} />
			)),
			keyInfo: () => {
				throw new Error("boom")
			},
		}
		expect((await check(throws)).join("\n")).toMatch(
			/keyInfo threw Error: boom/,
		)
	})
	it("a fitting fake view has no problems", async () => {
		const ok = fake(({ width, height }) => (
			<Lines lines={[[sp("fits")]]} width={width + 1} height={height} />
		))
		expect(await check(ok)).toEqual([])
	})
})
