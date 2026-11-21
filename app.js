/**
 * 个人展示空间核心渲染脚本
 * 目录：首页(#home) / 博客(#blog) / 随笔(#essays) / 画廊(#gallery) / 留言(#guestbook) / 关于(#about)
 */
(function () {
  const data = window.SITE_DATA;
  const appMain = document.getElementById('app-main');
  const modal = document.getElementById('reader-modal');
  const modalBody = document.getElementById('modal-body');
  const modalMetaBar = document.getElementById('modal-meta-bar');
  const lightbox = document.getElementById('lightbox');
  const toastEl = document.getElementById('toast');

  const GUESTBOOK_STORAGE_KEY = 'obsidian-space-guestbook-v1';
  const PENDING_DATA_KEY = 'obsidian-site-data-pending-v1';
  const VISITOR_ID_KEY = 'obsidian-visitor-id-v1';
  const VISITOR_NICK_KEY = 'obsidian-visitor-nick-v1';
  const LOCAL_LIKES_KEY = 'obsidian-local-likes-v1';
  const LOCAL_COMMENTS_KEY = 'obsidian-local-comments-v1';

  let currentRoute = 'home';
  let activeBlogTag = '全部';
  let blogQuery = '';
  let activeEssayCat = '全部';
  let activeGalleryCat = '全部';
  let lightboxList = [];
  let lightboxIndex = 0;

  let canvasRaf = null;
  let canvasCleanup = null;
  let typewriterTimer = null;

  let supabaseSdkPromise = null;
  let supabaseClient = null;
  let remoteGuestbookCache = null;
  let guestbookChannel = null;
  let guestbookPollTimer = null;
  let lastGuestbookSubmitAt = 0;
  let lastCommentSubmitAt = 0;
  const recentSelfSubmittedIds = new Set();

  const interactionsState = {
    loaded: false,
    loadingPromise: null,
    likeCounts: Object.create(null),
    likedKeys: new Set(),
    commentsByKey: Object.create(null),
  };
  const openEssayCommentKeys = new Set();

  /* ========================================================================
     1. 工具函数
     ======================================================================== */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function estimateReadMins(text) {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, '').length / 320));
  }

  function renderMarkdown(md) {
    const lines = md.trim().split('\n');
    let html = '';
    let inCode = false;
    let codeBuf = [];
    let inList = false;
    let listTag = 'ul';

    const closeList = () => {
      if (inList) {
        html += `</${listTag}>`;
        inList = false;
      }
    };

    const inline = (s) =>
      escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent-champagne);text-decoration:underline;">$1</a>'
        );

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.trim().startsWith('```')) {
        closeList();
        if (!inCode) {
          inCode = true;
          codeBuf = [];
        } else {
          html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
          inCode = false;
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(raw);
        continue;
      }
      if (!line.trim()) {
        closeList();
        continue;
      }
      if (line.startsWith('### ')) {
        closeList();
        html += `<h3>${inline(line.slice(4))}</h3>`;
      } else if (line.startsWith('## ')) {
        closeList();
        html += `<h2>${inline(line.slice(3))}</h2>`;
      } else if (line.startsWith('# ')) {
        closeList();
        html += `<h1>${inline(line.slice(2))}</h1>`;
      } else if (line.startsWith('> ')) {
        closeList();
        html += `<blockquote>${inline(line.slice(2))}</blockquote>`;
      } else if (/^[-*] /.test(line.trim())) {
        if (!inList || listTag !== 'ul') {
          closeList();
          listTag = 'ul';
          inList = true;
          html += '<ul>';
        }
        html += `<li>${inline(line.trim().slice(2))}</li>`;
      } else if (/^\d+\. /.test(line.trim())) {
        if (!inList || listTag !== 'ol') {
          closeList();
          listTag = 'ol';
          inList = true;
          html += '<ol>';
        }
        html += `<li>${inline(line.trim().replace(/^\d+\.\s+/, ''))}</li>`;
      } else {
        closeList();
        html += `<p>${inline(line)}</p>`;
      }
    }
    closeList();
    return html;
  }

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2300);
  }

  function getSupabaseConfig() {
    const cfg = window.SUPABASE_CONFIG;
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.anonKey !== 'string') return null;
    const url = cfg.url.trim().replace(/\/+$/, '');
    const anonKey = cfg.anonKey.trim();
    if (!url || !anonKey) return null;
    return {
      url,
      anonKey,
      table: (cfg.table || 'guestbook').trim() || 'guestbook',
    };
  }

  function formatGuestbookTime(val) {
    if (!val) return '';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function normalizeRemoteRow(row) {
    return {
      id: row.id,
      author: row.author || '匿名访客',
      text: row.text || '',
      time: formatGuestbookTime(row.created_at || row.time),
    };
  }

  function loadSupabaseSdk() {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      return Promise.resolve(window.supabase);
    }
    if (supabaseSdkPromise) return supabaseSdkPromise;
    supabaseSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/supabase.min.js?v=20261125';
      script.async = true;
      script.onload = () => {
        if (window.supabase && typeof window.supabase.createClient === 'function') {
          resolve(window.supabase);
        } else {
          supabaseSdkPromise = null;
          reject(new Error('实时推送组件初始化异常'));
        }
      };
      script.onerror = () => {
        supabaseSdkPromise = null;
        reject(new Error('实时推送组件加载失败'));
      };
      document.head.appendChild(script);
    });
    return supabaseSdkPromise;
  }

  async function getSupabaseClient() {
    const cfg = getSupabaseConfig();
    if (!cfg) return null;
    if (supabaseClient) return supabaseClient;
    const sdk = await loadSupabaseSdk();
    supabaseClient = sdk.createClient(cfg.url, cfg.anonKey);
    return supabaseClient;
  }

  function unsubscribeGuestbookRealtime() {
    if (guestbookPollTimer) {
      clearInterval(guestbookPollTimer);
      guestbookPollTimer = null;
    }
    if (guestbookChannel && supabaseClient) {
      try {
        supabaseClient.removeChannel(guestbookChannel);
      } catch {}
    }
    guestbookChannel = null;
  }

  async function fetchRemoteGuestbook() {
    const cfg = getSupabaseConfig();
    if (!cfg) return null;
    const endpoint = `${cfg.url}/rest/v1/${encodeURIComponent(cfg.table)}?select=id,author,text,created_at&order=created_at.desc&limit=100`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `云端读取失败 (${res.status})`);
    }
    const rows = await res.json();
    remoteGuestbookCache = (Array.isArray(rows) ? rows : []).map(normalizeRemoteRow);
    return remoteGuestbookCache;
  }

  async function insertRemoteGuestbook(author, text) {
    const cfg = getSupabaseConfig();
    if (!cfg) throw new Error('未配置云端留言板');
    const endpoint = `${cfg.url}/rest/v1/${encodeURIComponent(cfg.table)}?select=id,author,text,created_at`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ author, text }),
    });
    if (!res.ok) {
      let msg = `提交失败 (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.message) msg = body.message;
      } catch {}
      throw new Error(msg);
    }
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? rows[0] : { author, text, created_at: new Date().toISOString() };
  }

  function loadGuestbookMessages() {
    if (Array.isArray(remoteGuestbookCache)) {
      return [...remoteGuestbookCache, ...(data.guestbook || [])];
    }
    let localItems = [];
    try {
      const raw = localStorage.getItem(GUESTBOOK_STORAGE_KEY);
      if (raw) localItems = JSON.parse(raw);
    } catch {
      localItems = [];
    }
    return [...localItems, ...(data.guestbook || [])];
  }

  function saveGuestbookMessage(entry) {
    try {
      const raw = localStorage.getItem(GUESTBOOK_STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(entry);
      localStorage.setItem(GUESTBOOK_STORAGE_KEY, JSON.stringify(list));
    } catch {
      data.guestbook.unshift(entry);
    }
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getVisitorId() {
    try {
      let id = localStorage.getItem(VISITOR_ID_KEY);
      if (!id || id.length < 6) {
        id = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(VISITOR_ID_KEY, id);
      }
      return id;
    } catch {
      return `v-mem-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function getSavedNick() {
    try {
      return localStorage.getItem(VISITOR_NICK_KEY) || '';
    } catch {
      return '';
    }
  }

  function saveNick(name) {
    try {
      if (name) localStorage.setItem(VISITOR_NICK_KEY, name);
    } catch {}
  }

  function itemKey(type, id) {
    return `${type}:${id}`;
  }

  function getLikeCount(type, id) {
    return interactionsState.likeCounts[itemKey(type, id)] || 0;
  }

  function isItemLiked(type, id) {
    return interactionsState.likedKeys.has(itemKey(type, id));
  }

  function getItemComments(type, id) {
    return interactionsState.commentsByKey[itemKey(type, id)] || [];
  }

  function loadLocalInteractionsFallback() {
    try {
      const likes = JSON.parse(localStorage.getItem(LOCAL_LIKES_KEY) || '[]');
      likes.forEach((k) => {
        interactionsState.likedKeys.add(k);
        interactionsState.likeCounts[k] = Math.max(1, interactionsState.likeCounts[k] || 0);
      });
    } catch {}
    try {
      const comments = JSON.parse(localStorage.getItem(LOCAL_COMMENTS_KEY) || '{}');
      Object.keys(comments).forEach((k) => {
        interactionsState.commentsByKey[k] = comments[k];
      });
    } catch {}
  }

  async function ensureInteractionsLoaded(force) {
    const cfg = getSupabaseConfig();
    if (!cfg) {
      if (!interactionsState.loaded) {
        loadLocalInteractionsFallback();
        interactionsState.loaded = true;
      }
      return;
    }
    if (interactionsState.loaded && !force) return;
    if (interactionsState.loadingPromise && !force) return interactionsState.loadingPromise;

    const visitorId = getVisitorId();
    const headers = {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      Accept: 'application/json',
    };

    interactionsState.loadingPromise = (async () => {
      try {
        const [likesRes, commentsRes] = await Promise.all([
          fetch(`${cfg.url}/rest/v1/item_likes?select=item_type,item_id,visitor_id&limit=2000`, {
            headers,
            cache: 'no-store',
          }),
          fetch(
            `${cfg.url}/rest/v1/item_comments?select=id,item_type,item_id,item_title,author,text,created_at&order=created_at.desc&limit=500`,
            { headers, cache: 'no-store' }
          ),
        ]);

        if (likesRes.ok) {
          const rows = await likesRes.json();
          const counts = Object.create(null);
          const liked = new Set();
          (Array.isArray(rows) ? rows : []).forEach((r) => {
            const k = itemKey(r.item_type, r.item_id);
            counts[k] = (counts[k] || 0) + 1;
            if (r.visitor_id === visitorId) liked.add(k);
          });
          interactionsState.likeCounts = counts;
          interactionsState.likedKeys = liked;
        }

        if (commentsRes.ok) {
          const rows = await commentsRes.json();
          const byKey = Object.create(null);
          (Array.isArray(rows) ? rows : []).forEach((r) => {
            const k = itemKey(r.item_type, r.item_id);
            if (!byKey[k]) byKey[k] = [];
            byKey[k].push({
              id: r.id,
              author: r.author || '匿名访客',
              text: r.text || '',
              time: formatGuestbookTime(r.created_at),
            });
          });
          interactionsState.commentsByKey = byKey;
        }

        interactionsState.loaded = true;
        syncInteractionDOM();
      } catch {
        // 建表尚未执行或网络波动时静默降级，不影响主站展示
      } finally {
        interactionsState.loadingPromise = null;
      }
    })();

    return interactionsState.loadingPromise;
  }

  function syncInteractionDOM() {
    document.querySelectorAll('[data-like-btn]').forEach((btn) => {
      const k = btn.getAttribute('data-like-btn');
      const count = interactionsState.likeCounts[k] || 0;
      const liked = interactionsState.likedKeys.has(k);
      btn.classList.toggle('is-liked', liked);
      const numEl = btn.querySelector('.interact-num');
      if (numEl) numEl.textContent = String(count);
      const lblEl = btn.querySelector('.interact-like-label');
      if (lblEl) lblEl.textContent = liked ? '已赞' : '点赞';
    });

    document.querySelectorAll('[data-comment-count]').forEach((el) => {
      const k = el.getAttribute('data-comment-count');
      const list = interactionsState.commentsByKey[k] || [];
      el.textContent = String(list.length);
    });
  }

  async function toggleItemLike(type, id, title) {
    const k = itemKey(type, id);
    const prevLiked = interactionsState.likedKeys.has(k);
    const prevCount = interactionsState.likeCounts[k] || 0;

    // 乐观更新 UI，即时反馈
    if (prevLiked) {
      interactionsState.likedKeys.delete(k);
      interactionsState.likeCounts[k] = Math.max(0, prevCount - 1);
    } else {
      interactionsState.likedKeys.add(k);
      interactionsState.likeCounts[k] = prevCount + 1;
    }
    syncInteractionDOM();

    const cfg = getSupabaseConfig();
    if (!cfg) {
      try {
        localStorage.setItem(LOCAL_LIKES_KEY, JSON.stringify([...interactionsState.likedKeys]));
      } catch {}
      showToast(prevLiked ? '已取消点赞' : '感谢点赞');
      return;
    }

    try {
      const res = await fetch(`${cfg.url}/rest/v1/rpc/toggle_item_like`, {
        method: 'POST',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_type: type,
          p_id: String(id),
          p_visitor: getVisitorId(),
          p_title: String(title || '').slice(0, 120),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result && typeof result.count === 'number') {
        interactionsState.likeCounts[k] = result.count;
        if (result.liked) interactionsState.likedKeys.add(k);
        else interactionsState.likedKeys.delete(k);
        syncInteractionDOM();
      }
      showToast(result && result.liked ? '感谢点赞' : '已取消点赞');
    } catch {
      // 网络失败回滚
      if (prevLiked) interactionsState.likedKeys.add(k);
      else interactionsState.likedKeys.delete(k);
      interactionsState.likeCounts[k] = prevCount;
      syncInteractionDOM();
      showToast('点赞失败，请稍后重试');
    }
  }

  async function submitItemComment(type, id, title, author, text) {
    const nowMs = Date.now();
    if (nowMs - lastCommentSubmitAt < 5000) {
      throw new Error('发送太快啦，请 5 秒后再试');
    }

    saveNick(author);
    const k = itemKey(type, id);
    const cfg = getSupabaseConfig();

    if (!cfg) {
      const localMsg = {
        id: `local-${Date.now()}`,
        author,
        text,
        time: formatGuestbookTime(new Date().toISOString()),
      };
      if (!interactionsState.commentsByKey[k]) interactionsState.commentsByKey[k] = [];
      interactionsState.commentsByKey[k].unshift(localMsg);
      try {
        localStorage.setItem(LOCAL_COMMENTS_KEY, JSON.stringify(interactionsState.commentsByKey));
      } catch {}
      lastCommentSubmitAt = Date.now();
      syncInteractionDOM();
      return localMsg;
    }

    const res = await fetch(
      `${cfg.url}/rest/v1/item_comments?select=id,item_type,item_id,item_title,author,text,created_at`,
      {
        method: 'POST',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          item_type: type,
          item_id: String(id),
          item_title: String(title || '').slice(0, 120),
          author,
          text,
        }),
      }
    );

    if (!res.ok) {
      let errMsg = `提交失败 (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.message) errMsg = body.message;
      } catch {}
      throw new Error(errMsg);
    }

    const rows = await res.json().catch(() => []);
    const raw = Array.isArray(rows) && rows.length ? rows[0] : { author, text, created_at: new Date().toISOString() };
    const saved = {
      id: raw.id,
      author: raw.author || author,
      text: raw.text || text,
      time: formatGuestbookTime(raw.created_at),
    };
    if (!interactionsState.commentsByKey[k]) interactionsState.commentsByKey[k] = [];
    interactionsState.commentsByKey[k].unshift(saved);
    lastCommentSubmitAt = Date.now();
    syncInteractionDOM();
    return saved;
  }

  function heartSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"></path></svg>`;
  }

  function commentSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  }

  function interactionBarHTML(type, id, title, opts) {
    const k = itemKey(type, id);
    const liked = isItemLiked(type, id);
    const lCount = getLikeCount(type, id);
    const cCount = getItemComments(type, id).length;
    const inlineMode = opts && opts.inline ? ' data-comment-inline="1"' : '';
    const showLabel = opts && opts.showLikeLabel;
    return `
      <div class="interact-bar">
        <button
          type="button"
          class="interact-btn interact-like${liked ? ' is-liked' : ''}"
          data-like-btn="${escapeAttr(k)}"
          data-itype="${escapeAttr(type)}"
          data-iid="${escapeAttr(id)}"
          data-ititle="${escapeAttr(title || '')}"
          aria-label="点赞"
        >
          ${heartSvg()}
          ${showLabel ? `<span class="interact-like-label">${liked ? '已赞' : '点赞'}</span>` : ''}
          <span class="interact-num">${lCount}</span>
        </button>
        <button
          type="button"
          class="interact-btn interact-comment"
          data-comment-btn="${escapeAttr(k)}"
          data-itype="${escapeAttr(type)}"
          data-iid="${escapeAttr(id)}"
          data-ititle="${escapeAttr(title || '')}"${inlineMode}
          aria-label="评论"
        >
          ${commentSvg()}
          <span class="interact-num" data-comment-count="${escapeAttr(k)}">${cCount}</span>
        </button>
      </div>
    `;
  }

  function commentListHTML(type, id) {
    const list = getItemComments(type, id);
    if (!list.length) {
      return `<div class="comment-empty">还没有评论，快来写下第一条看法吧。</div>`;
    }
    return list
      .map(
        (c) => `
        <div class="comment-item">
          <div class="comment-item-head">
            <span class="comment-author">${escapeHtml(c.author)}</span>
            <span class="comment-time">${escapeHtml(c.time)}</span>
          </div>
          <p class="comment-text">${escapeHtml(c.text)}</p>
        </div>
      `
      )
      .join('');
  }

  function commentBoxHTML(type, id, title) {
    const k = itemKey(type, id);
    const savedNick = getSavedNick();
    return `
      <form class="comment-form" data-comment-form="${escapeAttr(k)}" data-itype="${escapeAttr(type)}" data-iid="${escapeAttr(id)}" data-ititle="${escapeAttr(title || '')}">
        <textarea class="glass-textarea" name="text" placeholder="写下你的评论..." maxlength="500" required></textarea>
        <div class="comment-form-row">
          <input class="glass-input" name="author" type="text" placeholder="你的昵称" maxlength="32" value="${escapeAttr(savedNick)}" required />
          <button type="submit" class="btn btn-primary btn-sm">发布评论</button>
        </div>
      </form>
      <div class="comment-list" data-comment-list="${escapeAttr(k)}">
        ${commentListHTML(type, id)}
      </div>
    `;
  }

  function bindCommentForms(root) {
    (root || document).querySelectorAll('[data-comment-form]').forEach((form) => {
      if (form.dataset.bound) return;
      form.dataset.bound = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const type = form.getAttribute('data-itype');
        const id = form.getAttribute('data-iid');
        const title = form.getAttribute('data-ititle') || '';
        const k = itemKey(type, id);
        const authorInput = form.querySelector('input[name="author"]');
        const textInput = form.querySelector('textarea[name="text"]');
        const submitBtn = form.querySelector('button[type="submit"]');
        const author = authorInput.value.trim();
        const text = textInput.value.trim();
        if (!author || !text) return;

        submitBtn.disabled = true;
        submitBtn.textContent = '发布中...';
        try {
          await submitItemComment(type, id, title, author, text);
          textInput.value = '';
          document.querySelectorAll(`[data-comment-list="${CSS.escape(k)}"]`).forEach((listEl) => {
            listEl.innerHTML = commentListHTML(type, id);
          });
          showToast('评论已发布');
        } catch (err) {
          showToast(err && err.message ? err.message : '评论发布失败，请稍后重试');
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = '发布评论';
        }
      });
    });
  }

  function bindGlassGlint() {
    // 悬停高光已改由纯 CSS opacity GPU 合成层实现，鼠标移动零 JS 计算、零重绘
  }

  /* ========================================================================
     2. 初始化导航与页脚
     ======================================================================== */
  function refreshShell() {
    document.getElementById('nav-brand-name').textContent = data.profile.brandName;
    document.getElementById('footer-brand-name').textContent = data.profile.brandName;
    document.getElementById('footer-bio').textContent = data.profile.bio;
    document.getElementById('footer-copyright').textContent =
      `© ${new Date().getFullYear()} ${data.profile.brandName}`;

    const socialsEl = document.getElementById('footer-socials');
    if (data.profile.socials && data.profile.socials.length) {
      socialsEl.innerHTML = data.profile.socials
        .map(
          (s) =>
            `<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a></li>`
        )
        .join('');
    } else {
      socialsEl.innerHTML = `<li style="color:var(--text-muted);font-size:0.84rem;">暂未配置外链</li>`;
    }

    const emailBtn = document.getElementById('copy-email-btn');
    const emailText = document.getElementById('footer-email-text');
    const contactHint = document.getElementById('footer-contact-hint');
    if (data.profile.email) {
      emailBtn.style.display = 'inline-flex';
      emailText.textContent = data.profile.email;
      contactHint.textContent = '点击下方按钮可快速复制联系邮箱。';
    } else {
      emailBtn.style.display = 'none';
      contactHint.textContent = '可在网页管理后台中填写联系邮箱或外链。';
    }
  }

  function initShell() {
    refreshShell();

    const emailBtn = document.getElementById('copy-email-btn');
    emailBtn.addEventListener('click', async () => {
      if (!data.profile.email) return;
      try {
        await navigator.clipboard.writeText(data.profile.email);
        showToast(`已复制邮箱：${data.profile.email}`);
      } catch {
        showToast(`联系邮箱：${data.profile.email}`);
      }
    });

    document.getElementById('theme-toggle').addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      try {
        localStorage.setItem('obsidian-glass-theme', isDark ? 'dark' : 'light');
      } catch {}
      showToast(isDark ? '已切换至黑曜石暗黑玻璃' : '已切换至白银雾面浅色玻璃');
    });

    const mobileDrawer = document.getElementById('mobile-drawer');
    document.getElementById('mobile-menu-btn').addEventListener('click', () => {
      mobileDrawer.classList.toggle('open');
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox-prev').addEventListener('click', () => stepLightbox(-1));
    document.getElementById('lightbox-next').addEventListener('click', () => stepLightbox(1));
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if (lightbox.classList.contains('open')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') stepLightbox(-1);
        if (e.key === 'ArrowRight') stepLightbox(1);
      } else if (modal.classList.contains('open') && e.key === 'Escape') {
        closeModal();
      }
    });

    bindGlassGlint();
  }

  /* ========================================================================
     3. 卡片片段
     ======================================================================== */
  function blogCardHTML(post) {
    const mins = estimateReadMins(post.content || '');
    return `
      <article class="blog-card liquid-glass glass-interactive" data-open-post="${escapeAttr(post.id)}">
        <div>
          <div class="blog-meta">
            <span>${escapeHtml(post.date || '')}</span>
            <span>·</span>
            <span>约 ${mins} 分钟阅读</span>
          </div>
          <h3 class="blog-title">${escapeHtml(post.title)}</h3>
          <p class="blog-excerpt">${escapeHtml(post.excerpt || '')}</p>
        </div>
        <div class="blog-card-foot">
          <div class="chip-row">
            ${(post.tags || []).map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('')}
          </div>
          ${interactionBarHTML('blog', post.id, post.title)}
        </div>
      </article>
    `;
  }

  function essayCardHTML(essay, showPhoto) {
    const essayTitle = essay.mood || (essay.text || '').slice(0, 24) || '随笔';
    const k = itemKey('essay', essay.id);
    const isInlineOpen = showPhoto && openEssayCommentKeys.has(k);
    return `
      <article class="essay-card liquid-glass glass-interactive" data-essay-card="${escapeAttr(essay.id)}">
        <div class="essay-top">
          <span>${escapeHtml(essay.date || '')}</span>
          ${essay.mood ? `<span class="essay-mood">${escapeHtml(essay.mood)}</span>` : ''}
        </div>
        <p class="essay-text">${escapeHtml(essay.text || '')}</p>
        ${
          showPhoto && essay.image
            ? `<img class="essay-photo" src="${essay.image}" alt="${escapeHtml(essay.mood || '随笔配图')}" data-essay-img="${escapeAttr(essay.id)}" loading="lazy" />`
            : ''
        }
        <div class="essay-foot">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            ${essay.location ? `<span>${escapeHtml(essay.location)}</span>` : ''}
            ${essay.category ? `<span>#${escapeHtml(essay.category)}</span>` : ''}
          </div>
          ${interactionBarHTML('essay', essay.id, essayTitle, { inline: showPhoto })}
        </div>
        ${
          showPhoto
            ? `<div class="inline-comments" data-inline-comments="${escapeAttr(k)}" style="${isInlineOpen ? '' : 'display:none;'}">${
                isInlineOpen ? commentBoxHTML('essay', essay.id, essayTitle) : ''
              }</div>`
            : ''
        }
      </article>
    `;
  }

  function photoCardHTML(item, idx) {
    return `
      <figure class="photo-card liquid-glass glass-interactive" data-open-lightbox="${idx}">
        <div class="photo-frame">
          <img src="${item.src}" alt="${escapeHtml(item.title || '')}" loading="lazy" />
        </div>
        <figcaption class="photo-meta">
          <div class="photo-title">${escapeHtml(item.title || '')}</div>
          <div class="photo-sub">
            <span>${escapeHtml(item.location || '')}</span>
            <span>${escapeHtml(item.date || '')}</span>
          </div>
          <div class="photo-actions">
            ${interactionBarHTML('gallery', item.id, item.title || '画廊照片')}
          </div>
        </figcaption>
      </figure>
    `;
  }

  /* ========================================================================
     4. 开屏动效：双轨道点阵 + 打字机
     ======================================================================== */
  function stopHomeEffects() {
    if (canvasCleanup) {
      canvasCleanup();
      canvasCleanup = null;
    }
    if (canvasRaf) {
      cancelAnimationFrame(canvasRaf);
      canvasRaf = null;
    }
    if (typewriterTimer) {
      clearTimeout(typewriterTimer);
      typewriterTimer = null;
    }
  }

  function startHeroTypewriter(phrases) {
    const el = document.getElementById('hero-typewriter');
    if (!el || !phrases.length) return;
    let pIdx = 0;
    let cIdx = 0;
    let deleting = false;

    function step() {
      const text = phrases[pIdx];
      if (!deleting) {
        cIdx++;
        el.textContent = text.slice(0, cIdx);
        if (cIdx === text.length) {
          deleting = true;
          typewriterTimer = setTimeout(step, 1850);
          return;
        }
        typewriterTimer = setTimeout(step, 85);
      } else {
        cIdx--;
        el.textContent = text.slice(0, cIdx);
        if (cIdx === 0) {
          deleting = false;
          pIdx = (pIdx + 1) % phrases.length;
          typewriterTimer = setTimeout(step, 340);
          return;
        }
        typewriterTimer = setTimeout(step, 42);
      }
    }
    step();
  }

  function heroOrbitSVG() {
    return `
      <div class="hero-orbit-layer" aria-hidden="true">
        <svg class="hero-orbit-svg" viewBox="0 0 800 520" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g opacity="0.55">
            <circle cx="96" cy="84" r="1.4" fill="#d6be9b" />
            <circle cx="178" cy="142" r="1" fill="#f5f4f0" />
            <circle cx="264" cy="68" r="1.2" fill="#f5f4f0" />
            <circle cx="548" cy="76" r="1.5" fill="#d6be9b" />
            <circle cx="672" cy="126" r="1.1" fill="#f5f4f0" />
            <circle cx="718" cy="214" r="1.3" fill="#d6be9b" />
            <circle cx="122" cy="348" r="1.2" fill="#f5f4f0" />
            <circle cx="216" cy="436" r="1.5" fill="#d6be9b" />
            <circle cx="612" cy="422" r="1.2" fill="#f5f4f0" />
            <circle cx="696" cy="356" r="1.4" fill="#d6be9b" />
            <circle cx="430" cy="52" r="1" fill="#f5f4f0" />
            <circle cx="352" cy="468" r="1.1" fill="#d6be9b" />
          </g>
          <g class="hero-orbit-ring-1">
            <ellipse cx="400" cy="260" rx="250" ry="104" transform="rotate(11 400 260)" stroke="rgba(214, 190, 155, 0.14)" stroke-width="1" />
            <circle cx="645" cy="308" r="2.8" fill="rgba(214, 190, 155, 0.78)" />
          </g>
          <g class="hero-orbit-ring-2">
            <ellipse cx="400" cy="260" rx="335" ry="178" transform="rotate(-15 400 260)" stroke="rgba(214, 190, 155, 0.085)" stroke-width="1" />
            <circle cx="76" cy="346" r="2.6" fill="rgba(214, 190, 155, 0.62)" />
          </g>
        </svg>
      </div>
    `;
  }

  function startKineticCanvas() {
    // 开屏轨道已改由零主线程开销的纯矢量 SVG + GPU transform 合成，无需每帧重绘 Canvas
  }

  /* ========================================================================
     5. 六大页面：首页 / 博客 / 随笔 / 画廊 / 留言 / 关于
     ======================================================================== */
  function renderHome() {
    const p = data.profile;
    const gbCount = loadGuestbookMessages().length;
    lightboxList = data.gallery.slice(0, 4);

    const extraSections = [];

    if (data.posts.length) {
      extraSections.push(`
        <section class="section">
          <div class="container">
            <div class="section-header">
              <div>
                <div class="kicker">Blog</div>
                <h2 class="section-title">最新博客</h2>
              </div>
              <a href="#blog" class="section-link">查看全部 →</a>
            </div>
            <div class="blog-grid">${data.posts.slice(0, 4).map(blogCardHTML).join('')}</div>
          </div>
        </section>
      `);
    }

    if (data.essays.length) {
      extraSections.push(`
        <section class="section">
          <div class="container">
            <div class="section-header">
              <div>
                <div class="kicker">Essays</div>
                <h2 class="section-title">近期随笔</h2>
              </div>
              <a href="#essays" class="section-link">进入随笔 →</a>
            </div>
            <div class="essays-preview-grid">${data.essays.slice(0, 3).map((e) => essayCardHTML(e, false)).join('')}</div>
          </div>
        </section>
      `);
    }

    if (data.gallery.length) {
      extraSections.push(`
        <section class="section">
          <div class="container">
            <div class="section-header">
              <div>
                <div class="kicker">Gallery</div>
                <h2 class="section-title">画廊精选</h2>
              </div>
              <a href="#gallery" class="section-link">进入画廊 →</a>
            </div>
            <div class="gallery-strip">${lightboxList.map((item, idx) => photoCardHTML(item, idx)).join('')}</div>
          </div>
        </section>
      `);
    }

    appMain.innerHTML = `
      <!-- 第一屏：100vh 居中大气开屏 -->
      <section class="hero-stage">
        ${heroOrbitSVG()}

        <div class="hero-center">
          <span class="status-pill">
            <span class="led-dot"></span>
            ${escapeHtml(p.statusBadge)}
          </span>

          <h1 class="hero-display">
            ${escapeHtml(p.heroGreeting)}<br />
            <span class="metallic">${escapeHtml(p.heroName)}</span>
          </h1>

          <div class="hero-rotating">
            <span>${escapeHtml(p.heroPrefix)}</span>
            <span class="hero-rotating-highlight"><span id="hero-typewriter"></span><span class="cursor-bar"></span></span>
          </div>

          <p class="hero-subline">${escapeHtml(p.heroSubline)}</p>

          <div class="hero-actions">
            <a href="#blog" class="btn btn-primary">阅读博客 →</a>
            <a href="#gallery" class="btn btn-liquid">探索画廊</a>
            <a href="#guestbook" class="btn btn-liquid">给我留言</a>
          </div>
        </div>

        <a href="#spaces-anchor" class="scroll-cue" id="scroll-down-btn">
          <span>向下滚动</span>
          <span class="scroll-line"></span>
        </a>
      </section>

      <!-- 第二屏：流体透明毛玻璃空间导航入口 -->
      <section class="section" id="spaces-anchor">
        <div class="container">
          <div class="section-header">
            <div>
              <div class="kicker">Directory</div>
              <h2 class="section-title">探索空间</h2>
            </div>
          </div>

          <div class="bento-strip">
            <a href="#blog" class="bento-tile liquid-glass glass-interactive">
              <div class="kicker">01 · Blog</div>
              <div class="bento-tile-title">博客</div>
              <p>沉淀思考、技术笔记与深度长文。</p>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="chip">${data.posts.length} 篇文章</span>
                <span style="color:var(--accent-champagne);font-size:0.84rem;">进入 →</span>
              </div>
            </a>

            <a href="#essays" class="bento-tile liquid-glass glass-interactive">
              <div class="kicker">02 · Essays</div>
              <div class="bento-tile-title">随笔</div>
              <p>记录日常片段、灵感与心情。</p>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="chip">${data.essays.length} 条随笔</span>
                <span style="color:var(--accent-champagne);font-size:0.84rem;">进入 →</span>
              </div>
            </a>

            <a href="#gallery" class="bento-tile liquid-glass glass-interactive">
              <div class="kicker">03 · Gallery</div>
              <div class="bento-tile-title">画廊</div>
              <p>用光影定格风景与生活切片。</p>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="chip">${data.gallery.length} 张照片</span>
                <span style="color:var(--accent-champagne);font-size:0.84rem;">进入 →</span>
              </div>
            </a>
          </div>

          <div class="blog-grid" style="margin-top:20px;">
            <a href="#guestbook" class="bento-tile liquid-glass glass-interactive">
              <div class="kicker">04 · Guestbook</div>
              <div class="bento-tile-title">留言</div>
              <p>路过留下一句话，分享想法或打个招呼。</p>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="chip" id="home-gb-count">${gbCount} 条留言</span>
                <span style="color:var(--accent-champagne);font-size:0.84rem;">去留言 →</span>
              </div>
            </a>

            <a href="#about" class="bento-tile liquid-glass glass-interactive">
              <div class="kicker">05 · About</div>
              <div class="bento-tile-title">关于</div>
              <p>了解这个个人空间的缘起与主人介绍。</p>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="chip">About Me</span>
                <span style="color:var(--accent-champagne);font-size:0.84rem;">查看 →</span>
              </div>
            </a>
          </div>
        </div>
      </section>

      ${extraSections.join('')}
    `;

    const scrollBtn = document.getElementById('scroll-down-btn');
    if (scrollBtn) {
      scrollBtn.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('spaces-anchor')?.scrollIntoView({ behavior: 'smooth' });
      });
    }

    startKineticCanvas();
    startHeroTypewriter(p.heroPhrases);
    bindContentTriggers();
    bindGlassGlint();

    if (getSupabaseConfig() && remoteGuestbookCache === null) {
      fetchRemoteGuestbook()
        .then((rows) => {
          const el = document.getElementById('home-gb-count');
          if (el && rows) el.textContent = `${rows.length + (data.guestbook || []).length} 条留言`;
        })
        .catch(() => {});
    }
  }

  function renderBlogPage() {
    if (!data.posts.length) {
      appMain.innerHTML = `
        <section class="page-hero">
          <div class="container">
            <div class="page-hero-card liquid-glass">
              <div>
                <div class="kicker">Blog</div>
                <h1>博客</h1>
                <p>沉淀思考、记录探索与深度长文。</p>
              </div>
              <span class="chip">0 篇文章</span>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="container">
            <div class="empty-state-box liquid-glass">
              <h3>暂未发布文章</h3>
              <p>点击下方进入网页管理后台，无需代码即可直接编写与发布博客文章。</p>
              <a href="#admin" class="btn btn-liquid btn-sm">前往管理后台写文章 →</a>
            </div>
          </div>
        </section>
      `;
      bindGlassGlint();
      return;
    }

    const tags = ['全部', ...new Set(data.posts.flatMap((p) => p.tags || []))];
    const q = blogQuery.trim().toLowerCase();
    const filtered = data.posts.filter((post) => {
      const okTag = activeBlogTag === '全部' || (post.tags || []).includes(activeBlogTag);
      const okQ =
        !q ||
        post.title.toLowerCase().includes(q) ||
        (post.excerpt || '').toLowerCase().includes(q) ||
        (post.content || '').toLowerCase().includes(q);
      return okTag && okQ;
    });

    appMain.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Blog</div>
              <h1>博客</h1>
              <p>记录探索与思考。</p>
            </div>
            <span class="chip">共 ${filtered.length} 篇文章</span>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="toolbar">
            <div class="filter-group">
              ${tags
                .map(
                  (t) =>
                    `<button class="filter-pill ${t === activeBlogTag ? 'active' : ''}" data-btag="${escapeHtml(t)}">${escapeHtml(t)}</button>`
                )
                .join('')}
            </div>
            <input type="search" class="search-box" id="blog-search" placeholder="搜索文章或关键词..." value="${escapeHtml(blogQuery)}" />
          </div>
          ${
            filtered.length
              ? `<div class="blog-grid">${filtered.map(blogCardHTML).join('')}</div>`
              : `<div class="empty-state liquid-glass">没有找到匹配的文章。</div>`
          }
        </div>
      </section>
    `;

    document.querySelectorAll('[data-btag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeBlogTag = btn.getAttribute('data-btag');
        renderBlogPage();
      });
    });

    const input = document.getElementById('blog-search');
    input.addEventListener('input', (e) => {
      blogQuery = e.target.value;
      const pos = input.selectionStart;
      renderBlogPage();
      const el = document.getElementById('blog-search');
      el.focus();
      el.setSelectionRange(pos, pos);
    });

    bindContentTriggers();
    bindGlassGlint();
  }

  function renderEssaysPage() {
    if (!data.essays.length) {
      appMain.innerHTML = `
        <section class="page-hero">
          <div class="container">
            <div class="page-hero-card liquid-glass">
              <div>
                <div class="kicker">Essays</div>
                <h1>随笔</h1>
                <p>自由记录日常片段、心情与灵感。</p>
              </div>
              <span class="chip">0 条随笔</span>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="container">
            <div class="empty-state-box liquid-glass">
              <h3>暂未发布随笔</h3>
              <p>点击下方进入网页管理后台，像发朋友圈一样写随笔并上传配图。</p>
              <a href="#admin" class="btn btn-liquid btn-sm">前往管理后台发随笔 →</a>
            </div>
          </div>
        </section>
      `;
      bindGlassGlint();
      return;
    }

    const cats = ['全部', ...new Set(data.essays.map((e) => e.category || '随笔'))];
    const filtered =
      activeEssayCat === '全部'
        ? data.essays
        : data.essays.filter((e) => (e.category || '随笔') === activeEssayCat);

    lightboxList = filtered
      .filter((e) => e.image)
      .map((e) => ({
        id: e.id,
        itemType: 'essay',
        title: e.mood || (e.text || '').slice(0, 24) || '随笔配图',
        location: e.location || '',
        date: e.date || '',
        camera: e.category || '',
        src: e.image,
      }));

    appMain.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Essays</div>
              <h1>随笔</h1>
              <p>记录日常碎片与想法。</p>
            </div>
            <span class="chip">共 ${filtered.length} 条随笔</span>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="toolbar">
            <div class="filter-group">
              ${cats
                .map(
                  (c) =>
                    `<button class="filter-pill ${c === activeEssayCat ? 'active' : ''}" data-ecat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
                )
                .join('')}
            </div>
          </div>
          <div class="essays-feed">${filtered.map((e) => essayCardHTML(e, true)).join('')}</div>
        </div>
      </section>
    `;

    document.querySelectorAll('[data-ecat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeEssayCat = btn.getAttribute('data-ecat');
        renderEssaysPage();
      });
    });

    document.querySelectorAll('[data-essay-img]').forEach((img) => {
      img.addEventListener('click', () => {
        const id = img.getAttribute('data-essay-img');
        const idx = lightboxList.findIndex((x) => x.id === id);
        if (idx >= 0) openLightbox(idx);
      });
    });

    bindContentTriggers();
    bindCommentForms(appMain);
    bindGlassGlint();
  }

  function renderGalleryPage() {
    if (!data.gallery.length) {
      appMain.innerHTML = `
        <section class="page-hero">
          <div class="container">
            <div class="page-hero-card liquid-glass">
              <div>
                <div class="kicker">Gallery</div>
                <h1>画廊</h1>
                <p>收藏旅途风景、生活照片与值得记住的光影。</p>
              </div>
              <span class="chip">0 张照片</span>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="container">
            <div class="empty-state-box liquid-glass">
              <h3>暂未上传照片</h3>
              <p>点击下方进入网页管理后台，直接从电脑或手机选图上传到画廊。</p>
              <a href="#admin" class="btn btn-liquid btn-sm">前往管理后台传照片 →</a>
            </div>
          </div>
        </section>
      `;
      bindGlassGlint();
      return;
    }

    const cats = ['全部', ...new Set(data.gallery.map((g) => g.category || '照片'))];
    const filtered =
      activeGalleryCat === '全部'
        ? data.gallery
        : data.gallery.filter((g) => (g.category || '照片') === activeGalleryCat);
    lightboxList = filtered;

    appMain.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Gallery</div>
              <h1>画廊</h1>
              <p>点击任意照片全屏欣赏，支持键盘左右切换。</p>
            </div>
            <span class="chip">共 ${filtered.length} 张照片</span>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="toolbar">
            <div class="filter-group">
              ${cats
                .map(
                  (c) =>
                    `<button class="filter-pill ${c === activeGalleryCat ? 'active' : ''}" data-gcat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
                )
                .join('')}
            </div>
          </div>
          <div class="gallery-grid">${filtered.map((item, idx) => photoCardHTML(item, idx)).join('')}</div>
        </div>
      </section>
    `;

    document.querySelectorAll('[data-gcat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeGalleryCat = btn.getAttribute('data-gcat');
        renderGalleryPage();
      });
    });

    bindContentTriggers();
    bindGlassGlint();
  }

  function guestbookItemHTML(m, isNew) {
    return `
      <article class="guestbook-item liquid-glass${isNew ? ' is-new' : ''}"${m.id != null ? ` data-gb-id="${escapeHtml(m.id)}"` : ''}>
        <div class="guestbook-item-head">
          <span class="guestbook-author">${escapeHtml(m.author)}</span>
          <span class="guestbook-time">${escapeHtml(m.time)}</span>
        </div>
        <p class="guestbook-msg">${escapeHtml(m.text)}</p>
      </article>
    `;
  }

  function guestbookEmptyHTML(text) {
    return `
      <div class="empty-state-box liquid-glass" style="max-width:none;margin:0;">
        <h3>还没有留言</h3>
        <p style="margin-bottom:0;">${escapeHtml(text || '在左侧写下第一条留言试试看吧。')}</p>
      </div>
    `;
  }

  function renderGuestbookPage() {
    unsubscribeGuestbookRealtime();
    const sbCfg = getSupabaseConfig();
    const initialMessages = sbCfg
      ? Array.isArray(remoteGuestbookCache)
        ? [...remoteGuestbookCache, ...(data.guestbook || [])]
        : []
      : loadGuestbookMessages();

    appMain.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">Guestbook</div>
              <h1>留言</h1>
              <p>欢迎在这里留下足迹、想法或一句问候。</p>
            </div>
            <span class="chip" id="gb-count-chip">${
              sbCfg && !Array.isArray(remoteGuestbookCache) ? '正在同步留言...' : `共 ${initialMessages.length} 条留言`
            }</span>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container guestbook-layout">
          <form class="guestbook-form liquid-glass" id="guestbook-form">
            <h3>写下你的留言</h3>
            <input class="glass-input" id="gb-name" type="text" placeholder="你的昵称" maxlength="32" value="${escapeAttr(getSavedNick())}" required />
            <textarea class="glass-textarea" id="gb-text" placeholder="说点什么吧..." maxlength="500" required></textarea>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span class="guestbook-status" id="gb-status">
                <span class="guestbook-status-dot"></span>
                <span id="gb-status-text">${
                  sbCfg
                    ? '正在连接全网实时留言板...'
                    : '本地预览模式 · 在 supabase-config.js 填入配置即可开启全网实时同步'
                }</span>
              </span>
              <button type="submit" class="btn btn-primary btn-sm" id="gb-submit-btn">发布留言</button>
            </div>
          </form>

          <div class="guestbook-list" id="guestbook-list">
            ${
              sbCfg && !Array.isArray(remoteGuestbookCache)
                ? `<div class="empty-state-box liquid-glass" style="max-width:none;margin:0;"><h3>正在加载留言...</h3><p style="margin-bottom:0;">正在从云端同步最新留言。</p></div>`
                : initialMessages.length
                  ? initialMessages.map((m) => guestbookItemHTML(m, false)).join('')
                  : guestbookEmptyHTML()
            }
          </div>
        </div>
      </section>
    `;

    const listEl = document.getElementById('guestbook-list');
    const countChip = document.getElementById('gb-count-chip');
    const statusEl = document.getElementById('gb-status');
    const statusTextEl = document.getElementById('gb-status-text');
    const submitBtn = document.getElementById('gb-submit-btn');

    function updateListView(messages) {
      if (!listEl || currentRoute !== 'guestbook') return;
      if (countChip) countChip.textContent = `共 ${messages.length} 条留言`;
      listEl.innerHTML = messages.length
        ? messages.map((m) => guestbookItemHTML(m, false)).join('')
        : guestbookEmptyHTML();
    }

    function prependLiveMessage(msg) {
      if (!listEl || currentRoute !== 'guestbook') return;
      if (!Array.isArray(remoteGuestbookCache)) remoteGuestbookCache = [];
      if (msg.id != null && remoteGuestbookCache.some((x) => String(x.id) === String(msg.id))) {
        return;
      }
      remoteGuestbookCache.unshift(msg);
      const total = remoteGuestbookCache.length + (data.guestbook || []).length;
      if (countChip) countChip.textContent = `共 ${total} 条留言`;
      const emptyBox = listEl.querySelector('.empty-state-box');
      if (emptyBox) listEl.innerHTML = '';
      listEl.insertAdjacentHTML('afterbegin', guestbookItemHTML(msg, true));
    }

    function removeLiveMessage(id) {
      if (!listEl || currentRoute !== 'guestbook' || id == null) return;
      if (Array.isArray(remoteGuestbookCache)) {
        remoteGuestbookCache = remoteGuestbookCache.filter((x) => String(x.id) !== String(id));
      }
      const card = listEl.querySelector(`[data-gb-id="${CSS.escape(String(id))}"]`);
      if (card) card.remove();
      const total = (remoteGuestbookCache ? remoteGuestbookCache.length : 0) + (data.guestbook || []).length;
      if (countChip) countChip.textContent = `共 ${total} 条留言`;
      if (total === 0) listEl.innerHTML = guestbookEmptyHTML();
    }

    function startFallbackPolling() {
      if (guestbookPollTimer || currentRoute !== 'guestbook') return;
      if (statusEl) statusEl.classList.add('is-live');
      if (statusTextEl) statusTextEl.textContent = '已连接云端 · 自动同步最新留言';
      guestbookPollTimer = setInterval(async () => {
        if (currentRoute !== 'guestbook' || document.hidden) return;
        try {
          const prevIds = new Set((remoteGuestbookCache || []).map((x) => String(x.id)));
          const rows = await fetchRemoteGuestbook();
          if (currentRoute !== 'guestbook' || !rows) return;
          updateListView([...rows, ...(data.guestbook || [])]);
          const newest = rows.find((r) => !prevIds.has(String(r.id)) && !recentSelfSubmittedIds.has(String(r.id)));
          if (newest) showToast(`收到来自 ${newest.author} 的新留言`);
        } catch {}
      }, 10000);
    }

    if (sbCfg) {
      (async () => {
        try {
          const rows = await fetchRemoteGuestbook();
          if (currentRoute !== 'guestbook') return;
          updateListView([...rows, ...(data.guestbook || [])]);
          if (statusEl) statusEl.classList.add('is-live');
          if (statusTextEl) statusTextEl.textContent = '已连接云端 · 正在启用实时推送...';

          try {
            const client = await getSupabaseClient();
            if (!client || currentRoute !== 'guestbook') return;

            guestbookChannel = client
              .channel('guestbook-realtime')
              .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: sbCfg.table },
                (payload) => {
                  if (!payload || !payload.new) return;
                  const incoming = normalizeRemoteRow(payload.new);
                  const isSelf = incoming.id != null && recentSelfSubmittedIds.has(String(incoming.id));
                  if (isSelf) recentSelfSubmittedIds.delete(String(incoming.id));
                  prependLiveMessage(incoming);
                  if (!isSelf) showToast(`收到来自 ${incoming.author} 的新留言`);
                }
              )
              .on(
                'postgres_changes',
                { event: 'DELETE', schema: 'public', table: sbCfg.table },
                (payload) => {
                  if (payload && payload.old && payload.old.id != null) {
                    removeLiveMessage(payload.old.id);
                  }
                }
              )
              .subscribe((status) => {
                if (currentRoute !== 'guestbook' || !statusEl || !statusTextEl) return;
                if (status === 'SUBSCRIBED') {
                  if (guestbookPollTimer) {
                    clearInterval(guestbookPollTimer);
                    guestbookPollTimer = null;
                  }
                  statusEl.classList.add('is-live');
                  statusTextEl.textContent = '实时在线 · 全网访客即时同步';
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                  startFallbackPolling();
                }
              });
          } catch {
            startFallbackPolling();
          }
        } catch (err) {
          if (currentRoute !== 'guestbook') return;
          if (statusEl) statusEl.classList.remove('is-live');
          if (statusTextEl) statusTextEl.textContent = '云端连接失败，请检查网络后刷新重试';
          if (countChip) countChip.textContent = '同步失败';
          if (listEl && !Array.isArray(remoteGuestbookCache)) {
            listEl.innerHTML = guestbookEmptyHTML(`无法连接留言服务：${err && err.message ? err.message : '请稍后重试'}`);
          }
        }
      })();
    }

    const form = document.getElementById('guestbook-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('gb-name');
      const textInput = document.getElementById('gb-text');
      const author = nameInput.value.trim();
      const text = textInput.value.trim();
      if (!author || !text) return;
      saveNick(author);

      if (!sbCfg) {
        const time = formatGuestbookTime(new Date().toISOString());
        saveGuestbookMessage({ author, text, time });
        showToast('留言已保存在本地预览');
        renderGuestbookPage();
        return;
      }

      const nowMs = Date.now();
      if (nowMs - lastGuestbookSubmitAt < 5000) {
        showToast('发送太快啦，请 5 秒后再试');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '发布中...';
      try {
        const inserted = await insertRemoteGuestbook(author, text);
        lastGuestbookSubmitAt = Date.now();
        const msg = normalizeRemoteRow(inserted);
        if (msg.id != null) recentSelfSubmittedIds.add(String(msg.id));
        prependLiveMessage(msg);
        textInput.value = '';
        showToast('留言已全网实时发布');
      } catch (err) {
        showToast(`发布失败：${err && err.message ? err.message : '请检查网络'}`);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = '发布留言';
        }
      }
    });

    bindGlassGlint();
  }

  function renderAboutPage() {
    const ab = data.about || { heading: '关于', paragraphs: [], interests: [] };
    const hasContent = (ab.paragraphs && ab.paragraphs.length) || (ab.interests && ab.interests.length);

    appMain.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <div class="page-hero-card liquid-glass">
            <div>
              <div class="kicker">About</div>
              <h1>关于</h1>
              <p>关于这个个人空间与主人的自由介绍。</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          ${
            hasContent
              ? `
                <div class="resume-card liquid-glass" style="max-width:820px;">
                  <h3>${escapeHtml(ab.heading || '关于我')}</h3>
                  ${(ab.paragraphs || []).map((p) => `<p style="color:var(--text-secondary);line-height:1.8;">${escapeHtml(p)}</p>`).join('')}
                  ${
                    ab.interests && ab.interests.length
                      ? `<div class="chip-row" style="margin-top:20px;">${ab.interests.map((i) => `<span class="chip">${escapeHtml(i)}</span>`).join('')}</div>`
                      : ''
                  }
                </div>
              `
              : `
                <div class="empty-state-box liquid-glass">
                  <h3>暂未填写个人介绍</h3>
                  <p>点击下方进入网页管理后台，自由写下关于你自己、兴趣爱好和建站初衷。</p>
                  <a href="#admin" class="btn btn-liquid btn-sm">前往管理后台编辑 →</a>
                </div>
              `
          }
        </div>
      </section>
    `;

    bindGlassGlint();
  }

  /* ========================================================================
     6. 弹窗与灯箱（含博客/随笔/画廊点赞与评论）
     ======================================================================== */
  function openPostModal(post, focusComments) {
    if (!post) return;
    const mins = estimateReadMins(post.content || '');
    const k = itemKey('blog', post.id);
    modalMetaBar.innerHTML = `<span>${escapeHtml(post.date || '')}</span><span>·</span><span>约 ${mins} 分钟阅读</span>`;
    modalBody.innerHTML = `
      <article class="prose">
        <h1 id="modal-title">${escapeHtml(post.title)}</h1>
        <div class="chip-row" style="margin-bottom:20px;">
          ${(post.tags || []).map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('')}
        </div>
        ${renderMarkdown(post.content || '')}
      </article>
      <section class="interaction-section" id="modal-comments-anchor">
        <div class="interaction-head">
          <h3>点赞与评论</h3>
          ${interactionBarHTML('blog', post.id, post.title, { showLikeLabel: true })}
        </div>
        ${commentBoxHTML('blog', post.id, post.title)}
      </section>
    `;
    bindLikeButtons(modalBody);
    bindCommentForms(modalBody);
    const modalCommentBtn = modalBody.querySelector(`[data-comment-btn="${CSS.escape(k)}"]`);
    if (modalCommentBtn) {
      modalCommentBtn.addEventListener('click', () => {
        const ta = modalBody.querySelector('textarea[name="text"]');
        if (ta) ta.focus();
      });
    }
    openModal();
    if (focusComments) {
      requestAnimationFrame(() => {
        const anchor = document.getElementById('modal-comments-anchor');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    ensureInteractionsLoaded(true).then(() => {
      const listEl = modalBody.querySelector(`[data-comment-list="${CSS.escape(k)}"]`);
      if (listEl) listEl.innerHTML = commentListHTML('blog', post.id);
    });
  }

  function openCommentsModal(type, id, title, subtitle, photoSrc) {
    const k = itemKey(type, id);
    const typeLabel = type === 'gallery' ? '画廊评论' : type === 'essay' ? '随笔评论' : '文章评论';
    modalMetaBar.innerHTML = `<span>${typeLabel}</span>`;
    modalBody.innerHTML = `
      <div>
        <h1 id="modal-title" style="margin:0 0 12px;font-family:var(--font-display);font-size:1.45rem;">${escapeHtml(title || typeLabel)}</h1>
        ${photoSrc ? `<img class="modal-photo-preview" src="${escapeAttr(photoSrc)}" alt="${escapeAttr(title || '')}" />` : ''}
        ${subtitle ? `<p style="margin:0 0 18px;color:var(--text-secondary);line-height:1.75;white-space:pre-wrap;">${escapeHtml(subtitle)}</p>` : ''}
        <section class="interaction-section" style="margin-top:12px;padding-top:18px;">
          <div class="interaction-head">
            <h3>互动与评论</h3>
            ${interactionBarHTML(type, id, title, { showLikeLabel: true })}
          </div>
          ${commentBoxHTML(type, id, title)}
        </section>
      </div>
    `;
    bindLikeButtons(modalBody);
    bindCommentForms(modalBody);
    const modalCommentBtn = modalBody.querySelector(`[data-comment-btn="${CSS.escape(k)}"]`);
    if (modalCommentBtn) {
      modalCommentBtn.addEventListener('click', () => {
        const ta = modalBody.querySelector('textarea[name="text"]');
        if (ta) ta.focus();
      });
    }
    openModal();
    ensureInteractionsLoaded(true).then(() => {
      const listEl = modalBody.querySelector(`[data-comment-list="${CSS.escape(k)}"]`);
      if (listEl) listEl.innerHTML = commentListHTML(type, id);
    });
  }

  function bindLikeButtons(root) {
    (root || document).querySelectorAll('[data-like-btn]').forEach((btn) => {
      if (btn.dataset.likeBound) return;
      btn.dataset.likeBound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleItemLike(
          btn.getAttribute('data-itype'),
          btn.getAttribute('data-iid'),
          btn.getAttribute('data-ititle') || ''
        );
      });
    });
  }

  function bindContentTriggers() {
    bindLikeButtons(appMain);

    appMain.querySelectorAll('[data-comment-btn]').forEach((btn) => {
      if (btn.dataset.commentBound) return;
      btn.dataset.commentBound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const type = btn.getAttribute('data-itype');
        const id = btn.getAttribute('data-iid');
        const title = btn.getAttribute('data-ititle') || '';
        const isInline = btn.getAttribute('data-comment-inline') === '1';

        if (type === 'blog') {
          const post = data.posts.find((p) => p.id === id);
          if (post) openPostModal(post, true);
          return;
        }

        if (type === 'essay' && isInline) {
          const k = itemKey('essay', id);
          const drawer = appMain.querySelector(`[data-inline-comments="${CSS.escape(k)}"]`);
          if (drawer) {
            const willOpen = drawer.style.display === 'none';
            if (willOpen) {
              openEssayCommentKeys.add(k);
              drawer.innerHTML = commentBoxHTML('essay', id, title);
              drawer.style.display = '';
              bindCommentForms(drawer);
              ensureInteractionsLoaded(true).then(() => {
                const listEl = drawer.querySelector(`[data-comment-list="${CSS.escape(k)}"]`);
                if (listEl) listEl.innerHTML = commentListHTML('essay', id);
              });
            } else {
              openEssayCommentKeys.delete(k);
              drawer.style.display = 'none';
            }
            return;
          }
        }

        if (type === 'essay') {
          const essay = data.essays.find((x) => x.id === id);
          openCommentsModal('essay', id, title, essay ? essay.text : '', essay ? essay.image : '');
          return;
        }

        if (type === 'gallery') {
          const photo = data.gallery.find((x) => x.id === id);
          openCommentsModal('gallery', id, title, photo ? [photo.location, photo.date].filter(Boolean).join(' · ') : '', photo ? photo.src : '');
        }
      });
    });

    appMain.querySelectorAll('[data-open-post]').forEach((el) => {
      el.addEventListener('click', () => {
        const post = data.posts.find((p) => p.id === el.getAttribute('data-open-post'));
        if (post) openPostModal(post, false);
      });
    });

    appMain.querySelectorAll('[data-open-lightbox]').forEach((el) => {
      el.addEventListener('click', () => {
        openLightbox(Number(el.getAttribute('data-open-lightbox')));
      });
    });

    ensureInteractionsLoaded(false);
  }

  function openModal() {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function openLightbox(idx) {
    if (!lightboxList.length) return;
    lightboxIndex = (idx + lightboxList.length) % lightboxList.length;
    const item = lightboxList[lightboxIndex];
    const itemType = item.itemType || 'gallery';
    document.getElementById('lightbox-img').src = item.src;
    document.getElementById('lightbox-img').alt = item.title || '';
    document.getElementById('lightbox-title').textContent = item.title || '';
    document.getElementById('lightbox-sub').textContent =
      `${item.location || ''} ${item.date ? '· ' + item.date : ''} (${lightboxIndex + 1}/${lightboxList.length})`;

    const actionsEl = document.getElementById('lightbox-actions');
    if (actionsEl && item.id) {
      actionsEl.innerHTML = interactionBarHTML(itemType, item.id, item.title || '画廊照片');
      bindLikeButtons(actionsEl);
      const lbCommentBtn = actionsEl.querySelector('[data-comment-btn]');
      if (lbCommentBtn) {
        lbCommentBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeLightbox();
          openCommentsModal(
            itemType,
            item.id,
            item.title || '画廊照片',
            [item.location, item.date].filter(Boolean).join(' · '),
            item.src
          );
        });
      }
    }

    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function stepLightbox(delta) {
    openLightbox(lightboxIndex + delta);
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  /* ========================================================================
     7. 路由切换：首页 / 博客 / 随笔 / 画廊 / 留言 / 关于
     ======================================================================== */
  function navigate() {
    stopHomeEffects();
    unsubscribeGuestbookRealtime();
    const raw = (window.location.hash || '#home').replace('#', '');
    currentRoute = ['home', 'blog', 'essays', 'gallery', 'guestbook', 'about', 'admin'].includes(raw) ? raw : 'home';

    document.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-nav') === currentRoute);
    });
    document.getElementById('mobile-drawer').classList.remove('open');

    if (currentRoute === 'home') renderHome();
    else if (currentRoute === 'blog') renderBlogPage();
    else if (currentRoute === 'essays') renderEssaysPage();
    else if (currentRoute === 'gallery') renderGalleryPage();
    else if (currentRoute === 'guestbook') renderGuestbookPage();
    else if (currentRoute === 'about') renderAboutPage();
    else if (currentRoute === 'admin' && window.ADMIN_PANEL) window.ADMIN_PANEL.render(appMain);

    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function applySiteDataInPlace(next) {
    if (!next || typeof next !== 'object') return;
    if (next.profile && typeof next.profile === 'object') data.profile = next.profile;
    if (Array.isArray(next.posts)) data.posts = next.posts;
    if (Array.isArray(next.essays)) data.essays = next.essays;
    if (Array.isArray(next.gallery)) data.gallery = next.gallery;
    if (Array.isArray(next.guestbook)) data.guestbook = next.guestbook;
    if (next.about && typeof next.about === 'object') data.about = next.about;
    if (typeof next._updatedAt === 'number') data._updatedAt = next._updatedAt;
  }

  function parseSiteDataScript(jsText) {
    const marker = jsText.indexOf('window.SITE_DATA');
    if (marker < 0) return null;
    const eqIdx = jsText.indexOf('=', marker);
    if (eqIdx < 0) return null;
    let body = jsText.slice(eqIdx + 1).trim();
    if (body.endsWith(';')) body = body.slice(0, -1).trim();
    return JSON.parse(body);
  }

  function restorePendingSiteData() {
    try {
      const raw = localStorage.getItem(PENDING_DATA_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || typeof parsed.updatedAt !== 'number') return 0;
      if (Date.now() - parsed.updatedAt > 10 * 60 * 1000) {
        localStorage.removeItem(PENDING_DATA_KEY);
        return 0;
      }
      const baseTs = typeof data._updatedAt === 'number' ? data._updatedAt : 0;
      if (parsed.updatedAt > baseTs) {
        applySiteDataInPlace(parsed.data);
        return parsed.updatedAt;
      }
      localStorage.removeItem(PENDING_DATA_KEY);
      return 0;
    } catch {
      return 0;
    }
  }

  async function syncLatestSiteData(pendingTs) {
    try {
      const res = await fetch(`./data.js?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      const remote = parseSiteDataScript(text);
      if (!remote || typeof remote !== 'object') return;

      const remoteTs = typeof remote._updatedAt === 'number' ? remote._updatedAt : 0;
      const currentTs = typeof data._updatedAt === 'number' ? data._updatedAt : 0;

      if (pendingTs && remoteTs >= pendingTs) {
        try {
          localStorage.removeItem(PENDING_DATA_KEY);
        } catch {}
      }

      // 如果本地有更新的刚保存快照（GitHub Pages 仍在构建），暂不被旧线上覆盖
      if (pendingTs && remoteTs < pendingTs) return;

      const shouldUpdate =
        remoteTs > currentTs ||
        (remoteTs === 0 && currentTs === 0 && JSON.stringify(remote) !== JSON.stringify(data));
      if (!shouldUpdate) return;

      applySiteDataInPlace(remote);
      refreshShell();

      // 避免打断用户正在填写后台表单或留言输入
      if (currentRoute === 'home') renderHome();
      else if (currentRoute === 'blog') renderBlogPage();
      else if (currentRoute === 'essays') renderEssaysPage();
      else if (currentRoute === 'gallery') renderGalleryPage();
      else if (currentRoute === 'about') renderAboutPage();
    } catch {}
  }

  window.SITE_APP = { showToast, refreshShell, bindGlassGlint };
  const pendingTs = restorePendingSiteData();
  initShell();
  window.addEventListener('hashchange', navigate);
  navigate();
  syncLatestSiteData(pendingTs);
})();
