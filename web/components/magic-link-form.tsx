"use client";

import Link from "next/link";
import { useState } from "react";

import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "sending" | "sent" | "not_invited" | "admin" | "error";

/** Email → magic-link form, shared by the login page and the chat's
 * out-of-trial panel. The admin email is refused here: the admin account
 * signs in with a password only, so a sign-in link for it must never be
 * requestable from the app. */
export function MagicLinkForm({ disabled = false }: { disabled?: boolean }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function sendLink(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
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
        <input
          type="email"
          required
          disabled={disabled}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@ed.ritsumei.ac.jp"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100"
        />
        <button
          type="submit"
          disabled={disabled || status === "sending"}
          className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Send sign-in link"}
        </button>
      </form>

      {status === "sent" && (
        <p className="mt-4 text-sm text-green-700">
          Check your inbox for the sign-in link.
        </p>
      )}
      {status === "not_invited" && (
        <p className="mt-4 text-sm text-amber-700">
          This email has not been invited yet. Ask the admin to invite you,
          then check your inbox.
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
          Something went wrong. Please try again in a moment.
        </p>
      )}
    </div>
  );
}
