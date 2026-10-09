import { LiveTranslation } from "@/components/live-translation";
import { loadShell } from "@/lib/shell";

/** Live translation, on its own page.
 *
 * Its own page rather than a mode of speaking practice, and the reason is the
 * microphone. Both features want it, neither can share it, and a student who
 * started a conversation and then pressed "translate" on the same screen
 * would get whichever of them grabbed the device first. Separate pages make
 * that impossible rather than merely unlikely.
 *
 * Signed-in only, and not by a rule written here: /api/translate/session
 * refuses an anonymous caller, because a minute of translation is metered
 * against an account. The middleware sends a signed-out visitor to /login
 * before this renders.
 */
export default async function TranslatePage() {
  const shell = await loadShell();
  return <LiveTranslation user={shell.user} conversations={shell.conversations} />;
}
