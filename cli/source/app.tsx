import { scanSources } from "./view-models/scan.js"
import { Box, Text, useApp, useStdout } from "ink"
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactElement,
} from "react"
import { Banner } from "./components/banner.js"
import { ChainStrip } from "./components/chain-strip.js"
import { ConfirmBar } from "./components/confirm-bar.js"
import { ErrorBoundary } from "./components/error-boundary.js"
import { Footer } from "./components/footer.js"
import { HelpOverlay } from "./components/help-overlay.js"
import { ColorContext } from "./components/lines.js"
import { Switcher } from "./components/switcher.js"
import { TooSmall } from "./components/too-small.js"
import type { IdentifyContext } from "./data/identify-state.js"
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
import { NOTICE_MS, bannerConditions } from "./view-models/chrome.js"
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
	const { stdout } = useStdout()
	const { columns: cols, rows } = useTerminalSize()
	const state = useStore(runtime.store, selectAll)
	const [ui, setUi] = useState<UiState>(() => initialUi(initialView))
	const uiRef = useRef(ui)
	const renderedRef = useRef({ cols, rows, contentRows: 0 })
	const small = tooSmall(cols, rows)
	const hc = heightClass(rows)
	const wc = widthClass(cols)
	const width = cols - 1
	const banner = small
		? null
		: safe(() => bannerLine(bannerConditions(state), state.now, width), null)
	const chrome = chromeRows(rows, banner !== null)
	const identifyContextFor = (u: UiState, live = false): IdentifyContext => {
		const dimensions = renderedRef.current
		const columns = live ? (stdout.columns ?? 0) : dimensions.cols
		const height = live ? (stdout.rows ?? 0) : dimensions.rows
		return {
			sourceId: u.scan.sourceId,
			discoveryId:
				u.detail.scan.open && u.scan.tab === "discoveries"
					? u.selected.scan
					: null,
			key: JSON.stringify([
				u.view,
				u.help,
				u.quit,
				u.scan.sourceId,
				u.scan.tab,
				u.scan.cursor,
				u.scan.retry,
				u.selected.scan,
				u.detail.scan.open,
				u.scan.receipt === true,
			]),
			active:
				u.view === "scan" &&
				!u.help &&
				!u.quit &&
				!u.scan.receipt &&
				u.detail.scan.open &&
				u.scan.tab === "discoveries" &&
				!tooSmall(columns, height),
			columns,
			rows: height,
			contentRows: dimensions.contentRows,
		}
	}
	const liveContext = (): IdentifyContext =>
		identifyContextFor(uiRef.current, true)
	const commitUi = (next: UiState): void => {
		uiRef.current = next
		runtime.setIdentifyContext?.(identifyContextFor(next), liveContext)
		setUi(next)
	}
	useLayoutEffect(() => {
		renderedRef.current = { cols, rows, contentRows: chrome.content }
		uiRef.current = ui
		runtime.setIdentifyContext?.(identifyContextFor(ui), liveContext)
		if (
			ui.confirm?.kind === "identify" &&
			!ui.help &&
			!small &&
			ui.confirm.layout.width === width &&
			ui.confirm.layout.height === chrome.content
		)
			runtime.markIdentifyVisible?.(ui.confirm.token)
	})
	useEffect(() => {
		const resize = (): void => {
			runtime.invalidateIdentify?.()
		}
		stdout.on("resize", resize)
		return () => {
			stdout.off("resize", resize)
		}
	}, [stdout, runtime])
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
		v: {
			...info.ctx,
			decoderOwned: safe(
				() =>
					state.decoders.value?.some(
						d =>
							d.id === ui.selected.decoders &&
							(d.owner === "scanner" || d.ephemeral),
					) === true,
				true,
			),
		},
	}
	// R75: a fresh key notice (ui.notice) wins; otherwise the view's standing notice.
	const footerNotice: UiState["notice"] =
		ui.notice && state.now - ui.notice.at < NOTICE_MS
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
		if (
			(small || tooSmall(stdout.columns ?? 0, stdout.rows ?? 0)) &&
			a.type !== "quit"
		) {
			runtime.invalidateIdentify?.()
			return
		}
		if (a.type === "scan-identify") {
			const prompt = runtime.prepareIdentify?.(
				identifyContextFor(uiRef.current, true),
			)
			if (!prompt) {
				commitUi({
					...uiRef.current,
					notice: {
						text:
							runtime.identifySnapshot?.().readiness.reason ??
							"Identify unavailable; reinspect detail",
						at: state.now,
					},
				})
				return
			}
			commitUi({
				...uiRef.current,
				confirm: {
					kind: "identify",
					token: prompt.token,
					request: prompt.request,
					layout: { width, height: chrome.content, rows: prompt.layout.lines },
					prompt: "Identify",
					yes: "confirm",
					no: "cancel",
				},
			})
			return
		}
		if (a.type !== "confirm-yes" && a.type !== "confirm-no")
			runtime.invalidateIdentify?.()
		switch (a.type) {
			case "quit":
				commitUi({ ...uiRef.current, quit: true })
				return
			case "reconnect":
				runtime.reconnect()
				commitUi({ ...uiRef.current, epoch: uiRef.current.epoch + 1 })
				return
			case "confirm-yes": {
				const c = uiRef.current.confirm
				if (!c) return
				if (c.kind === "identify") {
					runtime.confirmIdentify?.(c.token)
					const receipt = runtime.identifySnapshot?.().receipt
					commitUi({
						...uiRef.current,
						confirm: null,
						scan: {
							...uiRef.current.scan,
							receipt:
								receipt?.phase === "known" ||
								receipt?.phase === "terminal-confirmed",
						},
					})
					return
				}
				const confirmedIntent = c.intent
				if (
					confirmedIntent.kind === "decoder" &&
					state.decoders.value?.some(
						d =>
							d.id === confirmedIntent.decoderId &&
							(d.owner === "scanner" || d.ephemeral),
					)
				) {
					setUi(u => ({
						...u,
						confirm: null,
						notice: { text: "scanner probe is read-only", at: state.now },
					}))
					return
				}
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
		if (a.type === "confirm-no") runtime.invalidateIdentify?.()
		const out = view?.onAction?.(a, state, uiRef.current)
		if (out) {
			commitUi(out.ui)
			for (const e of out.effects) applyEffect(e)
			return
		}
		commitUi(
			applyUiAction(
				uiRef.current,
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
		if (ui.view === "scan" && ui.scan.sourceId === null) {
			const first = scanSources(state)[0]
			if (first)
				commitUi({
					...uiRef.current,
					scan: { ...uiRef.current.scan, sourceId: first },
				})
		}
	}, [ui.view, ui.scan.sourceId, state.sources.value])
	useEffect(() => {
		const active =
			ui.view === "scan" &&
			!small &&
			!ui.help &&
			!ui.quit &&
			ui.scan.sourceId !== null
		const detail =
			ui.detail.scan.open && ui.selected.scan && ui.scan.tab !== "spectrum"
				? {
						kind:
							ui.scan.tab === "jobs"
								? ("job" as const)
								: ("discovery" as const),
						id: ui.selected.scan,
					}
				: null
		runtime.setScanDemand?.(
			active && ui.scan.sourceId
				? {
						sourceId: ui.scan.sourceId,
						retry: ui.scan.retry,
						cursor: ui.scan.cursor,
						detail,
					}
				: null,
		)
	}, [
		runtime,
		ui.view,
		ui.help,
		ui.scan.sourceId,
		ui.scan.retry,
		ui.scan.cursor,
		ui.scan.tab,
		ui.detail.scan.open,
		ui.selected.scan,
		small,
		ui.quit,
	])
	useEffect(() => {
		const receipt = state.identify?.receipt
		if (
			state.identify?.inspection &&
			ui.view === "scan" &&
			receipt?.jobId &&
			!ui.scan.receipt
		)
			commitUi({
				...uiRef.current,
				scan: { ...uiRef.current.scan, receipt: true },
				confirm: null,
			})
	}, [state.identify?.inspection, state.identify?.receipt?.jobId])
	useEffect(() => {
		runtime.setIdentifyInspection?.(
			ui.view === "scan" &&
				ui.scan.receipt === true &&
				!small &&
				!ui.help &&
				!ui.quit,
		)
	}, [runtime, ui.view, ui.scan.receipt, small, ui.help, ui.quit])
	useEffect(() => {
		if (
			ui.confirm?.kind === "identify" &&
			state.identify?.prompt?.token !== ui.confirm.token
		)
			commitUi({ ...uiRef.current, confirm: null })
	}, [state.identify?.prompt?.token])
	useEffect(
		() => () => {
			runtime.setScanDemand?.(null)
			runtime.setIdentifyInspection?.(false)
			runtime.invalidateIdentify?.()
		},
		[runtime],
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
							<HelpOverlay ctx={ctx} width={width} height={chrome.content} />
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
