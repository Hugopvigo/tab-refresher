"""Genera los iconos con indicador verde (pestaña con recarga automática activa)
a partir de icon.png. Ejecutar una sola vez, y de nuevo solo si icon.png cambia:

    python3 generate_active_icons.py
"""
from PIL import Image, ImageDraw

SRC = "icon.png"
SIZES = (16, 32, 48)
GREEN = (52, 168, 83, 255)   # #34a853, mismo verde que .hero-dot.on en el popup
BORDER = (15, 17, 23, 255)   # #0f1117, fondo oscuro del popup

base = Image.open(SRC).convert("RGBA")

for size in SIZES:
    icon = base.resize((size, size), Image.LANCZOS)
    draw = ImageDraw.Draw(icon)

    r = max(3, round(size * 0.28))
    cx, cy = size - r - 1, r + 1
    border_r = r + max(1, round(size * 0.06))

    draw.ellipse((cx - border_r, cy - border_r, cx + border_r, cy + border_r), fill=BORDER)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GREEN)

    out = f"icon-active-{size}.png"
    icon.save(out)
    print(f"generado {out}")
