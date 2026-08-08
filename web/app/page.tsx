import { Chat } from "@/components/chat";

export default function Home() {
  // Auth is enforced in middleware: an unauthenticated visitor never reaches
  // this page, and /api/chat re-checks the session server-side regardless.
  return <Chat />;
}
