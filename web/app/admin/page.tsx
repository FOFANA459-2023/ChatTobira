"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { EMAIL_SHAPE, normalizeEmail } from "@/lib/email";
import { NavBar } from "@/components/nav";
import { createClient } from "@/lib/supabase/client";

interface Invite {
  email: string;
  created_at: string;
  /** Access paused: the account and all its history are intact. */
  suspended: boolean;
  /** Invited but never signed in, so there is no account to suspend yet. */
  registered: boolean;
}

type Session = "checking" | "signed_out" | "not_admin" | "admin";

export default function AdminPage() {
  const [session, setSession] = useState<Session>("checking");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState("");
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteNote, setInviteNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);

  const [newPassword, setNewPassword] = useState("");
  const [passwordNote, setPasswordNote] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const loadInvites = useCallback(() => {
    fetch("/api/invite")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { invites: Invite[] }) => setInvites(data.invites))
      .catch(() => setInvites([]));
  }, []);

  useEffect(() => {
    try {
      const supabase = createClient();
      supabase.auth
        .getUser()
        .then(({ data: { user } }) => {
          if (!user) setSession("signed_out");
          else if (isAdminEmail(user.email)) setSession("admin");
          else setSession("not_admin");
        })
        .catch(() => setSession("signed_out"));
    } catch {
      // Unconfigured deployment: render the sign-in form; submitting surfaces
      // the error rather than a blank page.
      setSession("signed_out");
    }
  }, []);

  useEffect(() => {
    if (session === "admin") loadInvites();
  }, [session, loadInvites]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSignInError("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: ADMIN_EMAIL,
        password,
      });
      if (error) {
        // Reporting every failure as "wrong password" hid a real lockout once:
        // a rate limit, an unconfirmed email, and a misconfigured deployment
        // all look identical from here, and none of them are fixed by typing
        // the password again. Name what actually happened.
        if (error.status === 429) {
          setSignInError(
            "Too many sign-in attempts. Supabase is rate-limiting this account — wait a few minutes and try again.",
          );
        } else if (/email not confirmed/i.test(error.message)) {
          setSignInError(
            "This account's email is not confirmed, so password sign-in is refused.",
          );
        } else if (/invalid login credentials/i.test(error.message)) {
          setSignInError("That password is not right. Please try again.");
        } else {
          setSignInError(`Sign-in failed: ${error.message}`);
        }
      } else {
        setPassword("");
        setSession("admin");
      }
    } catch (error) {
      setSignInError(
        `Could not reach the sign-in service: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    // Fold full-width IME characters and pasted "Name <email>" forms before
    // shape-checking: school addresses routinely arrive that way, and raw
    // validation read as ".ac.jp is blocked".
    const email = normalizeEmail(inviteEmail);
    if (!email) return;
    if (!EMAIL_SHAPE.test(email)) {
      setInviteNote({ ok: false, text: "That does not look like an email address." });
      return;
    }
    setBusy(true);
    setInviteNote(null);
    try {
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        allowlisted?: boolean;
      };
      if (response.ok) {
        setInviteNote({ ok: true, text: `Invite sent to ${email}.` });
        setInviteEmail("");
        loadInvites();
      } else if (body.error === "send_failed") {
        // allowlisted distinguishes a failed RE-send (their standing invite
        // survives) from a failed new invite (rolled back, list unchanged).
        setInviteNote({
          ok: false,
          text: body.allowlisted
            ? `${email} is already invited, but the fresh sign-in email could not be sent right now. They can request a link themselves on the login page.`
            : `The invite email to ${email} could not be sent, so they were NOT added. Fix email sending (SMTP) or try again in a moment.`,
        });
        loadInvites();
      } else if (body.error === "bad_email") {
        setInviteNote({ ok: false, text: "That does not look like an email address." });
      } else if (body.error === "invite_not_configured") {
        setInviteNote({
          ok: false,
          text: "Inviting is not configured on this deployment (missing SUPABASE_SERVICE_ROLE_KEY).",
        });
      } else {
        setInviteNote({ ok: false, text: "Could not send the invite. Please try again." });
      }
    } catch {
      setInviteNote({ ok: false, text: "Could not send the invite. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  /** Pause or restore access. Nothing is deleted either way. */
  async function setSuspended(email: string, suspend: boolean) {
    setBusy(true);
    setInviteNote(null);
    try {
      const response = await fetch("/api/invite", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, action: suspend ? "suspend" : "restore" }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setInviteNote({
          ok: true,
          text: suspend
            ? `${email} is suspended. Their account and history are kept — restore returns access.`
            : `${email} can sign in again.`,
        });
        loadInvites();
      } else if (body.error === "never_signed_in") {
        setInviteNote({
          ok: false,
          text: `${email} has not signed in yet, so there is no account to suspend. Remove the invite instead.`,
        });
      } else {
        setInviteNote({
          ok: false,
          text: `Could not ${suspend ? "suspend" : "restore"} ${email}. Try again.`,
        });
      }
    } catch {
      setInviteNote({
        ok: false,
        text: `Could not ${suspend ? "suspend" : "restore"} ${email}. Try again.`,
      });
    } finally {
      setBusy(false);
    }
  }

  /** Delete the invite and the account outright. Irreversible, so it asks. */
  async function remove(email: string) {
    if (
      !window.confirm(
        `Remove ${email} completely?\n\nThis deletes their account and everything attached to it — chat history, saved feedback, and usage — and cannot be undone.\n\nTo pause access instead and keep their work, use Suspend.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setInviteNote(null);
    try {
      const response = await fetch("/api/invite", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setInviteNote({ ok: true, text: `${email} was removed completely.` });
      } else if (body.error === "delete_failed") {
        setInviteNote({
          ok: false,
          text: `${email} was un-invited and suspended, but their account could not be deleted. Try Remove again.`,
        });
      } else {
        setInviteNote({ ok: false, text: `Could not remove ${email}. Try again.` });
      }
      loadInvites();
    } catch {
      setInviteNote({ ok: false, text: `Could not remove ${email}. Try again.` });
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword.length < 8) {
      setPasswordNote({ ok: false, text: "Use at least 8 characters." });
      return;
    }
    setBusy(true);
    setPasswordNote(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
        data: { first_name: "Varlee", full_name: "Varlee Fofana" },
      });
      if (error) throw error;
      setNewPassword("");
      setPasswordNote({
        ok: true,
        text: "Password saved. From now on you can sign in here with it directly.",
      });
    } catch {
      setPasswordNote({ ok: false, text: "Could not save the password. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Sign out lives in the navbar once signed in; while signed out this
          page IS the admin sign-in form, so the navbar offers no auth button
          of its own — just the way back to the chat and quizzes. */}
      <NavBar showAuth={session === "admin"} />
      <main className="flex flex-1 items-start justify-center p-6">
      <div className="mt-12 w-full max-w-md">
        <div className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Link href="/" className="hover:text-stone-600">
              ChatTobira
            </Link>{" "}
            <span className="text-base font-normal text-stone-500">Admin</span>
          </h1>

          {session === "checking" && (
            <p className="mt-6 text-sm text-stone-500">Checking session…</p>
          )}

          {session === "not_admin" && (
            <p className="mt-6 text-sm text-stone-600">
              This page is for the admin only.{" "}
              <Link href="/" className="underline">
                Back to the chat
              </Link>
              .
            </p>
          )}

          {session === "signed_out" && (
            <>
              <form onSubmit={signIn} className="mt-6 space-y-3">
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
              {signInError && (
                <p className="mt-3 text-sm text-red-700">{signInError}</p>
              )}
            </>
          )}

          {session === "admin" && (
            <>
              <p className="mt-2 text-sm text-stone-600">
                Invite a student by email — they receive a sign-in link and
                just enter their name on first visit.
              </p>
              <form onSubmit={invite} className="mt-5 flex gap-2">
                {/* type="text", not "email": the native email check runs on
                    the RAW input, and a full-width ＠ from a Japanese IME or
                    a pasted 「山田 <yt01@…>」 failed it before our normaliser
                    could run. Validation happens after normalizeEmail. */}
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="student@ed.ritsumei.ac.jp"
                  className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
                />
                <button
                  type="submit"
                  disabled={busy || inviteEmail.trim() === ""}
                  className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {busy ? "…" : "Invite"}
                </button>
              </form>
              {inviteNote && (
                <p
                  className={`mt-3 text-sm ${inviteNote.ok ? "text-green-700" : "text-amber-700"}`}
                >
                  {inviteNote.text}
                </p>
              )}

              <div className="mt-6 border-t border-stone-200 pt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
                  Admin password
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Set (or change) the password you use to sign in on this page.
                </p>
                <form onSubmit={savePassword} className="mt-2 flex gap-2">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password"
                    className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
                  />
                  <button
                    type="submit"
                    disabled={busy || newPassword === ""}
                    className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-100 disabled:opacity-50"
                  >
                    Save
                  </button>
                </form>
                {passwordNote && (
                  <p
                    className={`mt-2 text-xs ${passwordNote.ok ? "text-green-700" : "text-amber-700"}`}
                  >
                    {passwordNote.text}
                  </p>
                )}
              </div>

              {invites.length > 0 && (
                <div className="mt-6 border-t border-stone-200 pt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
                    Invited students
                  </p>
                  <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto text-sm">
                    {invites.map((invite) => (
                      <li
                        key={invite.email}
                        className="flex items-center justify-between gap-2 text-stone-700"
                      >
                        <span className="min-w-0 truncate">
                          <span
                            className={invite.suspended ? "text-stone-400 line-through" : ""}
                          >
                            {invite.email}
                          </span>
                          {invite.suspended && (
                            <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                              Suspended
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="text-xs text-stone-400">
                            {new Date(invite.created_at).toLocaleDateString()}
                          </span>
                          <button
                            onClick={() => setSuspended(invite.email, !invite.suspended)}
                            disabled={busy || !invite.registered}
                            title={
                              !invite.registered
                                ? "This student has not signed in yet, so there is no account to suspend"
                                : invite.suspended
                                  ? "Give this student access again"
                                  : "Pause access — the account and all their work are kept"
                            }
                            className={[
                              "rounded border px-2 py-0.5 text-xs disabled:opacity-40",
                              invite.suspended
                                ? "border-green-300 text-green-700 hover:bg-green-50"
                                : "border-stone-300 text-stone-600 hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800",
                            ].join(" ")}
                          >
                            {invite.suspended ? "Restore" : "Suspend"}
                          </button>
                          <button
                            onClick={() => remove(invite.email)}
                            disabled={busy}
                            title="Delete this student and all their data permanently"
                            className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:border-red-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-stone-400">
                    Suspend pauses access and keeps everything. Remove deletes
                    the student and their work permanently.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </main>
    </div>
  );
}
