import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../live-voice";
import { useLiveConversation } from "../use-live-voice";

/* --- Fakes for the browser's audio and socket APIs ----------------------- */

/** What the hook sends, as far as these tests read it. */
interface Sent {
  setup?: unknown;
  realtimeInput?: { audio: { data: string; mimeType: string } };
  toolResponse?: { functionResponses: unknown[] };
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
  /* test helpers */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  last<K extends keyof Sent>(kind: K): Required<Pick<Sent, K>> | undefined {
    return [...this.sent].reverse().find((m) => kind in m) as Required<Pick<Sent, K>> | undefined;
  }
}

const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource() {
    return { connect: (node: unknown) => node };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (node: unknown) => node };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    sources.push(source);
    return source;
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

function jsonResponse(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  // Calls only; the implementations below are set again every time.
  vi.clearAllMocks();
  FakeSocket.all = [];
  sources.length = 0;
  FakeWorkletNode.created = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  URL.createObjectURL = vi.fn(() => "blob:worklet");
  URL.revokeObjectURL = vi.fn();
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/voice/session") return jsonResponse({ token: "tok 1", model: "gemini-3.8-live" });
    if (url === "/api/voice/lookup") {
      return jsonResponse({ passages: [{ source: "Foundation 3, p.62", text: "〜ておく" }] });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Start a conversation and bring its socket up. */
async function connect(onTurn = vi.fn()) {
  const hook = renderHook(() => useLiveConversation({ onTurn }));
  let started!: Promise<string>;
  act(() => {
    started = hook.result.current.start({
      language: "ja",
      history: [{ role: "user", text: "こんにちは" }],
    });
  });
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  const socket = FakeSocket.all[0];
  act(() => socket.open());
  act(() => socket.receive({ setupComplete: {} }));
  await act(async () => {
    expect(await started).toBe("live");
  });
  return { ...hook, socket, onTurn };
}

function audioChunk(samples: number) {
  return bytesToBase64(new Uint8Array(new Int16Array(samples).fill(1000).buffer));
}

describe("useLiveConversation", () => {
  it("opens the socket with the server's token and names only the model", async () => {
    const { socket } = await connect();
    expect(socket.url).toContain("BidiGenerateContentConstrained?access_token=tok%201");
    expect(socket.sent[0]).toEqual({ setup: { model: "models/gemini-3.8-live" } });
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/voice/session")!;
    expect(JSON.parse(init.body)).toEqual({
      language: "ja",
      history: [{ role: "user", text: "こんにちは" }],
    });
  });

  it("streams the microphone as 16 kHz PCM as it is captured", async () => {
    const { socket, result } = await connect();
    // 40ms at 48 kHz, loud enough to count as speech.
    act(() => FakeWorkletNode.created.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(0.3) }));
    const audio = socket.last("realtimeInput")!.realtimeInput.audio;
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(base64ToBytes(audio.data).byteLength).toBe(640 * 2);
    expect(result.current.phase).toBe("hearing");
  });

  it("plays the reply the moment its first audio arrives, back to back", async () => {
    const { socket, result } = await connect();
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(2400) } }] } } }),
    );
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(2400) } }] } } }),
    );
    expect(result.current.phase).toBe("speaking");
    expect(sources).toHaveLength(2);
    const [first, second] = sources.map((s) => s.start.mock.calls[0][0] as number);
    // 2,400 samples at 24 kHz is 100ms: the second chunk starts where the first ends.
    expect(second - first).toBeCloseTo(0.1, 5);
  });

  it("stops talking at once when the student cuts in", async () => {
    const { socket, result } = await connect();
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(24000) } }] } } }),
    );
    expect(result.current.phase).toBe("speaking");
    act(() => socket.receive({ serverContent: { interrupted: true } }));
    expect(sources[0].stop).toHaveBeenCalled();
    expect(result.current.phase).toBe("listening");
  });

  it("hands each finished exchange to the transcript, and shows what it heard", async () => {
    const { socket, result, onTurn } = await connect();
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "昨日京都に" } } }));
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "行きました。" } } }));
    expect(result.current.heard).toBe("昨日京都に行きました。");
    act(() => socket.receive({ serverContent: { outputTranscription: { text: "いいですね！" } } }));
    act(() => socket.receive({ serverContent: { outputTranscription: { text: "何をしましたか？" } } }));
    act(() => socket.receive({ serverContent: { turnComplete: true } }));
    expect(onTurn).toHaveBeenCalledWith({
      user: "昨日京都に行きました。",
      assistant: "いいですね！何をしましたか？",
    });
  });

  it("does not end the exchange on the turn that only carries a tool call", async () => {
    const { socket, onTurn } = await connect();
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "ておくって何？" } } }));
    act(() => socket.receive({ serverContent: { turnComplete: true } }));
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("answers the tutor's lookup from the course material", async () => {
    const { socket, result } = await connect();
    act(() =>
      socket.receive({
        toolCall: { functionCalls: [{ id: "call-1", name: "search_course_material", args: { query: "〜ておく" } }] },
      }),
    );
    expect(result.current.phase).toBe("thinking");
    await waitFor(() => expect(socket.last("toolResponse")).toBeDefined());
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/voice/lookup")!;
    expect(JSON.parse(init.body)).toEqual({ query: "〜ておく" });
    // The call's own turn completing must not drop the screen to "listening"
    // while the answer is being composed.
    act(() => socket.receive({ serverContent: { turnComplete: true } }));
    await waitFor(() => expect(result.current.phase).toBe("thinking"));
    expect(socket.last("toolResponse")!.toolResponse.functionResponses).toEqual([
      {
        id: "call-1",
        name: "search_course_material",
        response: { passages: [{ source: "Foundation 3, p.62", text: "〜ておく" }] },
      },
    ]);
  });

  it("Skip silences the rest of the current reply only", async () => {
    const { socket, result } = await connect();
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(2400) } }] } } }),
    );
    act(() => result.current.interrupt());
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(2400) } }] } } }),
    );
    expect(sources).toHaveLength(1);
    act(() => socket.receive({ serverContent: { turnComplete: true } }));
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(2400) } }] } } }),
    );
    expect(sources).toHaveLength(2);
  });

  it("carries the conversation onto a new connection when the server rotates it", async () => {
    const { socket } = await connect();
    act(() => socket.receive({ sessionResumptionUpdate: { newHandle: "handle-7", resumable: true } }));
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "京都に行きました" } } }));
    act(() => socket.receive({ serverContent: { outputTranscription: { text: "いいですね" } } }));
    act(() => socket.receive({ serverContent: { turnComplete: true } }));
    act(() => socket.receive({ goAway: { timeLeft: "10s" } }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    // The old connection is still up, so the new session is seeded with the
    // whole conversation rather than resumed by handle.
    const [, init] = fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session")[1];
    expect(JSON.parse(init.body)).toEqual({
      language: "ja",
      history: [
        { role: "user", text: "こんにちは" },
        { role: "user", text: "京都に行きました" },
        { role: "assistant", text: "いいですね" },
      ],
    });
    const next = FakeSocket.all[1];
    act(() => next.open());
    act(() => next.receive({ setupComplete: {} }));
    await waitFor(() => expect(socket.readyState).toBe(3));
  });

  it("stop closes everything and keeps a half-finished exchange", async () => {
    const { socket, result, onTurn } = await connect();
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "じゃあね" } } }));
    act(() => result.current.stop());
    expect(onTurn).toHaveBeenCalledWith({ user: "じゃあね", assistant: "" });
    expect(socket.readyState).toBe(3);
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});

