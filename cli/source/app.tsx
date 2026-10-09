import { Box, Text, useApp } from "ink"
import { useEffect, useState, type ReactElement } from "react"
import { Banner } from "./components/banner.js"
import { ChainStrip } from "./components/chain-strip.js"
import { ConfirmBar } from "./components/confirm-bar.js"
import { ErrorBoundary } from "./components/error-boundary.js"
import { Footer } from "./components/footer.js"
import { HelpOverlay } from "./components/help-overlay.js"
import { ColorContext } from "./components/lines.js"
import { Switcher } from "./components/switcher.js"
import { TooSmall } from "./components/too-small.js"
import type { RuntimeHandle } from "./data/runtime.js"
import type { AppState } from "./data/types.js"
import { useKeys } from "./hooks/use-keys.js"
import { useStore } from "./hooks/use-store.js"
import { useTerminalSize } from "./hooks/use-terminal-size.js"
import { osc52 } from "./terminal.js"
import { EMPTY_VIEW_CTX, type Action, type ViewId } from "./ui/actions.js"
import { bannerLine } from "./ui/banner.js"
import { chromeRows, heightClass, tooSmall, widthClass } from "./ui/frame.js"
import type { KeyContext } from "./ui/keymap.js"
import { applyUiAction } from "./ui/ui-reducer.js"
import { initialUi, type UiState } from "./ui/ui-state.js"
import { bannerConditions, noticeShown } from "./view-models/chrome.js"
import type { Effect, ViewKeyInfo, ViewModule } from "./views/types.js"

export interface AppProps {
	runtime: RuntimeHandle
	views: Partial<Record<ViewId, ViewModule>>
	initialView: ViewId
	color: boolean
	writeRaw?: (s: string) => void
}

const selectAll = (s: AppState): AppState => s

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn()
	} catch {
		return fallback
	}
}
const NO_INFO: ViewKeyInfo = { rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }

export function App({
	runtime,
	views,
	initialView,
	color,
	writeRaw,
}: AppProps): ReactElement {
	const { exit } = useApp()
	const { columns: cols, rows } = useTerminalSize()
	const state = useStore(runtime.store, selectAll)
	const [ui, setUi] = useState<UiState>(() => initialUi(initialView))
	const small = tooSmall(cols, rows)
	const hc = heightClass(rows)
	const wc = widthClass(cols)
	const width = cols - 1
	const banner = small
		? null
		: safe(() => bannerLine(bannerConditions(state), state.now, width), null)
	const chrome = chromeRows(rows, banner !== null)
	const view = views[ui.view]
	// Computed outside the boundary, so a throw here must not take the app down.
	const info = view
		? safe(() => view.keyInfo(state, ui, width, chrome.content, hc), NO_INFO)
		: NO_INFO
	const ctx: KeyContext = {
		view: ui.view,
		confirm: ui.confirm?.kind ?? null,
		help: ui.help,
		input: ui.view === "messages" && ui.messages.draft !== null,
		edit: ui.view === "receiver" && ui.edit !== null,
		detail: ui.detail[ui.view].open,
		heightClass: hc,
		rows: info.rowIds.length,
		v: info.ctx,
	}
	// R75: a fresh key notice (ui.notice) wins; otherwise the view's standing notice.
	const footerNotice: UiState["notice"] = noticeShown(ui.notice, state.now)
		? ui.notice
		: info.notice !== undefined
			? { text: info.notice, at: state.now }
			: ui.notice

	const applyEffect = (e: Effect): void => {
		;(writeRaw ?? (s => process.stdout.write(s)))(osc52(e.text))
	}

	const dispatch = (a: Action): void => {
		// While too small nothing is visible: only quit (q, Ctrl-C) is honoured, so a
		// hidden confirm, audio toggle, draft or edit cannot change blind.
		if (small && a.type !== "quit") return
		switch (a.type) {
			case "quit":
				setUi(u => ({ ...u, quit: true }))
				return
			case "reconnect":
				runtime.reconnect()
				setUi(u => ({ ...u, epoch: u.epoch + 1 }))
				return
			case "confirm-yes": {
				const c = ui.confirm
				if (!c) return
				runtime.send(c.intent)
				setUi(u => ({
					...u,
					confirm: null,
					edit: c.kind === "tuner" ? null : u.edit,
				}))
				return
			}
			case "audio-toggle":
				if (info.ctx.audioRunning === null) return
				runtime.send({
					kind: "audio",
					op: info.ctx.audioRunning ? "stop" : "start",
				})
				return
			default:
				break
		}
		const out = view?.onAction?.(a, state, ui)
		if (out) {
			setUi(out.ui)
			for (const e of out.effects) applyEffect(e)
			return
		}
		setUi(u =>
			applyUiAction(
				u,
				a,
				{
					rowIds: info.rowIds,
					pageSize: info.pageSize,
					...(info.detailMaxScroll !== undefined
						? { detailMaxScroll: info.detailMaxScroll }
						: {}),
					...(info.newestSeq !== undefined
						? { newestSeq: info.newestSeq }
						: {}),
				},
				state.now,
			),
		)
	}

	// While too small, keys resolve as if no modal were open, so a bare q reaches the
	// global quit binding even under a hidden confirm, help, filter or edit; dispatch
	// drops everything else.
	useKeys(
		small
			? {
					...ctx,
					confirm: null,
					help: false,
					input: false,
					edit: false,
					detail: false,
				}
			: ctx,
		dispatch,
	)
	useEffect(() => {
		if (ui.quit) exit()
	}, [ui.quit, exit])

	// ColorContext wraps every path, so NO_COLOR also holds for the too-small line.
	if (small)
		return (
			<ColorContext.Provider value={color}>
				<TooSmall cols={cols} rows={rows} />
			</ColorContext.Provider>
		)

	return (
		<ColorContext.Provider value={color}>
			<ErrorBoundary key={ui.epoch}>
				<Box
					flexDirection="column"
					width={cols}
					height={rows - 1}
					overflow="hidden"
				>
					<ChainStrip state={state} width={width} />
					{/* §5.1: the banner sits directly under the strip. */}
					{banner ? <Banner line={banner} /> : null}
					{chrome.switcher === 1 ? (
						<Switcher view={ui.view} width={width} />
					) : null}
					{chrome.blank === 1 ? <Text> </Text> : null}
					<Box flexDirection="column" height={chrome.content} overflow="hidden">
						{ui.help ? (
							<HelpOverlay
								ctx={ctx}
								state={state}
								width={width}
								height={chrome.content}
							/>
						) : view ? (
							<view.Component
								state={state}
								ui={ui}
								width={width}
								height={chrome.content}
								heightClass={hc}
								widthClass={wc}
							/>
						) : (
							<Text> </Text>
						)}
					</Box>
					{ui.confirm ? (
						<ConfirmBar confirm={ui.confirm} width={width} />
					) : (
						<Footer
							ctx={ctx}
							notice={footerNotice}
							now={state.now}
							width={width}
						/>
					)}
				</Box>
			</ErrorBoundary>
		</ColorContext.Provider>
	)
}
