"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { MAX_TITLE, type ConversationSummary } from "@/lib/history";
import type { ShellUser } from "@/lib/shell";
import { createClient } from "@/lib/supabase/client";

export type ShellPage = "chat" | "speaking" | "grammar" | "kanji";

/** What the chat page hands the sidebar so its chats open in place, without a
 * page load. Every other page leaves this out: there a chat is a link to
 * /?c=<id>, and rename and delete are handled here. */
export interface ChatControls {
  currentId?: number;
  disabled?: boolean;
  onOpen: (id: number) => void;
  onPrefetch: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}

const PRACTICE: { page: ShellPage; href: string; label: string; ja: string; icon: ReactNode }[] = [
  { page: "speaking", href: "/speaking", label: "Speaking", ja: "会話", icon: <MicIcon /> },
  { page: "grammar", href: "/quiz?kind=grammar", label: "Grammar test", ja: "文法", icon: <GrammarIcon /> },
  { page: "kanji", href: "/quiz?kind=kanji", label: "Kanji test", ja: "漢字", icon: <KanjiIcon /> },
];

const COLLAPSE_KEY = "tobira.sidebar.collapsed";

/** The frame every study page sits in: a sidebar with the way to start a new
 * chat, the three kinds of practice, and the student's saved chats under
 * them; and the page beside it.
 *
 * From md up the sidebar is a column, and it folds down to a rail of icons
 * for a student who wants the room. On a phone it is a drawer behind the menu
 * button in a slim top bar, because a phone has no room for a column.
 *
 * `fullHeight` is for the chat, which scrolls its own transcript inside a
 * screen-tall column. Every other page scrolls the document, with the sidebar
 * held in place beside it.
 */
export function AppShell({
  page,
  user,
  conversations: initialConversations = [],
  chat,
  fullHeight = false,
  children,
}: {
  page: ShellPage;
  user: ShellUser | null;
  conversations?: ConversationSummary[];
  chat?: ChatControls;
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Remembered per browser: a student who folds the sidebar away wants it to
  // stay folded on the next page. Storage can be unavailable (private
  // windows, blocked site data); the sidebar then simply starts open.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* default: open */
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((was) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, was ? "0" : "1");
      } catch {
        /* not remembered, still toggled */
      }
      return !was;
    });
  }

  // Away from the chat page this shell owns the list; on it, the chat does,
  // because opening and starting chats changes it.
  const [ownList, setOwnList] = useState(initialConversations);
  // A page can add to the list while it is open — the Speaking page does, the
  // moment a call is first saved. New ids join at the top; anything renamed
  // or deleted here stays as it was.
  useEffect(() => {
    if (chat) return;
    setOwnList((current) => {
      const known = new Set(current.map((c) => c.id));
      const added = initialConversations.filter((c) => !known.has(c.id));
      return added.length > 0 ? [...added, ...current] : current;
    });
  }, [chat, initialConversations]);
  const conversations = chat ? initialConversations : ownList;
  const controls: Controls = chat
    ? { ...chat, inPageNew: true }
    : standaloneControls(ownList, setOwnList);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeDrawer();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  const panel = (inDrawer: boolean) => (
    <SidebarPanel
      page={page}
      user={user}
      conversations={conversations}
      controls={controls}
      inPage={Boolean(chat)}
      collapsed={!inDrawer && collapsed}
      onToggleCollapsed={inDrawer ? closeDrawer : toggleCollapsed}
      inDrawer={inDrawer}
      onNavigate={inDrawer ? closeDrawer : undefined}
    />
  );

  return (
    <div className={fullHeight ? "flex h-viewport" : "flex min-h-viewport"}>
      <aside
        className={`sticky top-0 hidden h-viewport shrink-0 border-r border-stone-200/80 bg-paper transition-[width] duration-200 md:block ${
          collapsed ? "w-16" : "w-64 lg:w-72"
        }`}
      >
        {panel(false)}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={closeDrawer}
            className="absolute inset-0 bg-stone-900/30"
          />
          <aside
            role="dialog"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 w-[82%] max-w-xs bg-paper shadow-2xl"
          >
            {panel(true)}
          </aside>
        </div>
      )}

      <div className={`flex min-w-0 flex-1 flex-col ${fullHeight ? "h-full" : ""}`}>
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-stone-200 bg-white/90 px-2 py-1.5 backdrop-blur md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-2 text-stone-600 hover:bg-stone-100"
          >
            <MenuIcon />
          </button>
          <Link href="/" className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            ChatTobira <span className="font-normal text-stone-400">とびら</span>
          </Link>
          {controls.inPageNew ? (
            <button
              type="button"
              onClick={controls.onNew}
              disabled={controls.disabled}
              aria-label="New chat"
              className="rounded-lg p-2 text-stone-600 hover:bg-stone-100 disabled:opacity-50"
            >
              <PencilIcon />
            </button>
          ) : (
            <Link href="/" aria-label="New chat" className="rounded-lg p-2 text-stone-600 hover:bg-stone-100">
              <PencilIcon />
            </Link>
          )}
        </header>
        {fullHeight ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
      </div>
    </div>
  );
}

