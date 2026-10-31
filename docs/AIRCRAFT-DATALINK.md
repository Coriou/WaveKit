# Aircraft data link (ACARS and VDL2)

Aircraft send more than ADS-B. On VHF they also exchange short data messages with ground stations:
ACARS (131 MHz band, 2400 bit/s) and VDL mode 2 (136 MHz band, which carries the same ACARS
messages faster plus its own link management). This page explains what WaveKit keeps from those
messages, how it reads them, and what it cannot read. ADS-B itself is in [ADS-B](ADSB.md).

## What the decoders give WaveKit

WaveKit runs [acarsdec](https://github.com/f00b4r0/acarsdec) for ACARS and
[dumpvdl2](https://github.com/szpajder/dumpvdl2) for VDL2. Both use
[libacars](https://github.com/szpajder/libacars) to decode the standard payloads that travel inside
ACARS text.

### Who sent a message

Every VDL2 frame carries two addresses, and dumpvdl2 says what each one names: `Aircraft`,
`Ground station`, `All stations` or `reserved`.

- The aircraft end of a frame is the aircraft's 24-bit ICAO address, the same address ADS-B uses.
  WaveKit reports it as `icao` whichever end it is: the source of a downlink, the destination of an
  uplink.
- A ground station's address is never reported as an aircraft. A frame between two ground
  addresses, or broadcast to all stations, names no aircraft.
- `direction` comes from dumpvdl2's address types at both ends: `downlink` from an aircraft to a
  ground station, `uplink` from a ground station to an aircraft or broadcast to all stations (the
  station announcing itself). When either end is missing, `reserved` or of another kind, the frame
  has no direction.

For ACARS heard directly on VHF there are no addresses. The block id decides the direction instead:
a digit means the aircraft sent the block, a letter means the ground did. This is how acarsdec and
libacars tell the two apart.

### Link frames (XID)

VDL2 sets up and hands over its links with XID frames. WaveKit keeps four of their parameters:

| Parameter          | What it is                                                           |
| ------------------ | -------------------------------------------------------------------- |
| `ac_location`      | The aircraft's own position and altitude, rounded (see below)        |
| `dst_airport`      | The destination airport the aircraft announced                       |
| `gs_location`      | A ground station's position, in its Ground Station Information Frame |
| `airport_coverage` | The airports a ground station serves                                 |

XID positions are coarse: dumpvdl2 decodes them to 0.1 degree (about 11 km) and the altitude to
1000 ft. WaveKit shows them as reported positions and never mixes them with an ADS-B track.

### Decoded payloads (libacars)

libacars recognises standard payloads by their label and content: ARINC 622 ADS-C reports and
FANS-1/A CPDLC (labels `A6`, `B6`, `AA`, `BA`, and `H1`), MIAM compressed messages (`MA`, `H1`),
OHMA maintenance data (`H1`) and media advisories (`SA`). WaveKit keeps libacars' result beside the
message text, as `libacars`, when it is plain JSON under 16 KiB. `libacarsDropped` says a result was
present but not kept.

The WaveKit image builds both dumpvdl2 and acarsdec with libacars, so ACARS heard on 131 MHz and
ACARS carried by VDL2 are decoded the same way. An acarsdec built without libacars still works and
gives the text alone.

## Reading a message

Activity shows an ACARS or VDL2 message as the aircraft and what the message is, for example
`N0WK01 ZZ0101 · No information to transmit`, rather than the bare label `_d`. Each message carries:

| Field     | What it says                                                                                 |
| --------- | -------------------------------------------------------------------------------------------- |
| Label     | The two-character label exactly as received (`_d` is acarsdec's spelling of `_DEL`)          |
| Meaning   | The label in plain language, or what libacars found in the message                           |
| Kind      | Link, Ground station, Air traffic, Airline operations, Onboard systems, Weather, Maintenance |
| Basis     | How sure WaveKit is of the meaning (below)                                                   |
| Direction | Air to ground, or ground to air                                                              |
| Text      | The text as received, or `Position from` when libacars decoded a position                    |

Link and ground station messages are technical traffic: acknowledgements, link tests, frequency
changes, ground stations announcing themselves. The web app folds them by default.

VDL2 frames without ACARS are link machinery: `Link supervision` (S frames), `Link control`
(U frames), `Data frame (not ACARS)` (I frames), and the XID types dumpvdl2 names, such as
`Link Connection Request`.

### Basis

| Basis                | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Standard, decoded    | libacars decoded this message (ADS-C, CPDLC, MIAM, media advisory, OHMA)                     |
| Standard format      | The label carries a standard payload that libacars decodes, but this message was not decoded |
| Public label list    | A public label list names the label. The text layout is not public                           |
| Airline's own format | The label is reserved for the airline; only the airline knows its format                     |
| Unknown label        | WaveKit has no explanation; the label and text are shown as received                         |

### Label table

The ARINC specifications that define the labels (618, 620, 622, 623) are not public, so the table
is built from open sources, cited by id in `src/core/activity/presentation/acars-labels.ts`:

- `libacars`: [libacars](https://github.com/szpajder/libacars) 2.2.1, `acars.c`: the labels it
  decodes as ARINC 622, MIAM, OHMA and media advisory.
- `acarsdec`: [acarsdec](https://github.com/f00b4r0/acarsdec), `output.c` (`_d` for `_DEL`) and
  `label.c` (OOOI and estimate fields of the Q labels).
- `acarshub`: [ACARS Hub](https://github.com/sdr-enthusiasts/docker-acarshub) label metadata
  (`rootfs/webapp/data/metadata.json`, attributed to Airframes.io).
- `acarsDecoder`: [@airframes/acars-decoder](https://github.com/airframesio/acars-decoder-typescript)
  1.9.5 plugin names, used to find labels whose public names disagree.

A label is listed only when libacars decodes it, or when a public list names it and no other source
names it differently. Labels `10`, `11`, `16`, `20` and `21` are left out because the sources
disagree on what they mean.

| Label | Meaning                                    | Kind               | Basis                | Sources                |
| ----- | ------------------------------------------ | ------------------ | -------------------- | ---------------------- |
| `_d`  | No information to transmit                 | Link               | Public label list    | acarsdec, acarshub     |
| `Q0`  | Link test                                  | Link               | Public label list    | acarshub               |
| `SA`  | Media advisory                             | Link               | Standard format      | libacars, acarshub     |
| `:;`  | Change transceiver frequency               | Link               | Public label list    | acarshub               |
| `F3`  | Dedicated transceiver advisory             | Link               | Public label list    | acarshub               |
| `HX`  | Undelivered uplink report                  | Link               | Public label list    | acarshub               |
| `QX`  | Intercept or unable to process             | Link               | Public label list    | acarshub               |
| `SQ`  | Ground station squitter                    | Ground station     | Public label list    | acarshub, acarsDecoder |
| `H1`  | Message to or from an onboard system       | Onboard systems    | Public label list    | libacars, acarshub     |
| `MA`  | Compressed message (MIAM)                  | Onboard systems    | Standard format      | libacars               |
| `AA`  | ATC message (CPDLC)                        | Air traffic        | Standard format      | libacars, acarshub     |
| `BA`  | ATC message (CPDLC)                        | Air traffic        | Standard format      | libacars, acarshub     |
| `A6`  | ADS-C request                              | Air traffic        | Standard format      | libacars, acarshub     |
| `B6`  | ADS-C report                               | Air traffic        | Standard format      | libacars, acarshub     |
| `B0`  | ATS facility notification                  | Air traffic        | Public label list    | acarshub               |
| `A1`  | Oceanic clearance                          | Air traffic        | Public label list    | acarshub               |
| `A2`  | Departure clearance                        | Air traffic        | Public label list    | acarshub               |
| `A3`  | Departure clearance                        | Air traffic        | Public label list    | acarshub               |
| `A4`  | Departure clearance acknowledged           | Air traffic        | Public label list    | acarshub               |
| `A5`  | Position report request                    | Air traffic        | Public label list    | acarshub               |
| `A7`  | Free text from ATC                         | Air traffic        | Public label list    | acarshub               |
| `A8`  | Departure slot                             | Air traffic        | Public label list    | acarshub               |
| `A9`  | ATIS information                           | Air traffic        | Public label list    | acarshub               |
| `B1`  | Oceanic clearance request                  | Air traffic        | Public label list    | acarshub               |
| `B2`  | Oceanic clearance readback                 | Air traffic        | Public label list    | acarshub               |
| `B3`  | Departure clearance request                | Air traffic        | Public label list    | acarshub               |
| `B4`  | Departure clearance readback               | Air traffic        | Public label list    | acarshub               |
| `B5`  | Waypoint position report                   | Air traffic        | Public label list    | acarshub               |
| `B7`  | Free text to ATC                           | Air traffic        | Public label list    | acarshub               |
| `B8`  | Departure slot request                     | Air traffic        | Public label list    | acarshub               |
| `B9`  | ATIS request                               | Air traffic        | Public label list    | acarshub               |
| `5D`  | ATIS request                               | Air traffic        | Public label list    | acarshub               |
| `5U`  | Weather request                            | Weather            | Public label list    | acarshub               |
| `24`  | Weather request                            | Weather            | Public label list    | acarshub               |
| `H2`  | Weather report                             | Weather            | Public label list    | acarshub               |
| `QA`  | Out of the gate, with fuel                 | Airline operations | Public label list    | acarshub, acarsdec     |
| `QB`  | Off the ground                             | Airline operations | Public label list    | acarshub, acarsdec     |
| `QC`  | On the ground                              | Airline operations | Public label list    | acarshub, acarsdec     |
| `QD`  | In at the gate, with fuel                  | Airline operations | Public label list    | acarshub, acarsdec     |
| `QE`  | Out of the gate, with fuel and destination | Airline operations | Public label list    | acarshub, acarsdec     |
| `QF`  | Off the ground, with destination           | Airline operations | Public label list    | acarshub, acarsdec     |
| `QG`  | Out of the gate, returned to it            | Airline operations | Public label list    | acarshub, acarsdec     |
| `QH`  | Out of the gate                            | Airline operations | Public label list    | acarshub, acarsdec     |
| `QK`  | Landing report                             | Airline operations | Public label list    | acarshub               |
| `QL`  | Arrival report                             | Airline operations | Public label list    | acarshub               |
| `QM`  | Arrival information                        | Airline operations | Public label list    | acarshub               |
| `QN`  | Diversion report                           | Airline operations | Public label list    | acarshub               |
| `QP`  | Out of the gate                            | Airline operations | Public label list    | acarshub               |
| `QQ`  | Off the ground                             | Airline operations | Public label list    | acarshub               |
| `QR`  | On the ground                              | Airline operations | Public label list    | acarshub               |
| `QS`  | In at the gate                             | Airline operations | Public label list    | acarshub               |
| `Q1`  | Departure or arrival estimate              | Airline operations | Public label list    | acarshub, acarsdec     |
| `Q2`  | Arrival estimate                           | Airline operations | Public label list    | acarshub, acarsdec     |
| `1M`  | Arrival estimate                           | Airline operations | Public label list    | acarshub               |
| `4T`  | Arrival estimate                           | Airline operations | Public label list    | acarshub, acarsDecoder |
| `5Y`  | Estimate revised or diversion              | Airline operations | Public label list    | acarshub               |
| `30`  | Position report                            | Airline operations | Public label list    | acarshub               |
| `5R`  | Position report                            | Airline operations | Public label list    | acarshub               |
| `54`  | Crew asks for a voice call                 | Airline operations | Public label list    | acarshub               |
| `7B`  | Crew message                               | Airline operations | Public label list    | acarshub               |
| `C1`  | Cockpit printer message                    | Airline operations | Public label list    | acarshub               |
| `7A`  | Engine data                                | Maintenance        | Public label list    | acarshub               |
| `5Z`  | Airline message                            | Airline operations | Airline's own format | acarshub               |
| `80`  | Airline message                            | Airline operations | Airline's own format | acarshub               |
| `83`  | Airline message                            | Airline operations | Airline's own format | acarshub               |
| `8D`  | Airline message                            | Airline operations | Airline's own format | acarshub               |
| `8E`  | Airline message                            | Airline operations | Airline's own format | acarshub               |

## Linking aircraft

The same aircraft shows up under different names: its ICAO address in ADS-B and VDL2, its
registration in ACARS, its callsign in ADS-B, its flight number in ACARS. WaveKit links them only
when one decoded frame carried both, and records how it knows.

| Seen together                  | From                                                | Holds for |
| ------------------------------ | --------------------------------------------------- | --------- |
| ICAO address and registration  | A VDL2 frame from or to the aircraft carrying ACARS | 30 days   |
| ICAO address and flight number | The same VDL2 frame                                 | 6 hours   |
| ICAO address and callsign      | An ADS-B message whose address passed its CRC       | 2 hours   |
| Registration and flight number | An ACARS message on VHF without errors              | 6 hours   |

A frame whose ACARS failed its CRC (`crc_ok: false`) or carried bit errors links nothing. Each
link is renewed whenever it is seen again and forgotten when its time runs out. Links are kept in
memory and learnt again after a restart: at most 50,000 observed links and, separately, 50,000
database links, the least recently seen going first in each, so database links can never push
out a link seen on the air.

- **Only an ICAO address or a registration names an aircraft.** A callsign or flight number names
  a flight; it is shown beside the aircraft and never used to join two aircraft. `ZZZ123` in ADS-B
  and `ZZ0123` in ACARS are not linked, however alike.
- **Evidence.** `observed` means one frame carried both identifiers. `database` means an aircraft
  database gave the ICAO address that registration: the local tar1090-db table or, while online
  lookups are on, an online airframe lookup ([ADS-B, Aircraft Enrichment](ADSB.md#aircraft-enrichment)).
  It is recorded each time the aircraft is identified, kept 30 days like an observed one, and loses
  to an observed link. `hint` marks a resemblance and never resolves anything. A callsign or flight
  number is never linked from a database.
- **Conflicts.** A registration linked to two ICAO addresses at once resolves to neither, and is left
  out of both aircraft's `entityKeys`, so neither aircraft lists the other's messages.
- ACARS heard on VHF has no ICAO address. Its registration joins the aircraft once a VDL2 frame
  or the aircraft database has linked that registration to an address.

The route is `GET /api/aircraft-identity/:kind/:value`, described in [API](API.md#aircraft-identity).

## In the web app

- **Activity** shows ACARS and VDL2 rows as explained above and folds link upkeep (`Link` and
  `Ground station` kinds) into one **Link traffic** row per protocol and channel
  ([WEB-APP.md](WEB-APP.md#activity-folding)).
- **Map** draws positions reported over datalink on their own **ACARS** layer, apart from ADS-B
  tracks: a new report appears as it arrives, its age counts up each minute, and it leaves after an
  hour. A selected aircraft lists its datalink messages under **Datalink**
  ([WEB-APP.md](WEB-APP.md#map-and-messages)); its links are asked again each minute and soon after
  a new message, so a registration linked later adds its messages and one that expires or turns out
  to be a conflict drops them. Both share one live Activity subscription.
- Activity rows of a tracked aircraft keep the live fleet's callsign or registration in the title
  and who flies what (airline, type) in the subtitle.
- **Comm-B**: when readsb decodes an aircraft's Comm-B replies, the aircraft row adds what the
  crew selected and what the aircraft measured (selected altitude, IAS, Mach, magnetic heading,
  QNH) in the fields its position report leaves free, at most six in all.

## What WaveKit cannot read

- Many ACARS labels carry an airline's own format, which the airline does not publish. WaveKit
  shows that text as received and does not guess at its fields.
- Some operators encrypt or encode their messages.
- ATC voice carries no identifier, so it is never linked to an aircraft.
