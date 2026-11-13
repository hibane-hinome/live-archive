"""把两张原始插画处理成站点用的装饰资源。

用法::

    python tools/prepare_art.py <场景图> <白底立绘图>

产物（写入 site/brand/）::

    scene-spring.webp   场景图压到 1600px 宽，作为全站氛围背景
    character-full.webp 立绘抠掉白底、裁到人物边界，带 alpha

白底不能按「接近白色」整体抠：衣服上的白花、眼白、皮肤高光也是浅色。
做法是从四条边做连通域 floodfill，只把和画外相连的白底判成背景；
再对紧邻背景的 2px 边缘按白度给半透明，并反解一次白底混色，
这样发丝和外轮廓不会留一圈硬白边。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "brand"
SENTINEL = (255, 0, 255)


def prepare_scene(src: Path) -> Path:
    im = Image.open(src).convert("RGB")
    if im.width > 1600:
        im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
    dst = OUT / "scene-spring.webp"
    im.save(dst, "WEBP", quality=82, method=6)
    return dst


def prepare_character(src: Path) -> Path:
    im = Image.open(src).convert("RGB")
    w, h = im.size

    # 1) 连通域：只吞掉与画外相连的白底
    probe = im.copy()
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        ImageDraw.floodfill(probe, seed, SENTINEL, thresh=28)

    arr = np.asarray(probe)
    bg = (arr[:, :, 0] == SENTINEL[0]) & (arr[:, :, 1] == SENTINEL[1]) & (arr[:, :, 2] == SENTINEL[2])

    # 2) 与背景相邻的 2px 做白度羽化；角色内部的浅色不受影响
    near = np.asarray(Image.fromarray((bg * 255).astype("uint8")).filter(ImageFilter.MaxFilter(5))) > 0
    edge = near & ~bg
    orig = np.asarray(im).astype(np.float32)
    whiteness = orig.min(axis=2)  # 越接近纯白越大
    soft = np.clip((255.0 - whiteness) / 30.0 * 255.0, 0, 255)

    alpha = np.where(bg, 0.0, 255.0).astype(np.float32)
    alpha[edge] = np.minimum(alpha[edge], soft[edge])

    # 3) 半透明像素是「前景 × a + 白底 × (1-a)」，反解回前景色，去掉白边
    a = alpha / 255.0
    safe = np.maximum(a, 0.04)
    rgb = orig.copy()
    for c in range(3):
        rgb[:, :, c] = (orig[:, :, c] - (1.0 - a) * 255.0) / safe
    rgb = np.clip(rgb, 0, 255)
    half = (alpha > 0) & (alpha < 255)
    rgb[~half] = orig[~half]

    rgba = np.dstack([rgb.astype(np.uint8), alpha.astype(np.uint8)])
    cut = Image.fromarray(rgba, "RGBA")
    box = cut.getchannel("A").getbbox()
    cut = cut.crop(box)

    # 站点里显示高度约 300–420px，留 1200px 高足够 Retina
    if cut.height > 1200:
        cut = cut.resize((round(cut.width * 1200 / cut.height), 1200), Image.LANCZOS)

    dst = OUT / "character-full.webp"
    cut.save(dst, "WEBP", quality=88, method=6)
    return dst


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    for fn, p in ((prepare_scene, Path(sys.argv[1])), (prepare_character, Path(sys.argv[2]))):
        out = fn(p)
        print(f"{out.relative_to(ROOT)}  {out.stat().st_size / 1024:.0f} KB  {Image.open(out).size}")
