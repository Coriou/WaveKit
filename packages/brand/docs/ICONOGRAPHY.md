# Iconography

## One family, not a collection of unrelated icons

Lucide and Tabler were compared as coherent open-source outline families. Tabler was
selected as the reference family: 24 × 24 units, 2-unit strokes and rounded terminals
and joins. The actual imported paths are recorded below, not merely linked to an
unversioned icon bank. No runtime icon package or CDN is needed.

Five icons use Tabler geometry; three are custom extensions where an application-
specific symbol was more useful. This does not mean all eight were drawn by one
literal artist. It means they share one construction system and one reviewed set.

## Categories, not executable names

| Label         | Signal group         | Drawing source           |
| ------------- | -------------------- | ------------------------ |
| Aircraft      | ADS-B                | Tabler `plane`           |
| Marine        | AIS                  | Tabler `ship`            |
| Aviation data | ACARS, VDL2          | Custom WaveKit extension |
| Voice         | DMR, P25, YSF        | Tabler `microphone`      |
| Paging        | POCSAG, FLEX         | Custom WaveKit extension |
| APRS          | APRS                 | Tabler `map-pin`         |
| Sensors       | ISM sensor telemetry | Tabler `access-point`    |
| Mesh          | Meshtastic LoRa      | Custom WaveKit extension |

This categorisation maps nine documented decoder integrations to eight readable
signal categories. ACARS and VDL2 are grouped as Aviation data. Availability and
runtime enablement depend on the product build, SDR source and configuration.
The source is the project's `.kiro/steering/product.md`, blob
`43bac806a9bb4bf423181b331b7ab6355646acfc`; this was not a live decoder test.

APRS is represented by a position marker, not by a satellite. Marine means AIS here;
VDL2 stays in aviation. Voice modes stay out of Paging, which covers POCSAG/FLEX in
the source documentation. The message pictogram denotes aviation data; it does not
imply a particular radio link, satellite service or aircraft UI.

## Supplied treatments

- `mono/`: single `currentColor`, preferred for interface controls and dense lists.
- `on-dark/`: paper outline with a restrained mint accent.
- `on-light/`: ink outline with a forest accent, not low-contrast pale mint.

The files contain only the icon. Keep visible labels in HTML or native text so they
can wrap, localise and be read accessibly. The board's captions are not baked into
individual category SVGs. Use the same treatment for an entire row.

## Size and drawing rules

Use 24 px as the default UI size; use 32 or 48 px for category navigation or explanatory
cards. At 16 px, inspect each shape and retain a text label; the category set has not
been given separate bespoke 16 px optical cuts. The logo mark does have a small cut.
Scale the whole SVG uniformly; the 2-unit stroke scales with it. Do not combine
absolute/non-scaling strokes with these standard masters. Avoid random individual
stroke-width overrides, filled library variants and arbitrary bounding-box cropping.
The slightly different optical footprints are intentional; keep the shared 24-unit
viewBox rather than resizing every drawing to its bounding box.

## Exact origins and adaptations

### Aircraft

Upstream: https://github.com/tabler/tabler-icons/blob/main/icons/outline/plane.svg

Git blob SHA: `77fd31c4961c36470359fe24c131c24fda593a07`.

Rotated 90 degrees anticlockwise to a top-view upright silhouette.

### Marine

Upstream: https://github.com/tabler/tabler-icons/blob/main/icons/outline/ship.svg

Git blob SHA: `e30d4ff174553b96449940f924d9c582fc3e023c`.

Same geometry; wave path separated for accent colour.

### Aviation data

Custom aircraft-message packet pictogram. Bubble and receive arcs, not a satellite or a radar claim.

### Voice

Upstream: https://github.com/tabler/tabler-icons/blob/main/icons/outline/microphone.svg

Git blob SHA: `7d3b830ba2c2cfeab196b4f895c9f61a006959ae`.

Same geometry; receiver arc separated for accent colour.

### Paging

Custom horizontal pager, with a display and three controls; not a smartphone.

### APRS

Upstream: https://github.com/tabler/tabler-icons/blob/main/icons/outline/map-pin.svg

Git blob SHA: `7291ed17118aebcf2b81f28ab08fa3af52233cc4`.

Same geometry; position target separated for accent. APRS is not labelled as satellites.

### Sensors

Upstream: https://github.com/tabler/tabler-icons/blob/main/icons/outline/access-point.svg

Git blob SHA: `b11b7c4194f4d2c26b1765516fdfef5e3ce16225`.

Same geometry; outer receive arcs separated for accent. Symbol is a radio sensor beacon, not a Wi-Fi product claim.

### Mesh

Custom peer-to-peer triangle; all three nodes are equal.

## Extension checklist

Use a category concept, not an executable logo. Begin with the existing family; keep
2-unit strokes, round caps, restrained internal detail and similar visual weight.
Check the new glyph beside all eight existing icons in mono, light and dark at 24,
32 and 48 px. Check that its meaning is correct for the actual signal. Add provenance,
license and changes to this file, then request approval before treating it as canonical.

## License

Retain `licenses/TABLER-MIT.txt` with copied Tabler-based icons, React icon code and
sprite derivatives. Custom extensions and the WaveKit brand are distinguished in
`licenses/NOTICES.md`. Do not claim these are exclusive original icons or all upstream
Tabler assets.
