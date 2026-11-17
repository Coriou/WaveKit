# wavekit-iqhub third-party licenses

wavekit-iqhub itself is AGPL-3.0-or-later. It is not in the image yet; when it is, the image
ships this file beside the binary's documentation.

Linked into the binary (`cargo tree -e normal`, Cargo.lock as committed):

| crate      | version | license           | use                                               |
| ---------- | ------- | ----------------- | ------------------------------------------------- |
| libc       | 0.2.190 | MIT OR Apache-2.0 | poll, sendmsg, setsockopt, shutdown, ioctl, fcntl |
| serde      | 1.0.229 | MIT OR Apache-2.0 | control protocol                                  |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | control protocol (serde internals)                |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | control protocol                                  |
| itoa       | 1.0.18  | MIT OR Apache-2.0 | serde_json integer formatting                     |
| memchr     | 2.8.3   | Unlicense OR MIT  | serde_json scanning                               |
| zmij       | 1.0.23  | MIT               | serde_json float formatting                       |

Nothing else is compiled for the binary: `serde` is used without its `derive` feature, so no
procedural macro (`serde_derive`, `syn`, `quote`, `proc-macro2`) is built. `Cargo.lock` still
lists `serde_derive` because `serde_core` names it under a target that never matches (a version
pin); `cargo build --release -v` compiles only the crates above.

Dev only, not shipped: proptest and its dependencies (MIT OR Apache-2.0).

No async runtime, no GPL or LGPL code. Regenerate the list with
`cargo tree --manifest-path native/wavekit-iqhub/Cargo.toml -e normal` and each crate's
`license` field.

WaveKit uses each dual-licensed crate under its MIT terms (the Apache-2.0 alternative:
https://www.apache.org/licenses/LICENSE-2.0).

## MIT License

libc: Copyright (c) The Rust Project Developers.
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
