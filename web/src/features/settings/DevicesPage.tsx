// Settings › Signed-in devices (System): the browsers and apps a protected core remembers. This browser first, with
// its name, kind and Sign out; then the others, each signed out with Undo; then Sign out everywhere and the way back
// in from the receiver when every device is lost. Layout follows Band plans (sections, rows, quiet notes).
import { useEffect, useRef, useState } from "react"
import type { AccessDeviceDto, AccessDeviceKind } from "@wavekit/api-types"
import { ACCESS_DEVICES_LIMITS } from "@wavekit/api-types"

import { useServices } from "../../app/context.ts"
import { errorMessage, useStore } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Skeleton } from "../../ui/Skeleton.tsx"
import { useNow } from "../hooks.ts"
import {
	KIND_ICON,
	KIND_OPTIONS,
	deviceSub,
	deviceTitle,
	devicesCount,
} from "./devices.ts"
import { SetIcon } from "./icons.tsx"

export function DevicesPage({ onSignedOut }: { onSignedOut: () => void }) {
	const { data } = useServices()
	const store = data.devices
	const devices = useStore(store, s => s.devices)
	const loading = useStore(store, s => s.loading)
	const error = useStore(store, s => s.error)
	const removing = useStore(store, s => s.removing)
	const now = useNow(true, 60_000)
	const [editing, setEditing] = useState<string | null>(null)
	const [confirm, setConfirm] = useState<"self" | "all" | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		void store.load()
		// a sign-out still waiting for Undo goes out when Settings closes
		return () => store.flushRevokes()
	}, [store])

	if (!devices)
		return (
			<div className="wkf-bp">
				{loading ? (
					<Skeleton rows={3} label="devices" />
				) : (
					<p className="wkf-bp-lock">
						{error
							? `Could not read the devices: ${error}`
							: "Pair this browser to see the devices signed in to this WaveKit."}
					</p>
				)}
			</div>
		)

	const me = devices.find(d => d.current)
	const others = devices.filter(d => !d.current && !removing.has(d.deviceId))

	const signOut = async (all: boolean) => {
		setBusy(true)
		try {
			if (all) await data.revokeAllDevices()
			else await data.logout()
			showAppToast(
				all
					? "Every device is signed out. This browser can watch until it is paired again."
					: "This browser is signed out. It can watch until it is paired again.",
			)
			onSignedOut()
		} catch (e) {
			showAppToast(`Could not sign out: ${errorMessage(e)}`, { tone: "warn" })
			setBusy(false)
			setConfirm(null)
		}
	}

	const revoke = (d: AccessDeviceDto) => {
		const title = deviceTitle(d)
		const undo = store.scheduleRevoke(d.deviceId, e =>
			showAppToast(`Could not sign out “${title}”: ${errorMessage(e)}`, {
				tone: "warn",
			}),
		)
		showAppToast(`Signed out “${title}”`, { undo })
	}

	return (
		<div className="wkf-bp wkf-dv">
			<p className="wkf-bp-desc">
				Browsers and apps paired with this WaveKit. Each stays signed in until
				it is signed out here or its session runs out unused.
			</p>
			{error && <p className="wkf-bp-lock">Could not refresh: {error}</p>}

			<Section first label="This browser" />
			{me && (
				<DeviceRow
					device={me}
					now={now}
					editing={editing === me.deviceId}
					onEdit={() => setEditing(me.deviceId)}
					onDone={() => setEditing(null)}
				>
					{confirm === "self" ? null : (
						<button
							type="button"
							className="wk-btn wkf-dv-out"
							data-variant="outline"
							onClick={() => setConfirm("self")}
						>
							<SetIcon name="logout" size={15} />
							Sign out
						</button>
					)}
				</DeviceRow>
			)}
			{confirm === "self" && (
				<Confirm
					text="Sign this browser out? It can still watch, but tuning, scans and settings need a new pairing code from the receiver."
					action="Sign out"
					busy={busy}
					onCancel={() => setConfirm(null)}
					onConfirm={() => void signOut(false)}
				/>
			)}

			<Section
				label={`Other devices · ${others.length}`}
				desc={`Up to ${ACCESS_DEVICES_LIMITS.maxDevices} devices stay paired at once.`}
			/>
			{others.length === 0 ? (
				<p className="wkf-dv-empty">No other device is paired.</p>
			) : (
				others.map(d => (
					<DeviceRow
						key={d.deviceId}
						device={d}
						now={now}
						editing={editing === d.deviceId}
						onEdit={() => setEditing(d.deviceId)}
						onDone={() => setEditing(null)}
					>
						<button
							type="button"
							className="wk-btn wkf-dv-out"
							data-variant="outline"
							aria-label={`Sign out ${deviceTitle(d)}`}
							onClick={() => revoke(d)}
						>
							Sign out
						</button>
					</DeviceRow>
				))
			)}

			<Section
				label="Everywhere"
				desc="For a lost phone or a shared computer: every device, this browser too, needs a new code to pair again."
			/>
			{confirm === "all" ? (
				<Confirm
					text={`Sign out ${devicesCount(devices.length - removing.size)}, this browser too?`}
					action="Sign out all"
					busy={busy}
					onCancel={() => setConfirm(null)}
					onConfirm={() => void signOut(true)}
				/>
			) : (
				<div className="wkf-dv-all">
					<button
						type="button"
						className="wk-btn"
						data-variant="danger"
						onClick={() => setConfirm("all")}
					>
						<SetIcon name="logout" size={15} />
						Sign out everywhere
					</button>
				</div>
			)}
			<p className="wkf-dv-note">
				Locked out of every device? On the receiver,{" "}
				<code>node dist/access-command.js devices revoke-all --yes</code> signs
				them all out, and <code>node dist/access-command.js pair</code> gives a
				new code.
			</p>
		</div>
	)
}

