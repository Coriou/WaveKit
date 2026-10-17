// Pair this browser: the one-time code from `node dist/access-command.js pair …` (or the CLI), an optional
// name for Settings › Devices, then the core sets the session cookie and the app reloads with controls on.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ACCESS_PAIRING_CODE } from "@wavekit/api-types"

import { useServices } from "../../app/context.ts"
import { isApiError } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button, Icon, IconButton, Input } from "../../ui/index.ts"
import { pairError } from "./notice.ts"

export function PairSheet({ onClose }: { onClose: () => void }) {
	const { data } = useServices()
	const [code, setCode] = useState("")
	const [name, setName] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const input = useRef<HTMLInputElement>(null)

	useEffect(() => input.current?.focus(), [])

	const trimmed = code.trim()
	const valid = ACCESS_PAIRING_CODE.test(trimmed)
	const submit = async () => {
		if (!valid || busy) return
		setBusy(true)
		setError(null)
		try {
			const label = name.trim()
			await data.pair({
				code: trimmed.toUpperCase(),
				...(label ? { name: label.slice(0, 64) } : {}),
				kind: "browser",
			})
			showAppToast("This browser is paired")
			onClose()
		} catch (e) {
			setError(pairError(isApiError(e) ? e.code : null, isApiError(e)))
			setBusy(false)
		}
	}

	return createPortal(
		<>
			<div className="wkf-pair-scrim" aria-hidden="true" onClick={onClose} />
			<div
				className="wkf-pair-sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby="wkf-pair-title"
				onKeyDown={e => {
					if (e.key === "Escape") {
						e.stopPropagation()
						onClose()
					}
				}}
			>
				<div className="wkf-pair-head">
					<b id="wkf-pair-title" className="wkf-grow">
						Pair this browser
					</b>
					<IconButton label="Close" close onClick={onClose}>
						<Icon name="close" />
					</IconButton>
				</div>
				<form
					className="wkf-pair-body"
					onSubmit={e => {
						e.preventDefault()
						void submit()
					}}
				>
					<p className="wkf-quiet">
						Until it is paired, this browser can watch but not tune, scan or
						change settings. Ask for a one-time code on the receiver:{" "}
						<code>node dist/access-command.js pair</code>. A code lasts 10
						minutes.
					</p>
					<label className="wkf-pair-label" htmlFor="wkf-pair-code">
						Code
					</label>
					<Input
						id="wkf-pair-code"
						ref={input}
						className="wkf-num"
						placeholder="ABCDE-FGHIJ"
						autoComplete="one-time-code"
						autoCapitalize="characters"
						spellCheck={false}
						maxLength={11}
						value={code}
						onChange={e => setCode(e.target.value)}
					/>
					<label className="wkf-pair-label" htmlFor="wkf-pair-name">
						Name <span className="wkf-quiet">(optional)</span>
					</label>
					<Input
						id="wkf-pair-name"
						placeholder="Kitchen tablet"
						maxLength={64}
						value={name}
						onChange={e => setName(e.target.value)}
					/>
					{error && (
						<p role="alert" className="wkf-pair-err">
							{error}
						</p>
					)}
					<div className="wkf-pair-actions">
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={!valid || busy}>
							{busy ? "Pairing…" : "Pair"}
						</Button>
					</div>
				</form>
			</div>
		</>,
		document.body,
	)
}
