"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Answer, RichText } from "@/components/answer";
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
  type QuizSection,
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
            <RichText text={segment.text} />
          </u>
        ) : (
          <RichText key={i} text={segment.text} />
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
const ROMAN = ["I", "II", "III", "IV", "V"];

/** Option labels as the papers print them: a. b. c., never A) B) C) D).
 * Across the 40 sat papers in the corpus, every listed-option question is
 * lettered lower-case with a full stop. */
const LETTERS = ["a", "b", "c", "d", "e"];

/** The mark line printed beside a section instruction: (1×5), (2点×5). */
function markLine(marks: number | undefined, items: number): string {
  const each = marks ?? 1;
  return each === 1 ? `(1×${items})` : `(${each}点×${items})`;
}

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
                    placeholder="e.g. 〜ておく、Topic 13 / Lesson 5、te-form…"
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
              <p className="mt-1 text-sm leading-7 text-stone-500">
                <JaText text={quiz.scope_description} />
              </p>
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
                  {/* The papers head each section with its numeral, the
                      instruction, and the marks it carries — 「I. 正しいほうを
                      選んで、〇を書いてください。(1×5)」 — so the student can
                      see what the section is worth before answering it. */}
                  <div className="border-b-2 border-stone-800 pb-2">
                    <p className="font-semibold leading-8">
                      {ROMAN[sectionIndex] ?? sectionIndex + 1}.{" "}
                      <span lang="ja" className="font-medium">
                        <JaText text={section.instruction_ja} />
                      </span>{" "}
                      <span className="font-normal text-stone-500">
                        {markLine(section.marks, section.items.length)}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{section.instruction_en}</p>
                    {section.items.some((item) => item.type === "fill_blank") && (
                      <p className="mt-0.5 text-xs text-stone-400">
                        Answers are accepted in hiragana, kanji, or romaji
                        (English letters).
                      </p>
                    )}
                  </div>
                  {/* A passage shared with the section above is printed once
                      and referred to, exactly as the papers do: the ○× section
                      of the Topic 16 paper opens 「上の文について」 rather than
                      reprinting the text its cloze was built on. */}
                  {section.passage &&
                    (section.passage === quiz.sections[sectionIndex - 1]?.passage ? (
                      <p className="mt-3 text-sm text-stone-500">
                        <span lang="ja">上の文</span> — the passage above.
                      </p>
                    ) : (
                      <div
                        lang="ja"
                        className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 text-base leading-8 shadow-sm"
                      >
                        <JaText text={section.passage} />
                      </div>
                    ))}
                  <div className="mt-4 space-y-4">
                    {section.items.map((item, itemIndex) => {
                      const index = offset + itemIndex;
                      return (
                        <QuizItemView
                          key={index}
                          // Numbered within the section, as the papers do:
                          // every section restarts at (1).
                          label={itemIndex + 1}
                          form={section.form}
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
                  {/* The word box, printed under the items exactly as the
                      papers print it. It is part of the question: without it
                      the section cannot be answered. */}
                  {section.word_bank && section.word_bank.length > 0 && (
                    <div
                      lang="ja"
                      className="mt-4 rounded-xl border-2 border-stone-800 bg-white px-4 py-3 text-center text-base leading-9"
                    >
                      {section.word_bank.map((word, wordIndex) => (
                        <span key={word}>
                          {wordIndex > 0 && <span className="text-stone-400"> ・ </span>}
                          <JaText text={word} />
                        </span>
                      ))}
                    </div>
                  )}
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
          <div className="mt-2 text-sm text-stone-700">
            <Answer text={feedback} />
          </div>
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
          <ul className="mt-2 space-y-1.5 text-sm leading-7 text-stone-700">
            {plan.map(({ review, questions }) => (
              <li key={review} className="flex items-baseline gap-2">
                <span className="text-stone-400">•</span>
                <span>
                  <JaText text={review} />{" "}
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
/** ① ② ③ ④ numbers the ○× statements, which is what the papers use them
 * for — never as option labels. */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

/** The options printed inside the sentence, as the papers set them.
 *
 * 「写真部は週 ( は / に / で ) 2かい かつどうします。」 — the commonest
 * choice question in the whole corpus, and the one the app could not render
 * at all. The student circles one of the options where it stands rather than
 * picking from a list underneath, so the choice has to sit in the text. */
function BracketChoice({
  choices,
  given,
  answer,
  checked,
  onAnswer,
}: {
  choices: string[];
  given: string;
  answer: string;
  checked: boolean;
  onAnswer: (value: string) => void;
}) {
  return (
    <span lang="ja" className="whitespace-nowrap">
      <span className="text-stone-400">（</span>
      {choices.map((choice, index) => (
        <span key={choice}>
          {index > 0 && <span className="px-0.5 text-stone-300">/</span>}
          <button
            onClick={() => !checked && onAnswer(choice)}
            aria-pressed={given === choice}
            className={[
              "rounded-full px-2 py-0.5 leading-7",
              given === choice ? "bg-stone-900 text-white" : "hover:bg-stone-100",
              // The circle the student would draw on paper.
              checked && choice === answer
                ? "!bg-green-50 !text-green-900 ring-2 ring-green-600"
                : "",
              checked && given === choice && choice !== answer
                ? "!bg-red-50 !text-red-900 line-through"
                : "",
            ].join(" ")}
          >
            <JaText text={choice} />
          </button>
        </span>
      ))}
      <span className="text-stone-400">）</span>
    </span>
  );
}

function QuizItemView({
  label,
  form,
  item,
  given,
  checked,
  onAnswer,
}: {
  /** The number printed beside the item, which restarts each section. */
  label: number;
  form?: QuizSection["form"];
  item: QuizItem;
  given: string;
  checked: boolean;
  onAnswer: (value: string) => void;
}) {
  const correct = checked && isCorrect(item, given);
  const choices = item.choices ?? [];
  // ○× statements are numbered ① ② ③ on the papers; everything else (1) (2).
  const isMaruBatsu = form === "maru_batsu" || item.type === "true_false";
  const number = isMaruBatsu ? (CIRCLED[label - 1] ?? `(${label})`) : `(${label})`;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium leading-8">
        {checked && (
          <span className={correct ? "mr-1 text-green-600" : "mr-1 text-red-600"}>
            {correct ? "○" : "✕"}
          </span>
        )}
        {number} <JaText text={item.question} />
        {/* An in-place choice belongs in the sentence, not under it. */}
        {form === "bracket" && choices.length > 0 && !item.sentence && (
          <>
            {" "}
            <BracketChoice
              choices={choices}
              given={given}
              answer={item.answer}
              checked={checked}
              onAnswer={onAnswer}
            />
          </>
        )}
      </p>
      {item.sentence && (
        <p lang="ja" className="mt-2 text-base leading-8">
          <JaText text={item.sentence} />
          {form === "bracket" && choices.length > 0 && (
            <>
              {" "}
              <BracketChoice
                choices={choices}
                given={given}
                answer={item.answer}
                checked={checked}
                onAnswer={onAnswer}
              />
            </>
          )}
        </p>
      )}

      {form !== "bracket" && item.type === "multiple_choice" && choices.length > 0 ? (
        // Listed options are lettered a. b. c. — the only labelling the sat
        // papers use for them. Stacked rather than gridded, because the
        // options are whole sentences on the a〜c comprehension sections.
        <div className="mt-3 space-y-1.5">
          {choices.map((choice, choiceIndex) => (
            <button
              key={choice}
              onClick={() => !checked && onAnswer(choice)}
              className={[
                "flex w-full items-baseline gap-2 rounded-lg border px-3 py-2 text-left text-sm leading-7",
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
              <span className="shrink-0 opacity-60">{LETTERS[choiceIndex] ?? ""}.</span>
              <span>
                <JaText text={choice} />
              </span>
            </button>
          ))}
        </div>
      ) : item.type === "true_false" ? (
        <div className="mt-3 flex gap-2">
          {["○", "×"].map((mark) => (
            <button
              key={mark}
              onClick={() => !checked && onAnswer(mark)}
              aria-pressed={given === mark}
              className={[
                "w-20 rounded-lg border px-3 py-2 text-center text-lg font-medium",
                given === mark
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-300 bg-white hover:bg-stone-100",
                // isCorrect canonicalises ○/◯ and ×/✕ spellings, so the
                // right button highlights even when the model picked a
                // different codepoint than the buttons send.
                checked && isCorrect(item, mark)
                  ? "!border-green-600 !bg-green-50 !text-green-900"
                  : "",
                checked && given === mark && !isCorrect(item, mark)
                  ? "!border-red-500 !bg-red-50 !text-red-900"
                  : "",
              ].join(" ")}
            >
              {mark}
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
          className={`mt-3 rounded-lg px-3 py-2 text-sm leading-7 ${
            correct ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"
          }`}
        >
          {!correct && (
            <p>
              Answer:{" "}
              <span lang="ja">
                <JaText
                  text={
                    item.answer_kana && item.answer_kana !== item.answer
                      ? `${item.answer}（${item.answer_kana}）`
                      : item.answer
                  }
                />
              </span>
            </p>
          )}
          <p className={correct ? "" : "mt-1"}>
            <JaText text={item.explanation} />
          </p>
          <p className="mt-1.5 border-t border-black/5 pt-1.5 text-xs opacity-80">
            <span className="font-medium">Review:</span>{" "}
            <JaText text={item.review} />
          </p>
        </div>
      )}
    </div>
  );
}
