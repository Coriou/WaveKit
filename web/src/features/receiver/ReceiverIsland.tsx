// The Receiver island (docs/web/canvas/Receiver.dc.html), read-only for now: source, sample rate, gain
// (TunerState.gain is in 0.1 dB), AGC and the rest of the tuner state. Controls come with a later lot.
import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { IslandSlot } from "../../shell/ShellIsland.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatMHz, formatRate } from "../format.ts"
import { useTunerState } from "../hooks.ts"
import { gainText, receiverSummary, sourceTitle } from "./summary.ts"

function ReceiverHead({ open, trigger }: Parameters<IslandSlot["head"]>[0]) {
	const { data } = useServices()
	const tuner = useTunerState()
	const source = useStore(data.sources, s =>
		tuner ? s.sources.find(x => x.id === tuner.sourceId) : s.sources[0],
	)
	const connected = source?.connected ?? false
	return (
		<button
			{...trigger}
			type="button"
			className="wk-island wk-island-head wk-shell-rx-head"
		>
			<span
				className="wk-shell-dot wkf-rx-dot"
				data-off={!connected || undefined}
				aria-hidden="true"
			/>
			<b>{sourceTitle(source, tuner)}</b>
			<span className="wk-shell-sub">{receiverSummary(tuner, source)}</span>
			<span className="wk-sr">{connected ? "connected" : "not connected"}</span>
			<Icon
				name="chevron-down"
				size={16}
				className="wk-shell-chev"
				data-open={open || undefined}
			/>
		</button>
	)
}

function ReceiverPanel() {
	const { data } = useServices()
	const tuner = useTunerState()
	const source = useStore(data.sources, s =>
		tuner ? s.sources.find(x => x.id === tuner.sourceId) : s.sources[0],
	)
	const error = useStore(data.tuner, s => s.error)
	const stats: { k: string; v: string }[] = tuner
		? [
				{ k: "Centre", v: `${formatMHz(tuner.frequency)} MHz` },
				{ k: "Sample rate", v: formatRate(tuner.sampleRate) },
				{ k: "Gain", v: gainText(tuner) },
				{ k: "RTL AGC", v: tuner.agcMode ? "On" : "Off" },
				{ k: "Bias-T", v: tuner.biasTee ? "On" : "Off" },
				{ k: "PPM", v: String(tuner.ppm) },
			]
		: []
	return (
		<>
			<div className="wkf-rx-title">
				<div className="wkf-grow">
					<div className="wkf-rx-name">{sourceTitle(source, tuner)}</div>
					<div className="wkf-quiet">
						{[source?.type, source?.url].filter(Boolean).join(" · ") ||
							"Unknown source"}
					</div>
				</div>
				<span
					className="wk-tag"
					data-size="md"
					data-variant={source?.connected ? "accent" : "amber"}
				>
					{source?.connected ? "Connected" : "Offline"}
				</span>
			</div>
			{stats.length > 0 ? (
				<dl className="wkf-rx-stats">
					{stats.map(s => (
						<div key={s.k}>
							<dt>{s.k}</dt>
							<dd>{s.v}</dd>
						</div>
					))}
				</dl>
			) : (
				<span className="wkf-quiet">No tuner-controlled source.</span>
			)}
			{tuner?.controlMode === "external" && (
				<span className="wkf-warn">
					SDR++ controls this receiver: WaveKit does not retune it.
				</span>
			)}
			{source?.lastError && (
				<span className="wkf-warn">{source.lastError}</span>
			)}
			{error && <span className="wkf-warn">{error}</span>}
			<Label>Settings</Label>
			<span className="wkf-quiet wkf-small">
				Sample rate, gain and AGC are read-only here for now. Change them in the
				CLI or the config.
			</span>
		</>
	)
}

export const receiverSlot: IslandSlot = {
	panelLabel: "Receiver",
	head: ctx => <ReceiverHead {...ctx} />,
	panel: () => <ReceiverPanel />,
}
