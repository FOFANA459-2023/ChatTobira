import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../app-shell";

const signOut = vi.fn().mockResolvedValue({});
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut } }),
}));

const STUDENT = { name: "Rin", email: "rin25@apu.ac.jp", isAdmin: false };

const at = (daysAgo: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const CHATS = [
  { id: 5, title: "て-form of 行く", createdAt: at(0) },
  { id: 4, title: "Topic 8 kanji", createdAt: at(1) },
  { id: 3, title: "Particles に and で", createdAt: at(3) },
  { id: 2, title: "Self introduction", createdAt: at(30) },
];

const practice = () => within(screen.getByRole("navigation", { name: "Practice" }));
const recents = () => within(screen.getByRole("navigation", { name: "Saved chats" }));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app sidebar", () => {
  it("puts speaking, grammar and kanji practice one click away, and marks where the student is", () => {
    render(
      <AppShell page="grammar" user={STUDENT}>
        <p>page</p>
      </AppShell>,
    );
    expect(practice().getByRole("link", { name: /Speaking/ })).toHaveAttribute("href", "/speaking");
    const grammar = practice().getByRole("link", { name: /Grammar test/ });
    expect(grammar).toHaveAttribute("href", "/quiz?kind=grammar");
    expect(grammar).toHaveAttribute("aria-current", "page");
    expect(practice().getByRole("link", { name: /Kanji test/ })).toHaveAttribute("href", "/quiz?kind=kanji");
    expect(practice().getByRole("link", { name: /Kanji test/ })).not.toHaveAttribute("aria-current");
  });

  it("lists the saved chats under them, grouped by when they were started", () => {
    render(
      <AppShell page="speaking" user={STUDENT} conversations={CHATS}>
        <p>page</p>
      </AppShell>,
    );
    const list = recents();
    expect(list.getByText("Today")).toBeInTheDocument();
    expect(list.getByText("Yesterday")).toBeInTheDocument();
    expect(list.getByText("This week")).toBeInTheDocument();
    expect(list.getByText("Earlier")).toBeInTheDocument();
    // Away from the chat page a saved chat is a link that opens it there.
    expect(list.getByRole("link", { name: "Topic 8 kanji" })).toHaveAttribute("href", "/?c=4");
  });

  it("offers a filter once the list is long, and it narrows the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: 100 + i,
      title: i === 4 ? "The te-form, again" : `Chat number ${i}`,
      createdAt: at(0),
    }));
    render(
      <AppShell page="kanji" user={STUDENT} conversations={many}>
        <p>page</p>
      </AppShell>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find a chat" }), {
      target: { value: "te-form" },
    });
    expect(recents().getByRole("link", { name: "The te-form, again" })).toBeInTheDocument();
    expect(recents().queryByRole("link", { name: "Chat number 0" })).not.toBeInTheDocument();
  });

  it("deletes a chat from any page, straight through the API", () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <AppShell page="speaking" user={STUDENT} conversations={CHATS}>
        <p>page</p>
      </AppShell>,
    );
    fireEvent.click(recents().getByRole("button", { name: "Delete Topic 8 kanji" }));
    expect(recents().queryByRole("link", { name: "Topic 8 kanji" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("shows who is signed in and signs them out", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(
      <AppShell page="speaking" user={STUDENT}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getAllByText("Rin")[0]).toBeInTheDocument();
    expect(screen.getAllByText("rin25@apu.ac.jp")[0]).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]);
    expect(signOut).toHaveBeenCalled();
  });

  it("gives the admin a way into the admin pages", () => {
    render(
      <AppShell page="speaking" user={{ name: "Varlee", email: "admin@example.com", isAdmin: true }}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
  });

  it("folds down to a rail of icons, and remembers it", () => {
    render(
      <AppShell page="grammar" user={STUDENT} conversations={CHATS}>
        <p>page</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    // The practice pages are still there, by icon, and named for a screen reader.
    expect(practice().getByRole("link", { name: "Grammar test" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("navigation", { name: "Saved chats" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("tobira.sidebar.collapsed")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(recents().getByRole("link", { name: "Topic 8 kanji" })).toBeInTheDocument();
  });

  it("opens as a drawer from the menu button on a phone, and closes on a pick", () => {
    render(
      <AppShell page="grammar" user={STUDENT} conversations={CHATS}>
        <p>page</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = within(screen.getByRole("dialog", { name: "Menu" }));
    const speaking = drawer.getByRole("link", { name: /Speaking/ });
    // jsdom cannot follow a link; the drawer closing is what is under test.
    speaking.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(speaking);
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
  });

  it("shows the name as the brand, with no logo", () => {
    const { container } = render(
      <AppShell page="grammar" user={STUDENT}>
        <p>page</p>
      </AppShell>,
    );
    const brand = screen.getAllByRole("link", { name: /ChatTobira/ })[0];
    expect(brand).toHaveAttribute("href", "/");
    expect(brand.querySelector("svg")).toBeNull();
    expect(container).toBeTruthy();
  });
});
