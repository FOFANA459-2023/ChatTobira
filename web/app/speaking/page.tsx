import { SpeakingPractice } from "@/components/speaking-practice";
import { greetingName } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";

/** Speaking practice, on its own page.
 *
 * The chat's microphone opens a free conversation mid-chat, which is right
 * when a question turns into a conversation. This page is for the other way
 * round: a student who sat down to PRACTISE and wants to choose what — a
 * topic, a grammar point from a particular book, or whatever they most need
 * to get better at saying out loud.
 *
 * Signed-in only, and not by a rule written here: /api/voice/session refuses
 * an anonymous caller, because a spoken minute is metered against an account.
 * The middleware sends a signed-out visitor to /login before this renders.
 */
export default async function SpeakingPage() {
  let firstName: string | null = null;
  let books: { id: number; title: string }[] = [];

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    firstName = greetingName(user?.user_metadata as Record<string, unknown> | undefined);

    // The same catalogue the practice papers are set from, so the two pages
    // cannot disagree about which books the student has.
    const { data } = await supabase
      .from("documents")
      .select("id, title")
      .eq("is_citable", true)
      .order("title");
    books = (data ?? []).map((d) => ({ id: d.id as number, title: d.title as string }));
  } catch {
    // The picker still works without the catalogue: a student can name a
    // topic and talk. An empty list hides the book column rather than the page.
  }

  return <SpeakingPractice firstName={firstName} books={books} />;
}
