# wavekit-chan third-party licenses

wavekit-chan itself is AGPL-3.0-or-later. The image ships this file at
`/usr/share/doc/wavekit-chan/LICENSES.md`.

Linked into the binary (`cargo tree -e normal`, Cargo.lock as committed):

| crate      | version | license           | use                                |
| ---------- | ------- | ----------------- | ---------------------------------- |
| serde      | 1.0.229 | MIT OR Apache-2.0 | control protocol                   |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | control protocol (serde internals) |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | control protocol                   |
| itoa       | 1.0.18  | MIT OR Apache-2.0 | serde_json integer formatting      |
| memchr     | 2.8.3   | Unlicense OR MIT  | serde_json scanning                |
| zmij       | 1.0.23  | MIT               | serde_json float formatting        |

Used only at build time (procedural macros; no code of theirs is in the binary):

| crate         | version | license                             |
| ------------- | ------- | ----------------------------------- |
| serde_derive  | 1.0.229 | MIT OR Apache-2.0                   |
| proc-macro2   | 1.0.107 | MIT OR Apache-2.0                   |
| quote         | 1.0.47  | MIT OR Apache-2.0                   |
| syn           | 3.0.6   | MIT OR Apache-2.0                   |
| unicode-ident | 1.0.26  | (MIT OR Apache-2.0) AND Unicode-3.0 |

Dev only, not shipped: proptest and its dependencies (MIT OR Apache-2.0).

No FFT crate and no GPL code (addendum §10 refined by plan assumption A5).
Regenerate the lists with `cargo tree --manifest-path native/wavekit-chan/Cargo.toml -e normal`
and each crate's `license` field.

WaveKit uses each dual-licensed crate under its MIT terms (the Apache-2.0 alternative:
https://www.apache.org/licenses/LICENSE-2.0).

## MIT License

memchr: Copyright (c) 2015 Andrew Gallant.
serde, serde_core, serde_json, itoa, zmij: copyright their authors (the crates' MIT files carry
no named holder; see each crate's repository).

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
