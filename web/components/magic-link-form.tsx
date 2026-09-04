"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { isAdminEmail } from "@/lib/admin";
import { EMAIL_SHAPE, normalizeEmail } from "@/lib/email";
import { createClient } from "@/lib/supabase/client";

type Status =
  | "idle"
  | "sending"
  | "sent"
  | "not_invited"
  | "admin"
  | "bad_email"
  | "cooldown"
  | "error";

/** Email → magic-link form, shared by the login page and the chat's
 * out-of-trial panel. The admin email is refused here: the admin account
 * signs in with a password only, so a sign-in link for it must never be
 * requestable from the app. */
export function MagicLinkForm({
  disabled = false,
  showAdminLink = false,
}: {
  disabled?: boolean;
  showAdminLink?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  /** Seconds until another link can be requested for this address. Supabase
   * refuses a second send inside its window, and a student who is told
   * nothing simply presses the button again and again. */
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  async function sendLink(event: React.FormEvent) {
    event.preventDefault();
    // Students type school addresses with the IME still on — full-width ＠
    // and letters — which must normalise, not fail.
    const address = normalizeEmail(email);
    if (!EMAIL_SHAPE.test(address)) {
      setStatus("bad_email");
      return;
    }
    if (isAdminEmail(address)) {
      setStatus("admin");
      return;
    }
    setStatus("sending");

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
      });

      if (!error) {
        setStatus("sent");
      } else if (/database error|not_invited/i.test(error.message)) {
        // The allowlist trigger rejected the signup inside auth.users.
        setStatus("not_invited");
      } else if (
        error.status === 429 ||
        /after (\d+) seconds?|rate limit|too many requests/i.test(error.message)
      ) {
        // A link is already in flight. Saying so — with the number of seconds
        // — is the difference between waiting and hammering the button.
        const seconds = /after (\d+) seconds?/i.exec(error.message)?.[1];
        setWait(seconds ? Number(seconds) : 60);
        setStatus("cooldown");
      } else {
        setStatus("error");
      }
    } catch {
      // Missing configuration must read as a clear message, not a crash.
      setStatus("error");
    }
  }

  return (
    <div>
      <form onSubmit={sendLink} className="space-y-3">
        {/* type="text", not "email": the native check runs on the raw input
            and rejects full-width IME characters before sendLink can
            normalise them. */}
        <input
          type="text"
          inputMode="email"
          autoComplete="email"
          required
          disabled={disabled}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@ed.ritsumei.ac.jp"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100"
        />
        <button
          type="submit"
          disabled={disabled || status === "sending" || wait > 0}
          className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {status === "sending"
            ? "Sending your link…"
            : wait > 0
              ? `Try again in ${wait}s`
              : "Send sign-in link"}
        </button>
      </form>

      {status === "sent" && (
        <p className="mt-4 text-sm text-green-700">
          Your sign-in link is on its way — check your inbox. The link works
          once and expires in one hour.
        </p>
      )}
      {status === "cooldown" && (
        <p className="mt-4 text-sm text-stone-600">
          A sign-in link was just sent to this address — check your inbox and spam folder.
          You can ask for another in {wait > 0 ? `${wait} seconds` : "a moment"}.
        </p>
      )}
      {status === "not_invited" && (
        <p className="mt-4 text-sm text-amber-700">
          This email is not on the invite list yet. ChatTobira is limited to
          invited students — ask the admin to invite you, and your sign-in
          link will arrive by email.
        </p>
      )}
      {status === "bad_email" && (
        <p className="mt-4 text-sm text-amber-700">
          That does not look like an email address — please check it and try
          again.
        </p>
      )}
      {status === "admin" && (
        <p className="mt-4 text-sm text-stone-600">
          The admin account signs in with a password on the{" "}
          <Link href="/admin" className="underline">
            Admin page
          </Link>
          .
        </p>
      )}
      {status === "error" && (
        <p className="mt-4 text-sm text-red-700">
          Something went wrong on our side. Please try again in a moment.
        </p>
      )}

      {showAdminLink && (
        <p className="mt-5 border-t border-stone-200 pt-3 text-center text-xs text-stone-400">
          <Link href="/admin" className="underline hover:text-stone-600">
            Admin sign-in
          </Link>
        </p>
      )}
    </div>
  );
}
