// Discoveries search: typed chips inside the field (Activity's pattern), suggestions under it (Enter takes
// the first, arrows choose), and the sort menu beside it.
import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useStore } from "../../../data/index.ts"
import { Icon } from "../../../ui/Icon.tsx"
import { ScanIcon } from "./icons.tsx"
import { SORTS, suggest } from "./search.ts"
import {
	addSearchToken,
	drawerView,
	removeSearchToken,
	setSort,
} from "./state.ts"

export function SearchBar({ count }: { count: string | null }) {
	const tokens = useStore(drawerView, s => s.tokens)
	const [text, setText] = useState("")
	const [focus, setFocus] = useState(false)
	const [active, setActive] = useState(0)
	const options = suggest(text)
	const show = focus && options.length > 0

	const commit = (i: number) => {
		const t = options[i]
		if (!t) return
		addSearchToken(t)
		setText("")
		setActive(0)
	}
	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault()
			commit(active)
		} else if (e.key === "ArrowDown" && options.length) {
			e.preventDefault()
			setActive(a => (a + 1) % options.length)
		} else if (e.key === "ArrowUp" && options.length) {
			e.preventDefault()
			setActive(a => (a - 1 + options.length) % options.length)
		} else if (e.key === "Backspace" && text === "" && tokens.length > 0) {
			removeSearchToken(tokens.length - 1)
		} else if (e.key === "Escape" && text !== "") {
			e.preventDefault()
			e.stopPropagation()
			setText("")
		}
	}

	return (
		<div className="wks-search">
			<div className="wk-field wks-field">
				<Icon name="search" size={16} />
				{tokens.map((t, i) => (
					<span key={`${t.kind}:${t.value}`} className="wk-token">
						<span className="wks-token-kind">{t.kindLabel}</span>
						{t.label}
						<button
							type="button"
							aria-label={`Remove filter ${t.kindLabel} ${t.label}`}
							onClick={() => removeSearchToken(i)}
						>
							<Icon name="close" />
						</button>
					</span>
				))}
				<input
					aria-label="Search discoveries"
					role="combobox"
					aria-expanded={show}
					aria-controls="wks-suggest"
					aria-autocomplete="list"
					placeholder={
						tokens.length
							? "Narrow further…"
							: "Frequency, protocol, CC, capcode…"
					}
					spellCheck={false}
					autoComplete="off"
					value={text}
					onChange={e => {
						setText(e.target.value)
						setActive(0)
					}}
					onFocus={() => setFocus(true)}
					onBlur={() => setFocus(false)}
					onKeyDown={onKeyDown}
				/>
				{count !== null && <span className="wks-result-count">{count}</span>}
			</div>
			<SortButton />
			{show && (
				<div
					id="wks-suggest"
					role="listbox"
					aria-label="Search as"
					className="wk-menu wks-suggest"
				>
					{options.map((t, i) => (
						<button
							key={`${t.kind}:${t.value}`}
							type="button"
							role="option"
							aria-selected={i === active}
							className="wk-option"
							data-size="touch"
							onMouseDown={e => {
								e.preventDefault()
								commit(i)
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="wks-sugg-kind">{t.kindLabel}</span>
							<span className="wks-sugg-value">{t.label}</span>
						</button>
					))}
					<div className="wk-menu-foot wks-sugg-foot">
						<span>↑↓ choose</span>
						<span>Enter add filter</span>
						<span>⌫ remove last</span>
					</div>
				</div>
			)}
		</div>
	)
}

function SortButton() {
	const sort = useStore(drawerView, s => s.sort)
	const [open, setOpen] = useState(false)
	const box = useRef<HTMLSpanElement>(null)
	const label = SORTS.find(o => o.value === sort)?.label ?? "Last heard"
	useEffect(() => {
		if (!open) return
		box.current
			?.querySelector<HTMLButtonElement>("[aria-checked=true]")
			?.focus()
		const onDown = (e: PointerEvent) => {
			if (!box.current?.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault()
				e.stopPropagation()
				setOpen(false)
				box.current?.querySelector<HTMLButtonElement>("button")?.focus()
			}
		}
		document.addEventListener("pointerdown", onDown)
		document.addEventListener("keydown", onKey, true)
		return () => {
			document.removeEventListener("pointerdown", onDown)
			document.removeEventListener("keydown", onKey, true)
		}
	}, [open])
	return (
		<span ref={box} className="wks-sort">
			<button
				type="button"
				className="wk-btn wks-sort-btn"
				data-variant="outline"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Sort by ${label}`}
				title="Sort"
				onClick={() => setOpen(o => !o)}
			>
				<ScanIcon name="sort" size={14} />
				<span className="wks-sort-label">{label}</span>
			</button>
			{open && (
				<div
					role="menu"
					aria-label="Sort discoveries"
					className="wk-menu wks-sort-menu"
				>
					{SORTS.map(o => (
						<button
							key={o.value}
							type="button"
							role="menuitemradio"
							aria-checked={o.value === sort}
							className="wk-option"
							onClick={() => {
								setSort(o.value)
								setOpen(false)
							}}
						>
							<ScanIcon
								name="check"
								size={14}
								strokeWidth={2.4}
								style={{ opacity: o.value === sort ? 1 : 0 }}
							/>
							{o.label}
						</button>
					))}
				</div>
			)}
		</span>
	)
}
