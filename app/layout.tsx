import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Chem-E-Car 赛事资料共享中心";
const description = "统一共享报名表、EDP、阿里邮箱附件、海报和视频；每校只保留最新有效版本，电脑与手机浏览器均可安全访问。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const preview = `${origin}/og-shared-center.png`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: { title, description, type: "website", url: origin, images: [{ url: preview, width: 1536, height: 1024, alt: "Chem-E-Car 赛事资料共享中心" }] },
    twitter: { card: "summary_large_image", title, description, images: [preview] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
