// The Tuner panel's "Saved" section (docs/web/canvas/Tuner.dc.html): save the tuned frequency (name, group, with
// the live mode, bandwidth and tone), recall one (tune + mode), rename, remove. Stored in core, shared by every client.
import "./saved.css"

import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { SavedFrequency } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { bandAt, channelAt, useStore } from "../../data/index.ts"
import type { SavedFrequencyRow } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatMHz } from "../format.ts"
import { useLiveStatus, useTunedHz } from "../hooks.ts"
import { modulationOf } from "./modes.ts"
import {
	defaultGroup,
	defaultSaveName,
	recallSaved,
	SAVE_GROUPS,
	saveInput,
	saveSummary,
	savedMeta,
} from "./saved.ts"

const BOOKMARK = "M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"

/** The bookmark glyph of the board: outline for "save", filled for "saved". */
export function BookmarkIcon({
	size = 16,
	filled = false,
}: {
	size?: number
	filled?: boolean
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill={filled ? "currentColor" : "none"}
			stroke={filled ? "none" : "currentColor"}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d={BOOKMARK} />
		</svg>
	)
}

function PencilIcon() {
	return (
		<svg
			width={15}
			height={15}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.9}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
			<path d="M13.5 6.5l4 4" />
		</svg>
	)
}

/** Recall (mode, bandwidth, tone, then tune) through the Tuner's coalescing tuner. */
export function useRecall(): (f: SavedFrequency) => void {
	const { data, tuning } = useServices()
	return f => {
		void recallSaved(
			{
				config: () => data.liveAudio.get().status?.config,
				setConfig: patch => data.liveAudio.setConfig(patch),
				tune: hz => tuning.tune(hz),
			},
			f,
		)
	}
}

function SaveForm({ hz, onDone }: { hz: number; onDone: () => void }) {
	const { data } = useServices()
	const status = useLiveStatus()
	const view = useStore(data.bandplan, s => s.view)
	const band = bandAt(view, hz)
	const [name, setName] = useState(() =>
		defaultSaveName(hz, channelAt(band, hz)?.name, band?.band.name),
	)
	const [group, setGroup] = useState(() => defaultGroup(band?.band.group))
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		input.current?.select()
	}, [])
	const draft = saveInput(
		{
			hz,
			config: status?.config ?? null,
			bandMode: modulationOf(band?.band.mode),
		},
		name.trim(),
		group,
	)
	const save = () => {
		if (!name.trim()) return
		onDone()
		data.savedFrequencies.create(draft).catch(() => undefined)
	}
	return (
		<div className="wkf-save" role="group" aria-label="Save this frequency">
			<label className="wkf-save-label">
				Name
				<input
					ref={input}
					className="wk-input wkf-save-name"
					value={name}
					maxLength={128}
					onChange={e => setName(e.target.value)}
					onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
						if (e.key === "Enter") {
							e.preventDefault()
							save()
						} else if (e.key === "Escape") {
							e.preventDefault()
							e.stopPropagation()
							onDone()
						}
					}}
				/>
			</label>
			<div className="wk-shell-row" role="radiogroup" aria-label="Group">
				{SAVE_GROUPS.map(g => (
					<Chip
						key={g}
						size="sm"
						role="radio"
						aria-checked={g === group}
						onClick={() => setGroup(g)}
					>
						{g}
					</Chip>
				))}
			</div>
			<span className="wkf-quiet wkf-xs">
				Saves {saveSummary(draft)}. Shared with every WaveKit client.
			</span>
			<div className="wkf-save-actions">
				<Button variant="ghost" size="lg" onClick={onDone}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="lg"
					disabled={!name.trim()}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</div>
	)
}

function RenameField({
	row,
	onDone,
}: {
	row: SavedFrequencyRow
	onDone: () => void
}) {
	const { data } = useServices()
	const [name, setName] = useState(row.name)
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		input.current?.select()
	}, [])
	const commit = () => {
		const next = name.trim()
		onDone()
		if (next && next !== row.name)
			data.savedFrequencies.rename(row.id, next).catch(() => undefined)
	}
	return (
		<input
			ref={input}
			className="wk-input wkf-saved-rename"
			value={name}
			maxLength={128}
			aria-label={`New name for ${row.name}`}
			onChange={e => setName(e.target.value)}
			onBlur={commit}
			onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
				if (e.key === "Enter") {
					e.preventDefault()
					commit()
				} else if (e.key === "Escape") {
					e.preventDefault()
					e.stopPropagation()
					onDone()
				}
			}}
		/>
	)
}

