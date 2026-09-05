/** Where a turn's time actually goes.
 *
 * Built because guessing was wrong. The chat route felt slow and the obvious
 * suspect was the model; measured, an ordinary conversational sentence spent
 * over ten seconds before the model was even called, while "こんにちは" — the
 * one input that skips retrieval — came back in under a second. Nothing in
 * the code said so, and nothing could have: the route runs five overlapping
 * network calls and reports only the answer.
 *
 * So each stage marks itself, and the route logs one line per turn. Server
 * side only. A student never sees a millisecond.
 */

export interface Mark {
  stage: string;
  ms: number;
}

export class Stopwatch {
  private readonly started = Date.now();
  private last = this.started;
  private readonly marks: Mark[] = [];

  /** Record the time since the previous mark. */
  mark(stage: string): void {
    const now = Date.now();
    this.marks.push({ stage, ms: now - this.last });
    this.last = now;
  }

  /** Time an awaited stage without restructuring the code around it. */
  async time<T>(stage: string, work: Promise<T>): Promise<T> {
    const from = Date.now();
    try {
      return await work;
    } finally {
      this.marks.push({ stage, ms: Date.now() - from });
    }
  }

  get total(): number {
    return Date.now() - this.started;
  }

  /** One line, ordered slowest first, so the bottleneck reads first.
   *
   * Deliberately not JSON: this is read by a person scanning a worker log for
   * the stage that got worse, and a sorted list of "stage 1234ms" is faster
   * to scan than a nested object. */
  format(label: string): string {
    const slowest = [...this.marks].sort((a, b) => b.ms - a.ms);
    return `${label} total=${this.total}ms ${slowest
      .map((mark) => `${mark.stage}=${mark.ms}ms`)
      .join(" ")}`;
  }
}
