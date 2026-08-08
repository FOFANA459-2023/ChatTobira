import type { Metadata } from "next";

import { ConsentBanner } from "@/components/consent-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatTobira",
  description:
    "Study assistant for the Tobira and Foundation Japanese curriculum.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ConsentBanner />
      </body>
    </html>
  );
}
