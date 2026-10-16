#!/usr/bin/env python3
"""Generate tokens/ui.json from tokens/ui.css (the WaveKit UI kit). Standard library only.

ui.json holds every kit token resolved per scope (theme / ground / accent), the scales and the
recipe class list. It is read by source/validate.py and later by the web app's theme mapping.

  python3 -I source/build_ui.py          write tokens/ui.json
  python3 -I source/build_ui.py --check  exit 1 when tokens/ui.json is stale
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / 'tokens/ui.css'
OUT = ROOT / 'tokens/ui.json'

GROUNDS = {'dark': ['ink', 'graphite', 'black'], 'light': ['paper']}
ACCENTS = ['phosphor', 'ice', 'violet', 'coral', 'mono']
SCALES = {'font': 'font-', 'fontSize': 'fs-', 'space': 'sp-', 'height': 'h-', 'radius': 'r-',
          'duration': 'dur-', 'easing': 'ease-', 'elevation': 'e'}
ATTR = re.compile(r'(:not\()?\[data-wk-(theme|ground|accent)(?:="([a-z]+)")?\]\)?')


def strip_comments(text: str) -> str:
    return re.sub(r'/\*.*?\*/', '', text, flags=re.S)


def layer(css: str, name: str) -> str:
    """The body of `@layer name{...}` (brace matched)."""
    start = css.index(f'@layer {name}{{') + len(f'@layer {name}{{')
    depth, i = 1, start
    while depth:
        depth += {'{': 1, '}': -1}.get(css[i], 0)
        i += 1
    return css[start:i - 1]


def rules(body: str) -> list[tuple[str, str]]:
    """Top-level `selector{declarations}` pairs (at-rules skipped)."""
    out, i = [], 0
    while True:
        open_ = body.find('{', i)
        if open_ < 0:
            return out
        selector = body[i:open_].strip()
        depth, j = 1, open_ + 1
        while depth:
            depth += {'{': 1, '}': -1}.get(body[j], 0)
            j += 1
        if not selector.startswith('@'):
            out.append((selector, body[open_ + 1:j - 1]))
        i = j


def declarations(block: str) -> dict[str, str]:
    return {k: v.strip() for k, v in re.findall(r'(--[\w-]+):([^;]+)(?:;|$)', block)}


def matches(selector: str, scope: dict[str, str]) -> tuple[bool, int]:
    """Does a token selector apply to the scope, and with what specificity."""
    if ATTR.sub('', selector).strip():
        raise ValueError(f'unsupported token selector: {selector}')
    count = 0
    for negated, attr, value in ATTR.findall(selector):
        count += 1
        have = scope.get(attr)
        hit = have is not None and (not value or value == have)
        if hit == bool(negated):
            return False, 0
    return True, count


def resolve(tokens: dict[str, str]) -> dict[str, str]:
    def sub(value: str, seen: frozenset[str]) -> str:
        def repl(m: re.Match[str]) -> str:
            name = m.group(1)
            if name in seen or name not in tokens:
                raise ValueError(f'unresolved or cyclic var({name})')
            return sub(tokens[name], seen | {name})
        return re.sub(r'var\((--[\w-]+)\)', repl, value)
    return {k: sub(v, frozenset({k})) for k, v in tokens.items()}


def build() -> str:
    css = strip_comments(CSS.read_text(encoding='utf-8'))
    token_rules = rules(layer(css, 'wk-tokens'))
    scopes: dict[str, dict[str, str]] = {}
    for theme, grounds in GROUNDS.items():
        for ground in grounds:
            for accent in ACCENTS:
                scope = {'theme': theme, 'ground': ground, 'accent': accent}
                applied = []
                for order, (selector, block) in enumerate(token_rules):
                    for part in selector.split(','):
                        hit, spec = matches(part.strip(), scope)
                        if hit:
                            applied.append((spec, order, block))
                            break
                tokens: dict[str, str] = {}
                for _, _, block in sorted(applied, key=lambda a: (a[0], a[1])):
                    tokens.update(declarations(block))
                scopes[f'{theme}/{ground}/{accent}'] = dict(sorted(resolve(tokens).items()))
    base = scopes['dark/black/mono']
    scales = {name: {k[len('--wk-' + prefix):]: v for k, v in base.items()
                     if k.startswith('--wk-' + prefix) and (prefix != 'e' or re.fullmatch(r'--wk-e\d', k))}
              for name, prefix in SCALES.items()}
    recipes = sorted(set(re.findall(r'\.(wk-[\w-]+)', layer(css, 'wk-recipes'))))
    doc = {'generatedFrom': 'tokens/ui.css', 'scopes': scopes, 'scales': scales, 'recipes': recipes}
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    text = build()
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding='utf-8') != text:
            print('tokens/ui.json is stale: run python3 -I source/build_ui.py', file=sys.stderr)
            sys.exit(1)
        return
    OUT.write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
