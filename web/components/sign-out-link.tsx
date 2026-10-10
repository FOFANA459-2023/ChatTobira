"use client";

import { createClient } from "@/lib/supabase/client";

/** Sign out, from a page that is otherwise static.
 *
 * The app's own sign-out lives in the sidebar, and the pages that sit outside
 * the shell — the approval gate, for one — have no sidebar to borrow it from.
 * Same two steps: end the session, then leave by assigning the location
 * rather than routing, so nothing of the signed-in render survives.
 */
export function SignOutLink({ className }: { className?: string }) {
  async function signOut() {
    try {
      await createClient().auth.signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button type="button" onClick={() => void signOut()} className={className}>
      Sign out
    </button>
  );
}