function SavedRow({
	row,
	tuned,
	editable,
	renaming,
	onRename,
	onRecall,
}: {
	row: SavedFrequencyRow
	tuned: boolean
	editable: boolean
	renaming: boolean
	onRename: (id: string | null) => void
	onRecall: (f: SavedFrequency) => void
}) {
	const { data } = useServices()
	const pending = row.pending !== undefined
	return (
		<div
			className="wkf-saved-row"
			data-tuned={tuned || undefined}
			data-pending={pending || undefined}
		>
			{renaming ? (
				<RenameField row={row} onDone={() => onRename(null)} />
			) : (
				<button
					type="button"
					className="wkf-saved-pick"
					onClick={() => onRecall(row)}
					title={`Tune to ${row.name} (${savedMeta(row)})`}
				>
					<span className="wkf-grow wkf-saved-text">
						<b className="wkf-ellipsis">{row.name}</b>
						<span className="wkf-quiet wkf-xs wkf-ellipsis">
							{pending ? "Saving…" : savedMeta(row)}
						</span>
					</span>
					<span className="wkf-saved-f">{formatMHz(row.frequencyHz)}</span>
				</button>
			)}
			{editable && !renaming && (
				<IconButton
					label={`Rename ${row.name}`}
					className="wkf-saved-edit"
					disabled={pending}
					onClick={() => onRename(row.id)}
				>
					<PencilIcon />
				</IconButton>
			)}
			{editable && (
				<IconButton
					label={`Remove ${row.name} from saved`}
					size="lg"
					className="wkf-saved-remove"
					disabled={pending}
					onClick={() => {
						data.savedFrequencies.remove(row.id).catch(() => undefined)
					}}
				>
					<BookmarkIcon size={15} filled />
				</IconButton>
			)}
		</div>
	)
}

/** The "Saved" block at the foot of the Tuning options panel. */
export const SavedSection = memo(function SavedSection() {
	const { data } = useServices()
	const readOnly = useReadOnly()
	const hz = useTunedHz()
	const state = useStore(data.savedFrequencies)
	const recall = useRecall()
	const [saving, setSaving] = useState(false)
	const [renaming, setRenaming] = useState<string | null>(null)
	const ready = state.status === "ready"
	const editable = ready && !readOnly
	const rounded = hz === null ? null : Math.round(hz)
	const isSaved =
		rounded !== null && state.items.some(f => f.frequencyHz === rounded)
	const full = state.items.length >= state.limit
	const canSave = editable && rounded !== null && !isSaved && !saving && !full
	return (
		<div className="wkf-saved">
			<div className="wkf-field-head wkf-saved-head">
				<Label>Saved</Label>
				{canSave && (
					<Button
						variant="ghost"
						size="sm"
						className="wkf-saved-add"
						onClick={() => setSaving(true)}
					>
						<BookmarkIcon />
						Save this frequency
					</Button>
				)}
			</div>
			{saving && rounded !== null && (
				<SaveForm hz={rounded} onDone={() => setSaving(false)} />
			)}
			{state.status === "unavailable" && (
				<span className="wkf-quiet wkf-small">
					Saved frequencies are kept by a WaveKit in protected mode; this one
					runs without access control.
				</span>
			)}
			{(state.status === "idle" || state.status === "loading") && (
				<span className="wkf-quiet wkf-small">Loading…</span>
			)}
			{ready && state.items.length === 0 && !saving && (
				<span className="wkf-quiet wkf-small">
					Nothing saved yet. Saved frequencies show on the spectrum and answer
					to their name when you type.
				</span>
			)}
			{state.items.length > 0 && (
				<div
					className="wkf-saved-list"
					role="list"
					aria-label="Saved frequencies"
				>
					{state.items.map(row => (
						<div role="listitem" key={row.id}>
							<SavedRow
								row={row}
								tuned={row.frequencyHz === rounded}
								editable={editable}
								renaming={renaming === row.id}
								onRename={setRenaming}
								onRecall={recall}
							/>
						</div>
					))}
				</div>
			)}
			{full && editable && (
				<span className="wkf-quiet wkf-small">
					{state.limit} saved: remove one to save another.
				</span>
			)}
			{state.error !== null && (
				<span className="wkf-warn" role="status">
					{state.error}
				</span>
			)}
		</div>
	)
})
