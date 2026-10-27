/** Synthetic meter only. Fields from pinned rtl_433 m_bus.c:839–860.
 * The JSON control key is C (not C_field). FSK -M level supplies freq1/freq2.
 */
export const wmbusPacket = {
	model: "Wireless-MBus",
	mode: "C",
	M: "TST",
	id: 12345678,
	version: 1,
	type: 7,
	type_string: "Water",
	C: 68,
	data_length: 12,
	data: "0b4453547856341201077800",
	mic: "CRC",
	CI: 120,
	AC: 1,
	ST: 0,
	CW: 0,
	freq1: 868.925,
	freq2: 868.975,
	mod: "FSK",
	rssi: -24,
	snr: 18,
	noise: -42,
}

export const wmbusJsonLine = JSON.stringify(wmbusPacket)
