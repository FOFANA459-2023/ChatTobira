import { AuthCard } from "@/components/auth-card";
import { SignOutLink } from "@/components/sign-out-link";
import { ADMIN_EMAIL } from "@/lib/admin";

/** Where an account that is waiting for approval lands.
 *
 * Reached by the middleware, not by a link: a confirmed account that has not
 * been approved is sent here from wherever it tried to go, so there is no way
 * into the app that goes round it.
 *
 * It explains WHY rather than only that, because the student has done
 * everything asked of them — signed up, confirmed their address — and being
 * stopped without a reason reads as a fault. The reason is real: ChatTobira
 * teaches from copyright-protected APU material, which is why the domain used
 * to be the gate (0010) and why a person is the gate now (0019).
 */
export default function PendingApprovalPage() {
  return (
    <AuthCard title="ChatTobira is not open to the public">
      <div className="space-y-4 text-sm leading-relaxed text-stone-600">
        <p>
          ChatTobira teaches from Ritsumeikan APU course materials, which are
          copyright-protected. Under APU policy, access is granted one account
          at a time.
        </p>
        <p>
          Your email is confirmed and your account is waiting for approval.
          You&rsquo;ll be able to sign in once it&rsquo;s approved.
        </p>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
          Questions or concerns? Write to the developer at{" "}
          {/* Selectable rather than a mailto: a student reading this on a
              shared or locked-down machine needs the address itself, and an
              address they can copy works everywhere a link might not. */}
          <span className="font-medium break-all select-all">{ADMIN_EMAIL}</span>
        </div>
      </div>
      <p className="mt-6 text-center text-sm">
        <SignOutLink className="text-stone-500 underline" />
      </p>
    </AuthCard>
  );
}
