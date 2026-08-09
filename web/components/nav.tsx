"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { createClient } from "@/lib/supabase/client";

const PAGES = [
  { href: "/", label: "Chat", ja: "チャット" },
  { href: "/quiz?kind=grammar", label: "Grammar test", ja: "文法" },
  { href: "/quiz?kind=kanji", label: "Kanji test", ja: "漢字" },
] as const;

/** Shared top navigation. The brand always leads home; every page is one
 * click away from every other page. `active` marks the current page since
 * two nav entries share the /quiz pathname.
 *
 * Auth controls live at the right end, after the page links: `children`
 * (admin-only actions like Invite students), then Sign out — or a Sign in
 * link for signed-out visitors. Pages behind the auth middleware can omit
 * `authenticated`; only the chat serves signed-out trial visitors. */
export function NavBar({
  active,
  authenticated = true,
  children,
}: {
  active?: "chat" | "grammar" | "kanji";
  authenticated?: boolean;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const current =
    active ?? (pathname === "/" ? "chat" : pathname.startsWith("/quiz") ? "grammar" : undefined);

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-stone-200 bg-white/80 px-4 py-3">
      <Link
        href="/"
        className="text-lg font-semibold tracking-tight hover:text-stone-600"
        title="Back to the chat"
      >
        ChatTobira <span className="font-normal text-stone-400">とびら</span>
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex gap-1 rounded-xl bg-stone-100 p-1">
          {PAGES.map((page, i) => {
            const key = (["chat", "grammar", "kanji"] as const)[i];
            const isActive = current === key;
            return (
              <Link
                key={page.href}
                href={page.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "rounded-lg px-3 py-1.5 text-sm",
                  isActive
                    ? "bg-white font-medium text-stone-900 shadow-sm"
                    : "text-stone-500 hover:text-stone-900",
                ].join(" ")}
              >
                {page.label} <span lang="ja" className="text-xs text-stone-400">{page.ja}</span>
              </Link>
            );
          })}
        </nav>

        {children}

        {authenticated ? (
          <button
            onClick={async () => {
              try {
                await createClient().auth.signOut();
              } finally {
                window.location.assign("/");
              }
            }}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:text-stone-900"
          >
            Sign out
          </button>
        ) : (
          <Link
            href="/login"
            className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
