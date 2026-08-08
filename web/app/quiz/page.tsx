import { QuizView } from "@/components/quiz";

export default function QuizPage() {
  // Auth enforced by middleware; /api/quiz re-checks server-side.
  return <QuizView />;
}
