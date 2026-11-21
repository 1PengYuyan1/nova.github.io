/**
 * ============================================================================
 * 内置可视化网页后台 (#admin) — 基于 GitHub Contents API，0 元免费免代码维护
 * 支持：站点设置 / 博客增删改 / 随笔发布与传图 / 画廊上传压缩照片 / 关于页编辑
 * ============================================================================
 */
(function () {
  const AUTH_KEY = 'obsidian-cms-github-auth-v1';

  const DEFAULT_REPO = {
    owner: '1PengYuyan1',
    repo: 'nova.github.io',
    branch: 'main',
    token: '',
    demoMode: false,
  };

  let activeTab = 'site';
  let editingPostId = null;
  let editingEssayId = null;
  let editingGalleryId = null;
  let pendingEssayImagePath = '';
  let pendingGalleryImagePath = '';
  let pendingEssayPreviewUrl = '';
  let pendingGalleryPreviewUrl = '';
  let isBusy = false;

  /* ========================================================================
     工具：认证读取、Base64 UTF-8 编解码、图片客户端压缩
     ======================================================================== */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) return { ...DEFAULT_REPO, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_REPO };
  }

  function saveAuth(auth) {
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    } catch {}
  }

  function clearAuth() {
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch {}
  }

  function isLoggedIn() {
    const a = getAuth();
    return Boolean(a.demoMode || (a.token && a.owner && a.repo));
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function todayStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function nowStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toast(msg) {
    if (window.SITE_APP && window.SITE_APP.showToast) {
      window.SITE_APP.showToast(msg);
    }
  }

  // 压缩本地图片，控制最大宽 1600px、体积轻量化，返回 { base64, dataUrl, ext }
  function compressImageFile(file, maxWidth = 1600, quality = 0.84) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片格式无法解析'));
        img.onload = () => {
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > maxWidth) {
            h = Math.round((h * maxWidth) / w);
            w = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const base64 = dataUrl.split(',')[1];
          resolve({ base64, dataUrl, ext: 'jpg' });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ========================================================================
     GitHub Contents API 读写封装
     ======================================================================== */
  async function ghRequest(path, options = {}) {
    const auth = getAuth();
    const url = `https://api.github.com${path}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${auth.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const msg = (json && json.message) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  }

  async function verifyGitHubAccess(auth) {
    const res = await fetch(`https://api.github.com/repos/${auth.owner}/${auth.repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${auth.token}`,
      },
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error('Token 无效或已过期，请检查后重试');
      if (res.status === 404) throw new Error('找不到该仓库，请确认用户名与仓库名是否正确');
      throw new Error(`验证失败 (HTTP ${res.status})`);
    }
    const repo = await res.json();
    if (!repo.permissions || !repo.permissions.push) {
      throw new Error('该 Token 缺少 repo 写入权限，请重新勾选 repo 权限生成 Token');
    }
    return repo;
  }

  async function uploadImageToGitHub(base64Content, filename) {
    const auth = getAuth();
    const relPath = `assets/images/${filename}`;
    if (auth.demoMode) {
      return { relPath: `./${relPath}`, demo: true };
    }
    await ghRequest(`/repos/${auth.owner}/${auth.repo}/contents/${relPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `upload image: ${filename}`,
        content: base64Content,
        branch: auth.branch || 'main',
      }),
    });
    return { relPath: `./${relPath}`, demo: false };
  }

  function serializeSiteData(dataObj) {
    return `/**\n * 站点内容数据（由网页管理后台自动同步生成）\n */\nwindow.SITE_DATA = ${JSON.stringify(dataObj, null, 2)};\n`;
  }

  async function commitSiteData(commitMsg) {
    const auth = getAuth();
    // 先刷新页面导航/页脚展示
    if (window.SITE_APP && window.SITE_APP.refreshShell) {
      window.SITE_APP.refreshShell();
    }
    if (auth.demoMode) {
      toast('本地体验模式：已即时更新当前页面预览（未推送到 GitHub）');
      return { demo: true };
    }

    const filePath = 'data.js';
    const existing = await ghRequest(
      `/repos/${auth.owner}/${auth.repo}/contents/${filePath}?ref=${encodeURIComponent(auth.branch || 'main')}`
    );
    const contentJs = serializeSiteData(window.SITE_DATA);

    await ghRequest(`/repos/${auth.owner}/${auth.repo}/contents/${filePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMsg || 'update site content via web admin',
        content: utf8ToBase64(contentJs),
        sha: existing.sha,
        branch: auth.branch || 'main',
      }),
    });
    toast('已保存并发布到 GitHub！约 30 秒后全网自动生效');
    return { demo: false };
  }

  /* ========================================================================
     主渲染入口
     ======================================================================== */
  function render(container) {
    if (!isLoggedIn()) {
      renderLogin(container);
      return;
    }
    renderWorkspace(container);
  }

  function renderLogin(container) {
    const auth = getAuth();
    container.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Web Admin Console</div>
              <h1>网页可视化管理后台</h1>
              <p>无需修改代码或敲命令行，登录你的 GitHub 令牌即可直接在网页上写博客、发随笔、传画廊照片与修改站点信息。</p>
            </div>
            <span class="chip">0 元免费 · 直连 GitHub</span>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="admin-login-grid">
            <form class="admin-card liquid-glass" id="admin-login-form">
              <h3>使用 GitHub Token 登录管理</h3>
              <p class="admin-hint">令牌仅保存在你当前浏览器的本地存储中，不会上传到任何第三方服务器。</p>

              <label class="admin-label">
                <span>GitHub 用户名（Owner）</span>
                <input class="glass-input" id="cms-owner" type="text" value="${escapeHtml(auth.owner)}" required />
              </label>

              <label class="admin-label">
                <span>网站仓库名（Repo）</span>
                <input class="glass-input" id="cms-repo" type="text" value="${escapeHtml(auth.repo)}" required />
              </label>

              <label class="admin-label">
                <span>分支名（Branch）</span>
                <input class="glass-input" id="cms-branch" type="text" value="${escapeHtml(auth.branch || 'main')}" required />
              </label>

              <label class="admin-label">
                <span>GitHub Personal Access Token（勾选了 repo 权限的 ghp_ 令牌）</span>
                <input class="glass-input" id="cms-token" type="password" placeholder="粘贴 ghp_ 开头的令牌..." required />
              </label>

              <div class="admin-error" id="cms-login-error" style="display:none;"></div>

              <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;">
                <button type="submit" class="btn btn-primary btn-sm" id="cms-login-btn">验证并进入后台 →</button>
                <button type="button" class="btn btn-liquid btn-sm" id="cms-demo-btn">先本地试玩（不推线上）</button>
              </div>
            </form>

            <div class="admin-card liquid-glass">
              <h3>工作原理说明</h3>
              <ul class="admin-guide-list">
                <li><strong>免代码写文章：</strong>在后台表单里填标题、标签和正文，点击「保存并发布」即可。</li>
                <li><strong>直接传照片：</strong>随笔与画廊支持直接选电脑/手机里的照片，自动压缩并上传到仓库的 <code>assets/images/</code>。</li>
                <li><strong>自动上线：</strong>保存后通过 GitHub 官方接口写入仓库，Cloudflare Pages 与 GitHub Pages 会在约 30 秒内自动完成更新。</li>
                <li><strong>安全隐私：</strong>只有拥有你 Token 的浏览器能发布修改，访客看不到管理界面，退出登录即可清除本地令牌。</li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    `;

    const form = document.getElementById('admin-login-form');
    const errEl = document.getElementById('cms-login-error');
    const loginBtn = document.getElementById('cms-login-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const nextAuth = {
        owner: document.getElementById('cms-owner').value.trim(),
        repo: document.getElementById('cms-repo').value.trim(),
        branch: document.getElementById('cms-branch').value.trim() || 'main',
        token: document.getElementById('cms-token').value.trim(),
        demoMode: false,
      };
      loginBtn.disabled = true;
      loginBtn.textContent = '正在验证权限...';
      try {
        await verifyGitHubAccess(nextAuth);
        saveAuth(nextAuth);
        toast('验证成功，已进入可视化管理后台');
        renderWorkspace(container);
      } catch (err) {
        errEl.textContent = err.message || '验证失败，请检查令牌与网络';
        errEl.style.display = 'block';
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = '验证并进入后台 →';
      }
    });

    document.getElementById('cms-demo-btn').addEventListener('click', () => {
      saveAuth({ ...getAuth(), demoMode: true });
      toast('已进入本地体验模式（修改仅在当前页面预览）');
      renderWorkspace(container);
    });

    if (window.SITE_APP && window.SITE_APP.bindGlassGlint) {
      window.SITE_APP.bindGlassGlint();
    }
  }

  /* ========================================================================
     已登录：后台工作台
     ======================================================================== */
  function renderWorkspace(container) {
    const auth = getAuth();
    const d = window.SITE_DATA;
    const tabs = [
      { id: 'site', label: '站点设置' },
      { id: 'blog', label: `博客 (${d.posts.length})` },
      { id: 'essays', label: `随笔 (${d.essays.length})` },
      { id: 'gallery', label: `画廊 (${d.gallery.length})` },
      { id: 'about', label: '关于页' },
    ];

    container.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Web Admin Console</div>
              <h1>内容管理后台</h1>
              <p>${
                auth.demoMode
                  ? '当前为【本地试玩模式】：所做修改会在前台页面即时生效，刷新后重置；需要同步到公网请点击右侧切换真实登录。'
                  : `已连接仓库：${escapeHtml(auth.owner)}/${escapeHtml(auth.repo)} (${escapeHtml(auth.branch)}) · 保存后自动推送并触发线上更新。`
              }</p>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a href="#home" class="btn btn-liquid btn-sm">返回前台预览</a>
              <button type="button" class="btn btn-liquid btn-sm" id="cms-logout-btn">${auth.demoMode ? '切换真实 GitHub 登录' : '退出登录'}</button>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="toolbar">
            <div class="filter-group">
              ${tabs
                .map(
                  (t) =>
                    `<button class="filter-pill ${t.id === activeTab ? 'active' : ''}" data-admin-tab="${t.id}">${escapeHtml(t.label)}</button>`
                )
                .join('')}
            </div>
            <span class="chip" id="cms-status-chip">${auth.demoMode ? '本地试玩模式' : '已连接 GitHub'}</span>
          </div>

          <div id="admin-tab-content"></div>
        </div>
      </section>
    `;

    document.getElementById('cms-logout-btn').addEventListener('click', () => {
      clearAuth();
      toast('已退出后台登录');
      renderLogin(container);
    });

    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.getAttribute('data-admin-tab');
        editingPostId = null;
        editingEssayId = null;
        editingGalleryId = null;
        pendingEssayImagePath = '';
        pendingGalleryImagePath = '';
        pendingEssayPreviewUrl = '';
        pendingGalleryPreviewUrl = '';
        renderWorkspace(container);
      });
    });

    const tabBox = document.getElementById('admin-tab-content');
    if (activeTab === 'site') renderSiteTab(tabBox, container);
    else if (activeTab === 'blog') renderBlogTab(tabBox, container);
    else if (activeTab === 'essays') renderEssaysTab(tabBox, container);
    else if (activeTab === 'gallery') renderGalleryTab(tabBox, container);
    else if (activeTab === 'about') renderAboutTab(tabBox, container);

    if (window.SITE_APP && window.SITE_APP.bindGlassGlint) {
      window.SITE_APP.bindGlassGlint();
    }
  }

  function setStatus(text) {
    const chip = document.getElementById('cms-status-chip');
    if (chip) chip.textContent = text;
  }

  /* ------------------------------------------------------------------------
     Tab 1: 站点与开屏设置
     ------------------------------------------------------------------------ */
  function renderSiteTab(box, rootContainer) {
    const p = window.SITE_DATA.profile;
    const socialsText = (p.socials || []).map((s) => `${s.label} | ${s.url}`).join('\n');

    box.innerHTML = `
      <form class="admin-card liquid-glass" id="form-site-settings" style="max-width:820px;">
        <h3>首页开屏与基础信息</h3>

        <div class="admin-row-2">
          <label class="admin-label">
            <span>导航栏品牌名称</span>
            <input class="glass-input" id="f-brandName" value="${escapeHtml(p.brandName)}" required />
          </label>
          <label class="admin-label">
            <span>顶部状态胶囊文案</span>
            <input class="glass-input" id="f-statusBadge" value="${escapeHtml(p.statusBadge)}" />
          </label>
        </div>

        <div class="admin-row-2">
          <label class="admin-label">
            <span>开屏第一行问候语</span>
            <input class="glass-input" id="f-heroGreeting" value="${escapeHtml(p.heroGreeting)}" />
          </label>
          <label class="admin-label">
            <span>开屏大标题名字</span>
            <input class="glass-input" id="f-heroName" value="${escapeHtml(p.heroName)}" required />
          </label>
        </div>

        <div class="admin-row-2">
          <label class="admin-label">
            <span>打字机前缀</span>
            <input class="glass-input" id="f-heroPrefix" value="${escapeHtml(p.heroPrefix)}" />
          </label>
          <label class="admin-label">
            <span>联系邮箱（留空则不显示）</span>
            <input class="glass-input" id="f-email" value="${escapeHtml(p.email || '')}" placeholder="例如：you@example.com" />
          </label>
        </div>

        <label class="admin-label">
          <span>打字机轮播短语（每行一条）</span>
          <textarea class="glass-textarea" id="f-heroPhrases" style="min-height:92px;">${escapeHtml((p.heroPhrases || []).join('\n'))}</textarea>
        </label>

        <label class="admin-label">
          <span>开屏副标题</span>
          <input class="glass-input" id="f-heroSubline" value="${escapeHtml(p.heroSubline || '')}" />
        </label>

        <label class="admin-label">
          <span>页脚简短介绍</span>
          <input class="glass-input" id="f-bio" value="${escapeHtml(p.bio || '')}" />
        </label>

        <label class="admin-label">
          <span>社交链接（每行一条，格式：名称 | 网址）</span>
          <textarea class="glass-textarea" id="f-socials" style="min-height:84px;" placeholder="GitHub | https://github.com/yourname">${escapeHtml(socialsText)}</textarea>
        </label>

        <div style="display:flex;gap:12px;align-items:center;">
          <button type="submit" class="btn btn-primary btn-sm" id="btn-save-site">保存并发布到线上</button>
        </div>
      </form>
    `;

    document.getElementById('form-site-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isBusy) return;
      isBusy = true;
      const btn = document.getElementById('btn-save-site');
      btn.disabled = true;
      btn.textContent = '正在发布...';
      setStatus('正在同步到 GitHub...');

      try {
        const phrases = document
          .getElementById('f-heroPhrases')
          .value.split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const parseSocialLine = (rawLine) => {
          const line = rawLine.trim();
          if (!line) return null;
          let label = '';
          let url = '';

          // 1. 支持英文 | 或中文全角 ｜ 分隔
          const pipeIdx = line.search(/[|｜]/);
          if (pipeIdx >= 0) {
            label = line.slice(0, pipeIdx).trim();
            url = line.slice(pipeIdx + 1).trim();
          } else {
            // 2. 支持直接贴网址，或用空格 / 冒号分隔（如 "GitHub https://..." 或 "GitHub：https://..."）
            const urlMatch = line.match(/(https?:\/\/\S+)/i);
            if (urlMatch) {
              url = urlMatch[1].trim();
              label = line
                .slice(0, urlMatch.index)
                .replace(/[:：\-—、,\s]+$/g, '')
                .trim();
            }
          }

          if (!url) return null;
          if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
            url = `https://${url}`;
          }
          if (!label) {
            try {
              const host = new URL(url).hostname.replace(/^www\./, '');
              label = host.split('.')[0] || host;
            } catch {
              label = url;
            }
          }
          return { label, url };
        };

        const socials = document
          .getElementById('f-socials')
          .value.split('\n')
          .map(parseSocialLine)
          .filter(Boolean);

        window.SITE_DATA.profile = {
          ...window.SITE_DATA.profile,
          brandName: document.getElementById('f-brandName').value.trim(),
          statusBadge: document.getElementById('f-statusBadge').value.trim(),
          heroGreeting: document.getElementById('f-heroGreeting').value.trim(),
          heroName: document.getElementById('f-heroName').value.trim(),
          heroPrefix: document.getElementById('f-heroPrefix').value.trim(),
          heroPhrases: phrases.length ? phrases : ['博客与思考'],
          heroSubline: document.getElementById('f-heroSubline').value.trim(),
          bio: document.getElementById('f-bio').value.trim(),
          email: document.getElementById('f-email').value.trim(),
          socials,
        };

        await commitSiteData('update site profile settings');
        renderWorkspace(rootContainer);
      } catch (err) {
        toast(`发布失败：${err.message}`);
        setStatus('发布失败');
      } finally {
        isBusy = false;
        btn.disabled = false;
        btn.textContent = '保存并发布到线上';
      }
    });
  }

  /* ------------------------------------------------------------------------
     Tab 2: 博客管理
     ------------------------------------------------------------------------ */
  function renderBlogTab(box, rootContainer) {
    const posts = window.SITE_DATA.posts;
    const editing = editingPostId ? posts.find((p) => p.id === editingPostId) : null;

    box.innerHTML = `
      <div class="admin-split">
        <form class="admin-card liquid-glass" id="form-blog">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3>${editing ? '编辑博客文章' : '发布新博客'}</h3>
            ${editing ? `<button type="button" class="btn btn-liquid btn-sm" id="cancel-edit-post">取消编辑</button>` : ''}
          </div>

          <label class="admin-label">
            <span>文章标题</span>
            <input class="glass-input" id="b-title" value="${escapeHtml(editing ? editing.title : '')}" placeholder="输入标题..." required />
          </label>

          <div class="admin-row-2">
            <label class="admin-label">
              <span>发布日期</span>
              <input class="glass-input" id="b-date" type="date" value="${escapeHtml(editing ? editing.date : todayStr())}" required />
            </label>
            <label class="admin-label">
              <span>标签（用逗号分隔）</span>
              <input class="glass-input" id="b-tags" value="${escapeHtml(editing ? (editing.tags || []).join(', ') : '')}" placeholder="例如：笔记, 思考, 生活" />
            </label>
          </div>

          <label class="admin-label">
            <span>文章摘要</span>
            <input class="glass-input" id="b-excerpt" value="${escapeHtml(editing ? editing.excerpt : '')}" placeholder="一句话介绍这篇文章..." />
          </label>

          <div class="admin-label">
            <label for="b-content">正文内容（支持 Markdown）</label>
            <div class="md-toolbar">
              <button type="button" class="md-btn" data-md-insert="\n## 小标题\n">H2 标题</button>
              <button type="button" class="md-btn" data-md-insert="**加粗文字**">加粗</button>
              <button type="button" class="md-btn" data-md-insert="\n> 引用内容\n">引用</button>
              <button type="button" class="md-btn" data-md-insert="\n- 列表项\n">列表</button>
              <button type="button" class="md-btn" data-md-insert="\n\`\`\`\n代码块\n\`\`\`\n">代码块</button>
            </div>
            <textarea class="glass-textarea" id="b-content" style="min-height:220px;" placeholder="开始写你的正文..." required>${escapeHtml(editing ? editing.content : '')}</textarea>
          </div>

          <button type="submit" class="btn btn-primary btn-sm" id="btn-save-post">${editing ? '保存修改并发布' : '发布博客到线上'}</button>
        </form>

        <div class="admin-card liquid-glass">
          <h3>已发布的博客（${posts.length}）</h3>
          ${
            posts.length
              ? `
                <div class="admin-item-list">
                  ${posts
                    .map(
                      (p) => `
                      <div class="admin-item-row">
                        <div class="admin-item-info">
                          <div class="admin-item-title">${escapeHtml(p.title)}</div>
                          <div class="admin-item-meta">${escapeHtml(p.date)} · ${(p.tags || []).join(' / ') || '无标签'}</div>
                        </div>
                        <div class="admin-item-actions">
                          <button type="button" class="btn btn-liquid btn-sm" data-edit-post="${p.id}">编辑</button>
                          <button type="button" class="btn btn-danger btn-sm" data-del-post="${p.id}">删除</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')}
                </div>
              `
              : `<p class="admin-hint">还没有博客文章，在左侧写下你的第一篇吧。</p>`
          }
        </div>
      </div>
    `;

    // Markdown 快捷按钮
    const textarea = document.getElementById('b-content');
    box.querySelectorAll('[data-md-insert]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const snippet = btn.getAttribute('data-md-insert');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
        textarea.focus();
        textarea.setSelectionRange(start + snippet.length, start + snippet.length);
      });
    });

    const cancelBtn = document.getElementById('cancel-edit-post');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        editingPostId = null;
        renderWorkspace(rootContainer);
      });
    }

    document.getElementById('form-blog').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isBusy) return;
      isBusy = true;
      const btn = document.getElementById('btn-save-post');
      btn.disabled = true;
      btn.textContent = '正在发布...';
      setStatus('正在同步到 GitHub...');

      try {
        const postObj = {
          id: editing ? editing.id : `post-${Date.now()}`,
          title: document.getElementById('b-title').value.trim(),
          date: document.getElementById('b-date').value.trim() || todayStr(),
          tags: document
            .getElementById('b-tags')
            .value.split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          excerpt: document.getElementById('b-excerpt').value.trim(),
          content: document.getElementById('b-content').value.trim(),
        };
        if (!postObj.excerpt) {
          postObj.excerpt = postObj.content.replace(/[#>*`\n]/g, ' ').trim().slice(0, 80);
        }

        if (editing) {
          const idx = window.SITE_DATA.posts.findIndex((x) => x.id === editing.id);
          if (idx >= 0) window.SITE_DATA.posts[idx] = postObj;
        } else {
          window.SITE_DATA.posts.unshift(postObj);
        }

        await commitSiteData(`${editing ? 'edit' : 'add'} blog post: ${postObj.title}`);
        editingPostId = null;
        renderWorkspace(rootContainer);
      } catch (err) {
        toast(`发布失败：${err.message}`);
      } finally {
        isBusy = false;
      }
    });

    box.querySelectorAll('[data-edit-post]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingPostId = btn.getAttribute('data-edit-post');
        renderWorkspace(rootContainer);
      });
    });

    box.querySelectorAll('[data-del-post]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy || !confirm('确定删除这篇博客文章吗？')) return;
        isBusy = true;
        setStatus('正在删除并同步...');
        try {
          const id = btn.getAttribute('data-del-post');
          window.SITE_DATA.posts = window.SITE_DATA.posts.filter((x) => x.id !== id);
          if (editingPostId === id) editingPostId = null;
          await commitSiteData(`delete blog post: ${id}`);
          renderWorkspace(rootContainer);
        } catch (err) {
          toast(`删除失败：${err.message}`);
        } finally {
          isBusy = false;
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     Tab 3: 随笔管理（支持直接本地选图上传）
     ------------------------------------------------------------------------ */
  function renderEssaysTab(box, rootContainer) {
    const essays = window.SITE_DATA.essays;
    const editing = editingEssayId ? essays.find((e) => e.id === editingEssayId) : null;
    const currentImg = pendingEssayPreviewUrl || pendingEssayImagePath || (editing ? editing.image : '');

    box.innerHTML = `
      <div class="admin-split">
        <form class="admin-card liquid-glass" id="form-essay">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3>${editing ? '编辑随笔' : '发一条随笔'}</h3>
            ${editing ? `<button type="button" class="btn btn-liquid btn-sm" id="cancel-edit-essay">取消编辑</button>` : ''}
          </div>

          <label class="admin-label">
            <span>此刻想写的话</span>
            <textarea class="glass-textarea" id="e-text" style="min-height:130px;" placeholder="记录此刻的想法、见闻或心情..." required>${escapeHtml(editing ? editing.text : '')}</textarea>
          </label>

          <div class="admin-row-3">
            <label class="admin-label">
              <span>分类</span>
              <input class="glass-input" id="e-category" value="${escapeHtml(editing ? editing.category : '日常')}" placeholder="日常 / 思考" />
            </label>
            <label class="admin-label">
              <span>心情标签</span>
              <input class="glass-input" id="e-mood" value="${escapeHtml(editing ? editing.mood : '')}" placeholder="例如：松弛时刻" />
            </label>
            <label class="admin-label">
              <span>地点</span>
              <input class="glass-input" id="e-location" value="${escapeHtml(editing ? editing.location : '')}" placeholder="例如：广州" />
            </label>
          </div>

          <label class="admin-label">
            <span>配图（可选，支持直接从电脑/手机选图上传）</span>
            <div class="upload-row">
              <input type="file" id="e-file" accept="image/*" class="file-input-hidden" />
              <label for="e-file" class="btn btn-liquid btn-sm" id="e-upload-label">选择并上传图片</label>
              <span class="admin-hint" id="e-img-status" style="margin:0;">${pendingEssayImagePath ? `已上传：${pendingEssayImagePath}` : editing && editing.image ? `当前图片：${editing.image}` : '未配图'}</span>
            </div>
            ${currentImg ? `<img src="${currentImg}" alt="preview" class="upload-preview" />` : ''}
          </label>

          <button type="submit" class="btn btn-primary btn-sm" id="btn-save-essay">${editing ? '保存修改并发布' : '发布随笔到线上'}</button>
        </form>

        <div class="admin-card liquid-glass">
          <h3>已发布的随笔（${essays.length}）</h3>
          ${
            essays.length
              ? `
                <div class="admin-item-list">
                  ${essays
                    .map(
                      (e) => `
                      <div class="admin-item-row">
                        <div class="admin-item-info">
                          <div class="admin-item-title">${escapeHtml(e.text.slice(0, 48))}${e.text.length > 48 ? '...' : ''}</div>
                          <div class="admin-item-meta">${escapeHtml(e.date)} · ${escapeHtml(e.category || '随笔')} ${e.mood ? '· ' + escapeHtml(e.mood) : ''}</div>
                        </div>
                        <div class="admin-item-actions">
                          <button type="button" class="btn btn-liquid btn-sm" data-edit-essay="${e.id}">编辑</button>
                          <button type="button" class="btn btn-danger btn-sm" data-del-essay="${e.id}">删除</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')}
                </div>
              `
              : `<p class="admin-hint">还没有随笔，在左侧发一条试试吧。</p>`
          }
        </div>
      </div>
    `;

    const cancelBtn = document.getElementById('cancel-edit-essay');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        editingEssayId = null;
        pendingEssayImagePath = '';
        pendingEssayPreviewUrl = '';
        renderWorkspace(rootContainer);
      });
    }

    document.getElementById('e-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = document.getElementById('e-img-status');
      statusEl.textContent = '正在压缩并上传图片...';
      try {
        const compressed = await compressImageFile(file);
        const filename = `essay-${Date.now()}.${compressed.ext}`;
        const result = await uploadImageToGitHub(compressed.base64, filename);
        pendingEssayImagePath = result.demo ? compressed.dataUrl : result.relPath;
        pendingEssayPreviewUrl = compressed.dataUrl;
        toast(result.demo ? '图片已在本地预览加载' : '图片已自动压缩并上传至 GitHub');
        renderEssaysTab(box, rootContainer);
      } catch (err) {
        statusEl.textContent = `上传失败：${err.message}`;
        toast(`图片上传失败：${err.message}`);
      }
    });

    document.getElementById('form-essay').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isBusy) return;
      isBusy = true;
      const btn = document.getElementById('btn-save-essay');
      btn.disabled = true;
      btn.textContent = '正在发布...';
      setStatus('正在同步到 GitHub...');

      try {
        const essayObj = {
          id: editing ? editing.id : `essay-${Date.now()}`,
          date: editing ? editing.date : nowStr(),
          category: document.getElementById('e-category').value.trim() || '日常',
          mood: document.getElementById('e-mood').value.trim(),
          location: document.getElementById('e-location').value.trim(),
          text: document.getElementById('e-text').value.trim(),
          image: pendingEssayImagePath || (editing ? editing.image : ''),
        };

        if (editing) {
          const idx = window.SITE_DATA.essays.findIndex((x) => x.id === editing.id);
          if (idx >= 0) window.SITE_DATA.essays[idx] = essayObj;
        } else {
          window.SITE_DATA.essays.unshift(essayObj);
        }

        await commitSiteData(`${editing ? 'edit' : 'add'} essay`);
        editingEssayId = null;
        pendingEssayImagePath = '';
        pendingEssayPreviewUrl = '';
        renderWorkspace(rootContainer);
      } catch (err) {
        toast(`发布失败：${err.message}`);
      } finally {
        isBusy = false;
      }
    });

    box.querySelectorAll('[data-edit-essay]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingEssayId = btn.getAttribute('data-edit-essay');
        pendingEssayImagePath = '';
        pendingEssayPreviewUrl = '';
        renderWorkspace(rootContainer);
      });
    });

    box.querySelectorAll('[data-del-essay]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy || !confirm('确定删除这条随笔吗？')) return;
        isBusy = true;
        try {
          const id = btn.getAttribute('data-del-essay');
          window.SITE_DATA.essays = window.SITE_DATA.essays.filter((x) => x.id !== id);
          if (editingEssayId === id) editingEssayId = null;
          await commitSiteData(`delete essay: ${id}`);
          renderWorkspace(rootContainer);
        } catch (err) {
          toast(`删除失败：${err.message}`);
        } finally {
          isBusy = false;
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     Tab 4: 画廊管理（选照片自动压缩并上传）
     ------------------------------------------------------------------------ */
  function renderGalleryTab(box, rootContainer) {
    const gallery = window.SITE_DATA.gallery;
    const editing = editingGalleryId ? gallery.find((g) => g.id === editingGalleryId) : null;
    const previewSrc = pendingGalleryPreviewUrl || pendingGalleryImagePath || (editing ? editing.src : '');

    box.innerHTML = `
      <div class="admin-split">
        <form class="admin-card liquid-glass" id="form-gallery">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3>${editing ? '编辑画廊照片' : '上传新照片到画廊'}</h3>
            ${editing ? `<button type="button" class="btn btn-liquid btn-sm" id="cancel-edit-gallery">取消编辑</button>` : ''}
          </div>

          <label class="admin-label">
            <span>选择本地照片（自动压缩优化体积并上传）</span>
            <div class="upload-row">
              <input type="file" id="g-file" accept="image/*" class="file-input-hidden" />
              <label for="g-file" class="btn btn-liquid btn-sm">选择并上传照片</label>
              <span class="admin-hint" id="g-img-status" style="margin:0;">${pendingGalleryImagePath ? `已上传：${pendingGalleryImagePath}` : editing ? `当前图片：${editing.src}` : '请先选择一张照片'}</span>
            </div>
            ${previewSrc ? `<img src="${previewSrc}" alt="gallery preview" class="upload-preview" />` : ''}
          </label>

          <label class="admin-label">
            <span>照片标题</span>
            <input class="glass-input" id="g-title" value="${escapeHtml(editing ? editing.title : '')}" placeholder="例如：傍晚的海风" required />
          </label>

          <div class="admin-row-3">
            <label class="admin-label">
              <span>分类</span>
              <input class="glass-input" id="g-category" value="${escapeHtml(editing ? editing.category : '生活')}" placeholder="生活 / 旅行 / 夜色" />
            </label>
            <label class="admin-label">
              <span>拍摄时间</span>
              <input class="glass-input" id="g-date" value="${escapeHtml(editing ? editing.date : todayStr().slice(0, 7))}" placeholder="2026-11" />
            </label>
            <label class="admin-label">
              <span>地点</span>
              <input class="glass-input" id="g-location" value="${escapeHtml(editing ? editing.location : '')}" placeholder="例如：海边" />
            </label>
          </div>

          <label class="admin-label">
            <span>设备或参数（可选）</span>
            <input class="glass-input" id="g-camera" value="${escapeHtml(editing ? editing.camera : '')}" placeholder="例如：iPhone / 35mm f/2.0" />
          </label>

          <button type="submit" class="btn btn-primary btn-sm" id="btn-save-gallery">${editing ? '保存修改并发布' : '添加到画廊并上线'}</button>
        </form>

        <div class="admin-card liquid-glass">
          <h3>画廊照片列表（${gallery.length}）</h3>
          ${
            gallery.length
              ? `
                <div class="admin-item-list">
                  ${gallery
                    .map(
                      (g) => `
                      <div class="admin-item-row">
                        <div style="display:flex;align-items:center;gap:12px;min-width:0;">
                          <img src="${g.src}" alt="" class="admin-thumb" />
                          <div class="admin-item-info">
                            <div class="admin-item-title">${escapeHtml(g.title)}</div>
                            <div class="admin-item-meta">${escapeHtml(g.category || '照片')} · ${escapeHtml(g.location || '')} ${escapeHtml(g.date || '')}</div>
                          </div>
                        </div>
                        <div class="admin-item-actions">
                          <button type="button" class="btn btn-liquid btn-sm" data-edit-gallery="${g.id}">编辑</button>
                          <button type="button" class="btn btn-danger btn-sm" data-del-gallery="${g.id}">删除</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')}
                </div>
              `
              : `<p class="admin-hint">画廊还是空的，在左侧选一张照片上传吧。</p>`
          }
        </div>
      </div>
    `;

    const cancelBtn = document.getElementById('cancel-edit-gallery');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        editingGalleryId = null;
        pendingGalleryImagePath = '';
        pendingGalleryPreviewUrl = '';
        renderWorkspace(rootContainer);
      });
    }

    document.getElementById('g-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = document.getElementById('g-img-status');
      statusEl.textContent = '正在压缩并上传照片...';
      try {
        const compressed = await compressImageFile(file);
        const filename = `gallery-${Date.now()}.${compressed.ext}`;
        const result = await uploadImageToGitHub(compressed.base64, filename);
        pendingGalleryImagePath = result.demo ? compressed.dataUrl : result.relPath;
        pendingGalleryPreviewUrl = compressed.dataUrl;
        toast(result.demo ? '照片已在本地预览加载' : '照片已自动压缩并上传至 GitHub');
        renderGalleryTab(box, rootContainer);
      } catch (err) {
        statusEl.textContent = `上传失败：${err.message}`;
        toast(`照片上传失败：${err.message}`);
      }
    });

    document.getElementById('form-gallery').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isBusy) return;
      const finalSrc = pendingGalleryImagePath || (editing ? editing.src : '');
      if (!finalSrc) {
        toast('请先选择并上传一张照片');
        return;
      }
      isBusy = true;
      const btn = document.getElementById('btn-save-gallery');
      btn.disabled = true;
      btn.textContent = '正在发布...';
      setStatus('正在同步到 GitHub...');

      try {
        const item = {
          id: editing ? editing.id : `g-${Date.now()}`,
          title: document.getElementById('g-title').value.trim(),
          category: document.getElementById('g-category').value.trim() || '生活',
          date: document.getElementById('g-date').value.trim(),
          location: document.getElementById('g-location').value.trim(),
          camera: document.getElementById('g-camera').value.trim(),
          src: finalSrc,
        };

        if (editing) {
          const idx = window.SITE_DATA.gallery.findIndex((x) => x.id === editing.id);
          if (idx >= 0) window.SITE_DATA.gallery[idx] = item;
        } else {
          window.SITE_DATA.gallery.unshift(item);
        }

        await commitSiteData(`${editing ? 'edit' : 'add'} gallery photo: ${item.title}`);
        editingGalleryId = null;
        pendingGalleryImagePath = '';
        pendingGalleryPreviewUrl = '';
        renderWorkspace(rootContainer);
      } catch (err) {
        toast(`发布失败：${err.message}`);
      } finally {
        isBusy = false;
      }
    });

    box.querySelectorAll('[data-edit-gallery]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingGalleryId = btn.getAttribute('data-edit-gallery');
        pendingGalleryImagePath = '';
        pendingGalleryPreviewUrl = '';
        renderWorkspace(rootContainer);
      });
    });

    box.querySelectorAll('[data-del-gallery]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy || !confirm('确定从画廊移除这张照片吗？')) return;
        isBusy = true;
        try {
          const id = btn.getAttribute('data-del-gallery');
          window.SITE_DATA.gallery = window.SITE_DATA.gallery.filter((x) => x.id !== id);
          if (editingGalleryId === id) editingGalleryId = null;
          await commitSiteData(`delete gallery photo: ${id}`);
          renderWorkspace(rootContainer);
        } catch (err) {
          toast(`删除失败：${err.message}`);
        } finally {
          isBusy = false;
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     Tab 5: 关于页面编辑
     ------------------------------------------------------------------------ */
  function renderAboutTab(box, rootContainer) {
    const ab = window.SITE_DATA.about || { heading: '关于这里', paragraphs: [], interests: [] };

    box.innerHTML = `
      <form class="admin-card liquid-glass" id="form-about" style="max-width:820px;">
        <h3>编辑「关于」页面</h3>

        <label class="admin-label">
          <span>页面小标题</span>
          <input class="glass-input" id="a-heading" value="${escapeHtml(ab.heading || '关于这里')}" />
        </label>

        <label class="admin-label">
          <span>个人与空间介绍（每一段之间用换行分隔）</span>
          <textarea class="glass-textarea" id="a-paragraphs" style="min-height:180px;" placeholder="写下关于你自己、兴趣爱好或建立这个网站的初衷...">${escapeHtml((ab.paragraphs || []).join('\n\n'))}</textarea>
        </label>

        <label class="admin-label">
          <span>兴趣标签（用逗号分隔）</span>
          <input class="glass-input" id="a-interests" value="${escapeHtml((ab.interests || []).join(', '))}" placeholder="例如：摄影, 音乐, 旅行, 机器人" />
        </label>

        <button type="submit" class="btn btn-primary btn-sm" id="btn-save-about">保存并发布到线上</button>
      </form>
    `;

    document.getElementById('form-about').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isBusy) return;
      isBusy = true;
      const btn = document.getElementById('btn-save-about');
      btn.disabled = true;
      btn.textContent = '正在发布...';
      setStatus('正在同步到 GitHub...');

      try {
        window.SITE_DATA.about = {
          heading: document.getElementById('a-heading').value.trim() || '关于这里',
          paragraphs: document
            .getElementById('a-paragraphs')
            .value.split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
          interests: document
            .getElementById('a-interests')
            .value.split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        };
        await commitSiteData('update about page');
        renderWorkspace(rootContainer);
      } catch (err) {
        toast(`发布失败：${err.message}`);
      } finally {
        isBusy = false;
      }
    });
  }

  window.ADMIN_PANEL = { render };
})();
