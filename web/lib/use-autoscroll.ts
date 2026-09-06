"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Following the newest message without fighting the student for the scrollbar.
 *
 * The chat had no auto-scroll at all: an answer streamed in below the fold and
 * the student watched a blank pane while the tutor wrote. The obvious fix —
 * scroll to the bottom whenever anything changes — is worse than nothing on
 * this app in particular, because the answers are long. A student scrolling
 * back to re-read a conjugation table while the reply is still streaming gets
 * yanked to the bottom every few hundred milliseconds, and there is no way to
 * win: the content keeps growing, so the yanking never stops.
 *
 * So the rule is the one every chat client eventually arrives at. The view is
 * PINNED to the bottom by default and follows new content. The moment the
 * student scrolls up it unpins and stays exactly where they put it, however
 * much arrives underneath. It re-pins when they come back to the bottom
 * themselves, or when they send a message — sending is an unambiguous
 * statement that they are done reading the old thing.
 */

/** How close to the bottom still counts as being at the bottom.
 *
 * Generous on purpose. Sub-pixel scroll heights, a fractional device pixel
 * ratio and the last message's bottom margin all mean scrollTop never quite
 * reaches scrollHeight - clientHeight, and a tight threshold reads that
 * arithmetic as the student having scrolled away. Measured drift on this
 * layout is a couple of pixels; 64 also lets someone nudge the wheel one
 * notch without losing the follow.
 */
const BOTTOM_THRESHOLD = 64;

export interface AutoScroll<T extends HTMLElement> {
  /** Put this on the scrolling container. */
  ref: React.RefObject<T | null>;
  /** True while the view is following new content. */
  pinned: boolean;
  /** Go to the newest content and start following again. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/** Module scope rather than inside the hook: it closes over nothing, and a
 * function redefined every render is a dependency the effects below would
 * have to re-subscribe for. */
function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
}

export function useAutoScroll<T extends HTMLElement>(): AutoScroll<T> {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  // The effects below must not re-subscribe every time `pinned` flips, and
  // the observer callbacks need its current value rather than the one from
  // the render they were created in.
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = ref.current;
    if (!element) return;
    setPinned(true);
    pinnedRef.current = true;
    // scrollTo with options is missing on older Safari and in jsdom; setting
    // scrollTop is the universal form and the only difference is that it
    // cannot animate.
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  // Who is scrolling, and therefore whether to keep following.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onScroll = () => {
      const bottom = atBottom(element);
      pinnedRef.current = bottom;
      setPinned(bottom);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // Content arriving. A streamed answer grows by a few characters at a time
  // and never changes the child count, so watching the message list would
  // miss all of it — the container's own scrollHeight is the thing that
  // actually changes, and ResizeObserver on the content is how that is
  // observed without polling.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const follow = () => {
      if (!pinnedRef.current) return;
      // Instant, never smooth. A smooth scroll animating during a stream
      // fires scroll events of its own that race the student's, and the
      // view ends up jittering between the two.
      element.scrollTop = element.scrollHeight;
    };

    // Both, because they see different things: the observer catches an
    // element growing (a streaming answer, an image loading) and the mutation
    // observer catches nodes appearing (a new message, the thinking
    // indicator) which does not always resize the observed box in the same
    // frame.
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    if (resize) {
      for (const child of Array.from(element.children)) resize.observe(child);
    }

    const mutation =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (resize) {
              for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                  if (node instanceof Element) resize.observe(node);
                }
              }
            }
            follow();
          });
    mutation?.observe(element, { childList: true, subtree: true, characterData: true });

    follow();
    return () => {
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, []);

  return { ref, pinned, scrollToBottom };
}
