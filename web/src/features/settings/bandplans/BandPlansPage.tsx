// Settings › Band plans (Settings.dc.html "Band plans page"): the stack of active plans (Your edits on top, then
// the plans in order: switch, grip, provenance and ⋯), then the bands they add up to with search and group chips.
// A band opens its editor; Import opens the sheet over the drawer.
import { useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent, KeyboardEvent } from "react"

import { useReadOnly, useServices } from "../../../app/context.ts"
import { useStore } from "../../../data/index.ts"
import { showAppToast } from "../../../shell/toast.ts"
import { groupColour } from "../../tuner/band.ts"
import { SetIcon } from "../icons.tsx"
import type { SetIconName } from "../icons.tsx"
import {
	addBand,
	removeImport,
	resetAll,
	setStack,
	togglePlan,
} from "./actions.ts"
import { BandEditor } from "./BandEditor.tsx"
import { ImportSheet } from "./ImportSheet.tsx"
import type { BandEntry, BandFilter, PlanItem } from "./model.ts"
import {
	OPERATOR,
	bandChips,
	bandEntries,
	bandExtra,
	bandRows,
	droppedBefore,
	edgesText,
	isEdited,
	moved,
	planItems,
} from "./model.ts"
import { UpdateCheck } from "./UpdateCheck.tsx"

export interface BandPlansPageProps {
	/** The band open in the editor (`packId/bandId`), else the page. */
	band: string | null
	onBand: (key: string | null) => void
	/** The drawer, where the import sheet is drawn over everything. */
	host: HTMLElement | null
	phone: boolean
}

/** Why nothing here can change, or undefined. */
export function useBandplansLock(): string | undefined {
	const readOnly = useReadOnly()
	const writable = useStore(
		useServices().data.bandplanStack,
		s => s.view?.capabilities.writable,
	)
	if (readOnly) return "Read-only access: sign in on this WaveKit to change it"
	if (writable === false)
		return "This WaveKit keeps band plans read-only (open access mode)"
	return undefined
}

export function useBandEntries(): BandEntry[] {
	const { data } = useServices()
	const view = useStore(data.bandplanStack, s => s.view)
	const packs = useStore(data.bandplanStack, s => s.packs)
	const resolved = useStore(data.bandplan, s => s.view)
	return useMemo(
		() => (view ? bandEntries(view, packs, resolved) : []),
		[view, packs, resolved],
	)
}

export function BandPlansPage({
	band,
	onBand,
	host,
	phone,
}: BandPlansPageProps) {
	const { data } = useServices()
	const stack = data.bandplanStack
	const state = useStore(stack)
	const entries = useBandEntries()
	const lock = useBandplansLock()
	const [sheet, setSheet] = useState(false)

	useEffect(() => {
		void stack.load()
	}, [stack])

	if (!state.view)
		return (
			<div className="wkf-set-nothing">
				{state.error
					? `Band plans did not load: ${state.error}`
					: "Loading band plans…"}
			</div>
		)

	const open = band ? entries.find(e => e.key === band) : undefined
	return (
		<>
			{open ? (
				<BandEditor
					entry={open}
					entries={entries}
					lock={lock}
					phone={phone}
					onClose={() => onBand(null)}
				/>
			) : (
				<PlanPage
					entries={entries}
					lock={lock}
					onBand={onBand}
					onImport={() => setSheet(true)}
				/>
			)}
			{sheet && host && (
				<ImportSheet
					host={host}
					phone={phone}
					onClose={() => setSheet(false)}
				/>
			)}
		</>
	)
}

function Section({
	label,
	desc,
	first,
	button,
}: {
	label: string
	desc: string
	first?: boolean
	button?: { label: string; icon: SetIconName; act: () => void }
}) {
	return (
		<div className="wkf-bp-sec" data-first={first || undefined}>
			<span className="wkf-grow">
				<span className="wk-label">{label}</span>
				<span className="wkf-set-help">{desc}</span>
			</span>
			{button && (
				<button
					type="button"
					className="wk-btn wk-tall wkf-bp-secbtn"
					data-variant="outline"
					onClick={button.act}
				>
					<SetIcon name={button.icon} size={15} />
					{button.label}
				</button>
			)}
		</div>
	)
}

