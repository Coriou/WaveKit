# wavekit-nfm third-party licenses

wavekit-nfm (the wideband recorder's NFM chain, shipped as `dist/wideband-nfm.wasm`) is
AGPL-3.0-or-later. The image ships this file at `/usr/share/doc/wavekit-nfm/LICENSES.md`.

No crates.io dependency: `Cargo.toml` has an empty `[dependencies]` and `Cargo.lock` lists only
the crate itself. The filters, the NCO and the discriminator are the textbook stages of
`src/core/scanner/channel/wideband-nfm.ts` and `fm-audio.ts`, whose tables JS hands to the kernel.
No GPL code.

Linked into the artefact from the Rust toolchain (1.98.1, `wasm32-unknown-unknown`, `no_std`; the
same `core` and `compiler_builtins` as `native/wavekit-frame/LICENSES.md` lists, with licences from
each crate's manifest in the toolchain's `rust-src` component):

| crate             | version | license                                                        | use                                  |
| ----------------- | ------- | -------------------------------------------------------------- | ------------------------------------ |
| core              | 1.98.1  | MIT OR Apache-2.0                                              | the language's core library          |
| compiler_builtins | 0.1.160 | MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0) | `atan2` and `atan` (its `libm` port) |

WaveKit uses `core` under its MIT terms. The `atan2` and `atan` that `compiler_builtins` links come
from its `libm` port of musl (MIT), which derives them from FreeBSD's msun and Sun's fdlibm; the
fdlibm notice is reproduced below. `compiler_builtins` also carries code from LLVM's compiler-rt
under Apache-2.0 WITH LLVM-exception, whose exception lets portions embedded into compiled object
code be redistributed without the conditions of sections 4(a), 4(b) and 4(d); its MIT part is
reproduced below.
Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0; the LLVM exception:
https://llvm.org/LICENSE.txt.

## MIT License

core, compiler_builtins (including its libm port): copyright the Rust project developers;
musl: copyright © 2005-2020 Rich Felker, et al.

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

## fdlibm (atan2, atan)

Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.

Developed at SunPro, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this software is freely granted, provided that
this notice is preserved.
