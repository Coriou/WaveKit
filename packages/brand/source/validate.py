#!/usr/bin/env python3
"""Validate @wavekit/brand. Standard library only unless --render is requested.

Checks SVG structure and safety, the icon system, that source/build.py still
reproduces the core masters byte-for-byte, that the React geometry and the
tokens mirror their masters, theme contrast, and font licensing/layout.
--render also rasterises every SVG and checks exports/ against fresh renders
(needs CairoSVG and Pillow).
"""
from __future__ import annotations
import argparse
import importlib.util
import io
import json
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # build.py / export.py are imported; leave no __pycache__
SVG_NS = 'http://www.w3.org/2000/svg'
ALLOWED = {'svg', 'title', 'desc', 'g', 'path', 'rect', 'circle', 'line', 'ellipse',
           'polygon', 'polyline', 'symbol', 'defs'}
FONT_SUFFIXES = {'.ttf', '.otf', '.woff', '.woff2', '.eot'}
SKIP_DIRS = {'build', 'node_modules', '__pycache__', '.turbo'}
HEX = re.compile(r'^#[0-9a-fA-F]{6}$')

# Theme pairs that must keep their contrast when the tokens are tuned:
# (foreground, background, minimum ratio). 4.5 = text, 3 = UI boundaries / focus.
CONTRAST_PAIRS = [
    ('fg', 'bg', 4.5), ('fg', 'surface', 4.5),
    ('fgMuted', 'bg', 4.5), ('fgMuted', 'surface', 4.5),
    ('accent', 'bg', 4.5), ('accent', 'surface', 4.5),
    ('accentInk', 'accent', 4.5),
    ('borderControl', 'bg', 3), ('borderControl', 'surface', 3),
    ('focusRing', 'bg', 3), ('focusRing', 'surface', 3),
]


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'source/{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def luminance(color: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def css_vars(block: str) -> dict[str, str]:
    return dict(re.findall(r'--wk-([\w-]+):\s*([^;]+);', block))


def camel(name: str) -> str:
    head, *rest = name.split('-')
    return head + ''.join(part.title() for part in rest)


def check_svgs(files: list[Path], render: bool, issues: list[str], result: dict) -> None:
    if render:
        try:
            import cairosvg
            from PIL import Image
        except (ImportError, OSError) as error:
            raise RuntimeError('--render needs CairoSVG (with the cairo library) and Pillow.') from error
    for file in files:
        rel = file.relative_to(ROOT).as_posix()
        if file.suffix.lower() != '.svg':
            continue
        result['svgFiles'] += 1
        text = file.read_text(encoding='utf-8')
        try:
            root = ET.fromstring(text)
        except ET.ParseError as error:
            issues.append(f'{rel}: invalid XML: {error}')
            continue
        if root.tag != f'{{{SVG_NS}}}svg':
            issues.append(f'{rel}: missing SVG namespace')
        is_sprite = rel == 'icons/categories.symbols.svg'
        if not is_sprite:
            try:
                viewbox = [float(n) for n in root.attrib['viewBox'].split()]
                assert len(viewbox) == 4 and viewbox[2] > 0 and viewbox[3] > 0
                assert root.get('aria-label')
            except (KeyError, ValueError, AssertionError):
                issues.append(f'{rel}: missing or invalid viewBox / accessible name')
                continue
        if '@font-face' in text or 'data:' in text or '<!DOCTYPE' in text:
            issues.append(f'{rel}: embedded resource or unsafe declaration')
        ids: set[str] = set()
        for element in root.iter():
            tag = element.tag.split('}')[-1]
            if tag not in ALLOWED:
                issues.append(f'{rel}: disallowed or non-outlined element <{tag}>')
            for key, value in element.attrib.items():
                localkey = key.split('}')[-1]
                if localkey.startswith('on') or localkey == 'href' or 'url(' in value:
                    issues.append(f'{rel}: external, interactive or URL attribute {key}')
                if localkey == 'id':
                    if value in ids:
                        issues.append(f'{rel}: duplicate id {value}')
                    ids.add(value)
            if tag == 'symbol' and element.get('viewBox') != '0 0 24 24':
                issues.append(f'{rel}: unexpected symbol viewBox')
        if is_sprite and len(ids) != 8:
            issues.append(f'{rel}: sprite must have 8 distinct symbols')
        if rel.startswith(('icons/mono/', 'icons/on-light/', 'icons/on-dark/')):
            if root.get('viewBox') != '0 0 24 24':
                issues.append(f'{rel}: icon not on canonical 24-unit grid')
            group = root.find(f'{{{SVG_NS}}}g')
            if group is None or any(group.get(k) != v for k, v in {
                'stroke-width': '2', 'stroke-linecap': 'round',
                'stroke-linejoin': 'round'}.items()):
                issues.append(f'{rel}: inconsistent icon stroke system')
        if render and not is_sprite:
            try:
                # Full board rasterisation is deliberately capped; core assets use native sizes.
                width = int(min(1800, viewbox[2]))
                png = cairosvg.svg2png(bytestring=text.encode(), output_width=width)
                image = Image.open(io.BytesIO(png)).convert('RGBA')
                bounds = image.getchannel('A').getbbox()
                if bounds is None:
                    issues.append(f'{rel}: empty raster')
                transparent = rel.startswith('logos/') or rel.startswith('icons/') or (
                    rel.startswith('marks/wavekit-mark-'))
                if transparent and bounds and (bounds[0] == 0 or bounds[1] == 0
                      or bounds[2] == image.width or bounds[3] == image.height):
                    issues.append(f'{rel}: painted bounds touch canvas edge; inspect clipping')
                result['renderedSvgFiles'] += 1
            except Exception as error:
                issues.append(f'{rel}: rasterisation failed: {error}')


