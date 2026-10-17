// Decoders in Settings (DESIGN.md "Decoder pages, generated"): one row per configured decoder in the group, and a
// page per decoder built from its type's option descriptors (GET /api/decoders/types) and its settings view
// (GET /api/decoders/:id/settings, protected cores only). Patchable keys get a widget by type; the rest are read-only.
// Every option applies when the decoder next starts, so changes wait for Apply. Pure.
import type {
	DecoderInfo,
	DecoderOptionDescriptor,
	DecoderSettingValue,
} from "@wavekit/api-types"

import { decoderLabel } from "../tuned/signal.ts"
import type { SettingsActions, SettingsSnapshot } from "./rows.ts"
import { words } from "./rows.ts"
import {
	optionText,
	type SettingEffect,
	type SettingOption,
	type SettingRow,
	type SettingValue,
	type SettingWidget,
} from "./model.ts"

/** Patchable options shown before the More fold. */
const ESSENTIALS = 5

const ACRONYMS: Readonly<Record<string, string>> = {
	iq: "IQ",
	agc: "AGC",
	fm: "FM",
	am: "AM",
	hz: "Hz",
	khz: "kHz",
	mhz: "MHz",
	db: "dB",
	ppm: "ppm",
	id: "ID",
	ids: "IDs",
	tg: "TG",
	ctcss: "CTCSS",
	dcs: "DCS",
	dmr: "DMR",
	nmea: "NMEA",
	mlat: "MLAT",
	ais: "AIS",
	aprs: "APRS",
	sbs: "SBS",
	json: "JSON",
	udp: "UDP",
	tcp: "TCP",
	psk: "PSK",
	lora: "LoRa",
}

