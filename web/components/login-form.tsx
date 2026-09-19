"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Field, inputClass, primaryButtonClass } from "@/components/auth-card";
import { isAdminEmail } from "@/lib/admin";
import { normalizeEmail } from "@/lib/email";
import { APU_DOMAIN, emailProblem } from "@/lib/signup";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "forgot" | "resend";

type Note = { tone: "ok" | "warn" | "error"; text: string } | null;

const TONE = {
  ok: "text-green-700",
  warn: "text-amber-800",
  error: "text-red-700",
} as const;

/** Email + password sign-in, with the two things a password login needs
 * beside it: a reset for a forgotten password, and a fresh confirmation link
 * for an account whose first one was lost. */
export function LoginForm({
  disabled = false,
  initialEmail = "",
  initialMode = "signin",
}: {
  disabled?: boolean;
  initialEmail?: string;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  /** Seconds before Supabase will send another email to this address. */
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  function switchTo(next: Mode) {
    setMode(next);
    setNote(null);
  }

  /** A rate-limit refusal, as a countdown instead of an error. */
  function cooldownFrom(error: { status?: number; message: string }): boolean {
    const seconds = /after (\d+) seconds?/i.exec(error.message)?.[1];
    if (error.status === 429 || seconds || /rate limit|too many/i.test(error.message)) {
      setWait(seconds ? Number(seconds) : 60);
      setNote({
        tone: "warn",
        text: "An email was sent to this address very recently. Check your inbox and spam folder, or try again when the timer runs out.",
      });
      return true;
    }
    return false;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = normalizeEmail(email);
    if (isAdminEmail(address)) {
      setNote({ tone: "warn", text: "The admin account signs in on the Admin page." });
      return;
    }
    const emailIssue = emailProblem(email);
    if (emailIssue) {
      setNote({ tone: "error", text: emailIssue });
      return;
    }
    if (mode === "signin" && !password) {
      setNote({ tone: "error", text: "Enter your password." });
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      const supabase = createClient();
      const origin = window.location.origin;

      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: address, password });
        if (!error) {
          // A full load rather than a client transition: the server components
          // and the middleware's welcome gate should see the fresh session.
          window.location.assign("/");
          return;
        }
        if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message)) {
          setMode("resend");
          setNote({
            tone: "warn",
            text: "Your email is not verified yet. Click the link we emailed you, or send a new one below.",
          });
        } else if (error.status === 429) {
          setNote({
            tone: "error",
            text: "Too many sign-in attempts. Wait a few minutes and try again.",
          });
        } else if (error.code === "invalid_credentials" || error.status === 400) {
          setNote({ tone: "error", text: "That email and password do not match." });
        } else {
          setNote({ tone: "error", text: "Something went wrong on our side. Please try again." });
        }
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(address, {
          redirectTo: `${origin}/auth/confirm?next=/reset-password`,
        });
        if (error) {
          if (!cooldownFrom(error)) {
            setNote({ tone: "error", text: "Could not send the reset email. Please try again." });
          }
        } else {
          // Said the same way whether or not the account exists, so the form
          // cannot be used to find out who has signed up.
          setNote({
            tone: "ok",
            text: `If ${address} has an account, a password reset link is on its way.`,
          });
          setWait(60);
        }
      } else {
        const { error } = await supabase.auth.resend({
          type: "signup",
          email: address,
          options: { emailRedirectTo: `${origin}/auth/confirm` },
        });
        if (error) {
          if (!cooldownFrom(error)) {
            setNote({ tone: "error", text: "Could not send the link. Please try again." });
          }
        } else {
          setNote({
            tone: "ok",
            text: `If ${address} is waiting for verification, a new confirmation link is on its way.`,
          });
          setWait(60);
        }
      }
    } catch {
      setNote({ tone: "error", text: "Something went wrong on our side. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const locked = disabled || busy;
  const action =
    mode === "signin"
      ? busy
        ? "Signing in…"
        : "Sign in"
      : wait > 0
        ? `Send again in ${wait}s`
        : busy
          ? "Sending…"
          : mode === "forgot"
            ? "Send reset link"
            : "Send confirmation link";

  return (
    <div>
      {mode !== "signin" && (
        <p className="mb-4 text-sm text-stone-600">
          {mode === "forgot"
            ? "Enter your APU email and we will send you a link to choose a new password."
            : "Enter your APU email and we will send a new confirmation link."}
        </p>
      )}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="APU email" htmlFor="login-email">
          <input
            id="login-email"
            type="text"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={`ab12cd34@${APU_DOMAIN}`}
            disabled={locked}
            className={inputClass}
          />
        </Field>

        {mode === "signin" && (
          <Field label="Password" htmlFor="login-password">
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={locked}
              className={inputClass}
            />
          </Field>
        )}

        <button
          type="submit"
          disabled={locked || (mode !== "signin" && wait > 0)}
          className={primaryButtonClass}
        >
          {action}
        </button>
      </form>

      {note && <p className={`mt-4 text-sm ${TONE[note.tone]}`}>{note.text}</p>}

      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-stone-500">
        {mode === "signin" ? (
          <>
            <button type="button" onClick={() => switchTo("forgot")} className="underline hover:text-stone-800">
              Forgot password?
            </button>
            <button type="button" onClick={() => switchTo("resend")} className="underline hover:text-stone-800">
              Resend confirmation email
            </button>
          </>
        ) : (
          <button type="button" onClick={() => switchTo("signin")} className="underline hover:text-stone-800">
            ← Back to sign in
          </button>
        )}
      </div>

      <p className="mt-6 text-center text-sm text-stone-600">
        New to ChatTobira?{" "}
        <Link href="/signup" className="font-medium text-stone-900 underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
