"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const PAGES = [
  { href: "/", label: "Chat", ja: "チャット" },
  { href: "/quiz?kind=grammar", label: "Grammar test", ja: "文法" },
  { href: "/quiz?kind=kanji", label: "Kanji test", ja: "漢字" },
] as const;

/** Shared top navigation. The brand always leads home; every page is one
 * click away from every other page. `active` marks the current page since
 * two nav entries share the /quiz pathname. */
export function NavBar({
  active,
  children,
}: {
  active?: "chat" | "grammar" | "kanji";
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
        {children}
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
      </div>
    </header>
  );
}
