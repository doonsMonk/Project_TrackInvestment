"""Generate assets/icon.ico: a rounded blue tile with a rising value line. Needs Pillow (build-time only)."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
SIZE = 256
BLUE = (42, 120, 214, 255)  # matches --series-1 in styles.css
WHITE = (255, 255, 255, 255)
WHITE_SOFT = (255, 255, 255, 150)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=56, fill=BLUE)
d.line([(44, 206), (212, 206)], fill=WHITE_SOFT, width=10)                     # baseline
d.line([(44, 176), (92, 136), (128, 154), (168, 100), (212, 68)], fill=WHITE, width=18, joint="curve")
d.ellipse((212 - 17, 68 - 17, 212 + 17, 68 + 17), fill=WHITE)                   # end marker

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", OUT)
