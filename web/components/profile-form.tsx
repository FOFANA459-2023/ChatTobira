"use client";

import { useState } from "react";

import { primaryButtonClass } from "@/components/auth-card";
import { COLLEGES, ordinal, profileProblems, REASONS, SEMESTERS, type ProfileAnswers } from "@/lib/signup";
import { createClient } from "@/lib/supabase/client";

const option =
  "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors has-[:checked]:border-stone-900 has-[:checked]:bg-stone-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-stone-400";

/** The three questions asked once, after the email is verified. Every one is
 * required; the reasons allow several answers and need at least one. */
export function ProfileForm() {
  const [college, setCollege] = useState<string | null>(null);
  const [semester, setSemester] = useState<number | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [problems, setProblems] = useState<ReturnType<typeof profileProblems>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /** An answered question stops showing its error straight away, rather
   * than waiting for the next press of the button. */
  function answered(question: keyof ProfileAnswers) {
    setProblems((current) => {
      const rest = { ...current };
      delete rest[question];
      return rest;
    });
  }

  function toggleReason(id: string) {
    const next = reasons.includes(id) ? reasons.filter((r) => r !== id) : [...reasons, id];
    setReasons(next);
    if (next.length > 0) answered("reasons");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const answers: ProfileAnswers = { college, semester, reasons };
    const found = profileProblems(answers);
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setFailed(false);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("complete_profile", {
        p_college: college,
        p_semester: semester,
        p_reasons: reasons,
      });
      if (error) throw error;
      // The onboarded flag lives in app_metadata; refresh so the session
      // carries it, then a full load so the middleware lets the chat through.
      await supabase.auth.refreshSession();
      window.location.assign("/");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-7">
      <fieldset aria-describedby={problems.college ? "college-error" : undefined}>
        <legend className="text-sm font-medium text-stone-800">
          Your college <span className="text-red-700">*</span>
        </legend>
        <div className="mt-2 space-y-2">
          {COLLEGES.map((c) => (
            <label key={c.id} className={`${option} border-stone-200`}>
              <input
                type="radio"
                name="college"
                value={c.id}
                checked={college === c.id}
                onChange={() => {
                  setCollege(c.id);
                  answered("college");
                }}
                disabled={busy}
                className="accent-stone-900"
              />
              <span>
                <span className="font-semibold">{c.label}</span>
                <span className="ml-1.5 text-stone-500">{c.name}</span>
              </span>
            </label>
          ))}
        </div>
        {problems.college && (
          <p id="college-error" className="mt-1.5 text-xs text-red-700">
            {problems.college}
          </p>
        )}
      </fieldset>

      <fieldset aria-describedby={problems.semester ? "semester-error" : undefined}>
        <legend className="text-sm font-medium text-stone-800">
          Your semester <span className="text-red-700">*</span>
        </legend>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {SEMESTERS.map((s) => (
            <label
              key={s}
              className={`${option} justify-center border-stone-200 px-2 has-[:checked]:!bg-stone-900 has-[:checked]:font-medium has-[:checked]:text-white`}
            >
              <input
                type="radio"
                name="semester"
                value={s}
                checked={semester === s}
                onChange={() => {
                  setSemester(s);
                  answered("semester");
                }}
                disabled={busy}
                className="sr-only"
              />
              {ordinal(s)}
            </label>
          ))}
        </div>
        {problems.semester && (
          <p id="semester-error" className="mt-1.5 text-xs text-red-700">
            {problems.semester}
          </p>
        )}
      </fieldset>

      <fieldset aria-describedby={problems.reasons ? "reasons-error" : undefined}>
        <legend className="text-sm font-medium text-stone-800">
          Why are you using ChatTobira? <span className="text-red-700">*</span>
        </legend>
        <p className="mt-0.5 text-xs text-stone-500">Choose all that apply.</p>
        <div className="mt-2 space-y-2">
          {REASONS.map((r) => (
            <label key={r.id} className={`${option} border-stone-200`}>
              <input
                type="checkbox"
                name="reasons"
                value={r.id}
                checked={reasons.includes(r.id)}
                onChange={() => toggleReason(r.id)}
                disabled={busy}
                className="accent-stone-900"
              />
              {r.label}
            </label>
          ))}
        </div>
        {problems.reasons && (
          <p id="reasons-error" className="mt-1.5 text-xs text-red-700">
            {problems.reasons}
          </p>
        )}
      </fieldset>

      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy ? "Saving…" : "Start studying"}
      </button>
      {failed && (
        <p className="text-sm text-red-700">Could not save your answers. Please try again.</p>
      )}
    </form>
  );
}
