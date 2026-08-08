"use client";

import Link from "next/link";

import { MagicLinkForm } from "@/components/magic-link-form";

/** Student sign-in is by invitation: the admin sends the first link from
 * the admin page. This page exists for returning students whose session
 * expired — an invited email can always request a fresh link. */
export default function LoginPage() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          ChatTobira{" "}
          <span className="text-base font-normal text-stone-500">とびら</span>
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          Access is limited to invited students — invites arrive by email.
          Already invited? Enter that email to get a fresh sign-in link.
        </p>


        {!configured && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Sign-in is temporarily unavailable while this site finishes setup.
            Please check back shortly.
            <span className="mt-1 block text-amber-700">
              Administrator: this deployment was built without
              NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it as a build variable and
              redeploy — these keys are compiled in at build time, so a runtime
              secret will not work.
            </span>
          </p>
        )}

        <div className="mt-6">
          <MagicLinkForm disabled={!configured} />
        </div>

        <p className="mt-6 border-t border-stone-200 pt-4 text-center text-xs text-stone-400">
          <Link href="/admin" className="underline hover:text-stone-600">
            Admin sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}
