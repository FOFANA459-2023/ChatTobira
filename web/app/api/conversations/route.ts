import { z } from "zod";

import { isAdminEmail } from "@/lib/admin";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  MAX_TITLE,
  renameConversation,
} from "@/lib/history";
import { createClient } from "@/lib/supabase/server";

/** A student's saved chats.
 *
 * GET               → the list, newest first
 * GET ?id=<number>  → one chat whole: its messages and the files added to it
 * PATCH {id, title} → rename it
 * DELETE {id}       → take it out of the sidebar (a student's rows are kept;
 *                     the admin's own chats are deleted outright)
 *
 * Everything runs under the student's own RLS, so another student's id finds
 * nothing rather than being refused — the two are deliberately the same.
 */
async function session() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { supabase, user } : null;
  } catch {
    return null;
  }
}

async function signedIn() {
  return (await session())?.supabase ?? null;
}

const notSignedIn = () => Response.json({ error: "not_signed_in" }, { status: 401 });
const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });
const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

const Id = z.number().int().positive();

export async function GET(request: Request) {
  const supabase = await signedIn();
  if (!supabase) return notSignedIn();

  const raw = new URL(request.url).searchParams.get("id");
  if (raw === null) {
    return Response.json({ conversations: await listConversations(supabase) });
  }
  const id = Id.safeParse(Number(raw));
  if (!id.success) return badRequest();

  const conversation = await loadConversation(supabase, id.data);
  return conversation ? Response.json(conversation) : notFound();
}

const RenameSchema = z.object({
  id: Id,
  title: z.string().trim().min(1).max(MAX_TITLE),
});

export async function PATCH(request: Request) {
  const supabase = await signedIn();
  if (!supabase) return notSignedIn();

  const parsed = RenameSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return badRequest();

  const renamed = await renameConversation(supabase, parsed.data.id, parsed.data.title);
  return renamed ? Response.json({ ok: true }) : notFound();
}

export async function DELETE(request: Request) {
  const current = await session();
  if (!current) return notSignedIn();
  const { supabase, user } = current;

  const parsed = z.object({ id: Id }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return badRequest();

  const result = await deleteConversation(supabase, parsed.data.id, {
    permanent: isAdminEmail(user.email),
  });
  if (result === "not_found") return notFound();
  if (result === "unavailable") {
    return Response.json({ error: "delete_unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
