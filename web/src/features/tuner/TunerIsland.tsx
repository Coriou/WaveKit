// The Tuner island (docs/web/canvas/Tuner.dc.html): the place-value frequency display, typed entry with
// band hints and channel suggestions, the scan hold row while a sweep runs, and the Tuning options panel.
import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	type WheelEvent,
} from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { bandAt, channelAt, Store, useStore } from "../../data/index.ts"
import type { IslandContext, IslandSlot } from "../../shell/ShellIsland.tsx"
import { shellStore } from "../../shell/store.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Icon, Mark } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { IslandHead } from "../../ui/Island.tsx"
import { Kbd } from "../../ui/Kbd.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatMHz, formatStep, formatWidth } from "../format.ts"
import { useLiveStatus, useTunedHz } from "../hooks.ts"
import { squelchForModulation } from "../listen/audio.ts"
import { groupColour, groupName } from "./band.ts"
import {
	clickDirection,
	frequencyDigits,
	parseFrequency,
	startsEntry,
	stepPlace,
	wheelDirection,
} from "./frequency.ts"
import { MODES, modeSpec, modulationOf, type Modulation } from "./modes.ts"
import { effectiveStep, STEPS } from "./prefs.ts"
import {
	activeSuggestion,
	entrySuggestions,
	entryTarget,
	type EntrySuggestion,
} from "./saved.ts"
import { SavedSection, useRecall } from "./SavedFrequencies.tsx"
import { ScanHoldRow } from "./ScanHoldRow.tsx"

interface EntryState {
	typing: boolean
	q: string
	sel: number
	/** The operator moved through the suggestions with the arrows (Enter then takes one over a typed number). */
	navigated: boolean
	/** The panel was open before typing (restored on close). */
	panelWasOpen: boolean
}

type EntryStore = Store<EntryState>

const CLOSED_ENTRY: EntryState = {
	typing: false,
	q: "",
	sel: 0,
	navigated: false,
	panelWasOpen: false,
}

function openEntry(entry: EntryStore, q: string): void {
	const wasOpen = shellStore.getState().panel === "tuner"
	entry.set({
		typing: true,
		q,
		sel: 0,
		navigated: false,
		panelWasOpen: wasOpen,
	})
	shellStore.openPanel("tuner")
}

function closeEntry(entry: EntryStore): void {
	const { panelWasOpen } = entry.get()
	entry.set(CLOSED_ENTRY)
	if (!panelWasOpen && shellStore.getState().panel === "tuner")
		shellStore.closePanel()
}

// ---- head

function Digits({ entry }: { entry: EntryStore }) {
	const { tuning } = useServices()
	const readOnly = useReadOnly()
	const hz = useTunedHz()
	const group = useRef<HTMLDivElement>(null)
	if (hz === null)
		return (
			<span
				className="wk-shell-freq wkf-freq-unknown"
				aria-label="Frequency unknown"
			>
				—
			</span>
		)
	const digits = frequencyDigits(hz)
	const nudge = (place: number, dir: number) => {
		if (readOnly || dir === 0) return
		const from = tuning.displayHz() ?? hz
		void tuning.tune(stepPlace(from, place, dir))
	}
	const focusDigit = (index: number) =>
		group.current
			?.querySelector<HTMLButtonElement>(`[data-digit="${index}"]`)
			?.focus()
	return (
		<div
			ref={group}
			className="wkf-digits"
			role="group"
			aria-label={`Frequency ${formatMHz(hz)} MHz. Click the top or bottom half of a digit, scroll, or use arrow keys. Type a number to enter one.`}
		>
			{digits.map(d => (
				<span key={d.index} className="wkf-digit-wrap">
					<button
						type="button"
						className="wkf-digit"
						data-digit={d.index}
						data-leading={d.leading || undefined}
						data-fine={d.fine || undefined}
						disabled={readOnly}
						tabIndex={d.index === 4 ? 0 : -1}
						aria-label={`Digit worth ${formatWidth(d.place)}, currently ${d.char}`}
						onClick={(e: MouseEvent<HTMLButtonElement>) => {
							const r = e.currentTarget.getBoundingClientRect()
							// keyboard "clicks" (Enter/Space) arrive at 0,0: treat them as up
							const dir =
								e.detail === 0 ? 1 : clickDirection(e.clientY, r.top, r.height)
							nudge(d.place, dir)
						}}
						onWheel={(e: WheelEvent<HTMLButtonElement>) =>
							nudge(d.place, wheelDirection(e.deltaY))
						}
						onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
							if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.preventDefault()
								nudge(d.place, e.key === "ArrowUp" ? 1 : -1)
							} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
								e.preventDefault()
								focusDigit(
									Math.min(
										9,
										Math.max(0, d.index + (e.key === "ArrowLeft" ? -1 : 1)),
									),
								)
							} else if (
								startsEntry(e.key) &&
								!e.metaKey &&
								!e.ctrlKey &&
								!readOnly
							) {
								e.preventDefault()
								openEntry(entry, e.key)
							}
						}}
					>
						{d.char}
					</button>
					{d.sepAfter && (
						<span className="wkf-digit-sep" aria-hidden="true">
							.
						</span>
					)}
				</span>
			))}
		</div>
	)
}