type Controls = Omit<ChatControls, "onNew"> & { onNew: () => void; inPageNew: boolean };

/** Rename and delete for pages that are not the chat: straight to the API,
 * shown at once, and put back if the server says no. Opening a chat there is
 * a link, so onOpen is never called. */
function standaloneControls(
  list: ConversationSummary[],
  setList: (update: (all: ConversationSummary[]) => ConversationSummary[]) => void,
): Controls {
  return {
    inPageNew: false,
    onNew: () => window.location.assign("/"),
    onOpen: (id) => window.location.assign(`/?c=${id}`),
    onPrefetch: () => {},
    onRename: (id, title) => {
      const previous = list.find((c) => c.id === id)?.title;
      setList((all) => all.map((c) => (c.id === id ? { ...c, title } : c)));
      void fetch("/api/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        })
        .catch(() => {
          if (previous !== undefined) {
            setList((all) => all.map((c) => (c.id === id ? { ...c, title: previous } : c)));
          }
        });
    },
    onDelete: (id) => {
      const before = list;
      setList((all) => all.filter((c) => c.id !== id));
      void fetch("/api/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        })
        .catch(() => setList(() => before));
    },
  };
}

function SidebarPanel({
  page,
  user,
  conversations,
  controls,
  inPage,
  collapsed,
  inDrawer,
  onToggleCollapsed,
  onNavigate,
}: {
  page: ShellPage;
  user: ShellUser | null;
  conversations: ConversationSummary[];
  controls: ChatControls & { inPageNew?: boolean };
  inPage: boolean;
  collapsed: boolean;
  inDrawer: boolean;
  onToggleCollapsed: () => void;
  onNavigate?: () => void;
}) {
  const newChat = (
    <NewChatButton
      collapsed={collapsed}
      inPage={inPage}
      disabled={controls.disabled}
      onNew={() => {
        controls.onNew();
        onNavigate?.();
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Wordmark and the fold. */}
      <div className={`flex items-center pt-3 ${collapsed ? "flex-col gap-2 px-2" : "justify-between px-4"}`}>
        {!collapsed && (
          <Link href="/" onClick={onNavigate} className="text-lg font-semibold tracking-tight text-stone-900 hover:text-stone-600">
            ChatTobira <span className="font-normal text-stone-400">とびら</span>
          </Link>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={inDrawer ? "Close menu" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={inDrawer ? "Close" : collapsed ? "Expand" : "Collapse"}
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
        >
          {inDrawer ? <CloseIcon /> : <PanelIcon />}
        </button>
      </div>

      <div className={`mt-4 ${collapsed ? "px-2" : "px-3"}`}>{newChat}</div>

      {/* The three ways to practise, always one click away. */}
      <nav aria-label="Practice" className={`mt-5 ${collapsed ? "px-2" : "px-3"}`}>
        {!collapsed && (
          <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400">
            Practice
          </p>
        )}
        <ul className="space-y-0.5">
          {PRACTICE.map((item) => (
            <li key={item.page}>
              <NavItem
                href={item.href}
                label={item.label}
                ja={item.ja}
                icon={item.icon}
                active={page === item.page}
                collapsed={collapsed}
                onClick={onNavigate}
              />
            </li>
          ))}
        </ul>
      </nav>

      {/* Saved chats. Signed-in students only: a trial has no account to
          keep them in. */}
      <div className={`mt-6 flex min-h-0 flex-1 flex-col ${collapsed ? "invisible" : ""}`}>
        {user && !collapsed && (
          <Recents
            conversations={conversations}
            controls={controls}
            inPage={inPage}
            onNavigate={onNavigate}
          />
        )}
      </div>

      <Footer user={user} collapsed={collapsed} onNavigate={onNavigate} />
    </div>
  );
}

function NewChatButton({
  collapsed,
  inPage,
  disabled,
  onNew,
}: {
  collapsed: boolean;
  inPage: boolean;
  disabled?: boolean;
  onNew: () => void;
}) {
  const className = `flex w-full items-center rounded-xl bg-stone-900 text-sm font-medium text-white shadow-sm transition hover:bg-stone-700 disabled:opacity-50 ${
    collapsed ? "justify-center p-2.5" : "gap-2 px-3 py-2.5"
  }`;
  const inner = (
    <>
      <PencilIcon />
      {!collapsed && <span>New chat</span>}
      {!collapsed && (
        <span lang="ja" className="ml-auto text-[11px] font-normal text-stone-400">
          新しい会話
        </span>
      )}
    </>
  );
  // On the chat page a new chat is a clean screen in place; anywhere else it
  // is the chat page itself, which always opens on a new chat.
  return inPage ? (
    <button type="button" onClick={onNew} disabled={disabled} className={className} title="New chat">
      {inner}
    </button>
  ) : (
    <Link href="/" className={className} title="New chat" aria-label={collapsed ? "New chat" : undefined}>
      {inner}
    </Link>
  );
}

function NavItem({
  href,
  label,
  ja,
  icon,
  active,
  collapsed,
  onClick,
}: {
  href: string;
  label: string;
  ja: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`relative flex items-center rounded-lg text-sm transition ${
        collapsed ? "justify-center p-2.5" : "gap-2.5 px-2.5 py-2"
      } ${
        active
          ? "bg-white font-medium text-stone-900 shadow-sm"
          : "text-stone-600 hover:bg-stone-200/50 hover:text-stone-900"
      }`}
    >
      {/* The door's edge: where the student is. */}
      {active && (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-shu" />
      )}
      <span className={active ? "text-shu" : "text-stone-400"}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && (
        <span lang="ja" className={`text-xs ${active ? "text-shu" : "text-stone-400"}`}>
          {ja}
        </span>
      )}
    </Link>
  );
}

/** Chats grouped by when they were started, the way a student remembers them:
 * the one from this morning, the one from yesterday, the ones from the week. */
function groupByDay(conversations: ConversationSummary[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups: { label: string; items: ConversationSummary[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This week", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const c of conversations) {
    const at = Date.parse(c.createdAt);
    const index = at >= startOfToday ? 0 : at >= startOfToday - day ? 1 : at >= startOfToday - 6 * day ? 2 : 3;
    groups[index].items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Past this many chats the list gets a filter box: scrolling through dozens
 * of titles for the one about the te-form is slower than typing "te". */
const FILTER_FROM = 8;

function Recents({
  conversations,
  controls,
  inPage,
  onNavigate,
}: {
  conversations: ConversationSummary[];
  controls: ChatControls;
  inPage: boolean;
  onNavigate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);
  const groups = useMemo(() => groupByDay(shown), [shown]);

  return (
    <>
      <div className="flex items-baseline justify-between px-5">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400">Recents</p>
        {conversations.length > 0 && (
          <span className="text-[11px] text-stone-400">{conversations.length}</span>
        )}
      </div>
      {conversations.length >= FILTER_FROM && (
        <div className="mt-2 px-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a chat"
            aria-label="Find a chat"
            className="w-full rounded-lg border border-stone-200 bg-white/70 px-2.5 py-1.5 text-sm outline-none placeholder:text-stone-400 focus:border-stone-400"
          />
        </div>
      )}
      <nav aria-label="Saved chats" className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-stone-400">
            Your chats will appear here.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-stone-400">No chat matches that.</p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mt-3">
              <p className="px-2 pb-1 text-[11px] text-stone-400">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    current={c.id === controls.currentId}
                    disabled={controls.disabled}
                    inPage={inPage}
                    onOpen={() => {
                      onNavigate?.();
                      if (c.id !== controls.currentId) controls.onOpen(c.id);
                    }}
                    onPrefetch={() => controls.onPrefetch(c.id)}
                    onRename={(title) => controls.onRename(c.id, title)}
                    onDelete={() => controls.onDelete(c.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
    </>
  );
}

function ChatRow({
  chat,
  current,
  disabled,
  inPage,
  onOpen,
  onPrefetch,
  onRename,
  onDelete,
}: {
  chat: ConversationSummary;
  current: boolean;
  disabled?: boolean;
  inPage: boolean;
  onOpen: () => void;
  onPrefetch: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== chat.title) onRename(title);
    else setDraft(chat.title);
  }

  if (editing) {
    return (
      <li>
        <input
          ref={inputRef}
          value={draft}
          maxLength={MAX_TITLE}
          aria-label="Chat name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(chat.title);
              setEditing(false);
            }
          }}
          className="w-full rounded-lg border border-stone-400 bg-white px-2.5 py-1.5 text-sm outline-none"
        />
      </li>
    );
  }

  const titleClass = `min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-sm disabled:opacity-60 ${
    current ? "font-medium text-stone-900" : "text-stone-600"
  }`;

  return (
    <li
      className={`group flex items-center rounded-lg ${
        current ? "bg-white shadow-sm" : "hover:bg-stone-200/50"
      }`}
    >
      {inPage ? (
        <button
          type="button"
          onClick={onOpen}
          onPointerEnter={onPrefetch}
          onFocus={onPrefetch}
          onTouchStart={onPrefetch}
          disabled={disabled}
          aria-current={current ? "page" : undefined}
          title={chat.title}
          className={titleClass}
        >
          {chat.title}
        </button>
      ) : (
        <a href={`/?c=${chat.id}`} title={chat.title} className={titleClass}>
          {chat.title}
        </a>
      )}
      {/* Always visible on touch screens, where there is no hover to reveal
          them; on a pointer they appear on the row being pointed at. */}
      <span className="flex shrink-0 items-center pr-1 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        <button
          type="button"
          onClick={() => {
            setDraft(chat.title);
            setEditing(true);
          }}
          aria-label={`Rename ${chat.title}`}
          title="Rename"
          className="rounded p-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete "${chat.title}"?`)) onDelete();
          }}
          aria-label={`Delete ${chat.title}`}
          title="Delete"
          className="rounded p-1.5 text-stone-400 hover:bg-shu-soft hover:text-shu"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </button>
      </span>
    </li>
  );
}

function Footer({
  user,
  collapsed,
  onNavigate,
}: {
  user: ShellUser | null;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  async function signOut() {
    try {
      await createClient().auth.signOut();
    } finally {
      window.location.assign("/");
    }
  }

  if (!user) {
    return collapsed ? (
      <div className="border-t border-stone-200/80 p-2">
        <Link href="/login" aria-label="Sign in" title="Sign in" className="flex justify-center rounded-lg p-2.5 text-stone-500 hover:bg-stone-200/50">
          <UserIcon />
        </Link>
      </div>
    ) : (
      <div className="border-t border-stone-200/80 p-3">
        <p className="px-1 text-xs leading-relaxed text-stone-500">
          Sign up with your APU email to keep your chats and practise without limits.
        </p>
        <div className="mt-2 flex gap-2">
          <Link
            href="/login"
            onClick={onNavigate}
            className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-center text-sm text-stone-700 hover:bg-stone-100"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            onClick={onNavigate}
            className="flex-1 rounded-lg bg-stone-900 px-3 py-1.5 text-center text-sm font-medium text-white hover:bg-stone-700"
          >
            Sign up
          </Link>
        </div>
      </div>
    );
  }

  const display = user.name ?? user.email ?? "Student";
  const initial = display.trim().charAt(0).toUpperCase() || "S";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-stone-200/80 p-2">
        <span
          title={display}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-shu-soft text-sm font-semibold text-shu"
        >
          {initial}
        </span>
        <button type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-stone-400 hover:bg-stone-200/50 hover:text-stone-700">
          <SignOutIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-stone-200/80 p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-shu-soft text-sm font-semibold text-shu">
          {initial}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium text-stone-800">{display}</span>
          <span className="block truncate text-xs text-stone-400">
            {user.isAdmin ? "Administrator" : (user.email ?? "APU student")}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void signOut()}
          aria-label="Sign out"
          title="Sign out"
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
        >
          <SignOutIcon />
        </button>
      </div>
      {user.isAdmin && (
        <Link
          href="/admin"
          onClick={onNavigate}
          className="mt-2 block rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-center text-sm text-stone-700 hover:bg-stone-100"
        >
          Admin
        </Link>
      )}
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function PencilIcon() {
  return (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

function MicIcon() {
  return (
    <Svg>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </Svg>
  );
}

function GrammarIcon() {
  return (
    <Svg>
      <path d="M4 5h16" />
      <path d="M4 10h10" />
      <path d="M4 15h16" />
      <path d="M4 20h7" />
    </Svg>
  );
}

function KanjiIcon() {
  return (
    <Svg>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M8 9h8" />
      <path d="M12 6.5v11" />
      <path d="M8.5 14.5 12 12l3.5 2.5" />
    </Svg>
  );
}

function MenuIcon() {
  return (
    <Svg>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </Svg>
  );
}

function PanelIcon() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

function UserIcon() {
  return (
    <Svg>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Svg>
  );
}

function SignOutIcon() {
  return (
    <Svg>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h11" />
    </Svg>
  );
}
