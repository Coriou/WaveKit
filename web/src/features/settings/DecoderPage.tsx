// A decoder page's header and Status block (DESIGN.md "Decoder pages, generated"): tool and where it listens, its
// state, then running for, messages, last message and the last error, with Restart (Start again when stopped) and
// Show log (GET /api/decoders/:id/log).
import { useState } from "react"
import type { DecoderInfo, DecoderLogLine } from "@wavekit/api-types"

import { useServices } from "../../app/context.ts"
import { errorMessage } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { decoderTone, decoderWhere } from "./decoder-rows.ts"
import { SetIcon } from "./icons.tsx"

const STATE_LABEL = {
	run: "Running",
	idle: "Idle",
	fault: "Stopped",
	off: "Off",
} as const

export function DecoderPageHead({ decoder }: { decoder: DecoderInfo }) {
	const tone = decoderTone(decoder)
	return (
		<div className="wkf-set-dechead">
			<span className="wk-tile" data-tone={tone}>
				<SetIcon name="decoders" size={20} strokeWidth={1.8} />
			</span>
			<span className="wkf-grow wkf-set-dec-text">
				<b className="wkf-ellipsis">
					{decoder.version
						? `${decoder.type} ${decoder.version}`
						: decoder.type}
				</b>
				<span className="wkf-ellipsis wkf-set-quiet wkf-num">
					{decoderWhere(decoder)}
				</span>
			</span>
			<span className="wk-tag wkf-set-pill" data-size="md" data-tone={tone}>
				<span aria-hidden="true" className="wkf-set-dot" />
				{STATE_LABEL[tone]}
			</span>
		</div>
	)
}

export function formatUptime(seconds: number): string {
	const s = Math.max(0, Math.round(seconds))
	if (s < 60) return `${s} s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m} min`
	const h = Math.floor(m / 60)
	if (h < 48) return `${h} h ${m % 60} min`
	return `${Math.floor(h / 24)} days`
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return "Never"
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return "—"
	const s = Math.round((now - t) / 1000)
	if (s < 5) return "now"
	if (s < 60) return `${s} s ago`
	if (s < 3600) return `${Math.round(s / 60)} min ago`
	if (s < 86_400) return `${Math.round(s / 3600)} h ago`
	return `${Math.round(s / 86_400)} days ago`
}

export function DecoderStatus({
	decoder,
	readOnly,
}: {
	decoder: DecoderInfo
	readOnly: boolean
}) {
	const { data } = useServices()
	const [busy, setBusy] = useState(false)
	const [log, setLog] = useState<DecoderLogLine[] | null>(null)
	const [logError, setLogError] = useState<string | null>(null)
	const tone = decoderTone(decoder)
	const stopped = !decoder.running
	const fault =
		decoder.health === "faulted" ||
		(stopped && decoder.desiredRunning !== false)
			? (decoder.lastError?.message ?? null)
			: null
	const stats = [
		{ k: "Running for", v: stopped ? "—" : formatUptime(decoder.uptime) },
		{ k: "Messages", v: decoder.stats.eventsOut.toLocaleString("en") },
		{ k: "Last message", v: ago(decoder.lastOutputAt) },
	]
	const restart = async () => {
		setBusy(true)
		const result = await data.decoderSettings.action(
			decoder.id,
			stopped ? "start" : "restart",
		)
		setBusy(false)
		if (!result.ok) showAppToast(result.message, { tone: "warn" })
	}
	const showLog = async () => {
		if (log) {
			setLog(null)
			return
		}
		try {
			setLog(await data.decoderSettings.log(decoder.id))
			setLogError(null)
		} catch (error) {
			setLogError(errorMessage(error))
		}
	}
	return (
		<div className="wkf-set-status">
			<div className="wk-label">Status</div>
			{fault && (
				<div role="alert" className="wkf-set-fault">
					<SetIcon name="warn" size={16} />
					<span>{fault}</span>
				</div>
			)}
			<div className="wkf-set-stats">
				{stats.map(s => (
					<div key={s.k}>
						<span>{s.k}</span>
						<b
							className="wkf-num wkf-ellipsis"
							data-tone={s.k === "Running for" ? tone : undefined}
						>
							{s.v}
						</b>
					</div>
				))}
			</div>
			<div className="wkf-set-btns">
				<button
					type="button"
					className="wk-btn"
					data-variant="outline"
					data-size="lg"
					disabled={busy || readOnly}
					onClick={() => void restart()}
				>
					<SetIcon name="restart" size={15} />
					{stopped ? "Start again" : "Restart"}
				</button>
				<button
					type="button"
					className="wk-btn"
					data-variant="ghost"
					data-size="lg"
					aria-expanded={log !== null}
					onClick={() => void showLog()}
				>
					{log ? "Hide log" : "Show log"}
				</button>
			</div>
			{logError && (
				<div className="wkf-set-note">
					<span data-tone="danger">{logError}</span>
				</div>
			)}
			{log && (
				<pre className="wkf-set-log wk-scroll" aria-label={`${decoder.id} log`}>
					{log.length === 0
						? "Nothing in the log yet."
						: log
								.map(l => (l.stream === "stderr" ? `! ${l.line}` : l.line))
								.join("\n")}
				</pre>
			)}
		</div>
	)
}
