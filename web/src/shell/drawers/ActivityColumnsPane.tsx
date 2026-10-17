import "../../features/activity/activity.css"
import "../../features/activity/columns.css"

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { ActivityFeed } from "../../data/activity-feed.ts"
import { ActivityList } from "../../features/activity/ActivityList.tsx"
import type {
	ActivityColumn,
	HeardSuggestion,
} from "../../features/activity/columns.ts"
import {
	COL_GAP,
	COL_MAX,
	COL_PEEK,
	COLUMN_PRESETS,
	MAX_COLUMNS,
	heardMost,
	paneColumns,
	sameColumnSearch,
} from "../../features/activity/columns.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { showAppToast } from "../toast.ts"
import type { PaneContentProps } from "./types.ts"

const ADD_W = 184
/** How long a sideways swipe must rest before snapping comes back (a render mid-swipe would re-snap and pull it back). */
const SETTLE_MS = 160

// Activity's columns pane (Activity board, "Activity wide mode: the columns pane"): the pinned searches side by side,
// left of the drawer. Each column is its own live list (its search under the drawer's); an item picked in any column
// opens in the drawer and stays highlighted. Columns fill the pane; with more than fit, the next one peeks in at the
// edge under a fade with "+N".
export default function ActivityColumnsPane({ onHide }: PaneContentProps) {
	const { activity } = useServices()
	const columns = useStore(activity, s => s.columns)
	const n = columns.length

	return (
		<section className="wkac-pane" aria-label="Activity columns">
			<header className="wkac-head">
				<h2 className="wk-h2">Columns</h2>
				{n > 0 && (
					<span className="wkac-count">
						{n} of {MAX_COLUMNS}
					</span>
				)}
				<span className="wkf-gap" />
				<Button
					variant="ghost"
					className="wkac-hide"
					title="Hide the columns. Columns in the Activity header brings them back."
					onClick={onHide}
				>
					Hide
				</Button>
			</header>
			{n === 0 ? <EmptyPane /> : <Columns columns={columns} />}
		</section>
	)
}

function useSuggestions(): {
	heard: HeardSuggestion[]
	presets: typeof COLUMN_PRESETS
} {
	const { activity } = useServices()
	const columns = useStore(activity, s => s.columns)
	const items = useStore(activity.feed, s => s.items)
	const [heard, setHeard] = useState<HeardSuggestion[]>([])
	// what you hear most moves slowly: recount at most every few seconds, not on every arrival
	const last = useRef(0)
	useEffect(() => {
		const now = Date.now()
		const wait = Math.max(0, last.current + 5000 - now)
		const t = setTimeout(() => {
			last.current = Date.now()
			setHeard(
				heardMost(
					items,
					columns.map(c => c.title),
				),
			)
		}, wait)
		return () => clearTimeout(t)
	}, [items, columns])
	const presets = COLUMN_PRESETS.filter(
		p => !columns.some(c => sameColumnSearch(c, { ...p, tokens: [] })),
	)
	return { heard, presets }
}

function EmptyPane() {
	const { activity } = useServices()
	const { heard, presets } = useSuggestions()
	return (
		<div className="wkac-empty">
			<p className="wkac-empty-title">Pin a search to watch it side by side</p>
			<p className="wkac-empty-text">
				Search a talkgroup, channel, capcode or name in Activity, then Pin as
				column. Or start from what you hear most:
			</p>
			{heard.length > 0 && (
				<div className="wkac-empty-row">
					{heard.map(h => (
						<Button
							key={h.title}
							variant="tonal"
							className="wkac-heard"
							onClick={() =>
								activity.addColumn(
									{
										title: h.title,
										tokens: h.tokens,
										chip: null,
										categories: null,
									},
									true,
								)
							}
						>
							+ {h.title}
							<span className="wkac-heard-n">
								{h.count} {h.count === 1 ? "item" : "items"}
							</span>
						</Button>
					))}
				</div>
			)}
			<div className="wkac-empty-row">
				{presets.map(p => (
					<button
						key={p.id}
						type="button"
						className="wk-chip"
						onClick={() =>
							activity.addColumn(
								{
									title: p.title,
									tokens: [],
									chip: p.chip,
									categories: p.categories,
								},
								true,
							)
						}
					>
						<span>+ {p.title}</span>
					</button>
				))}
			</div>
		</div>
	)
}

