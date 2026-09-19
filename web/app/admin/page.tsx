"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AdminShell, Card } from "@/components/admin/shell";
import { createClient } from "@/lib/supabase/client";

interface Summary {
  total: number;
  active: number;
  unverified: number;
  incomplete: number;
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
      intro="The state of the course at a glance."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Students" value={students?.total} href="/admin/students" />
        <Stat label="Active" value={students?.active} href="/admin/students" />
        <Stat
          label="Not finished signing up"
          value={students ? students.unverified + students.incomplete : undefined}
          href="/admin/students"
          tone={students && students.unverified + students.incomplete > 0 ? "warn" : "plain"}
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
          title="Sign-ups"
          description="Students sign up themselves with an @apu.ac.jp address."
        >
          <dl className="grid grid-cols-2 gap-px bg-stone-100 text-sm">
            <Figure label="Active" value={students?.active} />
            <Figure label="Email not verified" value={students?.unverified} />
            <Figure label="Profile pending" value={students?.incomplete} />
            <Figure label="Suspended" value={students?.suspended} />
          </dl>
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
