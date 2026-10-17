// The command palette (docs/web/canvas/Palette.dc.html; DESIGN.md "Command palette (⌘K), first pass", "⌘K fix"):
// one field that understands intent, grouped rows, nested scopes shown as a chip, live preview of local choices
// (Esc reverts), an effect bar, and a toast with Undo after running. A solid sheet over a light scrim; on a phone
// it fills the width from the top so the keyboard leaves the list visible.
import "./palette.css"

import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react"

import { useServices } from "../../app/context.ts"
import { themeStore, type ThemePrefs } from "../../shell/theme.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Icon } from "../../ui/Icon.tsx"
import { applyPreview, runAction } from "./actions.ts"
import { recentList, usePaletteContext } from "./context.ts"
import { GLYPHS, type GlyphName } from "./glyphs.ts"
import {
	flatten,
	initialIndex,
	PaletteModel,
	SCOPES,
	type PaletteItem,
	type RankedItem,
	type ScopeId,
} from "./model.ts"
import { takePaletteScope } from "./request.ts"
import { effectiveStep } from "../tuner/prefs.ts"

interface PreviewBase {
	theme: ThemePrefs
	stepHz: number | null
	volume: number
}

function Glyph({ name }: { name: GlyphName }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{GLYPHS[name].map(d => (
				<path key={d} d={d} />
			))}
		</svg>
	)
}

/** The title with the matched letters in the accent. */
function Title({ text, idx }: { text: string; idx: readonly number[] }) {
	if (idx.length === 0) return <>{text}</>
	const on = new Set(idx)
	const parts: { t: string; h: boolean }[] = []
	for (let i = 0; i < text.length; i++) {
		const h = on.has(i)
		const last = parts[parts.length - 1]
		if (last && last.h === h) last.t += text[i]
		else parts.push({ t: text[i] ?? "", h })
	}
	return (
		<>
			{parts.map((p, i) =>
				p.h ? (
					<mark key={i} className="wkp-hit">
						{p.t}
					</mark>
				) : (
					<span key={i}>{p.t}</span>
				),
			)}
		</>
	)
}

function Row({
	item,
	domId,
	on,
	onPick,
	onHover,
}: {
	item: RankedItem
	domId: string
	on: boolean
	onPick: () => void
	onHover: () => void
}) {
	const ref = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		if (on) ref.current?.scrollIntoView({ block: "nearest" })
	}, [on])
	const sw = item.swatch
	return (
		<div
			ref={ref}
			id={domId}
			role="option"
			aria-selected={on}
			aria-disabled={item.info || undefined}
			className="wk-row wkp-row"
			data-info={item.info || undefined}
			onMouseDown={e => e.preventDefault()}
			onMouseMove={onHover}
			onClick={onPick}
		>
			{sw ? (
				<span
					className="wkp-swatch"
					aria-hidden="true"
					data-wk-theme={sw.theme}
					data-wk-ground={sw.ground}
					data-wk-accent={sw.accent}
				>
					<span className="wkp-swatch-dot" />
				</span>
			) : (
				<span className="wk-tile wkp-tile" data-info={item.info || undefined}>
					<Glyph name={item.glyph} />
				</span>
			)}
			<span className="wkp-text">
				<span className="wkp-title" data-big={item.big || undefined}>
					<Title text={item.title} idx={item.idx} />
				</span>
				{item.sub ? <span className="wkp-sub">{item.sub}</span> : null}
			</span>
			{item.value ? <span className="wkp-value">{item.value}</span> : null}
			{item.cur ? (
				<span className="wk-tag wkp-cur" data-size="md" data-variant="accent">
					Current
				</span>
			) : null}
			{item.toggle !== undefined ? (
				<span
					className="wk-switch wkp-switch"
					aria-hidden="true"
					aria-checked={item.toggle}
				/>
			) : null}
			{item.kbd && item.kbd.length > 0 ? (
				<span className="wkp-kbd" aria-hidden="true">
					{item.kbd.map(k => (
						<kbd key={k} className="wk-kbd">
							{k}
						</kbd>
					))}
				</span>
			) : null}
			{item.opens ? <span className="wkp-opens">{item.opens}</span> : null}
			{item.scope ? (
				<span className="wkp-chev" aria-hidden="true">
					<Glyph name="go" />
				</span>
			) : null}
		</div>
	)
}

function effectPill(it: PaletteItem | undefined): {
	pill: string
	live: boolean
} | null {
	if (!it || it.info) return null
	if (it.preview) return { pill: "Live preview", live: true }
	if (it.action && it.effects) return { pill: "On Enter", live: false }
	if (it.does) return { pill: "Action", live: false }
	return null
}

export interface PaletteProps {
	onClose: () => void
}

