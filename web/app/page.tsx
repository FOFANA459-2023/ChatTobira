import { Chat } from "@/components/chat";
import { firstNameFrom } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  // Auth is enforced in middleware: an unauthenticated visitor never reaches
  // this page, and /api/chat re-checks the session server-side regardless.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const firstName = firstNameFrom(
    user?.user_metadata as Record<string, unknown> | undefined,
    user?.email,
  );
  return <Chat firstName={firstName} />;
}
