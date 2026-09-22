import { isAdminEmail } from "@/lib/admin";
import { Chat } from "@/components/chat";
import { listConversations, loadConversation, type ConversationSummary } from "@/lib/history";
import { greetingName } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";
import type { CourseLevel } from "@/lib/uploads";
import type { User } from "@supabase/supabase-js";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ c?: string | string[] }>;
}) {
  const { c } = await searchParams;
  const requestedId = typeof c === "string" && /^\d+$/.test(c) ? Number(c) : null;
  // Signed-out visitors see the chat too: middleware lets "/" through and
  // /api/chat meters them with the 3-question trial before requiring the
  // sign-in.
  let user: User | null = null;
  let level: CourseLevel | null = null;
  let conversations: ConversationSummary[] = [];
  let initial: Awaited<ReturnType<typeof loadConversation>> = null;
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
    if (user) {
      // Defaults the upload picker to the course this student is actually
      // taking, so filing a handout is two taps rather than a quiz.
      // The profile, the chat list and the chat the address names, together.
      const [{ data: profile }, list, opened] = await Promise.all([
        supabase.from("profiles").select("level").eq("id", user.id).single(),
        listConversations(supabase),
        requestedId ? loadConversation(supabase, requestedId) : Promise.resolve(null),
      ]);
      level = ((profile?.level as CourseLevel | null) ?? null) satisfies CourseLevel | null;
      conversations = list;
      // Someone else's id, or one that no longer exists, opens a new chat.
      initial = opened;
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
      conversations={conversations}
      initial={initial}
    />
  );
}
