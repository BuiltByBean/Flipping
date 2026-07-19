"""Generate the Flips PWA icon set.

Draws a dark-emerald rounded tile with a circular "flip" arrow ring and a
bold $ glyph, then exports every size the manifest / iOS needs.

Run:  python tools/make_icons.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024  # master canvas


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_rgb(c1, c2, t):
    return tuple(int(round(lerp(a, b, t))) for a, b in zip(c1, c2))


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        row = lerp_rgb(top, bottom, y / (size - 1))
        for x in range(size):
            px[x, y] = row
    return img


def find_font(px):
    candidates = [
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\seguisb.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, px)
    return ImageFont.load_default()


def draw_content(img, scale=1.0):
    """Draw glow + arrow ring + $ centered on img, scaled by `scale`."""
    size = img.size[0]
    cx = cy = size / 2

    # soft radial glow behind the mark
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = int(360 * scale * size / S)
    gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=(16, 185, 129, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(int(110 * size / S)))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)

    r = 330 * scale * size / S          # ring radius
    w = 58 * scale * size / S           # ring stroke width
    c_from = (52, 211, 153)             # emerald 400
    c_to = (13, 148, 136)               # teal 600

    def arc(start_deg, end_deg, col_a, col_b):
        steps = 64
        for i in range(steps):
            t0 = math.radians(lerp(start_deg, end_deg, i / steps))
            t1 = math.radians(lerp(start_deg, end_deg, (i + 1) / steps))
            col = lerp_rgb(col_a, col_b, i / steps)
            x0, y0 = cx + r * math.cos(t0), cy + r * math.sin(t0)
            x1, y1 = cx + r * math.cos(t1), cy + r * math.sin(t1)
            d.line([x0, y0, x1, y1], fill=col + (255,), width=int(w))
        # round caps
        for ang, col in ((start_deg, col_a), (end_deg, col_b)):
            t = math.radians(ang)
            x, y = cx + r * math.cos(t), cy + r * math.sin(t)
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col + (255,))

    def arrowhead(ang_deg, col):
        t = math.radians(ang_deg)
        px_, py_ = cx + r * math.cos(t), cy + r * math.sin(t)
        # direction of travel (clockwise on screen): d/dt of (cos, sin)
        dx, dy = -math.sin(t), math.cos(t)
        nx, ny = math.cos(t), math.sin(t)
        L = 118 * scale * size / S
        Wd = 66 * scale * size / S
        tip = (px_ + dx * L, py_ + dy * L)
        b1 = (px_ + nx * Wd, py_ + ny * Wd)
        b2 = (px_ - nx * Wd, py_ - ny * Wd)
        d.polygon([tip, b1, b2], fill=col + (255,))

    # two arcs with a gap for the arrowheads (flip / cycle motif)
    arc(205, 325, c_from, lerp_rgb(c_from, c_to, 0.5))
    arc(25, 145, c_to, lerp_rgb(c_to, c_from, 0.5))
    arrowhead(325, lerp_rgb(c_from, c_to, 0.5))
    arrowhead(145, lerp_rgb(c_to, c_from, 0.5))

    # $ glyph
    font = find_font(int(430 * scale * size / S))
    bbox = d.textbbox((0, 0), "$", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = cx - tw / 2 - bbox[0]
    ty = cy - th / 2 - bbox[1]
    # subtle drop shadow
    d.text((tx + 8 * size / S, ty + 10 * size / S), "$", font=font, fill=(0, 0, 0, 140))
    d.text((tx, ty), "$", font=font, fill=(236, 253, 245, 255))
    return img


def square_master(scale=1.0):
    base = vertical_gradient(S, (11, 22, 18), (13, 40, 31)).convert("RGBA")
    return draw_content(base, scale)


def rounded(img, radius_frac=0.225):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_frac), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), "PNG")


sq = square_master(1.0)
rd = rounded(sq)

save(rd, "icon-512.png", 512)
save(rd, "icon-192.png", 192)
save(rd, "favicon-48.png", 48)
# maskable: full-bleed square, content pulled into the 80% safe zone
save(square_master(0.72), "icon-512-maskable.png", 512)
# apple touch: full-bleed square (iOS rounds it), content slightly smaller
save(square_master(0.88), "apple-touch-icon.png", 180)

print("icons written to", os.path.abspath(OUT))
