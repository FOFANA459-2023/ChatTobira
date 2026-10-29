import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLiveTranslation } from "../use-live-translate";

/* --- Fakes for the browser's audio and socket APIs ----------------------- */

interface Sent {
  setup?: unknown;
  realtimeInput?: { audio: { data: string; mimeType: string } };
}

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Sent[] = [];
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  audio() {
    return this.sent.filter((m) => m.realtimeInput).map((m) => m.realtimeInput!.audio.data);
  }
}

class FakeAudioContext {
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource() {
    return { connect: (node: unknown) => node };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (node: unknown) => node };
  }
}

class FakeWorkletNode {
  static created: FakeWorkletNode[] = [];
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null };
  constructor() {
    FakeWorkletNode.created.push(this);
  }
  connect(node: unknown) {
    return node;
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();
const fetchMock = vi.fn();
/** The segments each POST to /api/translate/segments carried. */
let saved: { conversationId?: number; segments: { seq: number; translated: string }[] }[] = [];

function jsonResponse(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.all = [];
  FakeWorkletNode.created = [];
  saved = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  // No Permissions API by default — a browser that cannot say whether the
  // microphone is allowed must not be asked to guess.
  Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
  URL.createObjectURL = vi.fn(() => "blob:worklet");
  URL.revokeObjectURL = vi.fn();
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  fetchMock.mockImplementation((url: string, init?: { body: string }) => {
    if (url === "/api/translate/session") {
      return jsonResponse({
        token: "tok 1",
        model: "gemini-3.5-live-translate-preview",
        expiresAt: Date.now() + 66_000,
        remainingSeconds: 1_200,
      });
    }
    if (url === "/api/translate/segments") {
      saved.push(JSON.parse(init!.body));
      return jsonResponse({ conversationId: 77 });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 40ms of audio at 48 kHz, which downsamples to 640 samples at 16 kHz. */
function frame(level = 0.25) {
  return new Float32Array(1920).fill(level);
}

function speak(times = 1, level = 0.25) {
  const node = FakeWorkletNode.created.at(-1)!;
  for (let i = 0; i < times; i++) act(() => node.port.onmessage!({ data: frame(level) }));
}

/** Press Start and wait for the microphone, stopping short of the socket. */
async function startCapturing() {
  const hook = renderHook(() => useLiveTranslation());
  act(() => hook.result.current.start({ source: "ja", target: "en" }));
  await waitFor(() => expect(FakeWorkletNode.created).toHaveLength(1));
  return hook;
}

/** Press Start and bring the whole session up. */
async function listen() {
  const hook = await startCapturing();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  const socket = FakeSocket.all[0];
  act(() => socket.open());
  act(() => socket.receive({ setupComplete: {} }));
  await waitFor(() => expect(hook.result.current.phase).toBe("listening"));
  return { ...hook, socket };
}

/** One finished sentence: the model sends the translation, and a full stop is
 * what closes a segment (this model never sends turnComplete). */
function say(socket: FakeSocket, heard: string, meant: string) {
  act(() =>
    socket.receive({
      serverContent: { inputTranscription: { text: heard }, outputTranscription: { text: meant } },
    }),
  );
}

describe("starting on the click, not a second later", () => {
  it("sends the audio captured while the connection was still coming up", async () => {
    const hook = await startCapturing();
    // The student presses Start and speaks immediately. The socket does not
    // exist yet; these three frames used to be thrown away, which is what
    // made the first sentence of a lecture go missing.
    speak(3);
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0];
    expect(socket.audio()).toHaveLength(0);

    act(() => socket.open());
    act(() => socket.receive({ setupComplete: {} }));

    await waitFor(() => expect(socket.audio()).toHaveLength(3));
    expect(hook.result.current.phase).toBe("listening");
  });

  it("keeps the held audio in the order it was spoken, and goes on from there", async () => {
    await startCapturing();
    speak(1, 0.1);
    speak(1, 0.2);
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0];
    act(() => socket.open());
    act(() => socket.receive({ setupComplete: {} }));
    await waitFor(() => expect(socket.audio()).toHaveLength(2));
    const held = socket.audio();
    expect(held[0]).not.toEqual(held[1]);

    speak(1, 0.3);
    const all = socket.audio();
    expect(all).toHaveLength(3);
    expect(all.slice(0, 2)).toEqual(held);
  });

  it("holds at most three seconds, so a slow connection cannot pile up a lecture", async () => {
    await startCapturing();
    speak(120); // 4.8 seconds
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0];
    act(() => socket.open());
    act(() => socket.receive({ setupComplete: {} }));
    // 75 frames of 40ms. The oldest are dropped, not the newest: what matters
    // is the speech nearest to now.
    await waitFor(() => expect(socket.audio()).toHaveLength(75));
  });

  it("asks for the microphone and the token at the same time, once the microphone is allowed", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    });
    let allow!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => (allow = resolve)));

    const hook = renderHook(() => useLiveTranslation());
    act(() => hook.result.current.start({ source: "ja", target: "en" }));

    // The token is already being minted while the microphone is still opening.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/translate/session")).toBe(true),
    );
    act(() => allow({ getTracks: () => [track] }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  });

  it("waits for the microphone first when it might have to ask, so the token cannot expire unused", async () => {
    // No Permissions API, or a prompt still to come: a token is good for
    // thirty seconds and a permission dialog can sit on screen far longer.
    let allow!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => (allow = resolve)));

    const hook = renderHook(() => useLiveTranslation());
    act(() => hook.result.current.start({ source: "ja", target: "en" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/translate/session")).toHaveLength(0);

    act(() => allow({ getTracks: () => [track] }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/translate/session")).toHaveLength(
        1,
      ),
    );
  });

  it("drops what it was holding when the student pauses", async () => {
    const { result, socket } = await listen();
    act(() => result.current.pause());
    await waitFor(() => expect(result.current.phase).toBe("paused"));
    const before = socket.audio().length;
    speak(5);
    expect(socket.audio()).toHaveLength(before);
  });
});

