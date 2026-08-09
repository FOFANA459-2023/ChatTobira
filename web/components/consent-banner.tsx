"use client";

import { useEffect, useState } from "react";

const CONSENT_KEY = "tobira_consent_v1";
// Let the page land first; a notice that pounces on arrival reads as a popup
// to dismiss, one that arrives after a beat reads as information.
const APPEAR_DELAY_MS = 2000;
const EXIT_MS = 400;

/** Data-use notice, shown once per browser until acknowledged.
 *
 * The legal purpose of the data ChatTobira keeps (email, first name, study
 * activity) is enrollment verification: the course materials are copyrighted,
 * so access has to be verifiably limited to APU students, and this banner is
 * where that is disclosed. */
export function ConsentBanner() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(CONSENT_KEY) !== null) return;
    } catch {
      // Storage unavailable (private mode): stay quiet rather than nag on
      // every page view with no way to remember the acknowledgement.
      return;
    }
    const appear = setTimeout(() => {
      setMounted(true);
      // Two frames so the hidden position paints before the transition runs;
      // otherwise the card appears already in place with no slide.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setOpen(true)),
      );
    }, APPEAR_DELAY_MS);
    return () => clearTimeout(appear);
  }, []);

  function acknowledge() {
    try {
      localStorage.setItem(CONSENT_KEY, new Date().toISOString());
    } catch {
      /* remembered for this page view only */
    }
    setOpen(false);
    setTimeout(() => setMounted(false), EXIT_MS);
  }

  if (!mounted) return null;

  return (
    <div
      role="dialog"
      aria-label="Privacy and cookies notice"
      className={[
        "fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-6 sm:pb-6",
        "transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none",
        open ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
      ].join(" ")}
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-stone-200 bg-white/95 p-5 shadow-[0_8px_40px_rgba(0,0,0,0.12)] backdrop-blur sm:p-6">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">
          Privacy &amp; Cookies
        </h2>
        <div className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs leading-relaxed text-stone-600 sm:max-h-none">
          <p>
            ChatTobira collects and stores limited personal information, such
            as your email address, first name, and study activity, solely for
            the purposes of verifying your eligibility as an enrolled student
            of Ritsumeikan Asia Pacific University (APU), providing access to
            the platform, and maintaining a secure learning environment.
          </p>
          <p>
            Because ChatTobira provides access to copyright-protected APU
            course materials, access is restricted to verified APU students.
            Your personal information will not be used for purposes unrelated
            to operating and securing the platform.
          </p>
          <p>
            Cookies and similar technologies are used only as necessary to
            keep you signed in, maintain your session, and operate the
            platform&rsquo;s free trial. By using ChatTobira, you acknowledge
            and agree to the use of cookies and the collection of information
            described above.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={acknowledge}
            className="rounded-lg bg-stone-900 px-5 py-2 text-xs font-medium text-white transition-colors hover:bg-stone-700 active:scale-[0.98]"
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}