function EntryInput({ entry }: { entry: EntryStore }) {
	const { tuning, data } = useServices()
	const { q, sel, navigated } = useStore(entry)
	const view = useStore(data.bandplan, s => s.view)
	const saved = useStore(data.savedFrequencies, s => s.items)
	const recall = useRecall()
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		const el = input.current
		if (!el) return
		el.focus()
		el.setSelectionRange(el.value.length, el.value.length)
	}, [])
	const commit = () => {
		const parsed = parseFrequency(q, tuning.displayHz() ?? 0)
		const target = entryTarget(
			parsed,
			entrySuggestions(view, saved, q),
			sel,
			navigated,
		)
		if (!target) return
		closeEntry(entry)
		if (target.kind === "saved") recall(target.saved)
		else void tuning.tune(target.hz)
	}
	return (
		<>
			<input
				ref={input}
				className="wkf-entry"
				value={q}
				onChange={e =>
					entry.update(s => ({
						...s,
						q: e.target.value,
						sel: 0,
						navigated: false,
					}))
				}
				onKeyDown={e => {
					const n = entrySuggestions(view, saved, q).length
					const move = (dir: 1 | -1) => {
						e.preventDefault()
						const parsed = parseFrequency(q, tuning.displayHz() ?? 0)
						entry.update(s => {
							const at = activeSuggestion(parsed, s.sel, s.navigated)
							const next = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n
							return { ...s, sel: next, navigated: true }
						})
					}
					if (e.key === "Enter") {
						e.preventDefault()
						commit()
					} else if (e.key === "Escape") {
						e.preventDefault()
						e.stopPropagation()
						closeEntry(entry)
					} else if (e.key === "ArrowDown" && n) move(1)
					else if (e.key === "ArrowUp" && n) move(-1)
				}}
				aria-label="Type a frequency, channel, saved name or step"
				placeholder="161.15 · ch 16 · +25k"
				spellCheck={false}
				autoComplete="off"
			/>
			<Button
				variant="ghost"
				size="lg"
				className="wkf-entry-cancel"
				aria-label="Cancel typing"
				onClick={() => closeEntry(entry)}
			>
				Esc
			</Button>
		</>
	)
}

function TunerHead({ ctx, entry }: { ctx: IslandContext; entry: EntryStore }) {
	const typing = useStore(entry, s => s.typing)
	const readOnly = useReadOnly()
	const status = useLiveStatus()
	const mode = status ? modeSpec(status.config.modulation) : null
	return (
		<IslandHead className="wk-shell-tuner-head">
			<Mark size={26} className="wk-shell-brand" />
			<span className="wk-shell-vsep" aria-hidden="true" />
			{typing ? (
				<EntryInput entry={entry} />
			) : (
				<>
					<Digits entry={entry} />
					<IconButton
						label="Type a frequency"
						disabled={readOnly}
						onClick={() => openEntry(entry, "")}
					>
						<Icon name="keyboard" />
					</IconButton>
					<Button
						{...ctx.trigger}
						variant="ghost"
						size="lg"
						aria-label="Tuning options"
						className="wk-shell-mode"
					>
						<b>{mode?.label ?? "—"}</b>
						{status && mode?.bw
							? ` ${formatWidth(status.config.bandwidth)}`
							: ""}
						<Icon
							name="chevron-down"
							size={16}
							className="wk-shell-chev"
							data-open={ctx.open || undefined}
						/>
					</Button>
				</>
			)}
		</IslandHead>
	)
}

// ---- panel