describe("metered by the minute", () => {
  /** A session route that hands out minutes: each token ends `lifeMs` after
   * it is minted, with `left` seconds after it. */
  function minutes(lifeMs: number, left: number[]) {
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url !== "/api/voice/session") return jsonResponse({});
      const remaining = left[Math.min(call, left.length - 1)];
      call += 1;
      if (remaining < 0) {
        return jsonResponse(
          { error: "quota_exhausted", message: "You have used your 10 minutes of conversation for now. More are available at 3:40 PM (Japan time)." },
          429,
        );
      }
      return jsonResponse({
        token: `tok ${call}`,
        model: "gemini-3.8-live",
        expiresAt: Date.now() + lifeMs,
        remainingSeconds: remaining,
      });
    });
  }

  it("moves to the next minute before this one runs out, and never while the tutor is talking", async () => {
    // Handover is due 8s before expiry: 8.4s of life puts it ~0.4s away.
    minutes(8_400, [540, 480]);
    const { socket, result } = await connect();
    expect(result.current.secondsLeft).toBeGreaterThanOrEqual(540);
    act(() => socket.receive({ sessionResumptionUpdate: { newHandle: "h-1", resumable: true } }));
    // The tutor starts talking before the handover.
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(24000) } }] } } }),
    );

    await waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 3000 });
    const next = FakeSocket.all[1];
    act(() => next.open());
    act(() => next.receive({ setupComplete: {} }));
    // Ready, but the tutor is mid-sentence: the old connection keeps it.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(socket.readyState).toBe(1);

    // The sentence ends; the switch happens in the quiet.
    act(() => sources[0].onended?.());
    await waitFor(() => expect(socket.readyState).toBe(3));
    // The new minute carries the conversation on — as a fresh session seeded
    // with the transcript, because Google will not resume a session whose
    // connection is still open.
    const [, init] = fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session")[1];
    const body = JSON.parse(init.body);
    expect(body.resume).toBeUndefined();
    expect(body.history).toEqual([{ role: "user", text: "こんにちは" }]);
    // And the microphone now feeds it.
    act(() => FakeWorkletNode.created.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(0.01) }));
    expect(next.last("realtimeInput")).toBeDefined();
  });

  it("finishes the last minute and then ends the call, saying when more is available", async () => {
    // One minute left in the window, then none.
    minutes(8_400, [0]);
    const { socket, result, onTurn } = await connect();
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "ありがとう" } } }));
    act(() => socket.receive({ serverContent: { outputTranscription: { text: "どういたしまして" } } }));
    // No handover is attempted: there is nothing left to buy.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(FakeSocket.all).toHaveLength(1);
    // Google ends the call when the minute's token expires.
    act(() => socket.close(1011));
    expect(result.current.error).toBe("quota");
    expect(result.current.active).toBe(false);
    expect(onTurn).toHaveBeenCalledWith({ user: "ありがとう", assistant: "どういたしまして" });
  });

  it("keeps talking through a paid minute when the next one is refused", async () => {
    minutes(8_400, [60, -1]);
    const { socket, result } = await connect();
    await waitFor(
      () => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session")).toHaveLength(2),
      { timeout: 3000 },
    );
    await waitFor(() => expect(result.current.notice).toMatch(/3:40 PM/));
    // The minute already paid for is still running.
    expect(result.current.active).toBe(true);
    expect(socket.readyState).toBe(1);
    act(() => socket.close(1011));
    expect(result.current.error).toBe("quota");
  });

  it("shows no countdown on an unmetered account", async () => {
    minutes(30 * 60_000, [2147483647]);
    const { result } = await connect();
    expect(result.current.secondsLeft).toBeNull();
  });
});

