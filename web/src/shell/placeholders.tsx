// Stand-in island contents with the board's collapsed heads, until the slice (lot C5) supplies the real Tuner,
// Receiver, Listen and tuned card. They show the slot API and keep the shell's geometry true to the board.
import { useState, type CSSProperties } from "react"

import { Button } from "../ui/Button.tsx"
import { Chip } from "../ui/Chip.tsx"
import { Icon, Mark } from "../ui/Icon.tsx"
import { IconButton } from "../ui/IconButton.tsx"
import { Island, IslandHead } from "../ui/Island.tsx"
import { Label } from "../ui/Label.tsx"
import { Seg } from "../ui/Seg.tsx"
import { Switch } from "../ui/Switch.tsx"
import type { IslandSlot } from "./ShellIsland.tsx"

const MODES = ["NFM", "AM", "WFM", "USB", "LSB", "CW"] as const
type Mode = (typeof MODES)[number]

function TunerPanel() {
	const [mode, setMode] = useState<Mode>("NFM")
	const [step, setStep] = useState("12.5k")
	return (
		<>
			<Label>Mode</Label>
			<Seg
				label="Mode"
				wide
				options={MODES.map(m => ({ value: m, label: m }))}
				value={mode}
				onChange={setMode}
			/>
			<Label>Step</Label>
			<div className="wk-shell-row" role="group" aria-label="Step">
				{["6.25k", "12.5k", "25k", "100k"].map(s => (
					<Chip
						key={s}
						size="sm"
						pressed={step === s}
						onClick={() => setStep(s)}
					>
						{s}
					</Chip>
				))}
			</div>
		</>
	)
}

export const tunerPlaceholder: IslandSlot = {
	panelLabel: "Tuning options",
	head: ({ open, trigger }) => (
		<IslandHead className="wk-shell-tuner-head">
			<Mark size={26} className="wk-shell-brand" />
			<span className="wk-shell-vsep" aria-hidden="true" />
			<span className="wk-shell-freq" aria-label="Frequency 161.150000 MHz">
				161.150.000
			</span>
			<IconButton label="Type a frequency">
				<Icon name="keyboard" />
			</IconButton>
			<Button
				{...trigger}
				variant="ghost"
				size="lg"
				aria-label="Tuning options"
				className="wk-shell-mode"
			>
				<b>NFM</b> 12.5 kHz
				<Icon
					name="chevron-down"
					size={16}
					className="wk-shell-chev"
					data-open={open || undefined}
				/>
			</Button>
		</IslandHead>
	),
	panel: () => <TunerPanel />,
}

function ReceiverPanel() {
	const [agc, setAgc] = useState(false)
	const [bias, setBias] = useState(false)
	return (
		<>
			<div className="wk-shell-setting">
				<span id="rx-agc">Auto gain</span>
				<Switch aria-labelledby="rx-agc" checked={agc} onChange={setAgc} />
			</div>
			<div className="wk-shell-setting">
				<span id="rx-bias">Bias-T</span>
				<Switch aria-labelledby="rx-bias" checked={bias} onChange={setBias} />
			</div>
		</>
	)
}

export const receiverPlaceholder: IslandSlot = {
	panelLabel: "Receiver",
	head: ({ open, trigger }) => (
		// board: the whole Receiver head is its toggle
		<button
			{...trigger}
			type="button"
			className="wk-island wk-island-head wk-shell-rx-head"
		>
			<span className="wk-shell-dot" aria-hidden="true" />
			<b>Pi receiver</b>
			<span className="wk-shell-sub">2.4 MS/s · 38.6 dB</span>
			<Icon
				name="chevron-down"
				size={16}
				className="wk-shell-chev"
				data-open={open || undefined}
			/>
		</button>
	),
	panel: () => <ReceiverPanel />,
}

type Source = "auto" | "analog" | "voice"

function ListenPanel() {
	const [src, setSrc] = useState<Source>("auto")
	return (
		<>
			<Label>What you hear</Label>
			<Seg
				label="What you hear"
				wide
				options={[
					{ value: "auto", label: "Auto" },
					{ value: "analog", label: "Analog" },
					{ value: "voice", label: "Decoded voice" },
				]}
				value={src}
				onChange={setSrc}
			/>
		</>
	)
}

function ListenHead({
	open,
	trigger,
}: {
	open: boolean
	trigger: Parameters<IslandSlot["head"]>[0]["trigger"]
}) {
	const [on, setOn] = useState(true)
	return (
		<IslandHead className="wk-shell-listen-head">
			<button
				type="button"
				className="wk-shell-listen-btn"
				aria-pressed={on}
				aria-label={on ? "Stop listening" : "Listen"}
				onClick={() => setOn(!on)}
			>
				<Icon name="headphones" size={22} />
			</button>
			<div className="wk-shell-listen-text">
				<div>
					<b>{on ? "Listening" : "Not listening"}</b>{" "}
					<span className="wk-shell-sub">NFM · 161.150</span>
				</div>
				<div className="wk-meter" aria-hidden="true">
					<div
						className="wk-meter-fill"
						style={{ "--wk-level": on ? "0.62" : "0" } as CSSProperties}
					/>
				</div>
			</div>
			<IconButton {...trigger} size="lg" label="Audio options">
				<Icon
					name="chevron-up"
					className="wk-shell-chev"
					data-open={open || undefined}
				/>
			</IconButton>
		</IslandHead>
	)
}

export const listenPlaceholder: IslandSlot = {
	panelLabel: "Audio options",
	head: ctx => <ListenHead open={ctx.open} trigger={ctx.trigger} />,
	panel: () => <ListenPanel />,
}

export function TunedCardPlaceholder() {
	return (
		<Island className="wk-shell-card" role="region" aria-label="Tuned signal">
			<Label>Tuned</Label>
			<div className="wk-shell-card-freq">161.150 MHz</div>
			<div className="wk-shell-sub">DMR · TG 2081 · slot 1</div>
		</Island>
	)
}
