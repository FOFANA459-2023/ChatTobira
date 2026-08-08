"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/** First-visit gate: an invited student lands signed in but nameless, and
 * the name is required before the chat opens. Saved once to user_metadata;
 * every later visit goes straight through. */
export function NameGate() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setFailed(false);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        data: { first_name: trimmed },
      });
      if (error) throw error;
      // The server component re-reads the metadata and renders the chat.
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        <p lang="ja" className="text-xl">
          ようこそ！
        </p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">
          Welcome to ChatTobira
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          What should we call you? Your first name is all we need.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            required
            autoFocus
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="First name"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-center text-sm outline-none focus:border-stone-500"
          />
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {busy ? "…" : "Start studying"}
          </button>
        </form>
        {failed && (
          <p className="mt-3 text-sm text-red-700">
            Could not save your name. Please try again.
          </p>
        )}
      </div>
    </main>
  );
}
