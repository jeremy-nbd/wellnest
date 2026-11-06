import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "共养 · 多师共管工作台",
  description: "五位专业 AI 助手协同的健康咨询与 Agent 工作流演示",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
