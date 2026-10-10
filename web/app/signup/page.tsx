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
      intro="ChatTobira is for APU students. Sign up with your @apu.ac.jp email — we will send a link to confirm it."
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
