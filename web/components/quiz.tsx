"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { isCorrect, type Quiz, type QuizItem } from "@/lib/quiz";

interface Book {
  id: number;
  title: string;
  level: string | null;
  doc_type: string;
  topics: string[];
}

type Phase = "setup" | "loading" | "active" | "done" | "error";

export function QuizView() {
  const [books, setBooks] = useState<Book[]>([]);
  const [bookId, setBookId] = useState<number | null>(null);
  const [topic, setTopic] = useState("");
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
          topic: topic || undefined,
          count: 5,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setErrorText(
          body.error === "no_material"
            ? "No material is loaded for that selection yet. Try another topic."
            : body.error === "quota_exhausted"
              ? "You have reached today's limit. It resets at midnight, Japan time."
              : "Could not generate a quiz. Please try again.",
        );
        setPhase("error");
        return;
      }
      setQuiz((await response.json()) as Quiz);
      setPhase("active");
    } catch {
      setErrorText("Could not generate a quiz. Please try again.");
      setPhase("error");
    }
  }

  const score = quiz
    ? quiz.items.filter((item, i) => isCorrect(item, answers[i] ?? "")).length
    : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center justify-between gap-4 border-b border-stone-200 pb-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Practice <span className="font-normal text-stone-400">れんしゅう</span>
        </h1>
        <Link href="/" className="text-sm text-stone-500 hover:text-stone-900">
          Back to chat
        </Link>
      </header>

      {phase !== "active" && phase !== "done" && (
        <div className="mx-auto mt-12 max-w-md text-center">
          <p lang="ja" className="text-xl text-stone-600">
            クイズでふくしゅうしましょう
          </p>
          <p className="mt-2 text-sm text-stone-500">
            Choose the material to be quizzed on, then generate five questions.
          </p>

          <div className="mt-6 space-y-3 text-left">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700">Book / material</span>
              <select
                value={bookId ?? ""}
                onChange={(e) => {
                  setBookId(e.target.value ? Number(e.target.value) : null);
                  setTopic("");
                }}
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select a book…</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.title}
                    {book.level ? ` (${book.level})` : ""}
                  </option>
                ))}
              </select>
            </label>

            {selectedBook && selectedBook.topics.length > 0 && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700">
                  Topic <span className="font-normal text-stone-400">(optional)</span>
                </span>
                <select
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Whole book</option>
                  {selectedBook.topics.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <button
            onClick={generate}
            disabled={!bookId || phase === "loading"}
            className="mt-6 w-full rounded-xl bg-stone-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {phase === "loading" ? "Generating…" : "Generate quiz"}
          </button>
          {phase === "error" && (
            <p className="mt-4 text-sm text-red-700">{errorText}</p>
          )}
        </div>
      )}

      {quiz && (phase === "active" || phase === "done") && (
        <div className="mt-6 space-y-6">
          <h2 className="font-medium">{quiz.title}</h2>
          {quiz.items.map((item, index) => (
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
          ))}

          {!checked ? (
            <button
              onClick={() => {
                setChecked(true);
                setPhase("done");
              }}
              disabled={Object.keys(answers).length < quiz.items.length}
              className="rounded-xl bg-stone-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            >
              Check answers
            </button>
          ) : (
            <div className="flex items-center gap-4">
              <p className="text-lg font-semibold">
                {score} / {quiz.items.length}
              </p>
              <button
                onClick={() => {
                  setQuiz(null);
                  setPhase("setup");
                }}
                className="rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm hover:bg-stone-100"
              >
                New quiz
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
        {index + 1}. {item.question}
      </p>
      {item.sentence && (
        <p lang="ja" className="mt-2 text-base">
          {item.sentence}
        </p>
      )}

      {item.type === "multiple_choice" && item.choices ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {item.choices.map((choice) => (
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
              Expected: <span lang="ja">{item.answer}</span>
            </p>
          )}
          <p className={correct ? "" : "mt-1"}>{item.explanation}</p>
        </div>
      )}
    </div>
  );
}