function Columns({ columns }: { columns: readonly ActivityColumn[] }) {
	const { activity } = useServices()
	const box = useRef<HTMLDivElement>(null)
	const [paneW, setPaneW] = useState(900)
	const [scrollX, setScrollX] = useState(0)
	const [menu, setMenu] = useState<string | null>(null)
	const [renaming, setRenaming] = useState<string | null>(null)
	const [drag, setDrag] = useState<string | null>(null)
	const [over, setOver] = useState<string | null>(null)
	const editing = useStore(activity, s => s.editing)
	const canAdd = columns.length < MAX_COLUMNS
	const n = columns.length
	const geo = paneColumns(paneW, n, canAdd ? ADD_W : 0)
	const step = geo.colW + COL_GAP

	useLayoutEffect(() => {
		const el = box.current
		if (!el) return
		// the pane's own width: the scroller's plus its side padding
		const read = () => setPaneW(el.clientWidth || 900)
		read()
		if (typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(read)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// a new column is the last one: bring it into view
	const count = useRef(n)
	useEffect(() => {
		if (n > count.current)
			box.current?.scrollTo({
				left: box.current.scrollWidth,
				behavior: "smooth",
			})
		count.current = n
	}, [n])

	const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (settle.current) clearTimeout(settle.current)
		},
		[],
	)
	const onScroll = useCallback(() => {
		const el = box.current
		if (!el) return
		if (el.style.scrollSnapType !== "none") el.style.scrollSnapType = "none"
		if (settle.current) clearTimeout(settle.current)
		settle.current = setTimeout(() => {
			settle.current = null
			el.style.scrollSnapType = ""
			setScrollX(Math.round(el.scrollLeft))
		}, SETTLE_MS)
	}, [])

	const first = geo.over
		? Math.max(0, Math.ceil((scrollX - COL_PEEK - 1) / step))
		: 0
	const moreL = Math.min(first, n)
	const moreR = geo.over ? Math.max(0, n - geo.fit - first) : 0
	const scrollBy = (by: number) =>
		box.current?.scrollBy({ left: by * step, behavior: "smooth" })

	return (
		<div className="wkac-body">
			<div
				ref={box}
				className="wkac-cols wk-scroll"
				onScroll={onScroll}
				style={{
					scrollPaddingLeft: geo.over ? 10 + COL_PEEK + COL_GAP : 10,
				}}
			>
				{columns.map((c, i) => (
					<Column
						key={c.id}
						col={c}
						index={i}
						last={i === n - 1}
						width={geo.colW}
						grow={geo.grow}
						menuOpen={menu === c.id}
						setMenu={setMenu}
						renaming={renaming === c.id}
						setRenaming={setRenaming}
						editing={editing === c.id}
						dragging={drag === c.id}
						over={over === c.id}
						drag={drag}
						setDrag={setDrag}
						setOver={setOver}
					/>
				))}
				{canAdd && <AddTile />}
			</div>
			{moreL > 0 && (
				<div className="wkac-fade" data-side="left">
					<Button
						variant="outline"
						size="sm"
						className="wkac-more"
						aria-label={`Show ${moreL} more ${moreL === 1 ? "column" : "columns"} to the left`}
						onClick={() => scrollBy(-1)}
					>
						<Icon name="chevron-left" />+{moreL}
					</Button>
				</div>
			)}
			{moreR > 0 && (
				<div className="wkac-fade" data-side="right">
					<Button
						variant="outline"
						size="sm"
						className="wkac-more"
						aria-label={`Show ${moreR} more ${moreR === 1 ? "column" : "columns"} to the right`}
						onClick={() => scrollBy(1)}
					>
						+{moreR}
						<Icon name="chevron-right" />
					</Button>
				</div>
			)}
		</div>
	)
}

interface ColumnProps {
	col: ActivityColumn
	index: number
	last: boolean
	width: number
	grow: boolean
	menuOpen: boolean
	setMenu: (id: string | null) => void
	renaming: boolean
	setRenaming: (id: string | null) => void
	editing: boolean
	dragging: boolean
	over: boolean
	drag: string | null
	setDrag: (id: string | null) => void
	setOver: (id: string | null) => void
}

function Column({
	col,
	index,
	last,
	width,
	grow,
	menuOpen,
	setMenu,
	renaming,
	setRenaming,
	editing,
	dragging,
	over,
	drag,
	setDrag,
	setOver,
}: ColumnProps) {
	const { activity } = useServices()
	const feed = activity.columnFeed(col.id)
	const openId = useStore(activity, s => s.openId)
	const menuBtn = useRef<HTMLButtonElement>(null)
	if (!feed) return null

	const open = (id: string) => {
		const item = feed.get().items.find(i => i.eventId === id) ?? null
		if (item) activity.open(item)
	}

	return (
		<section
			className="wkac-col"
			aria-label={col.title}
			data-editing={editing || undefined}
			data-over={over || undefined}
			data-dragging={dragging || undefined}
			style={{
				flex: `${grow ? 1 : 0} 0 ${width}px`,
				maxWidth: COL_MAX,
			}}
			onDragOver={e => {
				if (drag === null || drag === col.id) return
				e.preventDefault()
				if (!over) setOver(col.id)
			}}
			onDragLeave={e => {
				if (over && !e.currentTarget.contains(e.relatedTarget as Node | null))
					setOver(null)
			}}
			onDrop={e => {
				e.preventDefault()
				if (drag !== null && drag !== col.id) activity.dropColumn(drag, col.id)
				setDrag(null)
				setOver(null)
			}}
		>
			<header
				className="wkac-colhead"
				draggable={!renaming}
				title="Drag to reorder"
				onDragStart={e => {
					try {
						e.dataTransfer.setData("text/plain", col.id)
						e.dataTransfer.effectAllowed = "move"
					} catch {
						// some browsers refuse data on synthetic drags; the state carries it
					}
					setMenu(null)
					setDrag(col.id)
				}}
				onDragEnd={() => {
					setDrag(null)
					setOver(null)
				}}
			>
				<Icon name="grip" size={14} className="wkac-grip" />
				{renaming ? (
					<RenameField
						title={col.title}
						onDone={title => {
							if (title !== null) activity.renameColumn(col.id, title)
							setRenaming(null)
							menuBtn.current?.focus()
						}}
					/>
				) : (
					<>
						<h3 className="wkac-title">{col.title}</h3>
						<ColumnCount feed={feed} />
					</>
				)}
				<span className="wkf-gap" />
				<IconButton
					ref={menuBtn}
					size="sm"
					label={`Options for column ${col.title}`}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					className="wkac-menubtn"
					onClick={() => setMenu(menuOpen ? null : col.id)}
				>
					<Icon name="dots" />
				</IconButton>
			</header>
			{menuOpen && (
				<ColumnMenu
					col={col}
					first={index === 0}
					last={last}
					onClose={(focusBack: boolean) => {
						setMenu(null)
						if (focusBack) menuBtn.current?.focus()
					}}
					onRename={() => {
						setMenu(null)
						setRenaming(col.id)
					}}
				/>
			)}
			<ActivityList
				feed={feed}
				openId={openId}
				label={col.title}
				column={col.id}
				className="wkac-list"
				onOpen={open}
			/>
			<ColumnEmpty feed={feed} title={col.title} />
		</section>
	)
}

function ColumnCount({ feed }: { feed: ActivityFeed }) {
	const count = useStore(feed, s => s.items.length)
	const more = useStore(feed, s => s.nextPageToken !== null)
	return (
		<span className="wkac-count">
			{count}
			{more ? "+" : ""}
		</span>
	)
}

function ColumnEmpty({ feed, title }: { feed: ActivityFeed; title: string }) {
	const { activity } = useServices()
	const empty = useStore(feed, s => s.items.length === 0)
	const status = useStore(feed, s => s.status)
	const query = useStore(feed, s => s.query)
	const searching = useStore(
		activity,
		s => s.tokens.length > 0 || s.chip !== null,
	)
	if (!empty || status === "loading") return null
	const nothing = searching || query === null
	return (
		<div className="wkac-colempty">
			{status === "error" ? (
				<>
					<p className="wkac-colempty-title">Could not load</p>
					<Button variant="outline" onClick={() => void feed.reload()}>
						Try again
					</Button>
				</>
			) : (
				<>
					<p className="wkac-colempty-title">
						{nothing ? "Nothing matches" : "Quiet so far"}
					</p>
					<p className="wkac-colempty-text">
						{nothing
							? `Nothing in ${title} matches the search.`
							: `New ${title} will appear here as WaveKit decodes it.`}
					</p>
					{searching && (
						<Button
							variant="outline"
							className="wkac-clear"
							onClick={() => activity.clear()}
						>
							Clear filters
						</Button>
					)}
				</>
			)}
		</div>
	)
}

function RenameField({
	title,
	onDone,
}: {
	title: string
	onDone: (title: string | null) => void
}) {
	const [text, setText] = useState(title)
	const input = useRef<HTMLInputElement>(null)
	const done = useRef(false)
	useEffect(() => {
		input.current?.focus()
		input.current?.select()
	}, [])
	const finish = (t: string | null) => {
		if (done.current) return
		done.current = true
		onDone(t)
	}
	return (
		<input
			ref={input}
			className="wk-input wkac-rename"
			value={text}
			aria-label="Column name"
			spellCheck={false}
			autoComplete="off"
			onChange={e => setText(e.target.value)}
			onKeyDown={e => {
				if (e.key === "Enter") {
					e.preventDefault()
					finish(text)
				} else if (e.key === "Escape") {
					e.preventDefault()
					e.stopPropagation()
					finish(null)
				}
			}}
			onBlur={() => finish(text)}
		/>
	)
}

function ColumnMenu({
	col,
	first,
	last,
	onClose,
	onRename,
}: {
	col: ActivityColumn
	first: boolean
	last: boolean
	onClose: (focusBack: boolean) => void
	onRename: () => void
}) {
	const { activity } = useServices()
	const box = useRef<HTMLDivElement>(null)
	const close = useRef(onClose)
	close.current = onClose

	useEffect(() => {
		box.current
			?.querySelector<HTMLButtonElement>(
				"[role=menuitem]:not([aria-disabled=true])",
			)
			?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return
			e.preventDefault()
			e.stopPropagation()
			close.current(true)
		}
		const onDown = (e: PointerEvent) => {
			if (!box.current?.contains(e.target as Node)) close.current(false)
		}
		document.addEventListener("keydown", onKey, true)
		document.addEventListener("pointerdown", onDown, true)
		return () => {
			document.removeEventListener("keydown", onKey, true)
			document.removeEventListener("pointerdown", onDown, true)
		}
	}, [])

	const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
		e.preventDefault()
		const items = [
			...(box.current?.querySelectorAll<HTMLButtonElement>(
				"[role=menuitem]:not([aria-disabled=true])",
			) ?? []),
		]
		const at = items.indexOf(document.activeElement as HTMLButtonElement)
		items[
			(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
		]?.focus()
	}

	const item = (
		label: string,
		act: () => void,
		opts: { hint?: string; off?: boolean; danger?: boolean } = {},
	) => (
		<button
			type="button"
			role="menuitem"
			className="wk-option"
			data-danger={opts.danger || undefined}
			aria-disabled={opts.off || undefined}
			onClick={() => {
				if (!opts.off) act()
			}}
		>
			{label}
			{opts.hint && <span className="wkac-hint">{opts.hint}</span>}
		</button>
	)

	return (
		<div
			ref={box}
			role="menu"
			aria-label={`Column ${col.title}`}
			className="wk-menu wkac-menu"
			onKeyDown={onMenuKey}
		>
			{item("Rename", onRename)}
			{item(
				"Edit search",
				() => {
					onClose(false)
					activity.editColumn(col.id)
					requestAnimationFrame(() =>
						document
							.querySelector<HTMLInputElement>(
								"input[aria-label='Search activity']",
							)
							?.focus(),
					)
				},
				{ hint: "in Activity" },
			)}
			{item(
				"Move left",
				() => {
					activity.moveColumn(col.id, -1)
					onClose(true)
				},
				{ off: first },
			)}
			{item(
				"Move right",
				() => {
					activity.moveColumn(col.id, 1)
					onClose(true)
				},
				{ off: last },
			)}
			{item(
				"Remove",
				() => {
					onClose(false)
					const undo = activity.removeColumn(col.id)
					if (undo) showAppToast(`Removed the column ${col.title}.`, { undo })
				},
				{ danger: true },
			)}
		</div>
	)
}

