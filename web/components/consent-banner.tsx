"use client";

import { useEffect, useState } from "react";

const CONSENT_KEY = "tobira_consent_v1";

/** Data-use notice, shown once per browser until acknowledged.
 *
 * The legal purpose of the data ChatTobira keeps (email, first name, study
 * activity) is enrollment verification: the course materials are copyrighted,
 * so access has to be verifiably limited to APU students, and this banner is
 * where that is disclosed. */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(CONSENT_KEY) === null);
    } catch {
      // Storage unavailable (private mode): stay quiet rather than nag on
      // every page view with no way to remember the acknowledgement.
    }
  }, []);

  function acknowledge() {
    try {
      localStorage.setItem(CONSENT_KEY, new Date().toISOString());
    } catch {
      /* remembered for this page view only */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-[0_-2px_12px_rgba(0,0,0,0.06)] backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600">
          <span className="font-medium text-stone-800">
            Privacy &amp; cookies.
          </span>{" "}
          ChatTobira stores limited personal data — your email address, first
          name, and study activity — solely to verify that you are an enrolled
          student of Ritsumeikan Asia Pacific University (APU). The course
          materials on this platform are copyright-protected, so access must be
          restricted to verified APU students. Cookies are used only to keep
          you signed in and to operate the free trial.
        </p>
        <button
          onClick={acknowledge}
          className="shrink-0 rounded-lg bg-stone-900 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700"
        >
          I understand
        </button>
      </div>
    </div>
  );
}