describe("when the server refuses the session", () => {
  /** How many tokens were minted — each one spends a minute of allowance. */
  const minted = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/translate/session").length;

  it("does not mint another token when the refusal is final", async () => {
    const { result, socket } = await listen();
    expect(minted()).toBe(1);

    // What an account with no credit actually sends: the socket opens, says
    // setupComplete, and dies the moment the model is asked to produce.
    act(() =>
      socket.onclose!({
        code: 1011,
        reason: "Your prepayment credits are depleted. Please go to AI Studio",
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("error"));
    // THE BUG: this path had no counter and called connect() again, so it
    // minted, opened, closed and minted again as fast as the network allowed
    // — fifty minutes of allowance in seconds.
    expect(minted()).toBe(1);
    expect(result.current.error?.kind).toBe("provider");
    expect(result.current.error?.message).toMatch(/not your allowance/);
  });

  it("keeps what was already translated when it gives up", async () => {
    const { result, socket } = await listen();
    say(socket, "大事なところです。", "This is the important part.");
    await waitFor(() => expect(result.current.segments).toHaveLength(1));

    act(() => socket.onclose!({ code: 1011, reason: "RESOURCE_EXHAUSTED: billing" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].segments[0].translated).toBe("This is the important part.");
  });

  it("still reconnects through an ordinary drop, but not for ever", async () => {
    const { result, socket } = await listen();
    // A blip, not a refusal: this one SHOULD be carried through, because a
    // ninety-minute lecture on bad wifi depends on it.
    act(() => socket.onclose!({ code: 1006, reason: "" }));
    await waitFor(() => expect(minted()).toBe(2));
    expect(result.current.phase).not.toBe("error");
  });

  it("gives up once the rebuild budget is spent, rather than draining the allowance", async () => {
    const { result } = await listen();
    // Five drops in a row with nothing translated in between: four rebuilds
    // are allowed, the fifth ends it.
    for (let i = 0; i < 6; i++) {
      const socket = FakeSocket.all.at(-1)!;
      act(() => socket.onclose!({ code: 1006, reason: "" }));
      await waitFor(() => expect(FakeSocket.all.at(-1)!.readyState).not.toBe(3));
      act(() => FakeSocket.all.at(-1)!.open());
      act(() => FakeSocket.all.at(-1)!.receive({ setupComplete: {} }));
      if (result.current.phase === "error") break;
    }
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(minted()).toBeLessThanOrEqual(5);
    expect(result.current.error?.message).toMatch(/kept dropping/);
  });
});

describe("ending a session saves it and clears the page", () => {
  it("writes the transcript, then empties the screen", async () => {
    const { result, socket } = await listen();
    say(socket, "来週までに提出してください。", "Please submit it by next week.");
    await waitFor(() => expect(result.current.segments).toHaveLength(1));

    await act(async () => {
      result.current.end();
    });

    await waitFor(() => expect(result.current.segments).toHaveLength(0));
    expect(result.current.pending).toBeNull();
    expect(result.current.phase).toBe("ended");
    expect(result.current.saving).toBe(false);
    // Saved BEFORE it was cleared, which is the whole point of the ordering.
    expect(saved).toHaveLength(1);
    expect(saved[0].segments.map((s) => s.translated)).toEqual([
      "Please submit it by next week.",
    ]);
    // And the link to it survives the clearing, because it is the only way
    // back to what was just taken off the screen.
    expect(result.current.conversationId).toBe(77);
  });

  it("keeps the last sentence, even the one still arriving when End was pressed", async () => {
    const { result, socket } = await listen();
    act(() =>
      socket.receive({
        serverContent: {
          inputTranscription: { text: "では、次に" },
          outputTranscription: { text: "Now, next" },
        },
      }),
    );
    expect(result.current.pending).not.toBeNull();

    await act(async () => {
      result.current.end();
    });

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].segments.map((s) => s.translated)).toEqual(["Now, next"]);
  });

  it("starts the next class in its own conversation, numbered from the beginning", async () => {
    const first = await listen();
    say(first.socket, "一つ目。", "The first one.");
    await waitFor(() => expect(first.result.current.segments).toHaveLength(1));
    await act(async () => {
      first.result.current.end();
    });
    await waitFor(() => expect(first.result.current.segments).toHaveLength(0));

    act(() => first.result.current.start({ source: "ja", target: "en" }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    const next = FakeSocket.all[1];
    act(() => next.open());
    act(() => next.receive({ setupComplete: {} }));
    await waitFor(() => expect(first.result.current.phase).toBe("listening"));
    say(next, "二つ目。", "The second one.");
    await waitFor(() => expect(first.result.current.segments).toHaveLength(1));
    await act(async () => {
      first.result.current.end();
    });

    await waitFor(() => expect(saved).toHaveLength(2));
    // A new lecture, so no conversation is named and the numbering restarts.
    // Segments key on (conversation, seq): carrying either over would write
    // this class on top of the last one.
    expect(saved[1].conversationId).toBeUndefined();
    expect(saved[1].segments[0].seq).toBe(0);
    expect(saved[0].segments[0].seq).toBe(0);
  });

  it("holds on to the transcript when the save could not be made", async () => {
    const { result, socket } = await listen();
    say(socket, "大事なところです。", "This is the important part.");
    await waitFor(() => expect(result.current.segments).toHaveLength(1));

    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/translate/segments") return jsonResponse({}, 500);
      return jsonResponse({});
    });

    await act(async () => {
      result.current.end();
    });

    // Nothing is thrown away on the strength of a save that failed: the text
    // stays on screen, and the retry still has a conversation to land in.
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.phase).toBe("ended");
  });

  it("says there was nothing to save when nobody spoke", async () => {
    const { result } = await listen();
    await act(async () => {
      result.current.end();
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.conversationId).toBeNull();
    expect(saved).toHaveLength(0);
  });
});
