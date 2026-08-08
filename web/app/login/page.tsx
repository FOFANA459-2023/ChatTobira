"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "sending" | "sent" | "not_invited" | "error";

/** Student sign-in is by invitation: the teacher sends the first link from
 * the admin page. This page exists for returning students whose session
 * expired — an invited email can always request a fresh link. */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  async function sendLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus("sending");

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
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
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          ChatTobira{" "}
          <span className="text-base font-normal text-stone-500">とびら</span>
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          Access is limited to invited students — your teacher sends the invite
          to your email. Already invited? Enter that email to get a fresh
          sign-in link.
        </p>

        {!configured && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Sign-in is temporarily unavailable while this site finishes setup.
            Please check back shortly.
            <span className="mt-1 block text-amber-700">
              Administrator: this deployment was built without
              NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it as a build variable and
              redeploy — these keys are compiled in at build time, so a runtime
              secret will not work.
            </span>
          </p>
        )}

        <form onSubmit={sendLink} className="mt-6 space-y-3">
          <input
            type="email"
            required
            disabled={!configured}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@ed.ritsumei.ac.jp"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100"
          />
          <button
            type="submit"
            // Unconfigured: fail visibly up front rather than after a click.
            disabled={!configured || status === "sending"}
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
            This email has not been invited yet. Ask your teacher to invite
            you, then check your inbox.
          </p>
        )}
        {status === "error" && (
          <p className="mt-4 text-sm text-red-700">
            Something went wrong. Please try again in a moment.
          </p>
        )}

        <p className="mt-6 border-t border-stone-200 pt-4 text-center text-xs text-stone-400">
          <Link href="/admin" className="underline hover:text-stone-600">
            Teacher sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}