describe("renewing the connection without hanging up", () => {
  /** Session route answers, in order. "ok" hands out a token whose handover is
   * due ~0.4s after it is minted; a number is that HTTP status. */
  function renewals(answers: ("ok" | number)[]) {
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url !== "/api/voice/session") return jsonResponse({});
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer !== "ok") return jsonResponse({ error: "token_failed" }, answer);
      return jsonResponse({
        token: `tok ${call}`,
        model: "gemini-3.8-live",
        expiresAt: Date.now() + 8_400,
        remainingSeconds: 540,
      });
    });
  }
  const sessionCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session");

  it("tries the renewal again when the token request fails, and the call carries on", async () => {
    // The first renewal fails twice — a 502 from Google, then a timeout —
    // and works on the third try. It used to hang up on the first.
    renewals(["ok", 502, 0, "ok"]);
    const { socket, result } = await connect();
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 6000 });
    expect(sessionCalls()).toHaveLength(4);
    // The old connection carried the conversation the whole time.
    expect(result.current.error).toBeNull();
    expect(result.current.active).toBe(true);
    const next = FakeSocket.all[1];
    act(() => next.open());
    act(() => next.receive({ setupComplete: {} }));
    await waitFor(() => expect(socket.readyState).toBe(3));
    act(() => FakeWorkletNode.created.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(0.01) }));
    expect(next.last("realtimeInput")).toBeDefined();
  }, 10_000);

  it("opens another connection when the new one fails to set up", async () => {
    renewals(["ok"]);
    const { socket, result } = await connect();
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 3000 });
    // Google closes the new connection before its setup completes.
    act(() => FakeSocket.all[1].close(1011));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(3), { timeout: 3000 });
    const third = FakeSocket.all[2];
    act(() => third.open());
    act(() => third.receive({ setupComplete: {} }));
    await waitFor(() => expect(socket.readyState).toBe(3));
    expect(result.current.active).toBe(true);
    expect(result.current.error).toBeNull();
  }, 10_000);

  it("ends the call only when every attempt has failed, keeping what was said", async () => {
    renewals(["ok", 502]);
    const { socket, result, onTurn } = await connect();
    act(() => socket.receive({ serverContent: { inputTranscription: { text: "もう一度" } } }));
    // Five tries, with pauses of 0.5s, 1s, 2s and 4s between them.
    await waitFor(() => expect(result.current.active).toBe(false), { timeout: 12_000 });
    expect(sessionCalls()).toHaveLength(6);
    expect(result.current.error).toBe("network");
    expect(onTurn).toHaveBeenCalledWith({ user: "もう一度", assistant: "" });
  }, 15_000);

  it("renews again when the new connection drops before it takes over", async () => {
    renewals(["ok"]);
    const { socket, result } = await connect();
    // The tutor is talking, so the switch waits for a quiet moment.
    act(() =>
      socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk(24000) } }] } } }),
    );
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 3000 });
    const second = FakeSocket.all[1];
    act(() => second.open());
    act(() => second.receive({ setupComplete: {} }));
    // It drops while waiting; then the tutor finishes.
    act(() => second.close(1011));
    act(() => sources[0].onended?.());
    // The dead connection never takes over: the old one keeps the call until
    // a working replacement is up. (Switching to the dead one closed it.)
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(socket.readyState).toBe(1);
    await waitFor(() => expect(FakeSocket.all).toHaveLength(3), { timeout: 3000 });
    const third = FakeSocket.all[2];
    act(() => third.open());
    act(() => third.receive({ setupComplete: {} }));
    await waitFor(() => expect(socket.readyState).toBe(3));
    expect(result.current.active).toBe(true);
  }, 10_000);
});

