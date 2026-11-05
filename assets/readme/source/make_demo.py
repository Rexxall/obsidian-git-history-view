"""Turn recorded keyframes into the README demo: a cursor, click feedback and a camera that follows the action.

    python3 make_demo.py <frames dir> <light|dark> <out.gif>

The frames dir holds start / type / result / compare screenshots (2x) and boxes.json (CSS px) from the recorder.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

BG = {"light": (247, 246, 251), "dark": (21, 20, 27)}
PAGE = {"light": (255, 255, 255), "dark": (13, 17, 23)}  # GitHub page outside the rounded card
LINE = {"light": (228, 225, 238), "dark": (44, 42, 54)}
ACCENT = {"light": (122, 90, 240), "dark": (164, 139, 255)}
RED = {"light": (201, 58, 64), "dark": (240, 124, 128)}
W, PAD, RADIUS, CROP_LEFT, SCALE = 1200, 40, 22, 88, 2
SIDEBAR = (1624, 84)  # close-up origin in screenshot px; width runs to the right edge


def smooth(t):
    return t * t * (3 - 2 * t)


class Film:
    def __init__(self, mode, size):
        self.mode, self.frames, self.durations = mode, [], []
        sw, sh = size
        self.full = (CROP_LEFT, 0, sw, sh)
        self.aspect = (sw - CROP_LEFT) / sh
        self.inner = W - 2 * PAD
        self.height = round(self.inner / self.aspect)

    def cam(self, x, y, w):
        return (x, y, x + w, y + w / self.aspect)

    def around(self, box, w):
        """Camera of width w centred on a screenshot-px box, kept inside the window."""
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        h = w / self.aspect
        x = min(max(cx - w / 2, self.full[0]), self.full[2] - w)
        y = min(max(cy - h / 2, 0), self.full[3] - h)
        return self.cam(x, y, w)

    @staticmethod
    def mix(a, b, t):
        return tuple(p + (q - p) * t for p, q in zip(a, b))

    def to_out(self, cam, x, y):
        s = self.inner / (cam[2] - cam[0])
        return PAD + (x - cam[0]) * s, PAD + (y - cam[1]) * s

    def add(self, shot, cam, ms, cursor=None, ripple=None, ring=None, ring_color=None):
        crop = shot.crop(tuple(round(v) for v in cam)).resize((self.inner, self.height), Image.LANCZOS)
        layer = Image.new("RGBA", crop.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        if ring:
            (x0, y0), (x1, y1) = self.to_out(cam, ring[0] - 8, ring[1] - 8), self.to_out(cam, ring[2] + 8, ring[3] + 8)
            d.rounded_rectangle((x0 - PAD, y0 - PAD, x1 - PAD, y1 - PAD), 12, outline=(*ring_color, 230), width=4)
        if ripple:
            (x, y), p = self.to_out(cam, *ripple[:2]), ripple[2]
            r = 10 + 26 * p
            d.ellipse((x - PAD - r, y - PAD - r, x - PAD + r, y - PAD + r), fill=(*ACCENT[self.mode], round(110 * (1 - p))))
        if cursor:
            x, y = self.to_out(cam, *cursor)
            x, y = x - PAD, y - PAD
            pts = [(0, 0), (0, 26), (6.5, 20), (11, 30), (15.5, 28), (11, 18.5), (19, 18.5)]
            d.polygon([(x + a * 1.35, y + b * 1.35) for a, b in pts], fill=(20, 20, 24, 255), outline=(255, 255, 255, 255), width=2)
        crop = Image.alpha_composite(crop.convert("RGBA"), layer).convert("RGB")
        self.frames.append(self.frame(crop))
        self.durations.append(ms)

    def frame(self, shot):
        H = shot.height + 2 * PAD
        canvas = Image.new("RGB", (W, H), BG[self.mode])
        shadow = Image.new("L", (W, H), 0)
        ImageDraw.Draw(shadow).rounded_rectangle((PAD, PAD + 8, PAD + self.inner, PAD + shot.height + 8), RADIUS, fill=70 if self.mode == "light" else 140)
        canvas.paste((0, 0, 0) if self.mode == "dark" else (60, 50, 110), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
        mask = Image.new("L", shot.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), RADIUS, fill=255)
        canvas.paste(shot, (PAD, PAD), mask)
        ImageDraw.Draw(canvas).rounded_rectangle((PAD, PAD, PAD + self.inner - 1, PAD + shot.height - 1), RADIUS, outline=LINE[self.mode], width=2)
        card = Image.new("L", (W, H), 0)
        ImageDraw.Draw(card).rounded_rectangle((0, 0, W - 1, H - 1), 28, fill=255)
        page = Image.new("RGB", (W, H), PAGE[self.mode])
        page.paste(canvas, (0, 0), card)
        return page

    def save(self, out):
        pal = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in self.frames]
        pal[0].save(out, save_all=True, append_images=pal[1:], duration=self.durations, loop=0, optimize=True, disposal=1)
        print(out, Path(out).stat().st_size // 1024, "KB", len(self.frames), "frames", sum(self.durations) / 1000, "s")


def main(frames_dir, mode, out):
    d = Path(frames_dir)
    boxes = {k: [v * SCALE for v in b] for k, b in json.loads((d / "boxes.json").read_text()).items()}
    shots = {f.stem.split("-", 1)[1]: [] for f in d.glob("*.png")}
    for f in sorted(d.glob("*.png")):
        shots[f.stem.split("-", 1)[1]].append(Image.open(f).convert("RGB"))
    start, types, result, compare = shots["start"][0], shots["type"], shots["result"][0], shots["compare"][0]
    film = Film(mode, start.size)
    side = film.cam(SIDEBAR[0], SIDEBAR[1], start.width - SIDEBAR[0])
    centre = lambda b: ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    search = (boxes["search"][0] + 90 * SCALE, centre(boxes["search"])[1])
    button = centre(boxes["button"])
    enter = (start.width - 120, start.height - 260)

    film.add(start, side, 700)
    for k in range(1, 11):  # cursor glides to the search field
        film.add(start, side, 35, cursor=film.mix(enter, search, smooth(k / 10)))
    for k in range(4):
        film.add(start, side, 45, cursor=search, ripple=(*search, k / 3))
    for img in types:
        film.add(img, side, 85, cursor=search)
    film.add(result, side, 500, cursor=search)
    for k in range(3):  # the row that says when it was deleted
        film.add(result, side, 140, cursor=search, ring=boxes["trail"], ring_color=RED[mode] if k % 2 == 0 else ACCENT[mode])
    film.add(result, side, 700, cursor=search, ring=boxes["trail"], ring_color=RED[mode])
    for k in range(1, 11):  # then to the button that opens it
        film.add(result, side, 35, cursor=film.mix(search, button, smooth(k / 10)))
    film.add(result, side, 250, cursor=button)
    for k in range(4):
        film.add(result, side, 45, cursor=button, ripple=(*button, k / 3))
    near = film.around(boxes["deleted"], 1500)
    for k in range(1, 11):  # camera travels to what was removed
        film.add(compare, film.mix(side, near, smooth(k / 10)), 55)
    film.add(compare, near, 900)
    film.add(compare, near, 1200, ring=boxes["deleted"], ring_color=RED[mode])
    for k in range(1, 9):  # and pulls back to the whole window
        film.add(compare, film.mix(near, film.full, smooth(k / 8)), 55)
    film.add(compare, film.full, 2600)
    film.save(out)


if __name__ == "__main__":
    main(*sys.argv[1:4])
