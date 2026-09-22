import { isAdminEmail } from "./admin";
import { listConversations, type ConversationSummary } from "./history";
import { greetingName } from "./name";
import { createClient } from "./supabase/server";

/** Who the sidebar belongs to. Null for a signed-out visitor. */
export interface ShellUser {
  /** The name to greet them by, from their signup. */
  name: string | null;
  email: string | null;
  isAdmin: boolean;
}

/** Everything the app sidebar needs, read once on the server so it renders
 * with the page instead of popping in after it. Pages that need the signed-in
 * user for their own reasons read it from here too, rather than asking
 * Supabase a second time. */
export async function loadShell(): Promise<{
  user: ShellUser | null;
  conversations: ConversationSummary[];
}> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { user: null, conversations: [] };
    return {
      user: {
        name: greetingName(user.user_metadata as Record<string, unknown> | undefined),
        email: user.email ?? null,
        isAdmin: isAdminEmail(user.email),
      },
      conversations: await listConversations(supabase),
    };
  } catch {
    // Unreachable auth reads as signed out, the same as every page's own
    // fallback: the trial still works, and the sidebar simply has no chats.
    return { user: null, conversations: [] };
  }
}
