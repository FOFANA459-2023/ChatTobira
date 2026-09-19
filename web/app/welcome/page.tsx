import { redirect } from "next/navigation";

import { NavBar } from "@/components/nav";
import { ProfileForm } from "@/components/profile-form";
import { isAdminEmail } from "@/lib/admin";
import { greetingName } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";

/** Asked once, straight after the email is verified. The middleware sends a
 * signed-in student here until it is answered. */
export default async function WelcomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (isAdminEmail(user.email) || user.app_metadata?.onboarded) redirect("/");

  const name = greetingName(user.user_metadata as Record<string, unknown> | undefined);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <p lang="ja" className="text-xl">
            ようこそ！
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">
            {name ? `Welcome, ${name}` : "Welcome to ChatTobira"}
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Your email is verified. Three quick questions and you are in.
          </p>
          <div className="mt-6">
            <ProfileForm />
          </div>
        </div>
      </main>
    </div>
  );
}
