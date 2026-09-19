"use client";

import Link from "next/link";
import { useState } from "react";

import { Field, inputClass, primaryButtonClass } from "@/components/auth-card";
import { isAdminEmail } from "@/lib/admin";
import { normalizeEmail } from "@/lib/email";
import {
  APU_DOMAIN,
  cleanFullName,
  emailProblem,
  fullNameProblem,
  MIN_PASSWORD,
  passwordProblem,
} from "@/lib/signup";
import { createClient } from "@/lib/supabase/client";

type Problems = Partial<Record<"fullName" | "email" | "password" | "confirm", string>>;

type Outcome =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "exists" }
  | { kind: "error"; text: string };

/** Full name, APU email, password. Supabase emails a confirmation link; the
 * account cannot sign in until it is clicked. */
export function SignupForm({ disabled = false }: { disabled?: boolean }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = normalizeEmail(email);
    const found: Problems = {};
    const nameIssue = fullNameProblem(fullName);
    if (nameIssue) found.fullName = nameIssue;
    const emailIssue = isAdminEmail(address)
      ? "The admin account signs in on the Admin page."
      : emailProblem(email);
    if (emailIssue) found.email = emailIssue;
    const passwordIssue = passwordProblem(password);
    if (passwordIssue) found.password = passwordIssue;
    else if (password !== confirm) found.confirm = "The two passwords do not match.";
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    setOutcome({ kind: "sending" });
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email: address,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm`,
          data: { full_name: cleanFullName(fullName) },
        },
      });

      if (error) {
        if (error.status === 429 || /rate limit|after \d+ seconds?/i.test(error.message)) {
          setOutcome({
            kind: "error",
            text: "Too many attempts just now. Wait a minute and try again.",
          });
        } else if (/already registered|already exists/i.test(error.message)) {
          setOutcome({ kind: "exists" });
        } else if (error.code === "weak_password" || /password/i.test(error.message)) {
          setProblems({ password: error.message });
          setOutcome({ kind: "idle" });
        } else if (/database error/i.test(error.message)) {
          // The signup trigger refused it. The checks above mirror it, so this
          // is a crafted request or a rule that drifted — either way, say which
          // rules apply rather than "database error".
          setOutcome({
            kind: "error",
            text: `That account could not be created. Use your @${APU_DOMAIN} address and your full name as on your student ID.`,
          });
        } else {
          setOutcome({ kind: "error", text: "Something went wrong on our side. Please try again." });
        }
        return;
      }

      // An address that already has a confirmed account comes back as a
      // "success" with no identities and no email sent — Supabase will not
      // reveal that the address exists. Say what is actually going on.
      if (data.user && (data.user.identities ?? []).length === 0) {
        setOutcome({ kind: "exists" });
        return;
      }

      // Email confirmation switched off in the dashboard hands back a session
      // straight away. Nothing to wait for; go and answer the questions.
      if (data.session) {
        window.location.assign("/welcome");
        return;
      }

      setOutcome({ kind: "sent", email: address });
    } catch {
      setOutcome({ kind: "error", text: "Something went wrong on our side. Please try again." });
    }
  }

  if (outcome.kind === "sent") {
    return (
      <div className="rounded-xl bg-green-50 px-4 py-4 text-sm text-green-900">
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1">
          We sent a confirmation link to <strong>{outcome.email}</strong>. Click it to verify your
          email, then you will be asked a few quick questions.
        </p>
        <p className="mt-2 text-xs text-green-800">
          Nothing there after a few minutes? Check your spam folder, or{" "}
          <Link href={`/login?resend=${encodeURIComponent(outcome.email)}`} className="underline">
            send the link again
          </Link>
          .
        </p>
      </div>
    );
  }

  const busy = disabled || outcome.kind === "sending";

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="Full name"
        hint="Exactly as it appears on your APU student ID card."
        htmlFor="full-name"
        error={problems.fullName}
      >
        <input
          id="full-name"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          aria-invalid={Boolean(problems.fullName)}
          aria-describedby={problems.fullName ? "full-name-error" : undefined}
          disabled={busy}
          maxLength={100}
          className={inputClass}
        />
      </Field>

      <Field label="APU email" htmlFor="email" error={problems.email}>
        {/* type="text": the native email check runs on the raw input and
            rejects full-width IME characters before they are normalised. */}
        <input
          id="email"
          type="text"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={`ab12cd34@${APU_DOMAIN}`}
          aria-invalid={Boolean(problems.email)}
          aria-describedby={problems.email ? "email-error" : undefined}
          disabled={busy}
          className={inputClass}
        />
      </Field>

      <Field
        label="Password"
        hint={`At least ${MIN_PASSWORD} characters.`}
        htmlFor="password"
        error={problems.password}
      >
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(problems.password)}
          aria-describedby={problems.password ? "password-error" : undefined}
          disabled={busy}
          className={inputClass}
        />
      </Field>

      <Field label="Confirm password" htmlFor="confirm" error={problems.confirm}>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={Boolean(problems.confirm)}
          aria-describedby={problems.confirm ? "confirm-error" : undefined}
          disabled={busy}
          className={inputClass}
        />
      </Field>

      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {outcome.kind === "sending" ? "Creating your account…" : "Create account"}
      </button>

      {outcome.kind === "exists" && (
        <p className="text-sm text-amber-800">
          An account with this email already exists.{" "}
          <Link href="/login" className="underline">
            Sign in
          </Link>{" "}
          instead, or reset your password there.
        </p>
      )}
      {outcome.kind === "error" && <p className="text-sm text-red-700">{outcome.text}</p>}
    </form>
  );
}
