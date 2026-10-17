// Band plans › Import (Settings.dc.html, the sheet over the drawer; a bottom sheet on a phone): choose a file or
// paste an address, check the preview (groups, bands, imported colours), then add it to the bottom of the stack.
// Solid surface, no blur. The core reads the file; nothing is kept until "Add to stack".
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type {
	BandPlanImportFormat,
	DisplayGroup,
	ImportPreview,
	ImportUrlPreview,
} from "@wavekit/api-types"
import { BANDPLANS_LIMITS, DISPLAY_GROUPS } from "@wavekit/api-types"

import { useServices } from "../../../app/context.ts"
import type { ImportFile } from "../../../data/index.ts"
import { bandplanWriteError, useStore } from "../../../data/index.ts"
import { showAppToast } from "../../../shell/toast.ts"
import { groupColour, groupName } from "../../tuner/band.ts"
import { SetIcon } from "../icons.tsx"
import { FORMAT_NAME, edgesText, shortUrl } from "./model.ts"

const PREVIEW_ROWS = 6

/** The format a file name or address says: .json SDR++, .xml SDR#, .csv Gqrx. */
export function formatOf(name: string): BandPlanImportFormat | null {
	const n = name.toLowerCase().replace(/[?#].*$/, "")
	if (n.endsWith(".json")) return "sdrpp-json"
	if (n.endsWith(".xml")) return "sdrsharp-xml"
	if (n.endsWith(".csv")) return "gqrx-csv"
	return null
}

function toBase64(bytes: Uint8Array): string {
	let s = ""
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(s)
}

type Read =
	| { kind: "file"; file: ImportFile; preview: ImportPreview }
	| { kind: "url"; file: ImportFile; preview: ImportUrlPreview }

export function ImportSheet({
	host,
	phone,
	onClose,
}: {
	host: HTMLElement
	phone: boolean
	onClose: () => void
}) {
	const { data } = useServices()
	const stack = data.bandplanStack
	const view = useStore(stack, s => s.view)
	const [url, setUrl] = useState("")
	const [read, setRead] = useState<Read | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [all, setAll] = useState(false)
	const [colours, setColours] = useState(false)
	const fileRef = useRef<HTMLInputElement>(null)
	const box = useRef<HTMLDivElement>(null)
	const formats = view?.capabilities.importFormats ?? []
	const hosts = view?.capabilities.urlImportHosts ?? []

	useEffect(() => {
		box.current?.querySelector<HTMLElement>("[data-close]")?.focus()
	}, [read])

	const accepts = (f: BandPlanImportFormat | null): f is BandPlanImportFormat =>
		f !== null && formats.includes(f)
	const formatError = () =>
		`WaveKit reads ${formats.map(f => FORMAT_NAME[f]).join(", ")} files here.`

	const pickFile = async (file: File) => {
		const format = formatOf(file.name)
		if (!accepts(format)) return setError(formatError())
		if (file.size > BANDPLANS_LIMITS.importFileBytes)
			return setError("That file is larger than 1 MB.")
		setBusy(true)
		setError(null)
		try {
			const bytes = new Uint8Array(await file.arrayBuffer())
			const f: ImportFile = {
				format,
				fileName: file.name.slice(0, 128),
				contentBase64: toBase64(bytes),
				groupOverrides: [],
			}
			setRead({ kind: "file", file: f, preview: await stack.previewFile(f) })
			setAll(false)
		} catch (e) {
			setError(bandplanWriteError(e))
		} finally {
			setBusy(false)
		}
	}

	const readUrl = async () => {
		const u = url.trim()
		if (!/^https:\/\/\S+\.\S+/.test(u))
			return setError(
				"Paste the address of a plan file, starting with https://",
			)
		const format = formatOf(u)
		if (!accepts(format)) return setError(formatError())
		setBusy(true)
		setError(null)
		try {
			const preview = await stack.previewUrl(u, format)
			setRead({
				kind: "url",
				preview,
				file: {
					format,
					fileName: preview.fileName,
					contentBase64: preview.contentBase64,
					groupOverrides: [],
				},
			})
			setAll(false)
		} catch (e) {
			setError(bandplanWriteError(e))
		} finally {
			setBusy(false)
		}
	}

	const preview = read?.preview ?? null
	/** An import of the same file or address: adding it again replaces that copy. */
	const again = useMemo(() => {
		if (!preview || !view) return null
		const src = read?.kind === "url" ? read.preview.sourceUrl : null
		return (
			view.packs.find(
				p =>
					p.provenance.kind === "imported" &&
					(p.provenance.sha256 === preview.sha256 ||
						(src !== null && p.provenance.sourceUrl === src)),
			) ?? null
		)
	}, [preview, read, view])
	const name =
		preview?.meta.name ??
		again?.name ??
		preview?.fileName.replace(/\.[a-z]+$/i, "") ??
		""

	const add = async () => {
		if (!read) return
		setBusy(true)
		try {
			await stack.commitImport({
				preview: read.preview,
				file: read.file,
				name: name.slice(0, 80) || null,
				keepColourHints: colours,
				replacesPackId: again?.id ?? null,
			})
			showAppToast(
				again
					? `${name} replaced and turned on`
					: `${name} added at the bottom of the stack`,
			)
			onClose()
		} catch (e) {
			setError(bandplanWriteError(e))
			setBusy(false)
		}
	}

	const groups = useMemo(() => {
		if (!preview) return []
		const n = new Map<DisplayGroup, number>()
		for (const b of preview.bands) n.set(b.group, (n.get(b.group) ?? 0) + 1)
		return DISPLAY_GROUPS.filter(g => n.has(g)).map(g => ({
			g,
			n: n.get(g) ?? 0,
		}))
	}, [preview])

	const title = preview ? "Check the import" : "Import a band plan"
	const src =
		read?.kind === "url"
			? `From ${shortUrl(read.preview.sourceUrl)}`
			: preview
				? `From ${preview.fileName}`
				: ""
	const meta = preview
		? [
				FORMAT_NAME[preview.format],
				`${preview.bands.length} band${preview.bands.length === 1 ? "" : "s"}`,
				preview.meta.author ? `by ${preview.meta.author}` : "",
			]
				.filter(Boolean)
				.join(" · ")
		: ""
	const skipped = preview?.report.skipped.reduce((n, s) => n + s.count, 0) ?? 0

	return createPortal(
		<>
			<div className="wkf-bp-sheetscrim" aria-hidden="true" onClick={onClose} />
			<div
				ref={box}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="wk-rise wkf-bp-sheet"
				data-phone={phone || undefined}
				onKeyDown={e => {
					if (e.key === "Escape") {
						e.preventDefault()
						e.stopPropagation()
						onClose()
					}
				}}
			>
				<div
					className="wkf-bp-sheethead"
					data-back={preview ? true : undefined}
				>
					{preview && (
						<button
							type="button"
							className="wk-icon-btn"
							data-size="lg"
							aria-label="Back to choosing a file"
							onClick={() => {
								setRead(null)
								setError(null)
								setBusy(false)
							}}
						>
							<SetIcon name="chevron-left" size={18} />
						</button>
					)}
					<h3 className="wk-h3 wkf-grow wkf-ellipsis">{title}</h3>
					<button
						type="button"
						className="wk-icon-btn"
						data-close=""
						aria-label="Close"
						onClick={onClose}
					>
						<SetIcon name="x" size={16} />
					</button>
				</div>
				<div className="wk-scroll wkf-bp-sheetbody">
					{!preview ? (
						<div className="wkf-bp-sheetcol">
							<p className="wkf-bp-desc">
								A band plan from SDR++, SDR# or Gqrx. It joins your stack as
								community data, not checked.
							</p>
							<input
								ref={fileRef}
								type="file"
								accept=".json,.xml,.csv"
								hidden
								onChange={e => {
									const f = e.target.files?.[0]
									e.target.value = ""
									if (f) void pickFile(f)
								}}
							/>
							<button
								type="button"
								className="wkf-bp-pick"
								disabled={busy}
								onClick={() => fileRef.current?.click()}
							>
								<span className="wkf-bp-pickicon">
									<SetIcon name="upload" size={18} strokeWidth={1.9} />
								</span>
								<span className="wkf-grow wkf-set-dec-text">
									<b>Choose a file</b>
									<span className="wkf-set-quiet">
										{formats.map(f => FORMAT_NAME[f]).join(", ")}
									</span>
								</span>
							</button>
							{hosts.length > 0 && (
								<>
									<div className="wkf-bp-or" aria-hidden="true">
										<span />
										or
										<span />
									</div>
									<div className="wkf-bp-sheetcol" data-gap="8">
										<label htmlFor="wkf-bp-url" className="wkf-bp-label">
											From a URL
										</label>
										<div className="wkf-bp-urlrow">
											<input
												id="wkf-bp-url"
												className="wk-input wk-box wk-tall wkf-grow"
												value={url}
												onChange={e => setUrl(e.target.value)}
												onKeyDown={e => {
													if (e.key === "Enter") void readUrl()
												}}
												placeholder="https://…/International.csv"
												spellCheck={false}
												autoComplete="off"
												inputMode="url"
											/>
											<button
												type="button"
												className="wk-btn wk-tall wkf-bp-secbtn"
												data-variant="outline"
												data-size="lg"
												disabled={busy}
												onClick={() => void readUrl()}
											>
												{busy ? "Reading…" : "Read"}
											</button>
										</div>
										<span className="wkf-set-help">
											Your WaveKit fetches it once and keeps the address, so you
											can check for an update by hand. It never updates on its
											own. It reads from {hosts.join(", ")}.
										</span>
									</div>
								</>
							)}
							{error && (
								<p role="alert" className="wkf-bp-err">
									{error}
								</p>
							)}
						</div>
					) : (
						<div className="wkf-bp-sheetcol" data-gap="16">
							<div className="wkf-set-dec-text">
								<span className="wkf-bp-planname">
									<b className="wkf-bp-pvname">{name}</b>
									<span className="wk-tag wkf-bp-comm" data-variant="outline">
										Community, unverified
									</span>
								</span>
								<span className="wkf-num">{meta}</span>
								<span className="wkf-set-quiet wkf-bp-src">{src}</span>
							</div>
							{again && (
								<div className="wkf-bp-note">
									You imported this before. Adding it again replaces that copy
									and turns it on.
								</div>
							)}
							{skipped > 0 && (
								<div className="wkf-bp-note">
									{skipped} row{skipped === 1 ? "" : "s"} of the file could not
									be read and stay out.
								</div>
							)}
							<div>
								<div className="wk-label">Groups</div>
								<div className="wkf-bp-pvline wkf-num">
									{preview.report.mapped} mapped to groups,{" "}
									{preview.report.toOther} to Other
								</div>
								<div className="wkf-bp-groups">
									{groups.map(({ g, n }) => (
										<span key={g} className="wkf-num">
											<span
												aria-hidden="true"
												className="wkf-bp-sw"
												style={{ background: groupColour(g) }}
											/>
											<span className="wkf-grow">{groupName(g)}</span>
											<span className="wkf-set-quiet">{n}</span>
										</span>
									))}
								</div>
							</div>
							<div>
								<div className="wk-label">Bands</div>
								<div className="wkf-bp-pvbands">
									{(all
										? preview.bands
										: preview.bands.slice(0, PREVIEW_ROWS)
									).map(b => (
										<span key={b.id}>
											<span
												aria-hidden="true"
												className="wkf-bp-sw"
												style={{ background: groupColour(b.group) }}
											/>
											<span className="wkf-grow wkf-ellipsis">
												{b.name}
												<span className="wkf-set-quiet">
													{" "}
													· {groupName(b.group)}
												</span>
											</span>
											<span className="wkf-set-quiet wkf-num">
												{edgesText(b.startHz, b.endHz)}
											</span>
										</span>
									))}
								</div>
								{!all && preview.bands.length > PREVIEW_ROWS && (
									<button
										type="button"
										className="wk-btn wkf-bp-showall wkf-num"
										data-variant="ghost"
										onClick={() => setAll(true)}
									>
										Show all {preview.bands.length}
									</button>
								)}
							</div>
							<div className="wkf-bp-colours">
								<span className="wkf-grow">
									<b id="wkf-bp-col">Use imported colours</b>
									<span className="wkf-set-help">
										{preview.report.colourHints
											? "Off, each band takes its group’s colour. The file’s colours are only a hint."
											: "This file carries no colours: each band takes its group’s colour."}
									</span>
								</span>
								<button
									type="button"
									role="switch"
									className="wk-switch"
									data-size="row"
									aria-checked={colours}
									aria-labelledby="wkf-bp-col"
									disabled={!preview.report.colourHints}
									onClick={() => setColours(c => !c)}
								/>
							</div>
							{error && (
								<p role="alert" className="wkf-bp-err">
									{error}
								</p>
							)}
						</div>
					)}
				</div>
				{preview && (
					<div className="wkf-bp-sheetfoot">
						<span className="wkf-set-help wkf-grow">
							Goes to the bottom of the stack, so it only names what the others
							leave out.
						</span>
						<span className="wkf-bp-updbtns">
							<button
								type="button"
								className="wk-btn wk-tall"
								data-variant="ghost"
								data-size="lg"
								onClick={onClose}
							>
								Cancel
							</button>
							<button
								type="button"
								className="wk-btn wk-tall"
								data-variant="primary"
								data-size="lg"
								disabled={busy}
								onClick={() => void add()}
							>
								{busy ? "Adding…" : "Add to stack"}
							</button>
						</span>
					</div>
				)}
			</div>
		</>,
		host,
	)
}