function EntryAssist({ entry }: { entry: EntryStore }) {
	const { tuning, data } = useServices()
	const { q, sel, navigated } = useStore(entry)
	const view = useStore(data.bandplan, s => s.view)
	const saved = useStore(data.savedFrequencies, s => s.items)
	const recall = useRecall()
	const status = useLiveStatus()
	const current = tuning.displayHz() ?? 0
	const parsed = parseFrequency(q, current)
	const sugg = entrySuggestions(view, saved, q)
	const active = activeSuggestion(parsed, sel, navigated)
	const pick = (s: EntrySuggestion) => {
		closeEntry(entry)
		if (s.kind === "saved") recall(s.saved)
		else void tuning.tune(s.hz)
	}
	let preview: ReactNode
	if (parsed.kind === "ok") {
		const band = bandAt(view, parsed.hz)
		const bandMode = modulationOf(band?.band.mode)
		const text = formatMHz(parsed.hz)
		const [main, sub = ""] =
			text.length > 7 ? [text.slice(0, 7), text.slice(7)] : [text]
		const hints = [
			parsed.hint,
			band ? band.band.name : "No band plan entry",
			band && bandMode && status && bandMode !== status.config.modulation
				? `${modeSpec(bandMode).label} band`
				: null,
		].filter(Boolean)
		preview = (
			<>
				<div className="wkf-assist-freq">
					<span className="wkf-assist-main">{main}</span>
					{sub && <span className="wkf-assist-sub">{sub}</span>}
					<span className="wkf-assist-unit">MHz</span>
					<span className="wkf-gap" />
					<Kbd>Enter</Kbd>
				</div>
				<span className="wkf-assist-hint">{hints.join(" · ")}</span>
			</>
		)
	} else if (parsed.kind === "error") {
		preview = <span className="wkf-assist-err">{parsed.message}</span>
	} else if (parsed.kind === "empty" || !sugg.length) {
		preview = (
			<span className="wkf-assist-help">
				Type MHz (161.15), kHz (161150k), GHz (1.09g), a channel (ch 16, pmr 3),
				a saved name, or a step from here (+25k).
			</span>
		)
	}
	return (
		<div className="wkf-assist">
			{preview && <div className="wkf-assist-top">{preview}</div>}
			{sugg.length > 0 && (
				<div
					role="listbox"
					aria-label="Suggestions"
					className="wkf-assist-list"
				>
					{sugg.map((s, i) => (
						<button
							key={s.key}
							type="button"
							role="option"
							aria-selected={i === active}
							className="wk-option"
							data-size="touch"
							onMouseEnter={() =>
								entry.update(x =>
									x.sel === i && x.navigated
										? x
										: { ...x, sel: i, navigated: true },
								)
							}
							onClick={() => pick(s)}
						>
							{s.kind === "saved" ? (
								<span className="wkf-saved-dot" />
							) : (
								<span
									className="wkf-swatch"
									style={{ background: groupColour(s.channel.group) }}
								/>
							)}
							<span className="wkf-grow wkf-ellipsis">
								<b>{s.label}</b>
							</span>
							<span className="wkf-quiet">{s.sub}</span>
							<span className="wkf-assist-f">{formatMHz(s.hz)}</span>
						</button>
					))}
				</div>
			)}
			<div className="wkf-assist-keys">
				<span>↑↓ choose</span>
				<span>Enter tune</span>
				<span>Esc cancel</span>
			</div>
		</div>
	)
}

function useCommitLater<T>(
	commit: (value: T) => void,
	ms = 200,
): (value: T) => void {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const latest = useRef(commit)
	latest.current = commit
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)
	return (value: T) => {
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => latest.current(value), ms)
	}
}

