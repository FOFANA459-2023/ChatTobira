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
 * `authenticated`; only the chat serves signed-out trial visitors. Pages
 * that ARE a sign-in form pass `showAuth={false}` so the navbar does not
 * offer a Sign in button pointing at the very form beside it. */
export function NavBar({
  active,
  authenticated = true,
  showAuth = true,
  children,
}: {
  active?: "chat" | "grammar" | "kanji";
  authenticated?: boolean;
  showAuth?: boolean;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const current =
    active ?? (pathname === "/" ? "chat" : pathname.startsWith("/quiz") ? "grammar" : undefined);

  return (
    // On phones the tab strip takes its own full-width row (order-last +
    // w-full) so labels never wrap mid-word; auth controls stay beside the
    // brand on the first row. From sm up everything sits on one line.
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-stone-200 bg-white/80 px-4 py-3">
      <Link
        href="/"
        className="text-lg font-semibold tracking-tight hover:text-stone-600"
        title="Back to the chat"
      >
        ChatTobira <span className="font-normal text-stone-400">とびら</span>
      </Link>

      <div className="flex items-center gap-2 sm:order-last">
        {children}

        {showAuth &&
          (authenticated ? (
            <button
              onClick={async () => {
                try {
                  await createClient().auth.signOut();
                } finally {
                  window.location.assign("/");
                }
              }}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:text-stone-900"
            >
              Sign out
            </button>
          ) : (
            <Link
              href="/login"
              className="whitespace-nowrap rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
            >
              Sign in
            </Link>
          ))}
      </div>

      <nav className="order-last flex w-full gap-1 rounded-xl bg-stone-100 p-1 sm:order-none sm:w-auto">
        {PAGES.map((page, i) => {
          const key = (["chat", "grammar", "kanji"] as const)[i];
          const isActive = current === key;
          return (
            <Link
              key={page.href}
              href={page.href}
              aria-current={isActive ? "page" : undefined}
              className={[
                "flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-center text-sm sm:flex-none",
                isActive
                  ? "bg-white font-medium text-stone-900 shadow-sm"
                  : "text-stone-500 hover:text-stone-900",
              ].join(" ")}
            >
              {page.label}{" "}
              <span lang="ja" className="hidden text-xs text-stone-400 sm:inline">
                {page.ja}
              </span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
