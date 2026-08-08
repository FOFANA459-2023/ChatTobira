"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";

interface Invite {
  email: string;
  created_at: string;
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
        setSignInError("That password is not right. Please try again.");
      } else {
        setPassword("");
        setSession("admin");
      }
    } catch {
      setSignInError("Could not sign in. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setBusy(true);
    setInviteNote(null);
    try {
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setInviteNote({ ok: true, text: `Invite sent to ${email}.` });
        setInviteEmail("");
        loadInvites();
      } else if (body.error === "send_failed") {
        setInviteNote({
          ok: false,
          text: `${email} was added to the invite list, but the email could not be sent right now. They can request a sign-in link themselves on the login page.`,
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

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    setSession("signed_out");
    setInvites([]);
  }

  return (
    <main className="flex min-h-screen items-start justify-center p-6">
      <div className="mt-12 w-full max-w-md">
        <div className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              <Link href="/" className="hover:text-stone-600">
                ChatTobira
              </Link>{" "}
              <span className="text-base font-normal text-stone-500">Admin</span>
            </h1>
            {session === "admin" && (
              <button
                onClick={signOut}
                className="text-sm text-stone-500 underline hover:text-stone-900"
              >
                Sign out
              </button>
            )}
          </div>

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
              <p className="mt-2 text-sm text-stone-600">ChatTobira Admin sign-in.</p>
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
                <input
                  type="email"
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
                  <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm">
                    {invites.map((invite) => (
                      <li
                        key={invite.email}
                        className="flex justify-between gap-2 text-stone-700"
                      >
                        <span className="truncate">{invite.email}</span>
                        <span className="shrink-0 text-xs text-stone-400">
                          {new Date(invite.created_at).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
