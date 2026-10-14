-- chatroom-pwa 迁移 Supabase：建表 + 开启实时 + RLS
-- 用法：在 Supabase 控制台 -> SQL Editor 里整段运行一次

-- 1. 消息表（含房间号、图片、消息类型）
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  room_id text not null default '666',
  name text not null default '用户',
  text text,
  img text,
  type text not null default 'chat',          -- chat = 普通消息, system = 系统消息
  created_at timestamptz not null default now()
);

-- 2. 按房间 + 时间建索引，历史消息查询更快
create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- 3. 开启 Realtime（实时推送）。Presence 在线状态无需建表，由客户端实时通道管理。
alter publication supabase_realtime add table public.messages;

-- 4. 行级安全（RLS）：纯昵称无账号的公开聊天室，允许所有人读 + 写
alter table public.messages enable row level security;

drop policy if exists "public read" on public.messages;
create policy "public read" on public.messages
  for select using (true);

drop policy if exists "public insert" on public.messages;
create policy "public insert" on public.messages
  for insert with check (true);

-- 5. 关键：授予表级权限。RLS 策略之外，anon/authenticated 必须有表的 GRANT，
--    否则 REST/Realtime 会报 42501 "permission denied for table messages"。
grant select, insert, update, delete on public.messages to anon, authenticated;
