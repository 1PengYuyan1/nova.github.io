-- ============================================================================
-- Nova 个人空间 · Supabase 全网实时留言板建表脚本
-- 在 Supabase 控制台 -> SQL Editor 中粘贴全部内容并点击 Run 执行即可
-- ============================================================================

-- 1. 创建留言表
create table if not exists public.guestbook (
  id bigint generated always as identity primary key,
  author text not null check (char_length(trim(author)) between 1 and 32),
  text text not null check (char_length(trim(text)) between 1 and 500),
  created_at timestamptz not null default now()
);

-- 2. 开启行级安全策略（RLS）：
--    允许全网访客读取和发表留言，但禁止访客篡改或删除他人留言
--    （站主本人可随时在 Supabase 控制台 Table Editor 中删除不当留言）
alter table public.guestbook enable row level security;

drop policy if exists "Allow public read guestbook" on public.guestbook;
create policy "Allow public read guestbook"
  on public.guestbook
  for select
  using (true);

drop policy if exists "Allow public insert guestbook" on public.guestbook;
create policy "Allow public insert guestbook"
  on public.guestbook
  for insert
  with check (
    char_length(trim(author)) between 1 and 32
    and char_length(trim(text)) between 1 and 500
  );

-- 3. 开启 Realtime 实时推送（他人留言后，在线页面无需刷新即可即时弹出）
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'guestbook'
  ) then
    alter publication supabase_realtime add table public.guestbook;
  end if;
end $$;