describe("recovering a dropped connection", () => {
  it("resumes by handle when the old connection is already gone", async () => {
    const { socket } = await connect();
    act(() => socket.receive({ sessionResumptionUpdate: { newHandle: "handle-9", resumable: true } }));
    act(() => socket.close(1011));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    const [, init] = fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session")[1];
    expect(JSON.parse(init.body)).toEqual({ language: "ja", resume: "handle-9" });
  });
});

describe("starting", () => {
  it("opens the microphone before the connection, and loses nothing said meanwhile", async () => {
    const hook = renderHook(() => useLiveConversation({ onTurn: vi.fn() }));
    let started!: Promise<string>;
    act(() => {
      started = hook.result.current.start({ language: "ja", history: [] });
    });
    // The student is already talking; the socket does not exist yet.
    await waitFor(() => expect(FakeWorkletNode.created.length).toBeGreaterThan(0));
    expect(hook.result.current.phase).toBe("listening");
    act(() => FakeWorkletNode.created.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(0.3) }));
    act(() => FakeWorkletNode.created.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(0.2) }));
    expect(hook.result.current.phase).toBe("hearing");

    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0];
    act(() => socket.open());
    act(() => socket.receive({ setupComplete: {} }));
    await act(async () => {
      expect(await started).toBe("live");
    });
    // Setup first, then both early pieces, in the order they were spoken.
    expect(socket.sent.map((m) => Object.keys(m)[0])).toEqual(["setup", "realtimeInput", "realtimeInput"]);
    const levels = socket.sent.slice(1).map((m) => new Int16Array(base64ToBytes(m.realtimeInput!.audio.data).buffer)[0]);
    expect(levels[0]).toBeGreaterThan(levels[1]);
  });


  it("falls back to the classic loop when live voice is not available", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: "voice_not_configured" }, 503));
    const { result } = renderHook(() => useLiveConversation({ onTurn: vi.fn() }));
    let outcome = "";
    await act(async () => {
      outcome = await result.current.start({ language: "ja", history: [] });
    });
    expect(outcome).toBe("fallback");
    expect(result.current.active).toBe(false);
  });

  it("says so when today's quota is spent, rather than falling back", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: "quota_exhausted" }, 429));
    const { result } = renderHook(() => useLiveConversation({ onTurn: vi.fn() }));
    let outcome = "";
    await act(async () => {
      outcome = await result.current.start({ language: "ja", history: [] });
    });
    expect(outcome).toBe("failed");
    expect(result.current.error).toBe("quota");
  });

  it("reports a blocked microphone", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    const { result } = renderHook(() => useLiveConversation({ onTurn: vi.fn() }));
    let outcome = "";
    await act(async () => {
      outcome = await result.current.start({ language: "ja", history: [] });
    });
    expect(outcome).toBe("failed");
    expect(result.current.error).toBe("permission");
  });
});
