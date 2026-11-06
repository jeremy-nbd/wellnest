"use client";
import { FormEvent, useEffect, useState } from "react";
import { BookOpen, Search, LoaderCircle, ArrowUpRight, X } from "lucide-react";

type Status = {
  ready: boolean;
  pages: number;
  chunks: number;
  model: string;
  dimensions: number;
  documents: { id: string; name: string; pages: number }[];
  progress?: { stage: string; completed: number; total: number };
};
type Hit = {
  id: string;
  documentId: string;
  filename: string;
  page: number;
  text: string;
};
export function NutritionLibrary() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState("成年人每天应该吃多少蔬菜？");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [warning, setWarning] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch("/api/rag/status", {
          signal: controller.signal,
        });
        const result = (await response.json()) as Status & { error?: string };
        if (!response.ok) throw new Error(result.error);
        setStatus(result);
        setServiceError("");
      } catch (error) {
        if (!controller.signal.aborted)
          setServiceError(
            error instanceof Error ? error.message : "知识库暂不可用。",
          );
      }
    }
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setWarning("");
    try {
      const response = await fetch("/api/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const result = (await response.json()) as {
        hits: Hit[];
        warning?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error);
      setHits(result.hits);
      setSearched(true);
      setWarning(result.warning || "");
    } catch (error) {
      setError(error instanceof Error ? error.message : "检索失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nutrition-library">
      <button
        className="library-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <BookOpen size={16} />
        <span>
          <strong>营养师 PDF 知识库</strong>
          <small>
            {status?.ready
              ? `${status.documents.length} 份资料 · ${status.pages.toLocaleString()} 页`
              : status?.progress
                ? `正在${status.progress.stage === "ocr" ? "识别文档" : "建立向量"} · ${status.progress.completed}/${status.progress.total}`
                : "查看文档与检索"}
          </small>
        </span>
        {open ? <X size={14} /> : <Search size={14} />}
      </button>
      {open && (
        <div className="library-body">
          {status?.documents.map((doc) => (
            <div className="library-document" key={doc.id}>
              <BookOpen size={13} />
              <span>{doc.name}</span>
              <small>{doc.pages} 页</small>
            </div>
          ))}
          {status?.ready && (
            <p className="library-meta">
              {status.chunks.toLocaleString()} 个片段 · {status.model} ·{" "}
              {status.dimensions} 维
            </p>
          )}
          <p className="library-meta">
            本地 OCR → 分段 → 向量＋关键词检索 → 营养师回答。页码使用 PDF
            文件页序，表格数值可打开原页核对。
          </p>
          <form onSubmit={search} className="library-search">
            <input
              aria-label="检索营养知识库"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={500}
              placeholder="输入食物、人群或营养问题"
            />
            <button
              disabled={busy || !status?.ready || !query.trim()}
              aria-label="搜索营养资料"
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Search size={16} />
              )}
            </button>
          </form>
          {(error || serviceError) && (
            <p className="library-message" role="alert">
              {error || serviceError}
            </p>
          )}
          {warning && <p className="library-message">{warning}</p>}
          {searched && !hits.length && (
            <p className="library-meta">
              没有找到相关片段，请换一个具体的问题。
            </p>
          )}
          <div className="library-hits">
            {hits.map((hit) => (
              <article key={hit.id}>
                <a
                  href={`/api/rag/page?document=${hit.documentId}&page=${hit.page}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {hit.filename} · PDF 第 {hit.page} 页{" "}
                  <ArrowUpRight size={12} />
                </a>
                <p>{hit.text}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
