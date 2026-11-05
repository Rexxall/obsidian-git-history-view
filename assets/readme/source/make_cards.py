"""Render the three-card summary in light and dark."""
from pathlib import Path
from make_hero import THEMES, SANS

CARDS = [
    ("Search the past", ["Find what you deleted, and when."], "search"),
    ("Compare any two", ["Side by side, or heading by heading."], "compare"),
    ("Take back one part", ["Preview first. Undo any time."], "restore"),
]

def glyph(kind, x, y, c):
    if kind == "search":
        return (f'<circle cx="{x+21}" cy="{y+21}" r="9" fill="none" stroke="{c["accent"]}" stroke-width="3"/>'
                f'<path d="M{x+28} {y+28} L{x+35} {y+35}" stroke="{c["accent"]}" stroke-width="3" stroke-linecap="round"/>')
    if kind == "compare":
        return (f'<rect x="{x+10}" y="{y+12}" width="12" height="4" rx="2" fill="{c["red"]}"/>'
                f'<rect x="{x+10}" y="{y+22}" width="12" height="4" rx="2" fill="{c["muted"]}"/>'
                f'<rect x="{x+10}" y="{y+32}" width="12" height="4" rx="2" fill="{c["red"]}"/>'
                f'<rect x="{x+26}" y="{y+12}" width="12" height="4" rx="2" fill="{c["green"]}"/>'
                f'<rect x="{x+26}" y="{y+22}" width="12" height="4" rx="2" fill="{c["muted"]}"/>'
                f'<rect x="{x+26}" y="{y+32}" width="12" height="4" rx="2" fill="{c["green"]}"/>')
    return (f'<rect x="{x+16}" y="{y+12}" width="22" height="4" rx="2" fill="{c["muted"]}"/>'
            f'<rect x="{x+16}" y="{y+21}" width="22" height="4" rx="2" fill="{c["accent"]}"/>'
            f'<rect x="{x+16}" y="{y+30}" width="16" height="4" rx="2" fill="{c["muted"]}"/>'
            f'<path d="M{x+12} {y+16} C{x+4} {y+20} {x+4} {y+28} {x+12} {y+32}" fill="none" stroke="{c["accent"]}" stroke-width="2.5" stroke-linecap="round"/>'
            f'<path d="M{x+8} {y+12} L{x+12} {y+16} L{x+8} {y+20}" fill="none" stroke="{c["accent"]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>')

def render(c):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="190" viewBox="0 0 1200 190" role="img" aria-labelledby="t d">',
             '<title id="t">What Git Note History does</title>',
             '<desc id="d">Search the past: find a sentence that is gone and the commit that removed it. Compare any two versions: side by side, unified, rendered, or by headings, lists and tasks. Take back one part: bring back one paragraph, with a preview and undo.</desc>',
             f'<g font-family="{SANS}">']
    for i, (title, body, kind) in enumerate(CARDS):
        x = 24 + i * 392
        parts.append(f'<rect x="{x}" y="16" width="368" height="158" rx="22" fill="{c["bg"]}" stroke="{c["line"]}"/>')
        parts.append(f'<rect x="{x+28}" y="44" width="48" height="48" rx="14" fill="{c["accent_soft"]}"/>')
        parts.append(glyph(kind, x + 28, 44, c))
        parts.append(f'<text x="{x+96}" y="78" font-size="27" font-weight="700" fill="{c["fg"]}">{title}</text>')
        for j, line in enumerate(body):
            parts.append(f'<text x="{x+28}" y="{138+j*28}" font-size="20" fill="{c["muted"]}">{line}</text>')
    parts.append('</g></svg>\n')
    return "\n".join(parts)

out = Path(__file__).resolve().parent.parent
for name, c in THEMES.items():
    (out / f"cards-{name}.svg").write_text(render(c), encoding="utf-8")
    print("wrote", f"cards-{name}.svg")
