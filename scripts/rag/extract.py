"""Resumable local OCR with PDF-page coordinates and immutable file identities."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
import pymupdf
from rapidocr_onnxruntime import RapidOCR

ENGINE = None
DOCUMENTS = {}


def needs_rotation(page):
    lines = page['lines']
    vertical = sum(line['height'] * page['height'] > line['width'] * page['width'] * 1.5 for line in lines)
    return bool(len(lines) > 10 and vertical / len(lines) > 0.5)


def recognize(array):
    height, width = array.shape[:2]
    results, _ = ENGINE(array)
    lines = []
    for box, text, confidence in results or []:
        xs, ys = [point[0] for point in box], [point[1] for point in box]
        lines.append({"text": text, "confidence": round(float(confidence), 4), "x": min(xs) / width, "y": min(ys) / height, "width": (max(xs) - min(xs)) / width, "height": (max(ys) - min(ys)) / height})
    return {"lines": lines, "width": width, "height": height}


def initialize_worker():
    global ENGINE
    ENGINE = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1, det_limit_side_len=1280)


def extract_page(task):
    file_path, document_id, page_number, output_root = task
    destination = Path(output_root) / document_id / f"{page_number:04}.json"
    cached = None
    if destination.exists():
        cached = json.loads(destination.read_text())
        if not needs_rotation(cached):
            return document_id, page_number, None
    try:
        if file_path not in DOCUMENTS:
            DOCUMENTS[file_path] = pymupdf.open(file_path)
        page = DOCUMENTS[file_path][page_number - 1]
        scale = min(2.5, 1800 / max(page.rect.width, page.rect.height))
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
        array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        if cached:
            rotation = 90
        else:
            boxes, _ = ENGINE(array, use_cls=False, use_rec=False)
            boxes = boxes or []
            vertical = sum(max(point[1] for point in box) - min(point[1] for point in box) > (max(point[0] for point in box) - min(point[0] for point in box)) * 1.5 for box in boxes)
            rotation = 90 if boxes and vertical / len(boxes) > 0.5 else 0
        if rotation:
            array = np.ascontiguousarray(np.rot90(array, k=3))
        recognized = recognize(array)
        if not rotation and needs_rotation(recognized):
            rotation = 90
            recognized = recognize(np.ascontiguousarray(np.rot90(array, k=3)))
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(f'.{os.getpid()}.tmp')
        temporary.write_text(json.dumps({"page": page_number, **recognized, "rotation": rotation, "method": "rapidocr"}, ensure_ascii=False), encoding='utf-8')
        temporary.replace(destination)
        return document_id, page_number, None
    except Exception as error:
        return document_id, page_number, str(error)


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='RAG')
    parser.add_argument('--output', default='.rag')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    documents = []
    tasks = []
    for file in sorted(Path(args.source).glob('*.pdf')):
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        document_id = digest[:16]
        with pymupdf.open(file) as pdf:
            pages = len(pdf)
        documents.append({"id": document_id, "name": file.name, "sha256": digest, "pages": pages, "bytes": file.stat().st_size, "kind": 'table' if '食物成分' in file.name else 'reference'})
        for page in range(1, pages + 1):
            tasks.append((str(file.resolve()), document_id, page, str((output / 'pages').resolve())))
    if not documents:
        raise SystemExit('No PDF files found in RAG/')
    atomic_json(output / 'manifest.json', {"version": 1, "documents": documents})
    failures = []
    total = len(tasks)
    completed = 0
    started = time.monotonic()
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, initializer=initialize_worker) as pool:
        futures = [pool.submit(extract_page, task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            document_id, page, error = future.result()
            completed += 1
            if error:
                failures.append({"document": document_id, "page": page, "error": error})
            if completed % 25 == 0 or completed == total:
                status = {"stage": 'ocr', "completed": completed, "total": total, "failures": failures, "elapsedSeconds": round(time.monotonic() - started)}
                atomic_json(output / 'progress.json', status)
                print(json.dumps({k: v for k, v in status.items() if k != 'failures'}), flush=True)
    if failures:
        raise SystemExit(f'{len(failures)} pages failed; rerun to resume those pages.')


if __name__ == '__main__':
    main()