def check_rebuild(issues: list[str], result: dict) -> None:
    """source/build.py must still reproduce the 46 core masters exactly."""
    build = load_module('build')
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        build.assemble(out)
        for file in sorted(out.rglob('*.svg')):
            rel = file.relative_to(out).as_posix()
            master = ROOT / rel
            if not master.is_file() or master.read_bytes() != file.read_bytes():
                issues.append(f'{rel}: differs from source/build.py output (edit geometry.json, then rebuild)')
            result['rebuiltMastersChecked'] += 1


def check_react(geometry: dict, issues: list[str]) -> None:
    """react/geometry.ts and react/icon-nodes.ts must mirror source/geometry.json."""
    ts = (ROOT / 'react/geometry.ts').read_text()
    consts = dict(re.findall(r'export const (\w+) =\s*"([^"]*)"', ts))
    expected = {
        'markPath': geometry['mark']['d'],
        'letteringPath': geometry['lettering']['d'],
        'letteringTransform': geometry['lettering']['transform'],
        'integratedMarkTransform': geometry['integratedMarkTransform'],
        'baselinePath': geometry['baseline']['d'],
        'baselineTransform': geometry['baseline']['transform'],
    }
    for key, value in expected.items():
        if consts.get(key) != value:
            issues.append(f'react/geometry.ts: {key} drifted from source/geometry.json')
    source = (ROOT / 'react/icon-nodes.ts').read_text()
    match = re.search(r'export const iconNodes = (\{.*?\n\}) as const', source, re.S)
    try:
        assert match
        literal = re.sub(r'^(\s*)([A-Za-z_][\w]*):', r'\1"\2":', match.group(1), flags=re.M)
        literal = re.sub(r',(\s*[\]}])', r'\1', literal)
        nodes = json.loads(literal)
    except (AssertionError, json.JSONDecodeError):
        issues.append('react/icon-nodes.ts: could not parse iconNodes for comparison')
        return
    for slug, icon in geometry['icons'].items():
        for part in ('base', 'accent'):
            wrapped = ET.fromstring(f'<g>{icon[part]}</g>')
            want = [[child.tag, dict(child.attrib)] for child in wrapped]
            if nodes.get(slug, {}).get(part) != want:
                issues.append(f'react/icon-nodes.ts: {slug}.{part} drifted from source/geometry.json')
    if set(nodes) != set(geometry['icons']):
        issues.append('react/icon-nodes.ts: category list differs from source/geometry.json')


def check_tokens(config: dict, geometry: dict, issues: list[str], result: dict) -> None:
    tokens = json.loads((ROOT / 'tokens/tokens.json').read_text())
    css = (ROOT / 'tokens/brand.css').read_text()
    palette = {k: v.upper() for k, v in config['colors'].items()}
    for name, other in (('tokens.json', tokens['colors']), ('geometry.json', geometry['palette'])):
        if {k: v.upper() for k, v in other.items()} != palette:
            issues.append(f'{name}: palette differs from brand.config.json')
    root_block = re.search(r'^:root \{(.*?)^\}', css, re.S | re.M)
    light = re.search(r'^:root,\s*\[data-wavekit-theme="light"\]\s*\{(.*?)\}', css, re.S | re.M)
    dark_media = re.search(
        r'@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-wavekit-theme="light"\]\)\s*\{(.*?)\}',
        css, re.S)
    dark = re.search(r'^\[data-wavekit-theme="dark"\]\s*\{(.*?)\}', css, re.S | re.M)
    if not (root_block and light and dark_media and dark):
        issues.append('tokens/brand.css: expected :root, light, dark media and dark attribute blocks')
        return
    raw = {k: v.strip() for k, v in css_vars(root_block.group(1)).items()}
    for key, value in palette.items():
        if raw.get(key, '').upper() != value:
            issues.append(f'tokens/brand.css: --wk-{key} differs from brand.config.json')
    if css_vars(dark_media.group(1)) != css_vars(dark.group(1)):
        issues.append('tokens/brand.css: the prefers-color-scheme and data-wavekit-theme dark blocks differ')

    def resolve(value: str) -> str:
        value = value.strip()
        ref = re.fullmatch(r'var\(--wk-([\w-]+)\)', value)
        return resolve(raw[ref.group(1)]) if ref else value.upper()

    for theme, match in (('light', light), ('dark', dark)):
        try:
            resolved = {camel(k): resolve(v) for k, v in css_vars(match.group(1)).items()}
        except KeyError as error:
            issues.append(f'tokens/brand.css: {theme} theme references undefined --wk-{error.args[0]}')
            continue
        if resolved != tokens['themes'][theme]:
            issues.append(f'tokens: {theme} theme in brand.css and tokens.json differ')
        for fg, bg, minimum in CONTRAST_PAIRS:
            a, b = resolved.get(fg, ''), resolved.get(bg, '')
            if not (HEX.match(a) and HEX.match(b)):
                issues.append(f'tokens: {theme} {fg}/{bg} is not a resolvable hex pair')
                continue
            ratio = contrast(a, b)
            result['contrast'][f'{theme}: {fg} on {bg}'] = round(ratio, 2)
            if ratio < minimum:
                issues.append(f'tokens: {theme} {fg} on {bg} is {ratio:.2f}:1, below {minimum}:1')


