"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AdminShell, Card } from "@/components/admin/shell";
import { EMAIL_SHAPE, normalizeEmail } from "@/lib/email";
import { createClient } from "@/lib/supabase/client";

interface Summary {
  invited: number;
  accepted: number;
  waiting: number;
  suspended: number;
}

interface Corpus {
  documents: number;
  searchable: number;
  chunks: number;
  citable: number;
}

type Note = { ok: boolean; text: string } | null;

export default function AdminDashboard() {
  const [students, setStudents] = useState<Summary | null>(null);
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteNote, setInviteNote] = useState<Note>(null);
  const [inviting, setInviting] = useState(false);
  /** Seconds left before this address can be emailed again. Counted down in
   * the UI so a cooldown is something the admin can see, not a mystery. */
  const [cooldown, setCooldown] = useState(0);

  const [newPassword, setNewPassword] = useState("");
  const [passwordNote, setPasswordNote] = useState<Note>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const load = useCallback(() => {
    void fetch("/api/admin/students")
      .then((r) => (r.ok ? r.json() : { summary: null }))
      .then((body: { summary: Summary | null }) => setStudents(body.summary))
      .catch(() => setStudents(null));
    void fetch("/api/admin/documents")
      .then((r) => (r.ok ? r.json() : { summary: null }))
      .then((body: { summary: Corpus | null }) => setCorpus(body.summary))
      .catch(() => setCorpus(null));
    void fetch("/api/upload/review")
      .then((r) => (r.ok ? r.json() : { queue: [] }))
      .then((body: { queue?: unknown[] }) =>
        setPending((body.queue ?? []).filter(Boolean).length),
      )
      .catch(() => setPending(null));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    // Fold full-width IME characters and pasted "Name <email>" forms before
    // checking the shape: school addresses routinely arrive that way.
    const email = normalizeEmail(inviteEmail);
    if (!email) return;
    if (!EMAIL_SHAPE.test(email)) {
      setInviteNote({ ok: false, text: "That does not look like an email address." });
      return;
    }
    setInviting(true);
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
        reason?: string;
        retryAfter?: number;
      };

      if (response.ok) {
        setInviteNote({ ok: true, text: `Sign-in link sent to ${email}.` });
        setInviteEmail("");
        load();
      } else if (body.error === "cooldown") {
        // Their invite is intact; only the email has to wait.
        const wait = body.retryAfter ?? 60;
        setCooldown(wait);
        setInviteNote({
          ok: true,
          text: `${email} is invited. A sign-in link was sent to them very recently, so the next one can go out in ${wait} seconds — they can also request one themselves on the login page.`,
        });
        load();
      } else if (body.error === "send_failed") {
        const why = body.reason ? ` (${body.reason})` : "";
        setInviteNote({
          ok: false,
          text: body.allowlisted
            ? `${email} is already invited, but the fresh sign-in email could not be sent${why}. They can request a link themselves on the login page.`
            : `The invite email to ${email} could not be sent, so they were NOT added${why}.`,
        });
        load();
      } else if (body.error === "bad_email") {
        setInviteNote({ ok: false, text: "That does not look like an email address." });
      } else if (body.error === "invite_not_configured") {
        setInviteNote({
          ok: false,
          text: "Inviting is not configured on this deployment (missing SUPABASE_SERVICE_ROLE_KEY).",
        });
      } else if (body.error === "is_admin") {
        setInviteNote({
          ok: false,
          text: "That is the admin account, which signs in with a password rather than a link.",
        });
      } else {
        setInviteNote({ ok: false, text: "Could not send the invite. Please try again." });
      }
    } catch {
      setInviteNote({ ok: false, text: "Could not send the invite. Please try again." });
    } finally {
      setInviting(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword.length < 8) {
      setPasswordNote({ ok: false, text: "Use at least 8 characters." });
      return;
    }
    setSavingPassword(true);
    setPasswordNote(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
        data: { first_name: "Varlee", full_name: "Varlee Fofana" },
      });
      if (error) throw error;
      setNewPassword("");
      setPasswordNote({ ok: true, text: "Password updated." });
    } catch (error) {
      setPasswordNote({
        ok: false,
        text: `Could not update the password: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <AdminShell
      active="dashboard"
      title="Dashboard"
      intro="Invite students, and see the state of the course at a glance."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Invited" value={students?.invited} href="/admin/students" />
        <Stat label="Signed in" value={students?.accepted} href="/admin/students" />
        <Stat
          label="Never signed in"
          value={students?.waiting}
          href="/admin/students"
          tone={students && students.waiting > 0 ? "warn" : "plain"}
        />
        <Stat label="Documents" value={corpus?.documents} href="/admin/documents" />
      </div>

      {pending !== null && pending > 0 && (
        <Link
          href="/admin/documents"
          className="mt-3 block rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100"
        >
          {pending} student {pending === 1 ? "upload is" : "uploads are"} waiting for review →
        </Link>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card
          title="Invite a student"
          description="Adds them to the allowlist and emails a sign-in link straight away."
        >
          <form onSubmit={invite} className="space-y-3 p-4">
            <input
              type="text"
              inputMode="email"
              autoComplete="off"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="student@ed.ritsumei.ac.jp"
              disabled={inviting}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100"
            />
            <button
              type="submit"
              disabled={inviting || cooldown > 0 || inviteEmail.trim() === ""}
              className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {inviting
                ? "Sending invitation…"
                : cooldown > 0
                  ? `Wait ${cooldown}s before the next link`
                  : "Send invitation"}
            </button>
            {inviteNote && (
              <p className={`text-sm ${inviteNote.ok ? "text-green-700" : "text-red-700"}`}>
                {inviteNote.text}
              </p>
            )}
            <p className="text-xs text-stone-400">
              Already invited? Sending again emails them a fresh link — their account and
              history are untouched.
            </p>
          </form>
        </Card>

        <div className="space-y-4">
          <Card title="Knowledge base" description="What the assistant can answer from.">
            <dl className="grid grid-cols-2 gap-px bg-stone-100 text-sm">
              <Figure label="Documents" value={corpus?.documents} />
              <Figure label="Fully indexed" value={corpus?.searchable} />
              <Figure label="Searchable passages" value={corpus?.chunks} />
              <Figure label="Citable textbooks" value={corpus?.citable} />
            </dl>
          </Card>

          <Card title="Admin password" description="Used to sign in to this portal.">
            <form onSubmit={savePassword} className="space-y-3 p-4">
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="New password (min 8 characters)"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
              <button
                type="submit"
                disabled={savingPassword || newPassword === ""}
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
              >
                {savingPassword ? "Saving…" : "Update password"}
              </button>
              {passwordNote && (
                <p className={`text-sm ${passwordNote.ok ? "text-green-700" : "text-red-700"}`}>
                  {passwordNote.text}
                </p>
              )}
            </form>
          </Card>
        </div>
      </div>
    </AdminShell>
  );
}

function Stat({
  label,
  value,
  href,
  tone = "plain",
}: {
  label: string;
  value: number | undefined;
  href: string;
  tone?: "plain" | "warn";
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-stone-200 bg-white px-4 py-3 shadow-sm hover:border-stone-300"
    >
      <p className="text-xs uppercase tracking-wide text-stone-400">{label}</p>
      {value === undefined ? (
        <span
          role="status"
          aria-label={`Loading ${label}`}
          className="mt-1.5 block h-7 w-10 animate-pulse rounded bg-stone-100 motion-reduce:animate-none"
        />
      ) : (
        <p
          className={`mt-0.5 text-2xl font-semibold ${
            tone === "warn" ? "text-amber-700" : "text-stone-900"
          }`}
        >
          {value}
        </p>
      )}
    </Link>
  );
}

function Figure({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="bg-white px-4 py-3">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-stone-900">
        {value === undefined ? (
          <span className="block h-5 w-12 animate-pulse rounded bg-stone-100 motion-reduce:animate-none" />
        ) : (
          value.toLocaleString()
        )}
      </dd>
    </div>
  );
}
