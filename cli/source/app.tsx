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
import { bannerConditions } from "./view-models/chrome.js"
import type { Effect, ViewKeyInfo, ViewModule } from "./views/types.js"

export interface AppProps {
	runtime: RuntimeHandle
	views: Partial<Record<ViewId, ViewModule>>
	initialView: ViewId
	color: boolean
	writeRaw?: (s: string) => void
}

const selectAll = (s: AppState): AppState => s
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
		: bannerLine(bannerConditions(state), state.now, width)
	const chrome = chromeRows(rows, banner !== null)
	const view = views[ui.view]
	const info = view ? view.keyInfo(state, ui, width, chrome.content) : NO_INFO
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

	const applyEffect = (e: Effect): void => {
		if (e.kind === "write") runtime.send(e.intent)
		else (writeRaw ?? (s => process.stdout.write(s)))(osc52(e.text))
	}

	const dispatch = (a: Action): void => {
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
				{ rowIds: info.rowIds, pageSize: info.pageSize },
				state.now,
			),
		)
	}

	useKeys(ctx, dispatch)
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
			<Box
				flexDirection="column"
				width={cols}
				height={rows - 1}
				overflow="hidden"
			>
				<ChainStrip state={state} width={width} />
				{chrome.switcher === 1 ? (
					<Switcher view={ui.view} width={width} />
				) : null}
				{chrome.blank === 1 ? <Text> </Text> : null}
				{banner ? <Banner line={banner} /> : null}
				<Box flexDirection="column" height={chrome.content} overflow="hidden">
					<ErrorBoundary key={ui.epoch}>
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
					</ErrorBoundary>
				</Box>
				{ui.confirm ? (
					<ConfirmBar confirm={ui.confirm} width={width} />
				) : (
					<Footer ctx={ctx} notice={ui.notice} now={state.now} width={width} />
				)}
			</Box>
		</ColorContext.Provider>
	)
}
