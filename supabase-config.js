/**
 * Supabase 全网实时留言板配置
 *
 * 配置步骤（约 2 分钟，永久免费）：
 * 1. 前往 https://supabase.com 注册并新建一个免费项目（Free Plan）。
 * 2. 打开左侧 SQL Editor，粘贴运行仓库里的 supabase-guestbook.sql 创建表与权限。
 * 3. 打开 Project Settings -> API，复制 Project URL 和 anon public key 填到下面。
 * 4. 提交并推送到 GitHub 后，全网访客无需登录即可留言并实时同步。
 *
 * 注意：未填写时页面会自动使用浏览器本地预览模式（localStorage），不影响站点正常运行。
 */
window.SUPABASE_CONFIG = {
  url: '',
  anonKey: '',
  table: 'guestbook',
};
