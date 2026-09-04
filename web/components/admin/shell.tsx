"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";

export type AdminSection = "dashboard" | "students" | "documents";

type Session = "checking" | "signed_out" | "not_admin" | "admin";

const SECTIONS: { id: AdminSection; href: string; label: string; ja: string }[] = [
  { id: "dashboard", href: "/admin", label: "Dashboard", ja: "ダッシュボード" },
  { id: "students", href: "/admin/students", label: "Students", ja: "学生" },
  { id: "documents", href: "/admin/documents", label: "Documents", ja: "教材" },
];

/** The password gate and the navigation, shared by every admin page.
 *
 * Extracted when the portal became three pages: the gate is the only thing
 * standing between a URL and the roster of every student, and three copies
 * of it is three chances for one to drift. Each page renders inside this and
 * is never mounted at all until the session is confirmed to be the admin's.
 */
export function AdminShell({
  active,
  title,
  intro,
  children,
}: {
  active: AdminSection;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session>("checking");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState("");
  const [busy, setBusy] = useState(false);

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
      // Unconfigured deployment: show the sign-in form; submitting it
      // surfaces the real error rather than rendering a blank page.
      setSession("signed_out");
    }
  }, []);

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
        // Reporting every failure as "wrong password" hid a real lockout
        // once: a rate limit, an unconfirmed email and a misconfigured
        // deployment look identical from here, and none of them are fixed by
        // typing the password again.
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

  if (session === "checking") {
    return (
      <Frame active={active} authenticated={false}>
        <div role="status" className="mx-auto max-w-sm py-24 text-center text-sm text-stone-400">
          Checking your session…
        </div>
      </Frame>
    );
  }

  if (session !== "admin") {
    return (
      <Frame active={active} authenticated={false}>
        <div className="mx-auto max-w-sm py-16">
          <h1 className="text-center text-lg font-semibold text-stone-800">Admin sign-in</h1>
          <p className="mt-1 text-center text-sm text-stone-500">
            {session === "not_admin"
              ? "You are signed in as a student. Sign in with the admin account to continue."
              : "This area is for the course administrator."}
          </p>
          <form onSubmit={signIn} className="mt-6 space-y-3">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Admin password"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
            <button
              type="submit"
              disabled={busy || password === ""}
              className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {signInError && <p className="mt-4 text-sm text-red-700">{signInError}</p>}
          <p className="mt-6 text-center text-xs text-stone-400">
            <Link href="/" className="underline hover:text-stone-600">
              ← Back to ChatTobira
            </Link>
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame active={active} authenticated>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
        {intro && <p className="mt-1 text-sm text-stone-500">{intro}</p>}
      </header>
      {children}
    </Frame>
  );
}

function Frame({
  active,
  authenticated,
  children,
}: {
  active: AdminSection;
  authenticated: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-stone-50">
      <div className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/admin" className="font-semibold text-stone-900">
            ChatTobira <span className="font-normal text-stone-400">admin</span>
          </Link>
          {authenticated && (
            <nav className="flex flex-wrap gap-1 text-sm">
              {SECTIONS.map((section) => (
                <Link
                  key={section.id}
                  href={section.href}
                  aria-current={section.id === active ? "page" : undefined}
                  className={
                    section.id === active
                      ? "rounded-lg bg-stone-900 px-3 py-1.5 font-medium text-white"
                      : "rounded-lg px-3 py-1.5 text-stone-600 hover:bg-stone-100"
                  }
                >
                  {section.label}
                  <span className="ml-1.5 text-xs opacity-60" lang="ja">
                    {section.ja}
                  </span>
                </Link>
              ))}
            </nav>
          )}
          <Link
            href="/"
            className="ml-auto rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            Back to app
          </Link>
        </div>
      </div>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}

/** Placeholder rows shown while a table loads, so a slow query reads as work
 * in progress rather than an empty table or a blank page. */
export function TableSkeleton({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-stone-100">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex gap-4 px-4 py-3.5">
          {Array.from({ length: columns }).map((_, column) => (
            <div
              key={column}
              className="h-3.5 animate-pulse rounded bg-stone-100 motion-reduce:animate-none"
              style={{ width: column === 0 ? "28%" : `${Math.max(12, 22 - column * 3)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A bordered white card, the shape every panel in this app already uses. */
export function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-stone-500">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
