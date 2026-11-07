# wavekit-frame third-party licenses

wavekit-frame (the spectrum worker's frame kernel, shipped as `dist/spectrum-frame.wasm`) is
AGPL-3.0-or-later. The image ships this file at `/usr/share/doc/wavekit-frame/LICENSES.md`.

No crates.io dependency: `Cargo.toml` has an empty `[dependencies]` and `Cargo.lock` lists only
the crate itself. No FFT crate: the kernel runs the same radix-2 transform as
`src/core/spectrum/fft.ts` (the textbook decimation-in-time algorithm), so its results match the
JS path bit for bit. No GPL code.

Linked into the artefact from the Rust toolchain (1.98.1, `wasm32-unknown-unknown`; licences from
each crate's manifest in the toolchain's `rust-src` component):

| crate             | version | license                                                        | use                                         |
| ----------------- | ------- | -------------------------------------------------------------- | ------------------------------------------- |
| core              | 1.98.1  | MIT OR Apache-2.0                                              | the language's core library                 |
| compiler_builtins | 0.1.160 | MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0) | memory and integer helpers the linker keeps |

WaveKit uses `core` under its MIT terms. `compiler_builtins` carries code from LLVM's compiler-rt
under Apache-2.0 WITH LLVM-exception, whose exception lets portions embedded into compiled object
code be redistributed without the conditions of sections 4(a), 4(b) and 4(d); its MIT part is
reproduced below.
Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0; the LLVM exception:
https://llvm.org/LICENSE.txt.

## MIT License

core, compiler_builtins: copyright the Rust project developers.

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
