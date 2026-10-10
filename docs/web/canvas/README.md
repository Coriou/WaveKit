# Design canvas snapshot

A copy of every board on the [design canvas](https://claude.ai/artifact/Mr2W34vvZxc8tGFCdMvZHE),
committed after each canvas update so the design has history, a backup and a reference for the
dev team. The canvas is the source of truth; edit there, never here.

- `canvas.json` is the canvas index: board positions, titles and the sticky notes (including the
  orange core-gaps sticky).
- Each `*.dc.html` is one board: markup plus a small logic class (mock data, interactions).
  Boards import each other by name (`<dc-import name="Spectrum">` loads `Spectrum.dc.html`).
- These files do not open on their own. They need the canvas runtime (`support.js`) and fonts
  served from the canvas (`/_blob/…`). Read them as source; open the canvas to use them.
- Excluded from Prettier (`.prettierignore`) so they stay byte-identical to the canvas.

See [../DESIGN.md](../DESIGN.md) for what each board is and why.
