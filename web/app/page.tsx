import { Chat } from "@/components/chat";
import { NameGate } from "@/components/name-gate";
import { firstNameFrom } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  // Auth is enforced in middleware: an unauthenticated visitor never reaches
  // this page, and /api/chat re-checks the session server-side regardless.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A name is required before studying: metadata only, no email guessing —
  // an invited student's first visit must actually ask.
  const firstName = firstNameFrom(
    user?.user_metadata as Record<string, unknown> | undefined,
    null,
  );
  if (user && !firstName) {
    return <NameGate />;
  }

  return <Chat firstName={firstName} />;
}
