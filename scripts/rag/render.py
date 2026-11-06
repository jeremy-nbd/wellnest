import json
import sys
from pathlib import Path
import pymupdf

with pymupdf.open(sys.argv[1]) as document:
    page = document[int(sys.argv[2]) - 1]
    rotation = 0
    if len(sys.argv) > 4 and Path(sys.argv[4]).exists():
        ocr = json.loads(Path(sys.argv[4]).read_text())
        lines = ocr['lines']
        vertical = sum(line['height'] * ocr['height'] > line['width'] * ocr['width'] * 1.5 for line in lines)
        if ocr.get('rotation') == 90 or (lines and vertical / len(lines) > 0.5):
            rotation = 90
    scale = min(2.5, 1800 / max(page.rect.width, page.rect.height))
    output = Path(sys.argv[3])
    temporary = output.with_suffix('.tmp.png')
    page.get_pixmap(matrix=pymupdf.Matrix(scale, scale).prerotate(rotation), colorspace=pymupdf.csRGB, alpha=False).save(temporary)
    temporary.replace(output)
