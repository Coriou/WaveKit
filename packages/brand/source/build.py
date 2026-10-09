#!/usr/bin/env python3
"""Reassemble WaveKit core SVGs from frozen paths. Standard library only.

Does not typeset fonts, redraw artwork, regenerate boards or make network requests.
"""
from __future__ import annotations
import argparse
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def assemble(destination: Path) -> int:
    geometry = json.loads((ROOT / 'source/geometry.json').read_text())
    if destination.resolve() == ROOT:
        raise ValueError('Choose a separate output directory; the masters are not overwritten.')
    destination.mkdir(parents=True, exist_ok=True)
    colors = geometry['palette']
    modes = {
        'on-dark': (colors['phosphor'], colors['paper']),
        'on-light': (colors['forest'], colors['ink']),
        'ink': (colors['ink'], colors['ink']),
        'black': ('#000000', '#000000'),
        'white': ('#FFFFFF', '#FFFFFF'),
        'currentColor': ('currentColor', 'currentColor'),
    }
    count = 0

    def write(path: str, width: int, height: int, body: str, title: str, desc: str = '') -> None:
        nonlocal count
        file = destination / path
        file.parent.mkdir(parents=True, exist_ok=True)
        safe = html.escape(title, quote=True)
        description = f'<desc>{html.escape(desc)}</desc>\n' if desc else ''
        file.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" fill="none" role="img" aria-label="{safe}">\n'
            f'<title>{safe}</title>\n{description}{body}\n</svg>\n', encoding='utf-8')
        count += 1

    def mark(color: str, small: bool = False) -> str:
        value = geometry['mark']
        stroke = value['smallStrokeWidth' if small else 'strokeWidth']
        return (f'<path d="{value["d"]}" stroke="{color}" stroke-width="{stroke}" '
                'stroke-linecap="butt" stroke-linejoin="round" fill="none"/>')

    for mode, (signal, text) in modes.items():
        for baseline in (False, True):
            kind = 'lockup' if baseline else 'wordmark'
            width, height = geometry['canvas'][kind]
            lettering = geometry['lettering']
            body = (f'<g data-part="signal-w" transform="{geometry["integratedMarkTransform"]}">'
                    f'{mark(signal)}</g><g data-part="lettering" transform="{lettering["transform"]}">'
                    f'<path fill="{text}" d="{lettering["d"]}"/></g>')
            if baseline:
                value = geometry['baseline']
                body += (f'<g data-part="baseline" transform="{value["transform"]}">'
                         f'<path fill="{text}" d="{value["d"]}"/></g>')
            # The one-ink black masters ship without a description; the others carry one.
            desc = '' if mode == 'black' else (
                'Integrated signal-w wordmark. Fixed vector lettering. Transparent background.')
            write(f'logos/wavekit-{kind}-{mode}.svg', width, height, body,
                  'WaveKit' + (' — MAKE SENSE OF THE SPECTRUM' if baseline else ''), desc)

    for mode, color in [('mint', colors['phosphor']), ('forest', colors['forest']),
                        ('ink', colors['ink']), ('white', '#FFFFFF'),
                        ('currentColor', 'currentColor')]:
        for small in (False, True):
            name = 'mark-small' if small else 'mark'
            write(f'marks/wavekit-{name}-{mode}.svg', 256, 256, mark(color, small),
                  'WaveKit signal mark' + (', small-size cut' if small else ''))
    for slug, icon in geometry['icons'].items():
        for mode, (base, accent) in {
            'mono': ('currentColor', 'currentColor'),
            'on-light': (colors['ink'], colors['forest']),
            'on-dark': (colors['paper'], colors['phosphor']),
        }.items():
            notice = ('<!-- Based on Tabler Icons, MIT; see licenses/TABLER-MIT.txt. -->\n'
                      if icon['source'] else
                      '<!-- Custom WaveKit extension to the 24-unit / 2-unit icon system. -->\n')
            body = (notice + '<g fill="none" stroke-width="2" stroke-linecap="round" '
                    f'stroke-linejoin="round"><g stroke="{base}">{icon["base"]}</g>'
                    f'<g stroke="{accent}">{icon["accent"]}</g></g>')
            write(f'icons/{mode}/{slug}.svg', 24, 24, body, icon['label'])
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'build', help='Separate output directory.')
    args = parser.parse_args()
    try:
        count = assemble(args.out)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f'Build failed: {error}\n')
    print(f'Reassembled {count} core SVGs in {args.out.resolve()}')


if __name__ == '__main__':
    main()
