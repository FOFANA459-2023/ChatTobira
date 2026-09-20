import type { Metadata, Viewport } from "next";

import { ConsentBanner } from "@/components/consent-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatTobira",
  description:
    "Study assistant for the Tobira and Foundation Japanese curriculum.",
};

/** One screenful, on any phone, including while the keyboard is up.
 *
 * width/initial-scale are what Next writes by default and are restated here
 * only because the third line has to live somewhere. That line is the one
 * that matters: by default a phone keyboard does not resize the page, it
 * covers it — the layout stays its full height behind the keyboard and the
 * browser scrolls and scales what is left, which is why answering a question
 * leaves the student pinching the page back to width afterwards.
 * resizes-content hands the layout the smaller viewport instead, so the page
 * re-lays itself out above the keyboard and everything still fits.
 *
 * Nothing here restricts zoom. maximum-scale and user-scalable=no would stop
 * iOS zooming on focus too, and they would also stop a student zooming in on
 * a kanji they cannot make out — the fields are 16px in globals.css instead,
 * which fixes the same thing without taking the gesture away. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
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