function Section({
	label,
	desc,
	first,
}: {
	label: string
	desc?: string
	first?: boolean
}) {
	return (
		<div className="wkf-bp-sec" data-first={first || undefined}>
			<span className="wkf-grow">
				<span className="wk-label">{label}</span>
				{desc && <span className="wkf-set-help">{desc}</span>}
			</span>
		</div>
	)
}

function Confirm({
	text,
	action,
	busy,
	onCancel,
	onConfirm,
}: {
	text: string
	action: string
	busy: boolean
	onCancel: () => void
	onConfirm: () => void
}) {
	const cancel = useRef<HTMLButtonElement>(null)
	useEffect(() => cancel.current?.focus(), [])
	return (
		<div
			className="wkf-dv-confirm"
			role="group"
			aria-label={action}
			onKeyDown={e => {
				if (e.key === "Escape") {
					e.stopPropagation()
					onCancel()
				}
			}}
		>
			<p>{text}</p>
			<span className="wkf-dv-confirm-btns">
				<button
					ref={cancel}
					type="button"
					className="wk-btn"
					data-variant="ghost"
					disabled={busy}
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className="wk-btn"
					data-variant="danger"
					disabled={busy}
					onClick={onConfirm}
				>
					{busy ? "Signing out…" : action}
				</button>
			</span>
		</div>
	)
}

function DeviceRow({
	device: d,
	now,
	editing,
	onEdit,
	onDone,
	children,
}: {
	device: AccessDeviceDto
	now: number
	editing: boolean
	onEdit: () => void
	onDone: () => void
	children?: React.ReactNode
}) {
	const title = deviceTitle(d)
	return (
		<div className="wk-row wkf-dv-row" data-device={d.deviceId}>
			<span className="wk-tile">
				<SetIcon name={KIND_ICON[d.kind ?? "browser"]} size={16} />
			</span>
			{editing ? (
				<LabelEditor device={d} onDone={onDone} />
			) : (
				<>
					<span className="wkf-grow wkf-dv-text">
						<span className="wkf-dv-name">
							<b>{title}</b>
							{d.current && <span className="wk-tag">This browser</span>}
						</span>
						<span className="wkf-dv-sub">{deviceSub(d, now)}</span>
					</span>
					<span className="wkf-dv-btns">
						<button
							type="button"
							className="wk-btn wkf-dv-icon"
							data-variant="ghost"
							aria-label={`Rename ${title}`}
							title="Rename"
							onClick={onEdit}
						>
							<SetIcon name="pencil" size={15} />
						</button>
						{children}
					</span>
				</>
			)}
		</div>
	)
}

function LabelEditor({
	device: d,
	onDone,
}: {
	device: AccessDeviceDto
	onDone: () => void
}) {
	const { data } = useServices()
	const [name, setName] = useState(d.name ?? "")
	const [kind, setKind] = useState<AccessDeviceKind>(d.kind ?? "browser")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		input.current?.focus()
		input.current?.select()
	}, [])

	const save = async () => {
		const trimmed = name.trim()
		const patch: { name?: string | null; kind?: AccessDeviceKind } = {}
		if (trimmed !== (d.name ?? "")) patch.name = trimmed || null
		if (kind !== d.kind) patch.kind = kind
		if (patch.name === undefined && patch.kind === undefined) {
			onDone()
			return
		}
		setBusy(true)
		setError(null)
		try {
			await data.devices.label(d.deviceId, patch)
			onDone()
		} catch (e) {
			setError(errorMessage(e))
			setBusy(false)
		}
	}

	return (
		<form
			className="wkf-grow wkf-dv-edit"
			onSubmit={e => {
				e.preventDefault()
				void save()
			}}
			onKeyDown={e => {
				if (e.key === "Escape") {
					e.stopPropagation()
					onDone()
				}
			}}
		>
			<span className="wkf-dv-edit-line">
				<input
					ref={input}
					className="wk-input wkf-grow"
					aria-label="Device name"
					placeholder={deviceTitle({ name: null, kind })}
					maxLength={ACCESS_DEVICES_LIMITS.nameMaxLength}
					value={name}
					onChange={e => setName(e.target.value)}
				/>
				<select
					className="wk-select"
					aria-label="Kind of device"
					value={kind}
					onChange={e => setKind(e.target.value as AccessDeviceKind)}
				>
					{KIND_OPTIONS.map(o => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</span>
			{error && (
				<span role="alert" className="wkf-dv-err">
					{error}
				</span>
			)}
			<span className="wkf-dv-edit-btns">
				<button
					type="button"
					className="wk-btn"
					data-variant="ghost"
					onClick={onDone}
				>
					Cancel
				</button>
				<button
					type="submit"
					className="wk-btn"
					data-variant="primary"
					disabled={busy}
				>
					{busy ? "Saving…" : "Save"}
				</button>
			</span>
		</form>
	)
}
