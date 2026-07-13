import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlexiDim Web — Lighting Configuration",
  description: "A complete, local-first web migration of the JCL FlexiDim lighting configuration app.",
  applicationName: "FlexiDim Web",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/flexidim/icon.png", apple: "/flexidim/icon.png" },
  openGraph: { title: "FlexiDim Web", description: "Your lighting system, back under your control.", type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "FlexiDim Web lighting control" }] },
  twitter: { card: "summary_large_image", title: "FlexiDim Web", description: "Your lighting system, back under your control.", images: ["/og.png"] },
};

export const viewport: Viewport = { themeColor: "#a94748", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