def check_fonts(files: list[Path], config: dict, issues: list[str], result: dict) -> None:
    fonts = [f for f in files if f.suffix.lower() in FONT_SUFFIXES]
    result['fontFiles'] = len(fonts)
    for file in fonts:
        rel = file.relative_to(ROOT).as_posix()
        parts = file.relative_to(ROOT).parts
        if len(parts) != 3 or parts[0] != 'fonts':
            issues.append(f'{rel}: font binaries belong in fonts/<family>/')
        if file.suffix.lower() != '.woff2':
            issues.append(f'{rel}: ship web fonts as .woff2')
        if not (file.parent / 'OFL.txt').is_file():
            issues.append(f'{rel}: licence file OFL.txt missing beside the font')
    if config['typography'].get('fontBinariesIncluded') != bool(fonts):
        issues.append('brand.config.json: typography.fontBinariesIncluded is out of date')
    css = (ROOT / 'tokens/typography.css').read_text()
    referenced = set()
    for url in re.findall(r'url\("([^"]+)"\)', css):
        target = (ROOT / 'tokens' / url).resolve()
        referenced.add(target)
        if not target.is_file():
            issues.append(f'tokens/typography.css: {url} does not exist')
    tokens = json.loads((ROOT / 'tokens/tokens.json').read_text())
    for family, faces in tokens['type']['fonts'].items():
        for face, path in faces.items():
            if (ROOT / path).resolve() not in referenced:
                issues.append(f'tokens.json: {family} {face} ({path}) is not loaded by typography.css')
    for file in fonts:
        if file.resolve() not in referenced:
            issues.append(f'{file.relative_to(ROOT).as_posix()}: shipped but not referenced by typography.css')


def check(render: bool = False) -> dict:
    issues: list[str] = []
    result: dict = {'status': 'pass', 'svgFiles': 0, 'renderedSvgFiles': 0,
                    'outlineOnly': True, 'fontFiles': 0, 'rebuiltMastersChecked': 0,
                    'exportsChecked': 0, 'contrast': {}, 'errors': issues}
    config = json.loads((ROOT / 'brand.config.json').read_text())
    geometry = json.loads((ROOT / 'source/geometry.json').read_text())
    assert config['baseline'] == geometry['baseline']['text'] == 'MAKE SENSE OF THE SPECTRUM'
    assert len(config['iconSystem']['categories']) == 8
    files = [p for p in sorted(ROOT.rglob('*')) if p.is_file()
             and not SKIP_DIRS.intersection(p.relative_to(ROOT).parts)]

    check_svgs(files, render, issues, result)
    for slug in config['iconSystem']['categories']:
        for mode in ('mono', 'on-light', 'on-dark'):
            if not (ROOT / f'icons/{mode}/{slug}.svg').is_file():
                issues.append(f'missing {mode}/{slug}.svg')
    for key, path in config['preferred'].items():
        if not (ROOT / path).is_file():
            issues.append(f'missing preferred {key}: {path}')
    if not (ROOT / 'licenses/TABLER-MIT.txt').is_file():
        issues.append('licenses/TABLER-MIT.txt must ship with the icons')
    manifest = json.loads((ROOT / 'templates/site.webmanifest').read_text())
    for icon in manifest['icons']:
        if not (ROOT / icon['src'].removeprefix('/brand/')).is_file():
            issues.append(f'templates/site.webmanifest: {icon["src"]} has no matching file')

    check_rebuild(issues, result)
    check_react(geometry, issues)
    check_tokens(config, geometry, issues, result)
    check_fonts(files, config, issues, result)
    if render:
        export = load_module('export')
        issues.extend(export.run(check=True))
        result['exportsChecked'] = len(export.EXPORTS) + 1

    result['outlineOnly'] = not any('non-outlined' in issue for issue in issues)
    result['status'] = 'fail' if issues else 'pass'
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--render', action='store_true',
                        help='Also rasterise SVGs and check exports/ (CairoSVG + Pillow).')
    args = parser.parse_args()
    try:
        result = check(args.render)
    except (OSError, ValueError, RuntimeError, AssertionError, KeyError) as error:
        parser.exit(1, f'Validation failed: {error}\n')
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['status'] == 'pass' else 1)


if __name__ == '__main__':
    main()
