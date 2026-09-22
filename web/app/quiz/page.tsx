import { QuizView } from "@/components/quiz";
import { loadShell } from "@/lib/shell";

export default async function QuizPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  // Signed-out visitors see the quiz too: middleware lets /quiz through and
  // /api/quiz meters them with the one-test trial before requiring sign-in.
  // The session is read here so the sidebar and the trial notice match what
  // the API will do; an unreachable auth reads as signed out.
  const [{ kind }, shell] = await Promise.all([searchParams, loadShell()]);
  const initialKind = kind === "kanji" ? "kanji" : "grammar";
  // Keyed so the sidebar's Grammar/Kanji links switch modes even when the
  // student is already on /quiz — same tree position, new state.
  return (
    <QuizView
      key={initialKind}
      initialKind={initialKind}
      authenticated={Boolean(shell.user)}
      user={shell.user}
      conversations={shell.conversations}
    />
  );
}