export function Palette({ onClose }: PaletteProps) {
	const services = useServices()
	const [recentVersion, setRecentVersion] = useState(0)
	const live = usePaletteContext(recentVersion)
	// while a preview is applied, rows read the values from before it ("Current", the effect bar's "from")
	const [base, setBase] = useState<PreviewBase | null>(null)
	const ctx = useMemo(
		() =>
			base
				? {
						...live,
						theme: base.theme,
						volume: base.volume,
						chosenStepHz: base.stepHz,
						stepHz: effectiveStep(base.stepHz, live.bandplan, live.tunedHz),
					}
				: live,
		[live, base],
	)
	const [scope, setScope] = useState<ScopeId | null>(() => takePaletteScope())
	const [q, setQ] = useState("")
	const [sel, setSel] = useState(0)
	// the cursor starts on the current value when a scope opens
	const [pendingInit, setPendingInit] = useState(scope !== null)

	const model = useMemo(() => new PaletteModel(ctx), [ctx])
	const groups = useMemo(() => model.build(scope, q), [model, scope, q])
	const flat = useMemo(() => flatten(groups), [groups])
	useLayoutEffect(() => {
		if (!pendingInit) return
		setPendingInit(false)
		setSel(initialIndex(groups, scope))
	}, [pendingInit, groups, scope])
	const index = Math.max(0, Math.min(sel, flat.length - 1))
	const cur = flat[index]

	// ---- live preview: the highlighted row's local choice, reverted when the cursor leaves or the palette closes
	const revert = useRef<(() => void) | null>(null)
	const previewKey = cur?.preview ? JSON.stringify(cur.preview) : null
	useEffect(() => {
		revert.current?.()
		revert.current = null
		if (cur?.preview) {
			setBase({
				theme: themeStore.getState(),
				stepHz: services.prefs.get().stepHz,
				volume: services.listen.get().volume,
			})
			revert.current = applyPreview(services, cur.preview)
		} else setBase(null)
		// keyed on the preview's value: a re-render with the same row keeps it applied
	}, [previewKey, services])
	useEffect(
		() => () => {
			revert.current?.()
			revert.current = null
		},
		[],
	)

	const input = useRef<HTMLInputElement>(null)
	useEffect(() => input.current?.focus(), [])

	const enter = useCallback((next: ScopeId) => {
		setScope(next)
		setQ("")
		setSel(0)
		setPendingInit(true)
		input.current?.focus()
	}, [])
	const back = useCallback(() => {
		setScope(null)
		setQ("")
		setSel(0)
	}, [])

	const run = useCallback(
		(it: RankedItem | undefined) => {
			if (!it || it.info) return
			if (it.scope) {
				enter(it.scope)
				return
			}
			const action = it.action
			if (!action) return
			// the run records its own Undo from the state before the preview
			revert.current?.()
			revert.current = null
			recentList.used(it.id, Date.now())
			setRecentVersion(v => v + 1)
			onClose()
			void runAction(services, action, it.done ?? null).then(r => {
				if (r.text)
					showAppToast(r.text, {
						...(r.undo ? { undo: r.undo } : {}),
						...(r.tone ? { tone: r.tone } : {}),
					})
			})
		},
		[enter, onClose, services],
	)

	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		const n = flat.length
		if (e.key === "ArrowDown") {
			e.preventDefault()
			if (n) setSel((index + 1) % n)
		} else if (e.key === "ArrowUp") {
			e.preventDefault()
			if (n) setSel((index - 1 + n) % n)
		} else if (e.key === "PageDown" || e.key === "End") {
			if (e.key === "End" && q) return
			e.preventDefault()
			if (n) setSel(Math.min(n - 1, e.key === "End" ? n - 1 : index + 8))
		} else if (e.key === "PageUp" || e.key === "Home") {
			if (e.key === "Home" && q) return
			e.preventDefault()
			if (n) setSel(Math.max(0, e.key === "Home" ? 0 : index - 8))
		} else if (e.key === "Enter") {
			e.preventDefault()
			run(cur)
		} else if (e.key === "Tab") {
			e.preventDefault()
			if (cur?.scope) enter(cur.scope)
		} else if (e.key === "Backspace" && !q && scope) {
			e.preventDefault()
			back()
		} else if (e.key === "Escape") {
			// the shell's Escape closes the palette; inside a scope it goes back first
			if (scope) {
				e.preventDefault()
				e.stopPropagation()
				e.nativeEvent.stopImmediatePropagation()
				back()
			}
		}
	}

	const listId = useId()
	const optionId = (i: number) => `${listId}-o${i}`
	const effects =
		cur && !cur.info
			? cur.effects && cur.effects.length > 0
				? cur.effects
				: cur.does
					? [{ label: "", from: "", to: cur.does }]
					: []
			: []
	const unchanged =
		cur?.effects !== undefined &&
		cur.effects.length > 0 &&
		cur.effects.every(e => e.from === e.to)
	const pill = effectPill(cur)
	const effect = pill && unchanged ? { pill: "Already set", live: false } : pill
	const meta = scope ? SCOPES[scope] : null
	const placeholder =
		meta?.placeholder ??
		"Tune, set or find anything · 161.15 · gain 30 · TG 2081"
	const hints = scope
		? [
				["↑↓", "move"],
				["↵", "choose"],
				["⌫", "back"],
				["esc", effect?.live ? "revert" : "back"],
			]
		: [
				["↑↓", "move"],
				["↵", "run"],
				["⇥", "open"],
				["esc", effect?.live ? "revert and close" : "close"],
			]
	const emptyText =
		scope === "tune"
			? "Not a frequency yet. Try 161.15, 161150k, 446.00625 MHz or ch 16."
			: scope
				? "Press Backspace to go back to all commands."
				: "Try a frequency, a talkgroup or a setting name."

	let k = 0
	return (
		<div
			className="wk-shell-scrim wkp-scrim"
			onMouseDown={e => {
				if (e.target === e.currentTarget) onClose()
			}}
		>
			<div
				className="wkp"
				role="dialog"
				aria-modal="true"
				aria-label="Commands"
			>
				<div className="wkp-head">
					<span className="wkp-search" aria-hidden="true">
						<Glyph name="search" />
					</span>
					{scope && meta ? (
						<button
							type="button"
							className="wk-token wkp-scope"
							onClick={back}
							aria-label={`${meta.title}: back to all commands`}
						>
							{meta.title}
							<Icon name="close" size={14} />
						</button>
					) : null}
					<input
						ref={input}
						className="wkp-input"
						value={q}
						onChange={e => {
							setQ(e.target.value)
							setSel(0)
						}}
						onKeyDown={onKey}
						placeholder={placeholder}
						aria-label="Command, frequency or search"
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-activedescendant={cur ? optionId(index) : undefined}
						aria-autocomplete="list"
						spellCheck={false}
						autoComplete="off"
						enterKeyHint="go"
					/>
					<button
						type="button"
						className="wkp-esc"
						onClick={onClose}
						aria-label="Close"
					>
						<span className="wkp-esc-key">esc</span>
						<Icon className="wkp-esc-x" name="close" size={18} />
					</button>
				</div>

				<div
					id={listId}
					className="wkp-list wk-scroll"
					role="listbox"
					aria-label="Commands"
				>
					{groups.map(g => (
						<div key={g.label} role="group" aria-label={g.label}>
							<div className="wk-label wkp-group" aria-hidden="true">
								{g.label}
							</div>
							{g.items.map(it => {
								const i = k++
								return (
									<Row
										key={it.id}
										item={it}
										domId={optionId(i)}
										on={i === index}
										onHover={() => {
											if (i !== index) setSel(i)
										}}
										onPick={() => run(it)}
									/>
								)
							})}
						</div>
					))}
					{flat.length === 0 ? (
						<div className="wkp-empty">
							<b>Nothing matches</b>
							<span>{emptyText}</span>
						</div>
					) : null}
				</div>

				{effect && effects.length > 0 ? (
					<div className="wkp-effect" role="status" aria-live="polite">
						<div className="wkp-effect-row">
							<span
								className="wk-tag wkp-pill"
								data-size="md"
								data-live={effect.live || undefined}
							>
								<span className="wkp-pill-dot" />
								{effect.pill}
							</span>
							<span className="wkp-effects">
								{effects.slice(0, 3).map(e => (
									<span key={e.label || e.to}>
										{e.label ? <span className="wkp-q">{e.label} </span> : null}
										{e.from ? (
											<>
												<span className="wkp-q">{e.from}</span>{" "}
												<span className="wkp-arrow">→</span>{" "}
											</>
										) : null}
										<b>{e.to}</b>
									</span>
								))}
							</span>
						</div>
						{cur?.warn ? <span className="wkp-warn">{cur.warn}</span> : null}
					</div>
				) : null}

				<div className="wkp-foot">
					{hints.map(([key, t]) => (
						<span key={key} className="wkp-hint">
							<kbd className="wk-kbd">{key}</kbd>
							{t}
						</span>
					))}
					<span className="wkp-grow" />
					<button
						type="button"
						className="wkp-hint wkp-keys"
						onClick={() => enter("keys")}
					>
						<kbd className="wk-kbd">?</kbd>Shortcuts
					</button>
				</div>
			</div>
		</div>
	)
}
