"""Render the README hero in light and dark from one layout."""
from pathlib import Path

THEMES = {
    "light": dict(bg="#F7F6FB", fg="#1D1B26", muted="#6B6780", line="#E4E1EE",
                  card="#FFFFFF", accent="#7A5AF0", accent_soft="#EEE9FF",
                  red="#C93A40", red_soft="#FCEBEC", green="#22855A", green_soft="#E5F4EC"),
    "dark": dict(bg="#15141B", fg="#EEECF5", muted="#9C98AF", line="#2C2A36",
                 card="#1E1D26", accent="#A48BFF", accent_soft="#2C2643",
                 red="#F07C80", red_soft="#3A1E24", green="#5CC892", green_soft="#16301F"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t d">
  <title id="t">Git Note History</title>
  <desc id="d">Find the sentence you deleted, see which commit removed it, and take back only that part. A note's timeline shows that “The best plans leave one afternoon empty.” was added in “Write the rule down” and removed in “Rewrite the middle, drop the slogan”.</desc>
  <rect width="1200" height="400" rx="28" fill="{bg}"/>

  <g id="title-block" font-family="{sans}">
    <text x="64" y="118" font-family="{mono}" font-size="17" letter-spacing="2" fill="{accent}">OBSIDIAN PLUGIN · READS GIT, NEVER WRITES</text>
    <text x="62" y="196" font-size="64" font-weight="700" letter-spacing="-1.5" fill="{fg}">Git Note History</text>
    <text x="64" y="252" font-size="29" fill="{fg}">Find the sentence you deleted.</text>
    <text x="64" y="292" font-size="29" fill="{muted}">Take back only that part.</text>
    <text x="64" y="346" font-family="{mono}" font-size="17" fill="{muted}">free · no account · no network</text>
  </g>

  <g id="project-proof" font-family="{sans}">
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{card}" stroke="{line}"/>
    <rect x="724" y="72" width="388" height="44" rx="22" fill="{bg}" stroke="{line}"/>
    <circle cx="748" cy="92" r="7" fill="none" stroke="{muted}" stroke-width="2"/>
    <path d="M753 97 L759 103" stroke="{muted}" stroke-width="2" stroke-linecap="round"/>
    <text x="770" y="101" font-size="19" fill="{fg}">one afternoon empty</text>

    <path d="M742 150 V258" stroke="{line}" stroke-width="2"/>

    <circle cx="742" cy="150" r="6" fill="{card}" stroke="{muted}" stroke-width="2"/>
    <text x="764" y="157" font-size="20" fill="{fg}">Add ending</text>

    <rect x="724" y="178" width="388" height="48" rx="12" fill="{accent_soft}"/>
    <circle cx="742" cy="202" r="6" fill="{accent}"/>
    <text x="764" y="209" font-size="20" font-weight="600" fill="{fg}">Rewrite the middle…</text>
    <rect x="990" y="189" width="108" height="26" rx="13" fill="{red_soft}"/>
    <text x="1044" y="207" font-size="17" text-anchor="middle" fill="{red}">removed it</text>

    <circle cx="742" cy="254" r="6" fill="{card}" stroke="{muted}" stroke-width="2"/>
    <text x="764" y="261" font-size="20" fill="{fg}">Write the rule down</text>
    <rect x="1006" y="241" width="92" height="26" rx="13" fill="{green_soft}"/>
    <text x="1052" y="259" font-size="17" text-anchor="middle" fill="{green}">added it</text>

    <rect x="724" y="290" width="388" height="40" rx="10" fill="{red_soft}"/>
    <text x="742" y="316" font-size="19" fill="{red}" text-decoration="line-through">…leave one afternoon empty.</text>
  </g>
</svg>
"""

if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent
    for name, c in THEMES.items():
        (out / f"hero-{name}.svg").write_text(TEMPLATE.format(sans=SANS, mono=MONO, **c), encoding="utf-8")
        print("wrote", out / f"hero-{name}.svg")
