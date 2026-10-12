import Link from "next/link";

import { AuthCard, SetupNotice } from "@/components/auth-card";
import { SignupForm } from "@/components/signup-form";

/** Anyone may ask for an account; nobody gets in until the teacher approves
 * it. See 0019 — the domain used to be the gate and a person is now. */
export default function SignupPage() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  return (
    <AuthCard
      title={
        <>
          Create your account{" "}
          <span className="text-base font-normal text-stone-500">とびら</span>
        </>
      }
      // Since 0019 the address no longer decides who gets in — the teacher
      // does — so this says what actually happens next instead of promising
      // the app to anyone with the right domain.
      intro="Sign up with any email. We will send a link to confirm it, and your account is approved by the course administrator before you can sign in."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-stone-800 underline">
            Sign in
          </Link>
        </>
      }
    >
      {!configured && <SetupNotice />}
      <SignupForm disabled={!configured} />
    </AuthCard>
  );
}
