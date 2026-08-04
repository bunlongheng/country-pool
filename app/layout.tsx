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
  metadataBase: new URL("https://pool-bheng.vercel.app"),
  title: "Pool",
  description: "A 3D pool game that teaches categories - countries, colors, fruits, veggies, and US state flags.",
  applicationName: "Pool",
  // Big link-preview card when shared (Open Graph + Twitter summary_large_image).
  // The hero image is auto-linked from app/opengraph-image.png + app/twitter-image.png.
  openGraph: {
    title: "Pool",
    description: "A 3D pool game that teaches categories - countries, colors, fruits, veggies, and US state flags.",
    url: "https://pool-bheng.vercel.app",
    siteName: "Pool",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pool",
    description: "A 3D pool game that teaches categories - countries, colors, fruits, veggies, and US state flags.",
  },
  // iOS "Add to Home Screen" title + standalone chrome.
  appleWebApp: {
    capable: true,
    title: "Pool",
    statusBarStyle: "black-translucent",
  },
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
