import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { broadcastList, UUID } from "./messages.js";
import { sb } from "./supabase.js";

// オープンチャット: 誰でも一覧から参加できるグループ（友だちでなくても入れる）
export const openChats = Router();
openChats.use("/open-chats", requireAuth);

openChats.get("/open-chats", async (_req, res) => {
  const me = currentUserId(res);
  const { data: convs, error } = await sb
    .from("sc_conversations")
    .select("id, title, description, avatar_path, last_message_at")
    .eq("is_open", true)
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const rows = (convs ?? []) as { id: string; title: string | null; description: string; avatar_path: string | null }[];
  if (!rows.length) {
    res.json([]);
    return;
  }
  const { data: members, error: membersError } = await sb
    .from("sc_members")
    .select("conversation_id, user_id")
    .in("conversation_id", rows.map((r) => r.id));
  if (membersError) throw membersError;
  const counts = new Map<string, number>();
  const joined = new Set<string>();
  for (const m of (members ?? []) as { conversation_id: string; user_id: string }[]) {
    counts.set(m.conversation_id, (counts.get(m.conversation_id) ?? 0) + 1);
    if (m.user_id === me) joined.add(m.conversation_id);
  }
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title ?? "オープンチャット",
      description: r.description ?? "",
      hasAvatar: Boolean(r.avatar_path),
      memberCount: counts.get(r.id) ?? 0,
      joined: joined.has(r.id)
    }))
  );
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional().default("")
});

openChats.post("/open-chats", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "名前は1〜40文字、説明は200文字以内で入力してください。" });
    return;
  }
  const me = currentUserId(res);
  const { data: conv, error } = await sb
    .from("sc_conversations")
    .insert({
      is_group: true,
      is_open: true,
      title: parsed.data.title,
      description: parsed.data.description,
      created_by: me
    })
    .select("id")
    .single();
  if (error) throw error;
  const { error: memberError } = await sb.from("sc_members").insert({ conversation_id: conv.id, user_id: me, role: "owner" });
  if (memberError) throw memberError;
  res.status(201).json({ id: conv.id });
});

openChats.post("/open-chats/:id/join", async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "オープンチャットが見つかりません。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("id").eq("id", id).eq("is_open", true).maybeSingle();
  if (error) throw error;
  if (!conv) {
    res.status(404).json({ error: "オープンチャットが見つかりません。" });
    return;
  }
  const { error: joinError } = await sb.from("sc_members").upsert(
    { conversation_id: id, user_id: currentUserId(res), role: "member" },
    { onConflict: "conversation_id,user_id", ignoreDuplicates: true }
  );
  if (joinError) throw joinError;
  await broadcastList(id);
  res.json({ ok: true });
});
