# Usage: python3 -I diff.py <beforeDir> <afterDir> <outDir> [names...]
import sys, os
from PIL import Image, ImageChops
import numpy as np
a, b, o = sys.argv[1:4]; names = sys.argv[4:]
os.makedirs(o, exist_ok=True)
files = sorted(f for f in os.listdir(a) if f.endswith('.png') and (not names or any(f.startswith(n + '-') for n in names)))
for f in files:
    if not os.path.exists(os.path.join(b, f)):
        print(f"{f}: MISSING after"); continue
    A = Image.open(os.path.join(a, f)).convert('RGB'); B = Image.open(os.path.join(b, f)).convert('RGB')
    note = '' if A.size == B.size else f' SIZE {A.size}->{B.size}'
    w, h = max(A.width, B.width), max(A.height, B.height)
    A2 = Image.new('RGB', (w, h)); A2.paste(A); B2 = Image.new('RGB', (w, h)); B2.paste(B)
    d = np.asarray(ImageChops.difference(A2, B2)).max(axis=2)
    n = int((d > 24).sum())
    pct = 100 * n / (w * h)
    print(f"{f}: {n} px differ ({pct:.3f}%){note}")
    if n:
        ys, xs = np.nonzero(d > 24)
        print(f"   bbox x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()}")
        m = np.zeros((h, w, 3), np.uint8); m[d > 24] = (255, 0, 80)
        base = (np.asarray(B2) * 0.35).astype(np.uint8)
        out = np.where(m.any(axis=2, keepdims=True), m, base)
        Image.fromarray(out).save(os.path.join(o, f))
