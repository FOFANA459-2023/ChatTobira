"use client";

import type { StudyScope } from "@/lib/retrieval";

const LEVELS = [
  { value: "", label: "All levels" },
  { value: "F2", label: "Foundation 2" },
  { value: "F3", label: "Foundation 3" },
  { value: "INT", label: "Intermediate" },
] as const;

// T6-T8 exist for F2, T12-T17 for F3 in the current corpus.
const TOPICS = ["", "T6", "T7", "T8", "T12", "T13", "T14", "T15", "T16", "T17"];

/** Study-mode filter: retrieval never pulls from the wrong week. */
export function ScopePicker({
  scope,
  onChange,
}: {
  scope: StudyScope;
  onChange: (scope: StudyScope) => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        aria-label="Level"
        value={scope.level ?? ""}
        onChange={(e) =>
          onChange({
            ...scope,
            level: (e.target.value || undefined) as StudyScope["level"],
          })
        }
        className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-sm"
      >
        {LEVELS.map((level) => (
          <option key={level.value} value={level.value}>
            {level.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Topic"
        value={scope.topic ?? ""}
        onChange={(e) => onChange({ ...scope, topic: e.target.value || undefined })}
        className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-sm"
      >
        {TOPICS.map((topic) => (
          <option key={topic} value={topic}>
            {topic === "" ? "All topics" : topic}
          </option>
        ))}
      </select>
    </div>
  );
}