function AddTile() {
	const { activity } = useServices()
	const { heard, presets } = useSuggestions()
	const searching = useStore(
		activity,
		s => s.tokens.length > 0 || s.chip !== null,
	)
	const editing = useStore(activity, s => s.editing !== null)
	const pinned = useStore(activity, s => {
		void s.columns
		void s.tokens
		void s.chip
		return activity.currentColumn()
	})
	return (
		<div className="wkac-add">
			<span className="wkac-add-title">Add a column</span>
			{searching && !editing && pinned === null && (
				<button
					type="button"
					className="wkac-add-btn"
					data-primary=""
					onClick={() => activity.pinSearch(true)}
				>
					Pin current search
				</button>
			)}
			{heard.slice(0, 2).map(h => (
				<button
					key={h.title}
					type="button"
					className="wkac-add-btn"
					onClick={() =>
						activity.addColumn(
							{
								title: h.title,
								tokens: h.tokens,
								chip: null,
								categories: null,
							},
							true,
						)
					}
				>
					+ {h.title}
				</button>
			))}
			{presets.map(p => (
				<button
					key={p.id}
					type="button"
					className="wkac-add-btn"
					onClick={() =>
						activity.addColumn(
							{
								title: p.title,
								tokens: [],
								chip: p.chip,
								categories: p.categories,
							},
							true,
						)
					}
				>
					+ {p.title}
				</button>
			))}
			<span className="wkac-add-hint">
				Up to five columns. They are kept in this browser.
			</span>
		</div>
	)
}
