"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminShell, Card, TableSkeleton } from "@/components/admin/shell";
import { relativeTime, shortDate } from "@/lib/time";

interface Student {
  email: string;
  name: string | null;
  invited_at: string;
  registered: boolean;
  accepted: boolean;
  suspended: boolean;
  last_sign_in_at: string | null;
  last_activity_at: string | null;
  questions_today: number;
}

type Filter = "all" | "active" | "waiting" | "suspended";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Signed in" },
  { id: "waiting", label: "Never signed in" },
  { id: "suspended", label: "Suspended" },
];

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    void fetch("/api/admin/students")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { students: Student[] }) => setStudents(body.students))
      .catch(() => {
        setStudents([]);
        setFailed(true);
      });
  }, []);

  useEffect(load, [load]);

  /** Suspend, restore, resend a link, or remove — all through the invite API
   * that already owns these operations. */
  async function act(email: string, action: "suspend" | "restore" | "resend" | "remove") {
    if (
      action === "remove" &&
      !window.confirm(
        `Remove ${email} completely?\n\nThis deletes their account and everything attached to it — chat history, feedback and usage — and cannot be undone.\n\nTo pause access instead and keep their work, use Suspend.`,
      )
    ) {
      return;
    }

    setBusyEmail(email);
    setNote(null);
    try {
      const request =
        action === "resend"
          ? { method: "POST", body: { email } }
          : action === "remove"
            ? { method: "DELETE", body: { email } }
            : { method: "PATCH", body: { email, action } };

      const response = await fetch("/api/invite", {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        retryAfter?: number;
      };

      if (response.ok) {
        setNote({
          ok: true,
          text:
            action === "resend"
              ? `A fresh sign-in link is on its way to ${email}.`
              : action === "remove"
                ? `${email} was removed completely.`
                : action === "suspend"
                  ? `${email} is suspended. Their account and history are kept.`
                  : `${email} can sign in again.`,
        });
      } else if (body.error === "cooldown") {
        setNote({
          ok: true,
          text: `${email} was emailed a link very recently — the next one can go out in ${body.retryAfter ?? 60} seconds.`,
        });
      } else if (body.error === "never_signed_in") {
        setNote({
          ok: false,
          text: `${email} has not signed in yet, so there is no account to suspend. Remove the invite instead.`,
        });
      } else {
        setNote({ ok: false, text: `Could not ${action} ${email}. Please try again.` });
      }
      load();
    } catch {
      setNote({ ok: false, text: `Could not ${action} ${email}. Please try again.` });
    } finally {
      setBusyEmail(null);
    }
  }

  const shown = (students ?? []).filter((student) =>
    filter === "all"
      ? true
      : filter === "active"
        ? student.accepted && !student.suspended
        : filter === "waiting"
          ? !student.accepted
          : student.suspended,
  );

  return (
    <AdminShell
      active="students"
      title="Students"
      intro="Everyone invited to ChatTobira, and whether they have actually used it."
    >
      {note && (
        <p
          className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${
            note.ok
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-800"
          }`}
        >
          {note.text}
        </p>
      )}

      <Card
        title={students ? `${shown.length} of ${students.length}` : "Students"}
        description="Last activity is the most recent question asked, or the last sign-in."
        actions={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                onClick={() => setFilter(option.id)}
                className={
                  filter === option.id
                    ? "rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-medium text-white"
                    : "rounded-lg border border-stone-200 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-100"
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      >
        {students === null ? (
          <TableSkeleton rows={5} columns={5} />
        ) : failed ? (
          <div className="px-4 py-10 text-center text-sm text-stone-500">
            The student list could not be loaded.{" "}
            <button onClick={load} className="underline hover:text-stone-800">
              Try again
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-stone-500">
            {students.length === 0
              ? "No students invited yet. Invite the first from the dashboard."
              : "No students match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                  <th className="px-4 py-2 font-medium">Student</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Last activity</th>
                  <th className="px-4 py-2 font-medium">Invited</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {shown.map((student) => (
                  <tr key={student.email} className="align-middle hover:bg-stone-50/60">
                    <td className="px-4 py-3">
                      <p className="font-medium text-stone-900">
                        {student.name ?? student.email.split("@")[0]}
                      </p>
                      <p className="text-xs text-stone-500">{student.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge student={student} />
                    </td>
                    <td className="px-4 py-3">
                      {student.last_activity_at ? (
                        <>
                          <span className="text-stone-700">
                            {relativeTime(student.last_activity_at)}
                          </span>
                          {student.questions_today > 0 && (
                            <span className="ml-1.5 text-xs text-stone-400">
                              · {student.questions_today} today
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-stone-400">Never logged in</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-500">
                      {shortDate(student.invited_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <RowButton
                          onClick={() => act(student.email, "resend")}
                          busy={busyEmail === student.email}
                        >
                          Resend link
                        </RowButton>
                        {student.registered && (
                          <RowButton
                            onClick={() =>
                              act(student.email, student.suspended ? "restore" : "suspend")
                            }
                            busy={busyEmail === student.email}
                          >
                            {student.suspended ? "Restore" : "Suspend"}
                          </RowButton>
                        )}
                        <RowButton
                          onClick={() => act(student.email, "remove")}
                          busy={busyEmail === student.email}
                          danger
                        >
                          Remove
                        </RowButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AdminShell>
  );
}

/** Where a student is in the journey: invited → emailed → signed in. */
function StatusBadge({ student }: { student: Student }) {
  const [label, className] = student.suspended
    ? ["Suspended", "bg-red-50 text-red-700"]
    : student.accepted
      ? ["Active", "bg-green-50 text-green-800"]
      : student.registered
        ? ["Link opened", "bg-sky-50 text-sky-800"]
        : ["Invited", "bg-stone-100 text-stone-600"];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
  );
}

function RowButton({
  children,
  onClick,
  busy,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${
        danger
          ? "border-red-200 text-red-700 hover:bg-red-50"
          : "border-stone-200 text-stone-600 hover:bg-stone-100"
      }`}
    >
      {busy ? "…" : children}
    </button>
  );
}
