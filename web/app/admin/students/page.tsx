"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminShell, Card, TableSkeleton } from "@/components/admin/shell";
import { COLLEGES, ordinal, REASONS } from "@/lib/signup";
import { relativeTime, shortDate } from "@/lib/time";

interface Student {
  email: string;
  name: string | null;
  college: string | null;
  semester: number | null;
  reasons: string[];
  signed_up_at: string;
  verified: boolean;
  onboarded: boolean;
  suspended: boolean;
  last_sign_in_at: string | null;
  last_activity_at: string | null;
  questions_today: number;
}

type Filter = "all" | "active" | "pending" | "suspended";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "pending", label: "Not finished signing up" },
  { id: "suspended", label: "Suspended" },
];

const REASON_LABEL = new Map<string, string>(REASONS.map((r) => [r.id, r.label]));

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

  /** Suspend, restore or remove, through the admin students API. */
  async function act(email: string, action: "suspend" | "restore" | "remove") {
    if (
      action === "remove" &&
      !window.confirm(
        `Remove ${email} completely?\n\nThis deletes their account and everything attached to it — chat history, feedback and usage — and cannot be undone. They could sign up again with the same address.\n\nTo pause access instead and keep their work, use Suspend.`,
      )
    ) {
      return;
    }

    setBusyEmail(email);
    setNote(null);
    try {
      const response = await fetch("/api/admin/students", {
        method: action === "remove" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "remove" ? { email } : { email, action }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };

      if (response.ok) {
        setNote({
          ok: true,
          text:
            action === "remove"
              ? `${email} was removed completely.`
              : action === "suspend"
                ? `${email} is suspended. Their account and history are kept.`
                : `${email} can sign in again.`,
        });
      } else if (body.error === "no_account") {
        setNote({ ok: false, text: `There is no account for ${email} any more.` });
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
        ? student.onboarded && !student.suspended
        : filter === "pending"
          ? !student.onboarded
          : student.suspended,
  );

  return (
    <AdminShell
      active="students"
      title="Students"
      intro="Everyone who has signed up for ChatTobira, and whether they have actually used it."
    >
      {note && (
        <p
          className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${
            note.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
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
          <TableSkeleton rows={5} columns={6} />
        ) : failed ? (
          <div className="px-4 py-10 text-center text-sm text-stone-500">
            The student list could not be loaded.{" "}
            <button onClick={load} className="underline hover:text-stone-800">
              Try again
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-stone-500">
            {students.length === 0 ? "Nobody has signed up yet." : "No students match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                  <th className="px-4 py-2 font-medium">Student</th>
                  <th className="px-4 py-2 font-medium">College</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Last activity</th>
                  <th className="px-4 py-2 font-medium">Signed up</th>
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
                      {student.college ? (
                        <>
                          <p
                            className="text-stone-700"
                            title={COLLEGES.find((c) => c.id === student.college)?.name}
                          >
                            {student.college}
                            {student.semester && (
                              <span className="text-stone-400">
                                {" "}
                                · {ordinal(student.semester)} semester
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-stone-500">
                            {student.reasons.map((r) => REASON_LABEL.get(r) ?? r).join(", ")}
                          </p>
                        </>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
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
                    <td className="px-4 py-3 text-stone-500">{shortDate(student.signed_up_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <RowButton
                          onClick={() =>
                            act(student.email, student.suspended ? "restore" : "suspend")
                          }
                          busy={busyEmail === student.email}
                        >
                          {student.suspended ? "Restore" : "Suspend"}
                        </RowButton>
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

/** Where a student is in the journey: signed up → verified → profile done. */
function StatusBadge({ student }: { student: Student }) {
  const [label, className] = student.suspended
    ? ["Suspended", "bg-red-50 text-red-700"]
    : student.onboarded
      ? ["Active", "bg-green-50 text-green-800"]
      : student.verified
        ? ["Profile pending", "bg-sky-50 text-sky-800"]
        : ["Email not verified", "bg-stone-100 text-stone-600"];
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
