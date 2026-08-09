"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MagicLinkForm } from "@/components/magic-link-form";
import { NavBar } from "@/components/nav";
import {
  flattenItems,
  isCorrect,
  scoreQuiz,
  splitUnderline,
  studyPlan,
  type Quiz,
  type QuizItem,
  type QuizKind,
} from "@/lib/quiz";

/** Japanese text with 【 】-marked words rendered as real underlines — the
 * printed papers underline the word an item asks about, and a literal marker
 * or a ＿＿ beside the word reads as a line NEXT to it, not under it. */
function JaText({ text }: { text: string }) {
  return (
    <>
      {splitUnderline(text).map((segment, i) =>
        segment.underline ? (
          <u key={i} className="underline decoration-2 underline-offset-4">
            {segment.text}
          </u>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface Book {
  id: number;
  title: string;
}

type Phase = "setup" | "loading" | "active" | "done" | "error" | "trial_exhausted";

const KIND_INFO: Record<
  QuizKind,
  { label: string; title: string; ja: string; blurb: string }
> = {
  grammar: {
    label: "Grammar",
    title: "Grammar Practice Test",
    ja: "文法",
    blurb: "Particles, conjugation, and sentence patterns — like the 文法ふくしゅうシート.",
  },
  kanji: {
    label: "Kanji & Vocabulary",
    title: "Kanji Practice Test",
    ja: "漢字・語彙",
    blurb: "Readings, writing, and words in context — like the 文字・語彙 section.",
  },
};

// Section numerals as they appear on the paper.
const ROMAN = ["I", "II", "III", "IV"];

export function QuizView({
  initialKind = "grammar",
  authenticated = true,
}: {
  initialKind?: QuizKind;
  authenticated?: boolean;
}) {
  const [kind, setKind] = useState<QuizKind>(initialKind);
  const [books, setBooks] = useState<Book[]>([]);
  const [bookId, setBookId] = useState<number | null>(null);
  const [focus, setFocus] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState(false);
  const [errorText, setErrorText] = useState("");
  // AI coaching for the checked paper: null = not requested, "" = loading.
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/quiz")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { books: Book[] }) => setBooks(data.books))
      .catch(() => setBooks([]));
  }, []);

  const selectedBook = books.find((b) => b.id === bookId) ?? null;
  const items = quiz ? flattenItems(quiz) : [];
  const answered = items.filter((_, i) => (answers[i] ?? "") !== "").length;

  async function generate() {
    if (!bookId) return;
    setPhase("loading");
    setChecked(false);
    setAnswers({});
    setFeedback(null);
    // "New Test" must mean new questions: the previous paper's texts ride
    // along so the generator writes around them.
    const avoid = quiz
      ? flattenItems(quiz)
          .flatMap((item) => [item.question, item.sentence])
          .filter((text): text is string => Boolean(text))
          .slice(0, 40)
      : undefined;
    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: bookId,
          focus: focus.trim() || undefined,
          kind,
          count: 15,
          avoid,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (body.error === "trial_exhausted") {
          setPhase("trial_exhausted");
          window.scrollTo({ top: 0 });
          return;
        }
        setErrorText(
          body.error === "no_material"
            ? "No material is loaded for that selection yet. Try another textbook."
            : body.error === "quota_exhausted"
              ? "You have reached today's limit. It resets at midnight, Japan time."
              : "Could not generate a test. Please try again.",
        );
        setPhase("error");
        return;
      }
      setQuiz((await response.json()) as Quiz);
      setPhase("active");
      window.scrollTo({ top: 0 });
    } catch {
      setErrorText("Could not generate a test. Please try again.");
      setPhase("error");
    }
  }

  function retake() {
    setAnswers({});
    setChecked(false);
    setFeedback(null);
    setPhase("active");
    window.scrollTo({ top: 0 });
  }

  function backToSetup() {
    setQuiz(null);
    setChecked(false);
    setAnswers({});
    setFeedback(null);
    setPhase("setup");
    window.scrollTo({ top: 0 });
  }

  /** Ask the coach about the just-checked paper. Best-effort: on any failure
   * the deterministic study plan stands alone rather than blocking the score. */
  async function requestFeedback(paper: Quiz, given: Record<number, string>) {
    setFeedback("");
    const paperItems = flattenItems(paper);
    const { correct: right, total: all } = scoreQuiz(paper, given);
    try {
      const response = await fetch("/api/quiz/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          scope_description: paper.scope_description.slice(0, 500),
          score: { correct: right, total: all },
          results: paperItems.slice(0, 30).map((item, i) => ({
            question: (item.sentence ?? item.question).slice(0, 300),
            review: item.review.slice(0, 200),
            correct: isCorrect(item, given[i] ?? ""),
            given: (given[i] ?? "").slice(0, 120) || undefined,
            answer: item.answer.slice(0, 120),
          })),
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { feedback?: string };
      setFeedback(body.feedback?.trim() || null);
    } catch {
      setFeedback(null);
    }
  }

  const { correct, total } = quiz ? scoreQuiz(quiz, answers) : { correct: 0, total: 0 };

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
      <NavBar active={kind} authenticated={authenticated} />
      <div className="flex-1 px-4 py-6">
        {phase === "trial_exhausted" && (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <p className="text-sm font-medium text-stone-800">
              You are out of free trial. Enter your email below and we will
              send you a sign-in link so you can keep studying.
            </p>
            <div className="mt-4 text-left">
              <MagicLinkForm showAdminLink />
            </div>
          </div>
        )}

        {(phase === "setup" || phase === "loading" || phase === "error") && (
          <div className="mx-auto mt-8 max-w-lg">
            <div className="text-center">
              <p lang="ja" className="text-xl text-stone-600">
                テストの練習をしましょう
              </p>
              <p className="mt-2 text-sm text-stone-500">
                Practice tests in the same format as the real ones. Pick a test
                type and the material, answer every question, then check your
                score and read the explanations.
              </p>
            </div>

            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {(Object.keys(KIND_INFO) as QuizKind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={[
                    "rounded-2xl border p-4 text-left",
                    kind === k
                      ? "border-stone-900 bg-white shadow-sm"
                      : "border-stone-200 bg-white/60 hover:border-stone-400",
                  ].join(" ")}
                >
                  <p className="font-medium">
                    {KIND_INFO[k].label}{" "}
                    <span lang="ja" className="font-normal text-stone-400">
                      {KIND_INFO[k].ja}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-stone-500">{KIND_INFO[k].blurb}</p>
                </button>
              ))}
            </div>

            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700">Textbook</span>
                <select
                  value={bookId ?? ""}
                  onChange={(e) => {
                    setBookId(e.target.value ? Number(e.target.value) : null);
                  }}
                  className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select a textbook…</option>
                  {books.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.title}
                    </option>
                  ))}
                </select>
              </label>

              {selectedBook && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-stone-700">
                    What should the test focus on?{" "}
                    <span className="font-normal text-stone-400">(optional)</span>
                  </span>
                  <input
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                    maxLength={200}
                    placeholder="e.g. 〜ておく、Topic 13、te-form…"
                    className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
                  />
                  <span className="mt-1 block text-xs text-stone-400">
                    Leave blank to be tested on lessons from the whole book.
                  </span>
                </label>
              )}
            </div>

            <button
              onClick={generate}
              disabled={!bookId || phase === "loading"}
              className="mt-6 w-full rounded-xl bg-stone-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {phase === "loading"
                ? "Writing your test…"
                : `Start the ${KIND_INFO[kind].title}`}
            </button>
            {phase === "error" && (
              <p className="mt-4 text-center text-sm text-red-700">{errorText}</p>
            )}
            {!authenticated && (
              <p className="mt-3 text-center text-xs text-stone-400">
                You can sit 1 practice test free — after that, sign in with
                your invited email.
              </p>
            )}
            <p className="mt-4 text-center">
              <Link href="/" className="text-sm text-stone-500 underline hover:text-stone-900">
                ← Back to chat
              </Link>
            </p>
          </div>
        )}

        {quiz && (phase === "active" || phase === "done") && (
          <div className="space-y-8">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{KIND_INFO[kind].title}</h2>
                {!checked && (
                  <p className="text-sm text-stone-500">
                    {answered} / {items.length} answered
                  </p>
                )}
              </div>
              <p className="mt-1 text-sm text-stone-500">{quiz.scope_description}</p>
            </div>

            {checked && (
              <ScoreCard
                correct={correct}
                total={total}
                plan={studyPlan(quiz, answers)}
                feedback={feedback}
                onRetake={retake}
                onNew={backToSetup}
                onRegenerate={generate}
              />
            )}

            {quiz.sections.map((section, sectionIndex) => {
              // Global question numbering continues across sections, as on
              // the printed papers.
              const offset = quiz.sections
                .slice(0, sectionIndex)
                .reduce((n, s) => n + s.items.length, 0);
              return (
                <section key={sectionIndex}>
                  <div className="border-b-2 border-stone-800 pb-2">
                    <p className="font-semibold">
                      問題{ROMAN[sectionIndex] ?? sectionIndex + 1}{" "}
                      <span lang="ja" className="font-medium">
                        {section.instruction_ja}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{section.instruction_en}</p>
                    {section.items.some((item) => item.type === "fill_blank") && (
                      <p className="mt-0.5 text-xs text-stone-400">
                        Answers are accepted in hiragana, kanji, or romaji
                        (English letters) — any correct form counts.
                      </p>
                    )}
                  </div>
                  <div className="mt-4 space-y-4">
                    {section.items.map((item, itemIndex) => {
                      const index = offset + itemIndex;
                      return (
                        <QuizItemView
                          key={index}
                          index={index}
                          item={item}
                          given={answers[index] ?? ""}
                          checked={checked}
                          onAnswer={(value) =>
                            setAnswers((current) => ({ ...current, [index]: value }))
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {!checked ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => {
                    setChecked(true);
                    setPhase("done");
                    void requestFeedback(quiz, answers);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  disabled={answered < items.length}
                  className="rounded-xl bg-stone-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  採点する — Check answers
                </button>
                {answered < items.length && (
                  <p className="text-sm text-stone-500">
                    Answer all {items.length} questions to check.
                  </p>
                )}
                <button
                  onClick={backToSetup}
                  className="rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm hover:bg-stone-100"
                >
                  Start over
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={retake}
                  className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700"
                >
                  Retake this test
                </button>
                <button
                  onClick={generate}
                  className="rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm hover:bg-stone-100"
                >
                  New Test
                </button>
                <button
                  onClick={backToSetup}
                  className="rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm hover:bg-stone-100"
                >
                  Change test type
                </button>
                <Link
                  href="/"
                  className="rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm hover:bg-stone-100"
                >
                  Back to chat
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreCard({
  correct,
  total,
  plan,
  feedback,
  onRetake,
  onNew,
  onRegenerate,
}: {
  correct: number;
  total: number;
  plan: { review: string; questions: number[] }[];
  /** null = unavailable, "" = still being written, otherwise the coaching. */
  feedback: string | null;
  onRetake: () => void;
  onNew: () => void;
  onRegenerate: () => void;
}) {
  const percent = total === 0 ? 0 : Math.round((correct / total) * 100);
  const [ja, en] =
    percent === 100
      ? ["満点！", "Perfect score!"]
      : percent >= 80
        ? ["よくできました！", "Great work — nearly there."]
        : percent >= 60
          ? ["もう少し！", "Getting there. Read the explanations below."]
          : ["がんばりましょう！", "Review the explanations below, then try again."];

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <div className="text-center">
        <p className="text-4xl font-semibold">
          {correct} <span className="text-xl font-normal text-stone-400">/ {total}</span>
        </p>
        <p className="mt-1 text-sm text-stone-500">{percent}%</p>
        <p className="mt-3">
          <span lang="ja" className="font-medium">
            {ja}
          </span>{" "}
          <span className="text-sm text-stone-500">{en}</span>
        </p>
      </div>

      {feedback === "" && (
        <p className="mt-5 animate-pulse rounded-xl bg-stone-50 p-4 text-sm text-stone-400">
          Writing your feedback…
        </p>
      )}
      {feedback && (
        <div className="mt-5 rounded-xl border border-stone-200 bg-white p-4 text-left">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Your study coach
          </p>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-stone-700">
            {feedback}
          </p>
        </div>
      )}

      {plan.length > 0 ? (
        <div className="mt-5 rounded-xl bg-stone-50 p-4 text-left">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Where to study next
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Based on this test, these are the parts of the course to review —
            most missed first.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-stone-700">
            {plan.map(({ review, questions }) => (
              <li key={review} className="flex items-baseline gap-2">
                <span className="text-stone-400">•</span>
                <span>
                  {review}{" "}
                  <span className="text-xs text-stone-400">
                    ({questions.length === 1 ? "question" : "questions"}{" "}
                    {questions.join(", ")})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-5 rounded-xl bg-green-50 p-4 text-center text-sm text-green-800">
          Nothing to review from this paper — everything correct. Try a New
          Test, or change the focus to drill something different.
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button
          onClick={onRetake}
          className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          Retake
        </button>
        <button
          onClick={onRegenerate}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-100"
        >
          New Test
        </button>
        <button
          onClick={onNew}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-100"
        >
          Change settings
        </button>
      </div>
    </div>
  );
}

// Choice markers as printed on the papers.
const CIRCLED = ["①", "②", "③", "④"];

function QuizItemView({
  index,
  item,
  given,
  checked,
  onAnswer,
}: {
  index: number;
  item: QuizItem;
  given: string;
  checked: boolean;
  onAnswer: (value: string) => void;
}) {
  const correct = checked && isCorrect(item, given);

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium">
        {checked && (
          <span className={correct ? "mr-1 text-green-600" : "mr-1 text-red-600"}>
            {correct ? "○" : "✕"}
          </span>
        )}
        ({index + 1}) <JaText text={item.question} />
      </p>
      {item.sentence && (
        <p lang="ja" className="mt-2 text-base leading-8">
          <JaText text={item.sentence} />
        </p>
      )}

      {item.type === "multiple_choice" && item.choices ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {item.choices.map((choice, choiceIndex) => (
            <button
              key={choice}
              onClick={() => !checked && onAnswer(choice)}
              className={[
                "rounded-lg border px-3 py-2 text-left text-sm",
                given === choice
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-300 bg-white hover:bg-stone-100",
                checked && choice === item.answer
                  ? "!border-green-600 !bg-green-50 !text-green-900"
                  : "",
                checked && given === choice && choice !== item.answer
                  ? "!border-red-500 !bg-red-50 !text-red-900"
                  : "",
              ].join(" ")}
            >
              <span className="mr-1.5 text-stone-400">{CIRCLED[choiceIndex] ?? ""}</span>
              <JaText text={choice} />
            </button>
          ))}
        </div>
      ) : (
        <input
          value={given}
          onChange={(e) => !checked && onAnswer(e.target.value)}
          placeholder="こたえ"
          lang="ja"
          className="mt-3 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
        />
      )}

      {checked && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            correct ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"
          }`}
        >
          {!correct && (
            <p>
              Answer:{" "}
              <span lang="ja">
                {item.answer}
                {item.answer_kana && item.answer_kana !== item.answer
                  ? `（${item.answer_kana}）`
                  : ""}
              </span>
            </p>
          )}
          <p className={correct ? "" : "mt-1"}>{item.explanation}</p>
          <p className="mt-1.5 border-t border-black/5 pt-1.5 text-xs opacity-80">
            <span className="font-medium">Review:</span> {item.review}
          </p>
        </div>
      )}
    </div>
  );
}
