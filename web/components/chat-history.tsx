"use client";

import { useEffect, useRef, useState } from "react";

import { MAX_TITLE, type ConversationSummary } from "@/lib/history";

/** The student's saved chats, down the left side.
 *
 * A column beside the chat from the md breakpoint up, where there is room
 * for one. On a phone there is not, so the same panel slides over the chat
 * from the left and closes on a pick, the backdrop, or Escape.
 *
 * Each chat can be opened, renamed in place, or deleted. Opening starts
 * loading on hover or touch, before the click lands, so a chat is usually
 * already in hand by the time it is asked for.
 */
export function ChatSidebar({
  conversations,
  currentId,
  disabled,
  mobileOpen,
  onCloseMobile,
  onOpen,
  onPrefetch,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  currentId: number | undefined;
  disabled?: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpen: (id: number) => void;
  onPrefetch: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}) {
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onCloseMobile();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const panel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <span className="text-sm font-semibold tracking-tight text-stone-800">Chats</span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close chats"
          className="rounded-lg px-2 py-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 md:hidden"
        >
          ×
        </button>
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            onNew();
            onCloseMobile();
          }}
          disabled={disabled}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          <span aria-hidden="true">+</span> New chat
        </button>
      </div>
      <nav aria-label="Saved chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-stone-400">
            Your chats will appear here.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                current={c.id === currentId}
                disabled={disabled}
                onOpen={() => {
                  onCloseMobile();
                  if (c.id !== currentId) onOpen(c.id);
                }}
                onPrefetch={() => onPrefetch(c.id)}
                onRename={(title) => onRename(c.id, title)}
                onDelete={() => onDelete(c.id)}
              />
            ))}
          </ul>
        )}
      </nav>
    </div>
  );

  return (
    <>
      <aside className="hidden w-64 shrink-0 border-r border-stone-200 bg-stone-50 md:block">
        {panel}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close chats"
            onClick={onCloseMobile}
            className="absolute inset-0 bg-black/30"
          />
          <aside
            role="dialog"
            aria-label="Chats"
            className="absolute inset-y-0 left-0 w-[80%] max-w-xs bg-stone-50 shadow-xl"
          >
            {panel}
          </aside>
        </div>
      )}
    </>
  );
}

function ChatRow({
  chat,
  current,
  disabled,
  onOpen,
  onPrefetch,
  onRename,
  onDelete,
}: {
  chat: ConversationSummary;
  current: boolean;
  disabled?: boolean;
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

  return (
    <li
      className={`group flex items-center rounded-lg ${
        current ? "bg-stone-200/70" : "hover:bg-stone-100"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        onTouchStart={onPrefetch}
        disabled={disabled}
        aria-current={current ? "page" : undefined}
        title={chat.title}
        className={`min-w-0 flex-1 truncate px-2.5 py-2 text-left text-sm disabled:opacity-60 ${
          current ? "font-medium text-stone-900" : "text-stone-700"
        }`}
      >
        {chat.title}
      </button>
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
          className="rounded p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </button>
      </span>
    </li>
  );
}
