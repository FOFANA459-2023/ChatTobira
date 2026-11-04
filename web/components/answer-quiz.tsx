"use client";

import { useState } from "react";

import { RichText, langOf } from "@/components/rich-text";
import type { QuizQuestion } from "@/lib/answer";

/** Practice questions the tutor wrote into its own answer.
 *
 * Asking the chat for "five questions on the て-form" used to produce five
 * questions with the answers printed underneath them: everything a student
 * needed except the one thing a question is for, which is not knowing the
 * answer until they have committed to one. The answer key is in the markup
 * and not on the screen — each option is a button, and the verdict and the
 * reason appear only once the student has pressed one.
 *
 * This is deliberately NOT the practice-test screen. That is a paper: a
 * sectioned 文法復習シート with every question answered before anything is
 * marked, because that is how the course's real tests work. This is a tutor
 * checking understanding mid-conversation, so each question is marked the
 * moment it is answered and the explanation follows immediately.
 */

/** Option labels as the course's papers print them: a. b. c., lower case
 * with a full stop. Matches the practice-test screen for the same reason the
 * furigana does — a student should not be able to tell two screens of the
 * same app apart by their lettering. */
const LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

/** Which option is the answer. The first ticked one: a model that ticks two
 * has written one question with two answers, and marking the student wrong
 * for picking the other one is the app's mistake, not theirs. -1 when none
 * is ticked, which makes the question un-markable and it is shown as a plain
 * list instead. */
function answerIndex(question: QuizQuestion): number {
  return question.choices.findIndex((choice) => choice.correct);
}

function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function Question({
  question,
  number,
  picked,
  onPick,
}: {
  question: QuizQuestion;
  number: number;
  picked: number | undefined;
  onPick: (choice: number) => void;
}) {
  const answer = answerIndex(question);
  const answered = picked !== undefined;
  const right = answered && picked === answer;

  return (
    <li className="space-y-2">
      <p className="flex gap-2 font-medium leading-7 text-stone-900">
        <span className="shrink-0 tabular-nums text-stone-400">{number}.</span>
        <span className="whitespace-pre-line" lang={langOf(question.prompt)}>
          <RichText text={question.prompt} />
        </span>
      </p>

      <div className="space-y-1.5 pl-6">
        {question.choices.map((choice, i) => {
          // Once a question is answered the answer is shown whether or not
          // the student found it. Hiding it would leave them with "wrong"
          // and no way to learn what right was.
          const showRight = answered && i === answer;
          const showWrong = answered && i === picked && i !== answer;
          return (
            <button
              key={i}
              type="button"
              // No answer key means nothing to mark against: the options are
              // still readable, but pressing one could only ever lie.
              disabled={answered || answer < 0}
              aria-pressed={picked === i}
              onClick={() => onPick(i)}
              className={[
                "flex w-full items-baseline gap-2 rounded-lg border px-3 py-2 text-left text-sm leading-7 transition-colors",
                showRight
                  ? "border-green-600 bg-green-50 text-green-900"
                  : showWrong
                    ? "border-red-500 bg-red-50 text-red-900"
                    : answered
                      ? "border-stone-200 bg-white text-stone-400"
                      : "border-stone-300 bg-white text-stone-800 hover:border-stone-400 hover:bg-stone-100",
              ].join(" ")}
            >
              <span className="shrink-0 opacity-60">{LETTERS[i] ?? "·"}.</span>
              <span className="grow" lang={langOf(choice.text)}>
                <RichText text={choice.text} />
              </span>
              {showRight && (
                <span className="shrink-0 self-center text-green-700">
                  <Tick />
                </span>
              )}
              {showWrong && (
                <span className="shrink-0 self-center text-red-600">
                  <Cross />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Announced rather than silently appearing: a student using a screen
          reader presses a button and must hear what it did. */}
      <div aria-live="polite" className="pl-6">
        {answered && (
          <p className="text-sm leading-7">
            <span className={right ? "font-semibold text-green-700" : "font-semibold text-red-600"}>
              {right ? "Correct" : "Not quite"}
            </span>
            {question.explanation && (
              <span className="text-stone-600" lang={langOf(question.explanation)}>
                {" — "}
                <RichText text={question.explanation} />
              </span>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function QuizBlock({ questions }: { questions: QuizQuestion[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});

  // Keyed by position, and the positions are append-only: this renders on
  // every streamed frame, and question 1 keeps its answer while question 4
  // is still being written.
  const answered = questions.filter((_, i) => picked[i] !== undefined);
  const done = answered.length === questions.length && questions.length > 0;
  const score = questions.filter((q, i) => picked[i] === answerIndex(q)).length;

  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3.5">
      <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-wide text-stone-500">
        Practice — tap an answer
      </p>
      <ol className="space-y-5">
        {questions.map((question, i) => (
          <Question
            key={i}
            question={question}
            number={i + 1}
            picked={picked[i]}
            onPick={(choice) => setPicked((given) => ({ ...given, [i]: choice }))}
          />
        ))}
      </ol>
      {done && (
        <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-3">
          <p className="text-sm font-medium tabular-nums text-stone-700">
            {score} / {questions.length} correct
          </p>
          <button
            type="button"
            onClick={() => setPicked({})}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-stone-500 hover:bg-stone-200 hover:text-stone-800"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
