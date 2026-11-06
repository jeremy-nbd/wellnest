export function pageRows(page) {
  let lines = page.lines.filter((line) => line.text.trim());
  const vertical = lines.filter(
    (line) => line.height * page.height > line.width * page.width * 1.5,
  ).length;
  const rotated = lines.length > 0 && vertical / lines.length > 0.5;
  if (rotated) {
    // The scanned landscape tables are turned 90 degrees counterclockwise.
    lines = lines.map((line) => ({
      ...line,
      x: 1 - line.y - line.height,
      y: line.x,
      width: line.height,
      height: line.width,
    }));
  }
  const rows = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const center = line.y + line.height / 2;
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate.center - center) <
        Math.min(line.height * 0.45, 0.009),
    );
    if (row) row.items.push(line);
    else rows.push({ center, items: [line] });
  }
  return rows
    .sort((a, b) => a.center - b.center)
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" | "),
    );
}