/** "sampleRate" / "sample_rate" → "Sample rate"; a trailing unit word goes ("callTimeoutMs" with unit ms → "Call timeout"). */
export function humanKey(key: string, unit?: string): string {
	let parts = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.trim()
		.split(/\s+/)
	if (unit && parts.length > 1 && parts.at(-1) === unit.toLowerCase())
		parts = parts.slice(0, -1)
	const text = parts.map(w => ACRONYMS[w] ?? w).join(" ")
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function decoderTone(d: DecoderInfo): "run" | "idle" | "fault" | "off" {
	if (d.health === "faulted") return "fault"
	if (!d.running) return d.desiredRunning === false ? "off" : "fault"
	if (d.suspended || d.health === "idle") return "idle"
	return d.health === "restarting" ? "fault" : "run"
}

export function decoderStatusText(d: DecoderInfo): string {
	if (d.health === "faulted")
		return `Stopped · ${d.lastError?.message ?? "it kept failing"}`
	if (d.health === "restarting") return "Restarting"
	if (!d.running) return d.desiredRunning === false ? "Stopped" : "Not running"
	if (d.suspended) return "Paused · outside the capture"
	const rate = d.rateHistory?.at(-2)
	if (rate !== undefined) return `${rate} msg/min`
	return d.health === "idle" ? "Running · nothing heard lately" : "Running"
}

const MHZ = (hz: number) => {
	let t = (hz / 1e6).toFixed(4)
	while (/\.\d{3,}0$/.test(t)) t = t.slice(0, -1)
	return t
}

export function decoderWhere(d: DecoderInfo): string {
	const f = d.targetFrequenciesHz ?? []
	if (f.length === 0) return "The tuned channel"
	if (f.length <= 2) return `${f.map(MHZ).join(" and ")} MHz`
	return `${f.length} channels at ${MHZ(f[0] ?? 0).split(".")[0]} MHz`
}

const restarts = (name: string): SettingEffect => ({
	kind: "restart",
	text: `Restarts ${name}`,
	short: `restarts ${name}`,
})

/** The text of a value, with its unit. */
function valueText(
	desc: DecoderOptionDescriptor,
	value: SettingValue,
	options: readonly SettingOption[],
): string {
	if (value === null) return "Default"
	if (desc.type === "boolean") return value === true ? "On" : "Off"
	if (Array.isArray(value)) {
		if (desc.unit === "Hz")
			return `${(value as readonly number[]).map(MHZ).join(", ")} MHz`
		return optionText(options, value) || "None"
	}
	if (desc.type === "enum") return optionText(options, value)
	if (desc.unit === "Hz" && typeof value === "number")
		return `${MHZ(value)} MHz`
	return `${String(value)}${desc.unit ? ` ${desc.unit}` : ""}`
}

function widgetFor(desc: DecoderOptionDescriptor): {
	widget: SettingWidget
	options: SettingOption[]
} {
	const options = (desc.enumValues ?? []).map(v => ({ value: v, label: v }))
	switch (desc.type) {
		case "boolean":
			return { widget: { kind: "switch" }, options }
		case "enum":
			return {
				widget:
					options.length <= 4
						? { kind: "seg", options }
						: { kind: "select", options },
				options,
			}
		case "integer":
		case "number":
			return {
				widget: {
					kind: "stepper",
					min: desc.min ?? -1_000_000_000,
					max: desc.max ?? 1_000_000_000,
					step: desc.type === "integer" ? 1 : 0.1,
					...(desc.unit ? { unit: ` ${desc.unit}` } : {}),
				},
				options,
			}
		case "string-list":
			return { widget: { kind: "chips", options }, options }
		case "number-list": {
			const hz = desc.unit === "Hz"
			return {
				widget: {
					kind: "text",
					placeholder: hz
						? "MHz, separated by commas"
						: "Numbers, separated by commas",
					inputMode: "decimal",
					parse: text => {
						const parts = text
							.split(/[,;\s]+/)
							.map(x => x.trim())
							.filter(Boolean)
						const nums = parts.map(x => Number(x.replace(",", ".")))
						if (nums.some(n => !Number.isFinite(n)))
							return {
								error: hz
									? "Type frequencies in MHz, like 131.525"
									: "Type numbers only",
							}
						const vals = hz ? nums.map(n => Math.round(n * 1e6)) : nums
						const out = vals.find(
							n =>
								(desc.min !== undefined && n < desc.min) ||
								(desc.max !== undefined && n > desc.max),
						)
						if (out !== undefined)
							return {
								error: "One of them is outside what this decoder accepts",
							}
						return { value: vals }
					},
					format: v =>
						Array.isArray(v)
							? (v as readonly number[])
									.map(n => (hz ? MHZ(n) : String(n)))
									.join(", ")
							: "",
				},
				options,
			}
		}
		default:
			return { widget: { kind: "read" }, options }
	}
}

const asSetting = (
	v: SettingValue,
	desc: DecoderOptionDescriptor,
): DecoderSettingValue | null => {
	if (v === null) return null
	if (desc.type === "integer" || desc.type === "number") return Number(v)
	return v
}

/** The Decoders group rows and every decoder page's rows. */
export function decoderRows(
	s: SettingsSnapshot,
	a: SettingsActions,
): SettingRow[] {
	const rows: SettingRow[] = []
	const readOnly = s.readOnly
		? "Read-only access: sign in on this WaveKit to change it"
		: undefined
	for (const d of s.decoders) {
		const name = decoderLabel(d.type)
		const view = s.decoderViews[d.id]
		const type = s.decoderTypes[d.type]
		const effect = restarts(name)
		const enabled = view?.enabled.value ?? d.desiredRunning ?? d.running
		const canWrite = s.decoderSettings && view !== undefined && !readOnly
		rows.push({
			id: `dec.${d.id}`,
			group: "decoders",
			label: name,
			help: decoderWhere(d),
			keys: words(`${d.type} ${d.id} decoder`),
			widget: {
				kind: "page",
				page: d.id,
				tool: d.version ? `${d.type} ${d.version}` : d.type,
				status: decoderStatusText(d),
				tone: decoderTone(d),
			},
			value: enabled,
			text: decoderStatusText(d),
			effect,
			...(canWrite
				? {
						write: (v: SettingValue) =>
							a.decoder(d.id, { enabled: v === true }),
					}
				: {}),
		})
		rows.push({
			id: `dec.${d.id}.enabled`,
			group: "decoders",
			page: d.id,
			label: "Enabled",
			help: "Off stops it and keeps it stopped after a restart",
			keys: words("enabled on off start stop"),
			widget: { kind: "switch" },
			value: enabled,
			text: enabled ? "On" : "Off",
			...(view ? { def: { value: true, text: "On" } } : {}),
			effect,
			...(canWrite
				? {
						write: (v: SettingValue) =>
							a.decoder(d.id, { enabled: v === true }),
					}
				: {
						lock:
							readOnly ??
							"This WaveKit keeps decoder settings in the YAML (open access mode)",
					}),
		})
		if (!type?.options || !view) continue
		let shownEssentials = 0
		const descs = [...type.options].sort(
			(x, y) => Number(y.patchable === true) - Number(x.patchable === true),
		)
		for (const desc of descs) {
			const setting = view.options.find(o => o.key === desc.key)
			const patchable = desc.patchable === true && setting?.patchable !== false
			const { widget, options } = widgetFor(desc)
			const editable = patchable && !desc.secret && widget.kind !== "read"
			const raw = setting?.value
			const value: SettingValue =
				raw === undefined || raw === null ? (desc.default ?? null) : raw
			const more = !(editable && shownEssentials < ESSENTIALS)
			if (!more) shownEssentials++
			const text = desc.secret
				? setting?.present
					? "Set"
					: "Not set"
				: raw === undefined && !patchable
					? setting?.present
						? "Set in the YAML"
						: desc.default === null
							? "Not set"
							: valueText(desc, desc.default, options)
					: valueText(desc, value, options)
			rows.push({
				id: `dec.${d.id}.${desc.key}`,
				group: "decoders",
				page: d.id,
				label: humanKey(desc.key, desc.unit),
				...(desc.description ? { help: desc.description } : {}),
				keys: words(
					`${desc.key} ${humanKey(desc.key, desc.unit).toLowerCase()}`,
				),
				more,
				widget: editable ? widget : { kind: "read" },
				value,
				text,
				...(editable && desc.default !== null
					? {
							def: {
								value: desc.default,
								text: valueText(desc, desc.default, options),
							},
						}
					: {}),
				effect,
				...(editable
					? readOnly
						? { lock: readOnly }
						: {
								write: (v: SettingValue) =>
									a.decoder(d.id, {
										options: {
											[desc.key]: asSetting(v, desc),
										},
									}),
							}
					: {
							lock: desc.secret
								? "A secret: set it in the YAML or the environment"
								: "Set in the YAML configuration",
						}),
			})
		}
	}
	return rows
}
