"use client";

import { useState } from "react";

/** Thumbs for the latest answer. One click, silently upserted — students will
 * not fill in forms mid-study, but a single tap builds the eval corpus that
 * tells us whether retrieval changes help or hurt. */
export function FeedbackButtons({ conversationId }: { conversationId?: number }) {
  const [given, setGiven] = useState<1 | -1 | null>(null);

  if (!conversationId) return null;

  async function send(rating: 1 | -1) {
    setGiven(rating);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, rating }),
      });
    } catch {
      /* best-effort; the optimistic UI stands */
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        aria-label="Helpful"
        onClick={() => send(1)}
        className={`rounded-md px-2 py-1 text-xs ${
          given === 1 ? "bg-green-100 text-green-800" : "text-stone-400 hover:bg-stone-100"
        }`}
      >
        👍
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        onClick={() => send(-1)}
        className={`rounded-md px-2 py-1 text-xs ${
          given === -1 ? "bg-red-100 text-red-800" : "text-stone-400 hover:bg-stone-100"
        }`}
      >
        👎
      </button>
    </div>
  );
}
