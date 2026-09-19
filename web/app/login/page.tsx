import Link from "next/link";

import { AuthCard, SetupNotice } from "@/components/auth-card";
import { LoginForm } from "@/components/login-form";
import { normalizeEmail } from "@/lib/email";

/** Student sign-in: APU email and password. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const resend = typeof params.resend === "string" ? normalizeEmail(params.resend) : "";
  const linkFailed = params.error === "link";

  return (
    <AuthCard
      title={
        <>
          Sign in <span className="text-base font-normal text-stone-500">とびら</span>
        </>
      }
      intro="Welcome back. Sign in with your APU email and password."
      footer={
        <Link href="/admin" className="underline hover:text-stone-600">
          Admin sign-in
        </Link>
      }
    >
      {!configured && <SetupNotice />}
      {linkFailed && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          That link has expired or was already used. Sign in below, or ask for a new link.
        </p>
      )}
      <LoginForm
        disabled={!configured}
        initialEmail={resend}
        initialMode={resend ? "resend" : "signin"}
      />
    </AuthCard>
  );
}
