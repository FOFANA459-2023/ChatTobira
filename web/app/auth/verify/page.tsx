import Link from "next/link";

import { AuthCard, primaryButtonClass } from "@/components/auth-card";

/** The page an emailed link opens. The token is still unspent here — it is
 * spent only when the student presses the button, so a mail scanner that
 * opened the link first has not used it up. See app/auth/confirm/route.ts. */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token_hash = typeof params.token_hash === "string" ? params.token_hash : null;
  const type = typeof params.type === "string" ? params.type : null;
  // What pressing the button does, in the student's words. Every emailed
  // link lands here, so the page has to say which one it is.
  const copy =
    type === "recovery"
      ? { title: "Reset your password", intro: "Press the button to continue, then choose a new password.", button: "Continue" }
      : type === "magiclink"
        ? { title: "Sign in to ChatTobira", intro: "Press the button to sign in on this device.", button: "Sign in" }
        : type === "email_change"
          ? { title: "Confirm your new email", intro: "Press the button to move your ChatTobira account to this address.", button: "Confirm new email" }
          : null;

  if (!token_hash || !type) {
    return (
      <AuthCard title="This link is incomplete">
        <p className="text-sm text-stone-600">
          Open the link from your email again, or{" "}
          <Link href="/login" className="underline">
            ask for a new one
          </Link>
          .
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={
        copy?.title ?? (
          <>
            Confirm your email <span className="text-base font-normal text-stone-500">確認</span>
          </>
        )
      }
      intro={
        copy?.intro ??
        "One click and your ChatTobira account is ready. Then three quick questions and you are in."
      }
    >
      <form method="post" action="/auth/confirm">
        <input type="hidden" name="token_hash" value={token_hash} />
        <input type="hidden" name="type" value={type} />
        <button type="submit" className={primaryButtonClass}>
          {copy?.button ?? "Confirm my email"}
        </button>
      </form>
      <p className="mt-4 text-xs text-stone-500">
        This link works once and expires an hour after it was sent.
      </p>
    </AuthCard>
  );
}
