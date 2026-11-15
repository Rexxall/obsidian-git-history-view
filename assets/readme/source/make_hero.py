"""Render the README hero in light and dark from one layout."""
from pathlib import Path

THEMES = {
    "light": dict(bg="#F4F7FA", fg="#15232F", muted="#5B6B78", line="#DCE5EC",
                  card="#FFFFFF", accent="#2D4F7A", action="#2D4F7A",
                  action_text="#FFFFFF", soft="#D8ECFF",
                  red="#C4383E", red_soft="#FCEBEC", green="#207B53", green_soft="#E5F4EC"),
    "dark": dict(bg="#0F1822", fg="#E6EEF5", muted="#93A4B3", line="#22303D",
                 card="#16222E", accent="#8EC5FF", action="#8EC5FF",
                 action_text="#0B1626", soft="#1C3044",
                 red="#F07C80", red_soft="#3A1E24", green="#5CC892", green_soft="#16301F"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t d">
  <title id="t">Git Note History</title>
  <desc id="d">Find the sentence you deleted, see which commit removed it, and take back only that part. A note's timeline shows that “The best plans leave one afternoon empty.” was added in “Write the rule down” and removed in “Rewrite the middle, drop the slogan”.</desc>
  <rect width="1200" height="400" rx="28" fill="{bg}"/>

  <g id="title-block" font-family="{sans}">
    <text x="64" y="118" font-family="{mono}" font-size="17" letter-spacing="2" fill="{accent}">OBSIDIAN PLUGIN · BROWSE NOTE HISTORY</text>
    <text x="62" y="196" font-size="64" font-weight="700" letter-spacing="-1.5" fill="{fg}">Git Note History</text>
    <text x="64" y="252" font-size="29" fill="{fg}">Find the sentence you deleted.</text>
    <text x="64" y="292" font-size="29" fill="{muted}">Take back only that part.</text>
    <text x="64" y="346" font-family="{mono}" font-size="17" fill="{muted}">free · no account · no network</text>
  </g>

  <g id="project-proof" font-family="{sans}">
    <rect x="724" y="32" width="436" height="304" rx="20" fill="{soft}" stroke="{accent}"/>
    <rect x="712" y="40" width="436" height="304" rx="20" fill="{bg}" stroke="{accent}"/>
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{card}" stroke="{line}"/>
    <rect x="724" y="72" width="388" height="44" rx="22" fill="{bg}" stroke="{line}"/>
    <circle cx="748" cy="92" r="7" fill="none" stroke="{accent}" stroke-width="2"/>
    <path d="M753 97 L759 103" stroke="{accent}" stroke-width="2" stroke-linecap="round"/>
    <text x="770" y="101" font-size="19" fill="{fg}">one afternoon empty</text>

    <path d="M742 150 V258" stroke="{line}" stroke-width="2"/>

    <circle cx="742" cy="150" r="6" fill="{card}" stroke="{accent}" stroke-width="2"/>
    <text x="764" y="157" font-size="20" fill="{fg}">Add ending</text>

    <rect x="724" y="178" width="388" height="48" rx="12" fill="{action}"/>
    <circle cx="742" cy="202" r="6" fill="{action_text}"/>
    <text x="764" y="209" font-size="20" font-weight="600" fill="{action_text}">Rewrite the middle…</text>
    <rect x="990" y="189" width="108" height="26" rx="13" fill="{red_soft}"/>
    <text x="1044" y="207" font-size="17" text-anchor="middle" fill="{red}">removed it</text>

    <circle cx="742" cy="254" r="6" fill="{card}" stroke="{accent}" stroke-width="2"/>
    <text x="764" y="261" font-size="20" fill="{fg}">Write the rule down</text>
    <rect x="1006" y="241" width="92" height="26" rx="13" fill="{green_soft}"/>
    <text x="1052" y="259" font-size="17" text-anchor="middle" fill="{green}">added it</text>

    <rect x="724" y="290" width="388" height="40" rx="10" fill="{red_soft}"/>
    <text x="742" y="316" font-size="19" fill="{red}" text-decoration="line-through">…leave one afternoon empty.</text>
  </g>
</svg>
"""

ZH_TEXT = {
    "OBSIDIAN PLUGIN · BROWSE NOTE HISTORY": "OBSIDIAN 插件 · 查看笔记历史",
    "Find the sentence you deleted.": "删掉的那句话，找得回来。",
    "Take back only that part.": "只取回需要的那一段。",
    "free · no account · no network": "免费 · 不要账号 · 不联网",
    "removed it": "删掉了它",
    "added it": "写进了它",
}


def render(c, language="en"):
    svg = TEMPLATE.format(sans=SANS, mono=MONO, **c)
    if language == "zh":
        for english, chinese in ZH_TEXT.items():
            svg = svg.replace(english, chinese)
        start = svg.index('  <desc id="d">')
        end = svg.index('</desc>', start) + len('</desc>')
        svg = svg[:start] + '  <desc id="d">找回删掉的那句话，看清哪次提交删掉了它，只取回需要的部分。示例时间线显示一句话被写入和删除的版本。</desc>' + svg[end:]
        svg = svg.replace('font-size="29"', 'font-size="30"')
    return svg


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent
    for language, prefix in (("en", "hero"), ("zh", "hero-zh")):
        for name, c in THEMES.items():
            target = out / f"{prefix}-{name}.svg"
            target.write_text(render(c, language), encoding="utf-8")
            print("wrote", target.name)
