// The JSON viewer (Json board): line numbers, keys that recede and numbers in the accent, Wrap, Copy and Copy one line.
// Never amber or red in here: those are state colours.
import type { JsonValue } from "@wavekit/api-types"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "../../ui/Button.tsx"
import { cx } from "../../ui/cx.ts"
import { jsonLines, jsonMeta, MAX_LINES } from "./json.ts"

const CHECK = "M5 12l5 5l10 -10"
const COPY =
	"M8 10a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2zM16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"

export interface JsonViewProps {
	data: JsonValue
	maxHeight?: number
	className?: string
}

export function JsonView({ data, maxHeight = 260, className }: JsonViewProps) {
	const text = useMemo(() => JSON.stringify(data, null, 2) ?? "null", [data])
	const { lines, total } = useMemo(() => jsonLines(text), [text])
	const [wrap, setWrap] = useState(true)
	const [copied, setCopied] = useState<"" | "pretty" | "line" | "failed">("")
	const timer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(timer.current), [])

	const write = (value: string, which: "pretty" | "line") => {
		const done = (state: typeof copied) => {
			setCopied(state)
			window.clearTimeout(timer.current)
			timer.current = window.setTimeout(() => setCopied(""), 1600)
		}
		if (!navigator.clipboard) {
			done("failed")
			return
		}
		navigator.clipboard.writeText(value).then(
			() => done(which),
			() => done("failed"),
		)
	}

	const copyLabel =
		copied === "pretty"
			? "Copied"
			: copied === "line"
				? "Copied line"
				: copied === "failed"
					? "Copy blocked"
					: "Copy"

	return (
		<div className={cx("wkd-json", className)}>
			<div className="wkd-json-bar">
				<span className="wkd-json-title">JSON</span>
				<span className="wkd-json-meta">{jsonMeta(text, total)}</span>
				<span className="wkd-grow" />
				<Button
					variant="ghost"
					size="sm"
					className="wkd-json-btn"
					aria-pressed={wrap}
					onClick={() => setWrap(!wrap)}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4l2 -2m0 4l-2 -2M4 18h5" />
					</svg>
					Wrap
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="wkd-json-btn"
					onClick={() => write(JSON.stringify(data) ?? "null", "line")}
				>
					Copy one line
				</Button>
				<Button
					size="sm"
					className="wkd-copy"
					data-state={
						copied === "" ? "idle" : copied === "failed" ? "failed" : "done"
					}
					onClick={() => write(text, "pretty")}
					aria-live="polite"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d={copied === "pretty" || copied === "line" ? CHECK : COPY} />
					</svg>
					{copyLabel}
				</Button>
			</div>
			<div
				className="wkd-json-body wk-scroll"
				style={{ maxHeight }}
				tabIndex={0}
				aria-label="Decoded JSON"
			>
				<code className="wkd-json-code" data-wrap={wrap ? "" : undefined}>
					{lines.map(l => (
						<div key={l.n} className="wkd-json-line">
							<span className="wkd-json-n" aria-hidden="true">
								{l.n}
							</span>
							<span
								className="wkd-json-text"
								style={{ paddingLeft: `${l.indent}ch` }}
							>
								{l.tokens.map((t, i) => (
									<span key={i} data-k={t.k}>
										{t.s}
									</span>
								))}
							</span>
						</div>
					))}
					{total > MAX_LINES && (
						<div className="wkd-json-more">
							{total - MAX_LINES} more lines. Copy carries them all.
						</div>
					)}
				</code>
			</div>
		</div>
	)
}
