import type { Metadata, Viewport } from "next";
import { Fraunces, Familjen_Grotesk } from "next/font/google";
import "./globals.css";

// Self-hosted at build time (served from /_next/static), so the locked CSP
// font-src 'self' stays happy - no runtime request to Google.
const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz", "SOFT"],
});
const body = Familjen_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Country Pool",
  description: "Play pool where every ball is a glossy 3D country flag.",
  applicationName: "Country Pool",
};

export const viewport: Viewport = {
  themeColor: "#0e4a2d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
