import { isAdminEmail } from "@/lib/admin";
import { Chat } from "@/components/chat";
import { NameGate } from "@/components/name-gate";
import { firstNameFrom } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";
import type { CourseLevel } from "@/lib/uploads";
import type { User } from "@supabase/supabase-js";

export default async function Home() {
  // Signed-out visitors see the chat too: middleware lets "/" through and
  // /api/chat meters them with the 3-question trial before requiring the
  // invited sign-in.
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

  // A name is required before studying: metadata only, no email guessing —
  // an invited student's first visit must actually ask. The admin skips the
  // gate; their name is stamped when they set their password.
  const firstName = firstNameFrom(
    user?.user_metadata as Record<string, unknown> | undefined,
    null,
  );
  const isAdmin = isAdminEmail(user?.email);
  if (user && !firstName && !isAdmin) {
    return <NameGate />;
  }

  return (
    <Chat
      firstName={firstName}
      isAdmin={isAdmin}
      authenticated={Boolean(user)}
      level={level}
    />
  );
}
