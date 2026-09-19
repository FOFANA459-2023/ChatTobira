"use client";

import { useState } from "react";

import { AuthCard, Field, inputClass, primaryButtonClass } from "@/components/auth-card";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signup";
import { createClient } from "@/lib/supabase/client";

/** Where a password reset link lands. /auth/confirm has already exchanged the
 * link for a session, so all that is left is choosing the new password. */
export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const issue = passwordProblem(password, confirm);
    setProblem(issue);
    if (issue) return;
    setBusy(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) {
        setProblem(
          /session|jwt|not authenticated/i.test(error.message)
            ? "This reset link has expired. Ask for a new one on the sign-in page."
            : error.message,
        );
        setBusy(false);
        return;
      }
      window.location.assign("/");
    } catch {
      setProblem("Something went wrong on our side. Please try again.");
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`} htmlFor="new-password">
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className={inputClass}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password">
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            className={inputClass}
          />
        </Field>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Saving…" : "Save password"}
        </button>
        {problem && <p className="text-sm text-red-700">{problem}</p>}
      </form>
    </AuthCard>
  );
}
