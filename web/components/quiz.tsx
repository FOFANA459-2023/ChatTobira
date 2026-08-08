"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { NavBar } from "@/components/nav";
import {
  flattenItems,
  isCorrect,
  scoreQuiz,
  type Quiz,
  type QuizItem,
  type QuizKind,
} from "@/lib/quiz";

interface Book {
  id: number;
  title: string;
}

type Phase = "setup" | "loading" | "active" | "done" | "error";

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

export function QuizView({ initialKind = "grammar" }: { initialKind?: QuizKind }) {
  const [kind, setKind] = useState<QuizKind>(initialKind);
  const [books, setBooks] = useState<Book[]>([]);
  const [bookId, setBookId] = useState<number | null>(null);
  const [focus, setFocus] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState(false);
  const [errorText, setErrorText] = useState("");

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
    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: bookId,
          focus: focus.trim() || undefined,
          kind,
          count: 15,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
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
    setPhase("active");
    window.scrollTo({ top: 0 });
  }

  function backToSetup() {
    setQuiz(null);
    setChecked(false);
    setAnswers({});
    setPhase("setup");
    window.scrollTo({ top: 0 });
  }

  const { correct, total } = quiz ? scoreQuiz(quiz, answers) : { correct: 0, total: 0 };

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
      <NavBar active={kind} />
      <div className="flex-1 px-4 py-6">
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
                        Answers are accepted in hiragana, kanji, or kanji with
                        furigana — any correct form counts.
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
                  New test, same settings
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
  onRetake,
  onNew,
  onRegenerate,
}: {
  correct: number;
  total: number;
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
    <div className="rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
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
          New test
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
        ({index + 1}) {item.question}
      </p>
      {item.sentence && (
        <p lang="ja" className="mt-2 text-base">
          {item.sentence}
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
              {choice}
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
        </div>
      )}
    </div>
  );
}
