import type { Metadata, Viewport } from "next";
import { Lora, Geist_Mono } from "next/font/google";
import "./globals.css";

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Research agent",
  description: "A research assistant with knowledge base and web search tools",
};

/**
 * `viewportFit: "cover"` is required for `env(safe-area-inset-*)` to report
 * anything but 0 — without it the composer sits under the iPhone home
 * indicator. `maximumScale` is intentionally left alone: capping it would
 * block pinch-zoom, which users with low vision rely on.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#faf9f5",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${lora.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* overflow-x-hidden is a backstop: no child should overflow
          horizontally, but on mobile a single stray element causes the whole
          page to pan sideways, which is worse than clipping it. */}
      <body className="flex min-h-full flex-col overflow-x-hidden">{children}</body>
    </html>
  );
}
