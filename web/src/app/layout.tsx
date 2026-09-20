import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/Providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "去中心化投票 Demo",
  description:
    "链上投票 dApp：候选人元数据存 IPFS，票数与事件由只读索引器投影到 MySQL，前端实时比对链上与索引两侧是否一致。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