function TuningOptions() {
	const { data, tuning, prefs } = useServices()
	const readOnly = useReadOnly()
	const status = useLiveStatus()
	const hz = useTunedHz()
	const view = useStore(data.bandplan, s => s.view)
	const chosenStep = useStore(prefs, s => s.stepHz)
	const bandStep = effectiveStep(null, view, hz)
	const tuneError = useStore(tuning, s => s.error)
	const audioError = useStore(data.liveAudio, s => s.error)
	const band = hz === null ? null : bandAt(view, hz)
	const channel = hz === null ? null : channelAt(band, hz)
	const config = status?.config
	const spec = config ? modeSpec(config.modulation) : null
	const [bw, setBw] = useState<number | null>(null)
	const commitBw = useCommitLater((value: number) => {
		data.liveAudio.setConfig({ bandwidth: value }).then(
			() => setBw(null),
			() => setBw(null),
		)
	})
	const noAudio = !config
	const setMode = (id: Modulation) => {
		const def = modeSpec(id).bw
		void data.liveAudio
			.setConfig({
				...squelchForModulation(config, id),
				...(def ? { modulation: id, bandwidth: def[3] } : { modulation: id }),
			})
			.catch(() => undefined)
	}
	const bandMode = modulationOf(band?.band.mode)
	const bwValue = bw ?? config?.bandwidth ?? 0
	const range = spec?.bw
	return (
		<>
			{band ? (
				<div className="wkf-band">
					<span
						className="wkf-swatch"
						style={{ background: groupColour(band.band.group) }}
					/>
					<b>{band.band.name}</b>
					<span className="wkf-quiet wkf-ellipsis">
						{[
							groupName(band.band.group),
							channel?.name,
							bandMode ? modeSpec(bandMode).label : null,
							band.band.stepHz ? `${formatWidth(band.band.stepHz)} step` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</div>
			) : (
				<span className="wkf-quiet">No band plan entry here</span>
			)}
			<Label>Mode</Label>
			<div
				role="radiogroup"
				aria-label="Demodulation mode"
				className="wk-seg is-grid wkf-modes"
			>
				{MODES.map(m => (
					<button
						key={m.id}
						type="button"
						role="radio"
						aria-checked={config?.modulation === m.id}
						disabled={readOnly || noAudio}
						title={
							bandMode === m.id && band
								? `${band.band.name} uses ${m.label}`
								: undefined
						}
						onClick={() => setMode(m.id)}
					>
						{m.label}
					</button>
				))}
			</div>
			{range && config && (
				<div className="wkf-field">
					<div className="wkf-field-head">
						<Label>Bandwidth</Label>
						<b className="wkf-num">{formatWidth(bwValue)}</b>
					</div>
					<div
						className="wk-slider wkf-slider"
						style={
							{
								"--wk-value": String(
									(bwValue - range[0]) / (range[1] - range[0]),
								),
							} as CSSProperties
						}
					>
						<div className="wk-slider-track">
							<div className="wk-slider-fill" />
						</div>
						<div className="wk-slider-knob" />
						<input
							type="range"
							min={range[0]}
							max={range[1]}
							step={range[2]}
							value={Math.min(range[1], Math.max(range[0], bwValue))}
							disabled={readOnly}
							aria-label="Bandwidth"
							aria-valuetext={formatWidth(bwValue)}
							onChange={e => {
								const v = Number(e.target.value)
								setBw(v)
								commitBw(v)
							}}
						/>
					</div>
				</div>
			)}
			<div className="wkf-field-head">
				<Label>Tuning step</Label>
				<span className="wkf-quiet wkf-small">Scroll the spectrum to step</span>
			</div>
			<div className="wk-shell-row" role="group" aria-label="Tuning step">
				<Chip
					pressed={chosenStep === null}
					title={`The band plan's step here: ${formatStep(bandStep)}`}
					onClick={() => prefs.setStep(null)}
				>
					{chosenStep === null ? `Auto · ${formatStep(bandStep)}` : "Auto"}
				</Chip>
				{STEPS.map(s => (
					<Chip
						key={s}
						pressed={s === chosenStep}
						title={
							band?.band.stepHz === s
								? `${band.band.name} steps by ${formatStep(s)}`
								: undefined
						}
						onClick={() => prefs.setStep(s)}
					>
						{formatStep(s)}
					</Chip>
				))}
			</div>
			{noAudio && (
				<span className="wkf-quiet wkf-small">
					Live audio is not available on this core: mode and bandwidth are
					read-only.
				</span>
			)}
			{(tuneError ?? audioError) && (
				<span className="wkf-warn" role="status">
					{tuneError ?? audioError}
				</span>
			)}
			<SavedSection />
		</>
	)
}

function TunerPanel({ entry }: { entry: EntryStore }) {
	const typing = useStore(entry, s => s.typing)
	return typing ? <EntryAssist entry={entry} /> : <TuningOptions />
}

/** The Tuner island slot. One per app (it holds the typed-entry state). */
export function createTunerSlot(): IslandSlot {
	const entry: EntryStore = new Store<EntryState>(CLOSED_ENTRY)
	// closing the panel (Escape, the trigger, another island) ends typing
	shellStore.subscribe(() => {
		if (shellStore.getState().panel !== "tuner" && entry.get().typing)
			entry.set(CLOSED_ENTRY)
	})
	return {
		panelLabel: "Tuning options",
		head: ctx => (
			<>
				<TunerHead ctx={ctx} entry={entry} />
				<ScanHoldRow />
			</>
		),
		panel: () => <TunerPanel entry={entry} />,
	}
}
