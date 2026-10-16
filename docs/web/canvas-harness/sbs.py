# python3 -I sbs.py out.png scale label beforePath afterPath [beforePath afterPath ...]
import sys
from PIL import Image, ImageDraw
out, scale = sys.argv[1], float(sys.argv[2]); pairs = sys.argv[3:]
rows = []
for i in range(0, len(pairs), 2):
    a, b = Image.open(pairs[i]).convert('RGB'), Image.open(pairs[i+1]).convert('RGB')
    a = a.resize((int(a.width*scale), int(a.height*scale))); b = b.resize((int(b.width*scale), int(b.height*scale)))
    rows.append((a, b))
W = max(a.width + b.width for a, b in rows) + 30; H = sum(max(a.height, b.height) + 24 for a, b in rows)
im = Image.new('RGB', (W, H), (128, 128, 128)); d = ImageDraw.Draw(im); y = 0
for a, b in rows:
    d.text((4, y + 4), 'AVANT', fill=(255, 255, 255)); d.text((a.width + 34, y + 4), 'APRES', fill=(255, 255, 255))
    im.paste(a, (0, y + 20)); im.paste(b, (a.width + 30, y + 20)); y += max(a.height, b.height) + 24
im.save(out)
