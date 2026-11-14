import "./panel.css"

// The list panels' shell parts (Activity, Recordings): the notice slot under the filters, the thin
// progress line under the header, the first-load placeholder and the failed-load state. The states and
// their order are panel-state.ts; the words are the panel's.
import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { retryText } from "./panel-state.ts"
import { Skeleton } from "./Skeleton.tsx"

/**
 * The one notice under the filters: a polite live region that is always mounted (so a change is
 * announced once), empty when there is nothing to say.
 */
export function PanelNotice({
	tone,
	children,
	action,
}: {
	tone?: "warn" | undefined
	children?: ReactNode
	action?: { label: string; run: () => void } | undefined
}) {
	const empty =
		children === undefined || children === null || children === false
	return (
		<div
			className="wk-panel-notice"
			role="status"
			aria-live="polite"
			data-tone={tone}
			data-empty={empty || undefined}
		>
			{!empty && <span className="wk-panel-notice-text">{children}</span>}
			{!empty && action && (
				<button
					type="button"
					className="wk-btn"
					data-variant="outline"
					data-size="sm"
					onClick={action.run}
				>
					{action.label}
				</button>
			)}
		</div>
	)
}

/** The thin line under the header while rows are on screen and a read runs. */
export function PanelProgress({ on }: { on: boolean }) {
	return (
		<span
			className="wk-panel-progress"
			data-on={on || undefined}
			aria-hidden="true"
		/>
	)
}

/** The first load: the skeleton, which says the core is busy once a read runs past 3 s. */
export function PanelLoading({
	label,
	busy,
	round,
}: {
	label: string
	busy: boolean
	round?: boolean
}) {
	return <Skeleton label={label} busy={busy} {...(round ? { round } : {})} />
}

/** A failed first load: what failed in plain words, Try again, and when it tries by itself. */
export function PanelFailed({
	title,
	text,
	retryAt,
	onRetry,
	icon,
}: {
	title: string
	text: string
	retryAt: number | null
	onRetry: () => void
	icon?: ReactNode
}) {
	const retry = useRetryText(retryAt)
	return (
		<div className="wk-panel-failed" role="alert">
			{icon && <span className="wk-panel-failed-icon">{icon}</span>}
			<span className="wk-panel-failed-title">{title}</span>
			<span className="wk-panel-failed-text">{text}</span>
			<button
				type="button"
				className="wk-btn"
				data-variant="outline"
				data-size="lg"
				onClick={onRetry}
			>
				Try again
			</button>
			{retry && <span className="wk-panel-failed-retry">{retry}</span>}
		</div>
	)
}

/** "Trying again in 8 s", ticking each second while a retry is planned. */
export function useRetryText(retryAt: number | null): string | null {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (retryAt === null) return
		setNow(Date.now())
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [retryAt])
	return retryText(retryAt, now)
}