function PlanPage({
	entries,
	lock,
	onBand,
	onImport,
}: {
	entries: readonly BandEntry[]
	lock: string | undefined
	onBand: (key: string | null) => void
	onImport: () => void
}) {
	const { data } = useServices()
	const stack = data.bandplanStack
	const view = useStore(stack, s => s.view)
	const packs = useStore(stack, s => s.packs)
	const [q, setQ] = useState("")
	const [filter, setFilter] = useState<BandFilter>("all")
	const [menu, setMenu] = useState<string | null>(null)
	const [drag, setDrag] = useState<string | null>(null)
	const [over, setOver] = useState<string | null>(null)
	const [update, setUpdate] = useState<string | null>(null)

	const editCount = entries.filter(isEdited).length
	const items = useMemo(
		() => (view ? planItems(view, packs, editCount) : []),
		[view, packs, editCount],
	)
	const chips = useMemo(() => bandChips(entries), [entries])
	const rows = useMemo(() => bandRows(entries, q, filter), [entries, q, filter])
	if (!view) return null
	const list = view.stack.entries

	const move = (id: string, by: number) => {
		const name = list.find(e => e.packId === id)?.name ?? id
		void setStack(stack, moved(list, id, by), `${name} moved`)
	}
	const drop = (target: string) => {
		const from = drag
		setDrag(null)
		setOver(null)
		if (!from || from === target) return
		const name = list.find(e => e.packId === from)?.name ?? from
		void setStack(stack, droppedBefore(list, from, target), `${name} moved`)
	}

	const menuOf = (p: PlanItem, i: number) => {
		const n = items.length
		const out: {
			label: string
			icon: SetIconName
			act: () => void
			danger?: boolean
		}[] = []
		if (p.kind === "edits") {
			out.push({
				label: "Show edited bands",
				icon: "filter",
				act: () => {
					setQ("")
					setFilter("edited")
				},
			})
			if (!lock && editCount)
				out.push({
					label: "Undo all edits",
					icon: "reset",
					act: () => void resetAll(stack),
				})
			return out
		}
		if (p.canCheck && !lock)
			out.push({
				label: "Check for update",
				icon: "restart",
				act: () => setUpdate(p.id),
			})
		else if (p.kind === "builtin")
			out.push({
				label: "Check for update",
				icon: "restart",
				act: () =>
					showAppToast(`${p.name} is built in. It updates with WaveKit.`),
			})
		if (p.source) {
			const url = p.source
			out.push({
				label: "Show source",
				icon: "link",
				act: () => window.open(url, "_blank", "noopener"),
			})
		}
		if (!lock && i > 1)
			out.push({ label: "Move up", icon: "up", act: () => move(p.id, -1) })
		if (!lock && i < n - 1)
			out.push({ label: "Move down", icon: "down", act: () => move(p.id, 1) })
		if (!lock && p.kind === "imported")
			out.push({
				label: "Remove import",
				icon: "trash",
				danger: true,
				act: () => void removeImport(stack, p.id, p.name),
			})
		return out
	}

	const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault()
			e.stopPropagation()
			setMenu(null)
			return
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
		e.preventDefault()
		const all = [
			...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
		]
		const at = all.indexOf(document.activeElement as HTMLButtonElement)
		all[
			(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length
		]?.focus()
	}

	const newBand = async () => {
		const key = await addBand(stack, {
			startHz: 433_050_000,
			endHz: 434_790_000,
		})
		if (key) onBand(key)
	}

	return (
		<div className="wkf-bp">
			<p className="wkf-bp-desc">
				What WaveKit calls each part of the spectrum. The spectrum lanes, the
				Tuner, Scan a band and ⌘K all read it.
			</p>
			{lock && <p className="wkf-bp-lock">{lock}</p>}
			<Section
				first
				label="Active plans"
				desc="Higher plans name a band where plans overlap. Gaps fall through to the next one."
				{...(lock
					? {}
					: { button: { label: "Import", icon: "upload", act: onImport } })}
			/>
			{items.map((p, i) => (
				<PlanRow
					key={p.id}
					item={p}
					lock={lock}
					menu={menu === p.id ? menuOf(p, i) : null}
					onMenu={() => setMenu(m => (m === p.id ? null : p.id))}
					onMenuKey={onMenuKey}
					closeMenu={() => setMenu(null)}
					dragging={drag === p.id}
					over={over === p.id && drag !== null && drag !== p.id}
					onDragStart={e => {
						if (p.kind === "edits" || lock) {
							e.preventDefault()
							return
						}
						e.dataTransfer.setData("text/plain", p.id)
						e.dataTransfer.effectAllowed = "move"
						setDrag(p.id)
						setMenu(null)
					}}
					onDragEnd={() => {
						setDrag(null)
						setOver(null)
					}}
					onDragOver={e => {
						if (!drag || drag === p.id || p.kind === "edits") return
						e.preventDefault()
						if (over !== p.id) setOver(p.id)
					}}
					onDrop={e => {
						e.preventDefault()
						drop(p.id)
					}}
					onToggle={() => void togglePlan(stack, p.id)}
					update={
						update === p.id ? (
							<UpdateCheck packId={p.id} onDone={() => setUpdate(null)} />
						) : null
					}
				/>
			))}

			<Section
				label={`Bands · ${entries.length}`}
				desc="What the active plans add up to, lowest first. A narrower band names its part of a wider one."
				{...(lock
					? {}
					: {
							button: {
								label: "Add band",
								icon: "plus",
								act: () => void newBand(),
							},
						})}
			/>
			<div className="wkf-bp-tools">
				<div className="wk-field">
					<SetIcon name="search" size={15} className="wkf-set-quiet" />
					<input
						aria-label="Find a band"
						placeholder="Find a band, channel or MHz"
						spellCheck={false}
						autoComplete="off"
						value={q}
						onChange={e => setQ(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Escape" && q) {
								e.preventDefault()
								e.stopPropagation()
								setQ("")
							}
						}}
					/>
				</div>
				<div role="group" aria-label="Show bands of" className="wkf-bp-chips">
					{chips.map(c => (
						<button
							key={c.id}
							type="button"
							className="wk-chip wk-tall"
							data-size="sm"
							aria-pressed={filter === c.id}
							onClick={() =>
								setFilter(f => (f === c.id && c.id !== "all" ? "all" : c.id))
							}
						>
							{c.group && (
								<span
									aria-hidden="true"
									className="wkf-bp-sw"
									style={{ background: groupColour(c.group) }}
								/>
							)}
							{c.label}
							<span className="wkf-set-quiet wkf-num">{c.n}</span>
						</button>
					))}
				</div>
			</div>
			{rows.length === 0 && (
				<p className="wkf-bp-desc">
					{q.trim()
						? `No band or channel matches “${q.trim()}”.`
						: "No band here."}
				</p>
			)}
			{rows.map(({ entry, depth }) => (
				<BandRow
					key={entry.key}
					entry={entry}
					depth={depth}
					onOpen={() => onBand(entry.key)}
				/>
			))}
		</div>
	)
}

