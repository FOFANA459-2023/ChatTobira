import { isAdminEmail } from "@/lib/admin";
import { Chat } from "@/components/chat";
import { greetingName } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";
import type { CourseLevel } from "@/lib/uploads";
import type { User } from "@supabase/supabase-js";

export default async function Home() {
  // Signed-out visitors see the chat too: middleware lets "/" through and
  // /api/chat meters them with the 3-question trial before requiring the
  // sign-in.
  let user: User | null = null;
  let level: CourseLevel | null = null;
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
    if (user) {
      // Defaults the upload picker to the course this student is actually
      // taking, so filing a handout is two taps rather than a quiz.
      const { data: profile } = await supabase
        .from("profiles")
        .select("level")
        .eq("id", user.id)
        .single();
      level = ((profile?.level as CourseLevel | null) ?? null) satisfies CourseLevel | null;
    }
  } catch {
    // Unreachable auth reads as signed out; the trial still works.
  }

  // The full name given at signup. The middleware has already sent anyone
  // who has not finished the welcome questions to /welcome.
  const firstName = greetingName(user?.user_metadata as Record<string, unknown> | undefined);
  const isAdmin = isAdminEmail(user?.email);

  return (
    <Chat
      firstName={firstName}
      isAdmin={isAdmin}
      authenticated={Boolean(user)}
      level={level}
    />
  );
}
