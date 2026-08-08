import { QuizView } from "@/components/quiz";

export default async function QuizPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  // Auth enforced by middleware; /api/quiz re-checks server-side.
  const { kind } = await searchParams;
  const initialKind = kind === "kanji" ? "kanji" : "grammar";
  // Keyed so the nav's Grammar/Kanji links switch modes even when the
  // student is already on /quiz — same tree position, new state.
  return <QuizView key={initialKind} initialKind={initialKind} />;
}