interface MenuItem {
	label: string
	icon: SetIconName
	act: () => void
	danger?: boolean
}

function PlanRow({
	item: p,
	lock,
	menu,
	onMenu,
	onMenuKey,
	closeMenu,
	dragging,
	over,
	onDragStart,
	onDragEnd,
	onDragOver,
	onDrop,
	onToggle,
	update,
}: {
	item: PlanItem
	lock: string | undefined
	menu: readonly MenuItem[] | null
	onMenu: () => void
	onMenuKey: (e: KeyboardEvent<HTMLDivElement>) => void
	closeMenu: () => void
	dragging: boolean
	over: boolean
	onDragStart: (e: DragEvent<HTMLSpanElement>) => void
	onDragEnd: () => void
	onDragOver: (e: DragEvent<HTMLDivElement>) => void
	onDrop: (e: DragEvent<HTMLDivElement>) => void
	onToggle: () => void
	update: React.ReactNode
}) {
	const firstItem = useRef<HTMLButtonElement>(null)
	const moreBtn = useRef<HTMLButtonElement>(null)
	const open = menu !== null
	useEffect(() => {
		if (open) firstItem.current?.focus()
	}, [open])
	const edits = p.kind === "edits"
	const canDrag = !edits && !lock
	return (
		<div
			className="wk-row wkf-bp-plan"
			data-plan={p.id}
			data-off={!p.on || undefined}
			data-dragging={dragging || undefined}
			data-over={over || undefined}
			onDragOver={onDragOver}
			onDrop={onDrop}
		>
			<span
				className="wkf-bp-grip"
				draggable={canDrag}
				onDragStart={onDragStart}
				onDragEnd={onDragEnd}
				title={edits ? "Your edits stay on top" : "Drag to reorder"}
				data-fixed={!canDrag || undefined}
				aria-hidden="true"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
					<circle cx="9" cy="6" r="1.6" />
					<circle cx="15" cy="6" r="1.6" />
					<circle cx="9" cy="12" r="1.6" />
					<circle cx="15" cy="12" r="1.6" />
					<circle cx="9" cy="18" r="1.6" />
					<circle cx="15" cy="18" r="1.6" />
				</svg>
			</span>
			<span className="wkf-grow wkf-bp-plantext">
				<span className="wkf-bp-planname">
					<b>{p.name}</b>
					{p.kind !== "edits" && (
						<span className="wk-tag">
							{p.kind === "builtin" ? "Built in" : "Imported"}
						</span>
					)}
					{p.kind === "imported" && (
						<span className="wk-tag wkf-bp-comm" data-variant="outline">
							Community
						</span>
					)}
					{!p.on && <span className="wkf-bp-off">Off</span>}
				</span>
				<span className="wkf-bp-sub">{p.sub}</span>
				{p.prov && <span className="wkf-bp-prov wkf-num">{p.prov}</span>}
				{update}
			</span>
			{!edits && (
				<button
					type="button"
					role="switch"
					className="wk-switch"
					data-size="row"
					aria-checked={p.on}
					aria-label={`Use ${p.name}`}
					disabled={lock !== undefined}
					onClick={onToggle}
				/>
			)}
			<button
				ref={moreBtn}
				type="button"
				className="wk-icon-btn wkf-bp-more"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`More for ${p.name}`}
				onClick={onMenu}
			>
				<SetIcon name="dots" size={16} />
			</button>
			{menu && (
				<>
					<div
						className="wkf-bp-scrim"
						aria-hidden="true"
						onPointerDown={closeMenu}
					/>
					<div
						role="menu"
						aria-label={p.name}
						className="wk-menu wk-rise wkf-bp-menu"
						onKeyDown={e => {
							onMenuKey(e)
							if (e.key === "Escape") moreBtn.current?.focus()
						}}
					>
						{menu.map((m, k) => (
							<button
								key={m.label}
								ref={k === 0 ? firstItem : undefined}
								type="button"
								role="menuitem"
								className="wk-option"
								data-tone={m.danger ? "danger" : undefined}
								onClick={() => {
									closeMenu()
									m.act()
								}}
							>
								<SetIcon name={m.icon} size={15} strokeWidth={1.9} />
								{m.label}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	)
}

function BandRow({
	entry: e,
	depth,
	onOpen,
}: {
	entry: BandEntry
	depth: number
	onOpen: () => void
}) {
	const extra = bandExtra(e)
	const edges = edgesText(e.band.startHz, e.band.endHz)
	return (
		<button
			type="button"
			className="wk-row wkf-bp-band"
			data-band={e.key}
			data-hidden={e.hidden || undefined}
			style={{ paddingLeft: 12 + depth * 18 }}
			aria-label={`${e.band.name}, ${edges}${e.mark ? `, ${e.mark}` : ""}`}
			onClick={onOpen}
		>
			{depth > 0 && (
				<span
					aria-hidden="true"
					className="wkf-bp-guide"
					style={{ left: 5 + depth * 18 }}
				/>
			)}
			<span
				aria-hidden="true"
				className="wkf-bp-swatch"
				style={{ background: groupColour(e.band.group) }}
			/>
			<span className="wkf-grow wkf-bp-bandtext">
				<span className="wkf-bp-bandname">
					<b className="wkf-ellipsis">{e.band.name}</b>
					{e.mark && (
						<span
							className="wk-tag"
							data-variant={e.mark === "Hidden" ? undefined : "accent"}
						>
							{e.mark}
						</span>
					)}
				</span>
				<span className="wkf-bp-meta wkf-num">
					<span>
						<span className="wkf-bp-edges">{edges}</span> · {e.namedBy}
					</span>
					{e.verified && (
						<span className="wkf-bp-ver">
							<SetIcon name="check" size={12} strokeWidth={2.6} />
							Verified
						</span>
					)}
					{!e.verified && e.packId !== OPERATOR && (
						<span className="wk-tag wkf-bp-comm" data-variant="outline">
							community
						</span>
					)}
					{extra && <span>· {extra}</span>}
				</span>
			</span>
			<SetIcon name="chevron-right" size={16} className="wkf-set-chev" />
		</button>
	)
}
