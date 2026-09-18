import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAudioCache, useTextToSpeech } from "@/lib/use-voice";

/** What the Listen button promises: pressed after an answer has finished, it
 * plays at once — because the first clause was synthesised while the student
 * was reading, and the click is served from that. */

const ANSWER = "京都はとてもきれいな町ですね。お寺やお店がたくさんありますよ。";

let played: string[];
let fetches: string[];

beforeEach(() => {
  resetAudioCache();
  played = [];
  fetches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      fetches.push(JSON.parse(init.body).text);
      return new Response(new Blob(["RIFF"], { type: "audio/wav" }), { status: 200 });
    }),
  );
  // jsdom implements neither, and the hook's unmount cleanup revokes after
  // this file's afterEach has run, so they are set on URL itself.
  let n = 0;
  URL.createObjectURL = () => `blob:${n++}`;
  URL.revokeObjectURL = () => {};
  // An <audio> that "plays" instantly and ends on the next tick.
  vi.stubGlobal(
    "Audio",
    class {
      src: string;
      onplaying: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
      }
      play() {
        played.push(this.src);
        queueMicrotask(() => this.onplaying?.());
        setTimeout(() => this.onended?.(), 0);
        return Promise.resolve();
      }
      pause() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("the Listen button", () => {
  it("plays the prefetched opening without asking the server again", async () => {
    const { result } = renderHook(() => useTextToSpeech());
    act(() => result.current.prefetch(ANSWER));
    expect(fetches).toHaveLength(1);
    const opening = fetches[0];

    await act(async () => {
      await result.current.speak(ANSWER);
    });
    await waitFor(() => expect(played.length).toBeGreaterThan(0));

    // The opening clause was requested exactly once: by the prefetch. The
    // click reused it; only the clauses after it were new requests.
    expect(fetches.filter((text) => text === opening)).toHaveLength(1);
  });

  it("prefetches only the opening clause, not the whole answer", () => {
    const { result } = renderHook(() => useTextToSpeech());
    act(() => result.current.prefetch(ANSWER));
    // Every answer is prefetched whether or not anyone listens, so the cost
    // is bounded to the one clause the student would otherwise wait for.
    expect(fetches).toHaveLength(1);
  });

  it("does not remember a failure, so the click can try again", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_url: string, init: { body: string }) => {
        fetches.push(JSON.parse(init.body).text);
        return new Response("no", { status: 502 });
      },
    );
    const { result } = renderHook(() => useTextToSpeech());
    act(() => result.current.prefetch(ANSWER));
    await waitFor(() => expect(fetches).toHaveLength(1));
    // Let the failed request settle and leave the cache.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      await result.current.speak(ANSWER);
    });
    await waitFor(() => expect(played.length).toBeGreaterThan(0));
    // The opening was asked for twice: the failed prefetch, then the click.
    expect(fetches.filter((text) => text === fetches[0]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("a long answer read aloud", () => {
  const LONG =
    "最初の文はとても大切なポイントです。二番目の文も聞いてください。三番目の文は少し長いですが大丈夫です。四番目の文で終わりです。";

  /** Answer each request from a script keyed on how many times that text has
   * been asked for; anything unscripted succeeds. */
  function server(script: (text: string, attempt: number) => Response | undefined) {
    const seen = new Map<string, number>();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: { body: string }) => {
        const text = JSON.parse(init.body).text as string;
        const attempt = (seen.get(text) ?? 0) + 1;
        seen.set(text, attempt);
        fetches.push(text);
        return (
          script(text, attempt) ??
          new Response(new Blob(["RIFF"], { type: "audio/wav" }), { status: 200 })
        );
      },
    );
  }

  let browserVoice: string[];
  beforeEach(() => {
    browserVoice = [];
    vi.stubGlobal("speechSynthesis", {
      speak: (u: { text: string }) => browserVoice.push(u.text),
      cancel: () => {},
      getVoices: () => [],
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
  });

  it("never hands the rest of the answer to a different voice once Kore has spoken", async () => {
    // The reported bug: part way through a long answer the tutor became
    // someone else. A piece that fails after Kore has been heard is skipped,
    // and the pieces after it are still read in Kore's voice.
    server((text) => (text.startsWith("二番目") ? new Response("no", { status: 401 }) : undefined));
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak(LONG);
    });
    await waitFor(() => expect(result.current.speaking).toBe(false), { timeout: 3000 });
    expect(browserVoice).toEqual([]);
    expect(played.length).toBeGreaterThanOrEqual(2);
  });

  it("still uses the browser voice for the whole answer when Kore never spoke", async () => {
    // Signed out: /api/speak answers 401 from the first piece. One voice, the
    // browser's, from start to finish — and without waiting.
    server(() => new Response("no", { status: 401 }));
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak(LONG);
    });
    await waitFor(() => expect(browserVoice.length).toBeGreaterThan(0));
    expect(played).toEqual([]);
  });

  it("waits out the speech quota and retries the same voice", async () => {
    // The ten-a-minute project quota. The route passes on Google's wait; the
    // player waits it out rather than switching voice.
    server((text, attempt) =>
      text.startsWith("最初") && attempt === 1
        ? Response.json({ error: "tts_quota", retryAfter: 1 }, { status: 429 })
        : undefined,
    );
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak(LONG);
    });
    await waitFor(() => expect(played.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(browserVoice).toEqual([]);
    expect(fetches.filter((t) => t.startsWith("最初"))).toHaveLength(2);
  });

  it("does not prefetch while the service is over quota", async () => {
    server((text, attempt) =>
      attempt === 1 ? Response.json({ error: "tts_quota", retryAfter: 1 }, { status: 429 }) : undefined,
    );
    const { result } = renderHook(() => useTextToSpeech());
    act(() => result.current.prefetch(LONG));
    await waitFor(() => expect(fetches).toHaveLength(1));
    // Give the 429 a moment to land and start the cooldown.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    act(() => result.current.prefetch("別の答えです。これは二番目の文です。"));
    expect(fetches.filter((t) => t.startsWith("別の"))).toHaveLength(0);
  });
});
