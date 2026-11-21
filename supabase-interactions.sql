-- ============================================================================
-- Nova 个人空间 · 博客/随笔/画廊 点赞 + 评论 + QQ 邮箱通知（Resend）建表脚本
-- 在 Supabase 控制台 -> SQL Editor 中执行
-- ============================================================================

-- 0. 开启异步 HTTP 请求扩展（用于数据库触发器后台发送邮件通知）
create extension if not exists pg_net;

-- 1. 内容点赞表（支持博客 blog / 随笔 essay / 画廊 gallery）
create table if not exists public.item_likes (
  id bigint generated always as identity primary key,
  item_type text not null check (item_type in ('blog', 'essay', 'gallery')),
  item_id text not null check (char_length(trim(item_id)) between 1 and 120),
  item_title text not null default '',
  visitor_id text not null check (char_length(trim(visitor_id)) between 4 and 120),
  created_at timestamptz not null default now(),
  unique (item_type, item_id, visitor_id)
);

create index if not exists idx_item_likes_target on public.item_likes (item_type, item_id);

alter table public.item_likes enable row level security;

drop policy if exists "Allow public read item_likes" on public.item_likes;
create policy "Allow public read item_likes"
  on public.item_likes
  for select
  using (true);

-- 通过安全 RPC 切换点赞/取消赞（防止访客删除他人的点赞记录）
create or replace function public.toggle_item_like(
  p_type text,
  p_id text,
  p_visitor text,
  p_title text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted boolean := false;
  v_count bigint := 0;
begin
  if p_type not in ('blog', 'essay', 'gallery') then
    raise exception 'invalid item_type';
  end if;
  if char_length(trim(coalesce(p_id, ''))) = 0 or char_length(trim(coalesce(p_visitor, ''))) < 4 then
    raise exception 'invalid parameters';
  end if;

  delete from public.item_likes
  where item_type = p_type
    and item_id = trim(p_id)
    and visitor_id = trim(p_visitor);

  if found then
    v_deleted := true;
  else
    insert into public.item_likes (item_type, item_id, visitor_id, item_title)
    values (p_type, trim(p_id), trim(p_visitor), left(coalesce(p_title, ''), 120))
    on conflict (item_type, item_id, visitor_id) do nothing;
  end if;

  select count(*) into v_count
  from public.item_likes
  where item_type = p_type and item_id = trim(p_id);

  return jsonb_build_object(
    'liked', (not v_deleted),
    'count', v_count
  );
end;
$$;

grant execute on function public.toggle_item_like(text, text, text, text) to anon, authenticated;

-- 2. 内容评论表（支持博客 blog / 随笔 essay / 画廊 gallery）
create table if not exists public.item_comments (
  id bigint generated always as identity primary key,
  item_type text not null check (item_type in ('blog', 'essay', 'gallery')),
  item_id text not null check (char_length(trim(item_id)) between 1 and 120),
  item_title text not null default '',
  author text not null check (char_length(trim(author)) between 1 and 32),
  text text not null check (char_length(trim(text)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists idx_item_comments_target on public.item_comments (item_type, item_id, created_at desc);

alter table public.item_comments enable row level security;

drop policy if exists "Allow public read item_comments" on public.item_comments;
create policy "Allow public read item_comments"
  on public.item_comments
  for select
  using (true);

drop policy if exists "Allow public insert item_comments" on public.item_comments;
create policy "Allow public insert item_comments"
  on public.item_comments
  for insert
  with check (
    item_type in ('blog', 'essay', 'gallery')
    and char_length(trim(item_id)) between 1 and 120
    and char_length(trim(author)) between 1 and 32
    and char_length(trim(text)) between 1 and 500
  );

-- 将评论表与点赞表加入 Realtime 实时推送
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'item_comments'
  ) then
    alter publication supabase_realtime add table public.item_comments;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'item_likes'
  ) then
    alter publication supabase_realtime add table public.item_likes;
  end if;
end $$;

-- 3. 站主私密配置表（严格开启 RLS 且零公开策略，前端 anonKey 无法读取）
create table if not exists public.site_secrets (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.site_secrets enable row level security;

delete from public.site_secrets where key = 'pushplus_token';

insert into public.site_secrets (key, value)
values
  ('resend_api_key', ''),
  ('notify_email', '1209565852@qq.com')
on conflict (key) do nothing;

-- 4. 邮件通知触发器函数（收到留言 / 评论 / 点赞时自动异步发送邮件到 QQ 邮箱）
drop trigger if exists trg_notify_guestbook on public.guestbook;
drop trigger if exists trg_notify_item_comments on public.item_comments;
drop trigger if exists trg_notify_item_likes on public.item_likes;
drop function if exists public.notify_wechat_on_interaction();

create or replace function public.notify_email_on_interaction()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_api_key text;
  v_to_email text;
  v_subject text;
  v_html text;
  v_type_label text;
  v_safe_author text;
  v_safe_text text;
  v_safe_title text;
  v_hash text;
begin
  select trim(value) into v_api_key
  from public.site_secrets
  where key = 'resend_api_key'
  limit 1;

  select trim(value) into v_to_email
  from public.site_secrets
  where key = 'notify_email'
  limit 1;

  if v_api_key is null or v_api_key = '' or v_to_email is null or v_to_email = '' then
    return new;
  end if;

  if tg_table_name = 'guestbook' then
    v_safe_author := replace(replace(coalesce(new.author, '访客'), '<', '&lt;'), '>', '&gt;');
    v_safe_text := replace(replace(coalesce(new.text, ''), '<', '&lt;'), '>', '&gt;');
    v_subject := 'Nova 空间 · 收到来自 ' || coalesce(new.author, '访客') || ' 的新留言';
    v_html :=
      '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.7;color:#1f2328;">' ||
      '<h3 style="margin:0 0 12px;">Nova 空间收到一条新留言</h3>' ||
      '<p style="margin:4px 0;"><b>访客昵称：</b>' || v_safe_author || '</p>' ||
      '<p style="margin:4px 0;"><b>留言内容：</b>' || v_safe_text || '</p>' ||
      '<p style="margin:14px 0 0;"><a href="https://1pengyuyan1.github.io/nova.github.io/#guestbook">点击前往留言板查看</a></p>' ||
      '</div>';

  elsif tg_table_name = 'item_comments' then
    v_type_label := case new.item_type
      when 'blog' then '博客'
      when 'essay' then '随笔'
      when 'gallery' then '画廊'
      else new.item_type
    end;
    v_hash := case new.item_type when 'essay' then 'essays' else new.item_type end;
    v_safe_title := replace(replace(coalesce(nullif(trim(new.item_title), ''), new.item_id), '<', '&lt;'), '>', '&gt;');
    v_safe_author := replace(replace(coalesce(new.author, '访客'), '<', '&lt;'), '>', '&gt;');
    v_safe_text := replace(replace(coalesce(new.text, ''), '<', '&lt;'), '>', '&gt;');
    v_subject := 'Nova 空间 · ' || v_type_label || '收到新评论';
    v_html :=
      '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.7;color:#1f2328;">' ||
      '<h3 style="margin:0 0 12px;">你的' || v_type_label || '收到一条新评论</h3>' ||
      '<p style="margin:4px 0;"><b>所属内容：</b>《' || v_safe_title || '》</p>' ||
      '<p style="margin:4px 0;"><b>访客昵称：</b>' || v_safe_author || '</p>' ||
      '<p style="margin:4px 0;"><b>评论内容：</b>' || v_safe_text || '</p>' ||
      '<p style="margin:14px 0 0;"><a href="https://1pengyuyan1.github.io/nova.github.io/#' || v_hash || '">点击前往查看</a></p>' ||
      '</div>';

  elsif tg_table_name = 'item_likes' then
    v_type_label := case new.item_type
      when 'blog' then '博客'
      when 'essay' then '随笔'
      when 'gallery' then '画廊'
      else new.item_type
    end;
    v_hash := case new.item_type when 'essay' then 'essays' else new.item_type end;
    v_safe_title := replace(replace(coalesce(nullif(trim(new.item_title), ''), new.item_id), '<', '&lt;'), '>', '&gt;');
    v_subject := 'Nova 空间 · ' || v_type_label || '收到新点赞';
    v_html :=
      '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.7;color:#1f2328;">' ||
      '<h3 style="margin:0 0 12px;">你的' || v_type_label || '收到一个新的点赞</h3>' ||
      '<p style="margin:4px 0;"><b>获赞内容：</b>《' || v_safe_title || '》</p>' ||
      '<p style="margin:14px 0 0;"><a href="https://1pengyuyan1.github.io/nova.github.io/#' || v_hash || '">点击前往查看</a></p>' ||
      '</div>';
  else
    return new;
  end if;

  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_api_key
      ),
      body := jsonb_build_object(
        'from', 'Nova Space <onboarding@resend.dev>',
        'to', jsonb_build_array(v_to_email),
        'subject', v_subject,
        'html', v_html
      )
    );
  exception when others then
    -- 邮件发送失败时不影响访客正常点赞/评论/留言
    null;
  end;

  return new;
end;
$$;

create trigger trg_notify_guestbook
  after insert on public.guestbook
  for each row execute function public.notify_email_on_interaction();

create trigger trg_notify_item_comments
  after insert on public.item_comments
  for each row execute function public.notify_email_on_interaction();

create trigger trg_notify_item_likes
  after insert on public.item_likes
  for each row execute function public.notify_email_on_interaction();
