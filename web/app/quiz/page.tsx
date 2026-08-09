import { QuizView } from "@/components/quiz";
import { createClient } from "@/lib/supabase/server";

export default async function QuizPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  // Signed-out visitors see the quiz too: middleware lets /quiz through and
  // /api/quiz meters them with the one-test trial before requiring sign-in.
  // The session is read here only so the navbar and the trial notice match
  // what the API will do.
  let authenticated = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authenticated = Boolean(user);
  } catch {
    // Unreachable auth reads as signed out; the trial still works.
  }

  const { kind } = await searchParams;
  const initialKind = kind === "kanji" ? "kanji" : "grammar";
  // Keyed so the nav's Grammar/Kanji links switch modes even when the
  // student is already on /quiz — same tree position, new state.
  return (
    <QuizView key={initialKind} initialKind={initialKind} authenticated={authenticated} />
  );
}
