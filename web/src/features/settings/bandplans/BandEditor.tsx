// The band editor (Settings.dc.html bpEditor): where the band sits and who names it, its fields as settings rows
// (More folds the scan ones), its channels with add and remove, then provenance with "Reset to France" (or Delete
// band for one you added). Every change saves at once, with Undo in the toast.
import { useId, useMemo, useRef, useState } from "react"

import { useServices } from "../../../app/context.ts"
import { formatMHz } from "../../format.ts"
import { groupColour, groupName } from "../../tuner/band.ts"
import { SetIcon } from "../icons.tsx"
import type { SettingRow } from "../model.ts"
import { SettingRowView } from "../SettingRowView.tsx"
import { deleteBand, resetBand, saveBand } from "./actions.ts"
import {
	TUNER_MAX_HZ,
	TUNER_MIN_HZ,
	channelId,
	editorRows,
	parseChannelName,
} from "./editor-rows.ts"
import type { BandEntry } from "./model.ts"
import { OPERATOR, YOUR_EDITS, edgesText, typedMHz } from "./model.ts"
import { showAppToast } from "../../../shell/toast.ts"

const CHANNEL_CAP = 8

export function BandEditor({
	entry,
	entries,
	lock,
	phone,
	onClose,
}: {
	entry: BandEntry
	entries: readonly BandEntry[]
	lock: string | undefined
	phone: boolean
	onClose: () => void
}) {
	const { data } = useServices()
	const stack = data.bandplanStack
	const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
	const [more, setMore] = useState(false)
	const [allChannels, setAllChannels] = useState(false)
	const freqRef = useRef<HTMLInputElement>(null)
	const nameRef = useRef<HTMLInputElement>(null)
	const id = useId()

	const b = entry.band
	const yours = entry.packId === OPERATOR
	const { main, more: moreRows } = useMemo(
		() =>
			editorRows({
				entry,
				siblings: entries.filter(e => e.packId === entry.packId),
				readOnly: lock,
				save: (set, label) =>
					saveBand(stack, entry, set, `${label} saved · ${entry.band.name}`),
			}),
		[entry, entries, lock, stack],
	)

	const change = (
		row: SettingRow,
		value: Parameters<NonNullable<SettingRow["write"]>>[0],
	) => {
		if (!row.write) return
		void row.write(value).then(r =>
			setErrors(e => {
				const next = { ...e }
				if (r.ok) delete next[row.id]
				else next[row.id] = r.message
				return next
			}),
		)
	}
	const rowView = (row: SettingRow) => (
		<SettingRowView
			key={row.id}
			row={row}
			{...(errors[row.id] ? { error: errors[row.id] as string } : {})}
			phone={phone}
			onChange={v => change(row, v)}
			onUndo={() => undefined}
			onReset={() => row.def && change(row, row.def.value)}
			onCopy={() => {
				void navigator.clipboard
					?.writeText(`${row.id}: ${JSON.stringify(row.value)}`)
					.then(() => showAppToast("Copied as YAML"))
					.catch(() => showAppToast("Could not copy", { tone: "warn" }))
			}}
		/>
	)

	// ---- channels
	const channels = b.channels
	const packChannels = entry.original?.channels ?? []
	const shown = allChannels ? channels : channels.slice(0, CHANNEL_CAP)
	const saveChannels = (next: typeof channels, toast: string) =>
		saveBand(stack, entry, { channels: [...next] }, toast).then(r => {
			if (!r.ok) showAppToast(r.message, { tone: "warn" })
			return r.ok
		})
	const addChannel = () => {
		const hz = typedMHz(freqRef.current?.value ?? "")
		if (hz === null) {
			showAppToast("Type the channel frequency in MHz", { tone: "warn" })
			return
		}
		if (hz < b.startHz || hz > b.endHz) {
			showAppToast(
				`${formatMHz(hz)} MHz is outside ${b.name} (${edgesText(b.startHz, b.endHz)})`,
				{ tone: "warn" },
			)
			return
		}
		const { name, aliases } = parseChannelName(nameRef.current?.value ?? "", hz)
		const channel = {
			id: channelId(
				name,
				channels.map(c => c.id),
			),
			name,
			frequencyHz: hz,
			aliases,
			registryRef: null,
		}
		const next = [...channels, channel].sort(
			(x, y) => x.frequencyHz - y.frequencyHz,
		)
		void saveChannels(next, `${name} added`).then(ok => {
			if (!ok) return
			if (freqRef.current) freqRef.current.value = ""
			if (nameRef.current) nameRef.current.value = ""
			freqRef.current?.focus()
		})
	}

	// ---- head and provenance
	const edited = entry.edit !== null
	const named = `${groupName(b.group)} · ${
		yours
			? "added by you"
			: `named by ${entry.namedBy}${edited && entry.namedBy !== YOUR_EDITS ? ", edited" : ""}`
	}`
	const pill = yours
		? { label: "Yours", tone: "yours" }
		: entry.verified
			? { label: "Verified", tone: "verified" }
			: { label: "Community", tone: "community" }
	const citation =
		entry.original?.provenance.kind === "builtin-cited"
			? entry.original.provenance.citations[0]?.title
			: undefined
	const prov = yours
		? "Added by you. In no plan, so pack updates never touch it."
		: `From ${entry.packName}${citation ? ` · checked against ${citation}` : " · community, not yet checked"}`
	const inTuner = b.startHz >= TUNER_MIN_HZ && b.endHz <= TUNER_MAX_HZ

	return (
		<div className="wkf-bp">
			<div className="wkf-set-dechead">
				<span className="wk-tile" aria-hidden="true">
					<span
						className="wkf-bp-headsw"
						style={{ background: groupColour(b.group) }}
					/>
				</span>
				<span className="wkf-grow wkf-set-dec-text">
					<b className="wkf-ellipsis wkf-num">
						{edgesText(b.startHz, b.endHz)}
					</b>
					<span className="wkf-ellipsis wkf-set-quiet">{named}</span>
				</span>
				<span
					className="wk-tag wkf-bp-pill"
					data-size="md"
					data-tone={pill.tone}
				>
					{pill.tone === "verified" && (
						<SetIcon name="check" size={12} strokeWidth={2.6} />
					)}
					{pill.label}
				</span>
			</div>
			{entry.hidden && (
				<p className="wkf-bp-lock">
					Hidden: it leaves the spectrum lanes, presets and ⌘K, and stays listed
					here.
				</p>
			)}
			{!inTuner && (
				<p className="wkf-bp-lock">
					Partly outside what the dongle tunes (24 to 1766 MHz).
				</p>
			)}
			{lock && <p className="wkf-bp-lock">{lock}</p>}
			{main.map(rowView)}
			<button
				type="button"
				className="wk-row wkf-set-fold"
				aria-expanded={more}
				data-open={more || undefined}
				onClick={() => setMore(m => !m)}
			>
				{more ? (
					<>
						<span className="wk-label wkf-grow">More</span>
						<span className="wkf-set-quiet">Hide</span>
						<SetIcon name="chevron-left" size={14} className="wkf-set-up" />
					</>
				) : (
					<>
						<b className="wkf-num">{moreRows.length} more</b>
						<span className="wkf-grow wkf-ellipsis wkf-set-quiet">
							{moreRows.map(r => r.label).join(", ")}
						</span>
						<SetIcon name="chevron-left" size={16} className="wkf-set-down" />
					</>
				)}
			</button>
			{more && moreRows.map(rowView)}

			<div className="wkf-bp-sec">
				<span className="wkf-grow">
					<span className="wk-label">Channels · {channels.length}</span>
					<span className="wkf-set-help">
						Named frequencies in the band. Names and aliases work in the Tuner
						and ⌘K.
					</span>
				</span>
			</div>
			{channels.length === 0 && (
				<p className="wkf-bp-desc">No channels yet. Add one below.</p>
			)}
			{shown.map(c => {
				const pc = packChannels.find(p => p.id === c.id)
				const mark = yours
					? ""
					: !pc
						? "Added"
						: pc.name !== c.name || pc.aliases.join() !== c.aliases.join()
							? "Renamed"
							: ""
				const meta = c.aliases.length
					? `Also ${c.aliases.map(a => `“${a}”`).join(", ")}`
					: ""
				return (
					<div key={c.id} className="wk-row wkf-bp-ch">
						<span className="wkf-bp-chf wkf-num">
							{formatMHz(c.frequencyHz)}
						</span>
						<span className="wkf-grow wkf-bp-bandtext">
							<span className="wkf-bp-bandname">
								<span className="wkf-ellipsis">{c.name}</span>
								{mark && (
									<span className="wk-tag" data-variant="accent">
										{mark}
									</span>
								)}
							</span>
							{meta && <span className="wkf-bp-meta wkf-ellipsis">{meta}</span>}
						</span>
						{!lock && (
							<button
								type="button"
								className="wk-icon-btn"
								aria-label={`Remove ${c.name}`}
								onClick={() =>
									void saveChannels(
										channels.filter(x => x.id !== c.id),
										`${c.name} removed`,
									)
								}
							>
								<SetIcon name="x" size={13} strokeWidth={2.2} />
							</button>
						)}
					</div>
				)
			})}
			{channels.length > shown.length && (
				<button
					type="button"
					className="wk-row wkf-bp-all wkf-num"
					onClick={() => setAllChannels(true)}
				>
					Show all {channels.length}
				</button>
			)}
			{!lock && (
				<div role="group" aria-label="Add a channel" className="wkf-bp-chadd">
					<input
						ref={freqRef}
						id={`${id}-f`}
						className="wk-input wk-box wk-tall wkf-bp-chin wkf-num"
						placeholder="MHz"
						aria-label="Channel frequency in MHz"
						inputMode="decimal"
						spellCheck={false}
						autoComplete="off"
						onKeyDown={e => {
							if (e.key === "Enter") addChannel()
						}}
					/>
					<input
						ref={nameRef}
						className="wk-input wk-box wk-tall wkf-grow"
						placeholder="Name, then aliases after commas"
						aria-label="Channel name, then aliases after commas"
						spellCheck={false}
						autoComplete="off"
						onKeyDown={e => {
							if (e.key === "Enter") addChannel()
						}}
					/>
					<button
						type="button"
						className="wk-btn wk-tall wkf-bp-secbtn"
						data-variant="outline"
						onClick={addChannel}
					>
						Add channel
					</button>
				</div>
			)}

			<div className="wkf-bp-provblock">
				<div className="wkf-bp-provline">
					<SetIcon
						name={entry.verified ? "check" : "info"}
						size={15}
						className={entry.verified ? "wkf-bp-ver" : "wkf-set-quiet"}
					/>
					<span>{prov}</span>
				</div>
				{!lock && (edited || yours) && (
					<div className="wkf-bp-provbtns">
						{edited && (
							<button
								type="button"
								className="wk-btn wk-tall wkf-bp-secbtn"
								data-variant="outline"
								data-size="lg"
								onClick={() => void resetBand(stack, entry)}
							>
								<SetIcon name="reset" size={15} />
								Reset to {entry.packName}
							</button>
						)}
						{yours && (
							<button
								type="button"
								className="wk-btn wk-tall wkf-bp-delete"
								data-variant="ghost"
								data-size="lg"
								onClick={() =>
									void deleteBand(stack, entry).then(ok => ok && onClose())
								}
							>
								Delete band
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
