import Link from "next/link";
import type { ReactNode } from "react";

import { NavBar } from "@/components/nav";

/** The frame every sign-in page shares: nav, a centred card, the brand. */
export function AuthCard({
  title,
  intro,
  children,
  footer,
}: {
  title: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-viewport flex-col">
      {/* These pages ARE the sign-in forms, so the navbar's own button is
          hidden; the page links remain the way back to the chat. */}
      <NavBar showAuth={false} />
      <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {intro && <div className="mt-2 text-sm text-stone-600">{intro}</div>}
          <div className="mt-6">{children}</div>
          {footer && (
            <div className="mt-6 border-t border-stone-200 pt-4 text-center text-xs text-stone-500">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100 aria-[invalid=true]:border-red-400";

export const primaryButtonClass =
  "w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      {hint && <p className="mt-0.5 text-xs text-stone-500">{hint}</p>}
      <div className="mt-1.5">{children}</div>
      {error && (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** What an out-of-trial visitor is offered: make an account, or sign in. */
export function AuthPrompt({ message }: { message: string }) {
  return (
    <div>
      <p className="text-sm font-medium text-stone-800">{message}</p>
      <div className="mt-3 flex gap-2">
        <Link href="/signup" className={`${primaryButtonClass} text-center`}>
          Create account
        </Link>
        <Link
          href="/login"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-center text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Sign in
        </Link>
      </div>
      <p className="mt-2 text-xs text-stone-500">Free for APU students with an @apu.ac.jp email.</p>
    </div>
  );
}

/** Shown when the build has no Supabase keys. */
export function SetupNotice() {
  return (
    <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Sign-in is temporarily unavailable while this site finishes setup. Please check back
      shortly.
      <span className="mt-1 block text-amber-700">
        Administrator: this deployment was built without NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it
        as a build variable and redeploy — these keys are compiled in at build time, so a runtime
        secret will not work.
      </span>
    </p>
  );
}
