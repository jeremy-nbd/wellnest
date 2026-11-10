/** Keep bibliography details in the source panel, including for saved answers. */
export function answerForDisplay(text: string): string {
  return text
    // Some models generate their own source disclosure instead of using the UI.
    .replace(
      /<details\b[^>]*>\s*<summary\b[^>]*>[^<]*(?:来源|参考|文献)[^<]*<\/summary>[\s\S]*?(?:<\/details>|$)/gi,
      "",
    )
    .trimStart()
    .replace(
      /^(?:#{1,6}\s+)?(?:\*\*)?(?:参考来源|资料来源|来源)(?:\*\*)?\s*[：:](?:\*\*)?\s*([^\r\n]*)(?:\r?\n|$)/,
      (_match, source: string) => {
        // Keep data qualifications, even when an older answer puts them here.
        if (/演示|虚构|估算|待核对|未经核验/.test(source)) return source + "\n";
        // Some saved answers start their advice on the same line.
        const end = source.indexOf("。");
        return end < 0 ? "" : source.slice(end + 1).replace(/^\*\*/, "");
      },
    )
    .trimStart()
    .replace(
      /\[([^\]]+)\]\((\/api\/rag\/page\?[^\s)]+)\)/g,
      (_match, label: string) =>
        /\.pdf\b|PDF\s*第|第\s*\d+(?:\s*[-–、,，]\s*\d+)*\s*页|^(?:来源|参考|原文|查看原文|查看来源)$/i.test(label)
          ? ""
          : label,
    )
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/[ \t]+([，。；：！？、])/g, "$1");
}
