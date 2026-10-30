"use client";

import { useEffect, useRef, useState } from "react";

const CONSENT_KEY = "tobira_consent_v1";
/** How much of the screen the notice is standing on.
 *
 * It is a fixed bar at the bottom of a page whose screens are sized to the
 * viewport and centre their content in it, so it does not push anything out
 * of the way — it covers it. On a 1024x768 window that put the card squarely
 * over the "Confirm my email" button, and a student following the link from
 * their signup email pressed a button that could not be pressed: nothing
 * happened, every time, on the one screen they cannot skip.
 *
 * Publishing the height here lets h-viewport and min-h-viewport in
 * globals.css take it off, so every full-height screen ends where the notice
 * begins instead of running underneath it. Unset, the fallback is 0px and
 * nothing moves. */
const INSET_VAR = "--consent-inset";
// Let the page land first; a notice that pounces on arrival reads as a popup
// to dismiss, one that arrives after a beat reads as information.
const APPEAR_DELAY_MS = 2000;
const EXIT_MS = 400;

/** Data-use notice, shown once per browser until acknowledged.
 *
 * The legal purpose of the data ChatTobira keeps (email, full name, college, study
 * activity) is enrollment verification: the course materials are copyrighted,
 * so access has to be limited to students the course approves, and this banner is
 * where that is disclosed. */
export function ConsentBanner() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

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

  // Keep the reserved strip the same height as the notice. It is measured
  // rather than guessed because the text wraps differently at every width,
  // and a guess that is short by a line puts the button back underneath it.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const publish = () =>
      document.documentElement.style.setProperty(INSET_VAR, `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(INSET_VAR);
    };
  }, [mounted]);

  function acknowledge() {
    try {
      localStorage.setItem(CONSENT_KEY, new Date().toISOString());
    } catch {
      /* remembered for this page view only */
    }
    setOpen(false);
    // Given back as it starts to leave, so the page grows into the space
    // while the card slides out of it rather than a beat afterwards.
    document.documentElement.style.removeProperty(INSET_VAR);
    setTimeout(() => setMounted(false), EXIT_MS);
  }

  if (!mounted) return null;

  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label="Privacy and cookies notice"
      className={[
        // pointer-events: the gutter either side of the card is this
        // element too, and it was swallowing clicks on whatever showed
        // through it.
        "pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-6 sm:pb-6",
        "transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none",
        open ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
      ].join(" ")}
    >
      <div className="pointer-events-auto mx-auto max-w-2xl rounded-2xl border border-stone-200 bg-white/95 p-5 shadow-[0_8px_40px_rgba(0,0,0,0.12)] backdrop-blur sm:p-6">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">
          Privacy &amp; Cookies
        </h2>
        <div className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs leading-relaxed text-stone-600 sm:max-h-none">
          <p>
            ChatTobira collects and stores limited personal information, such
            as your email address, full name, college and semester, and study activity, solely for
            the purposes of confirming that you are a student taking the course,
            providing access to the platform, and maintaining a secure learning
            environment.
          </p>
          <p>
            Because ChatTobira provides access to copyright-protected
            Ritsumeikan Asia Pacific University (APU) textbooks and class
            materials, every account is approved individually by the course
            administrator before it can be used.
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
