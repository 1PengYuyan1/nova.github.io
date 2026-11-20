/**
 * ============================================================================
 * 个人展示空间配置中心（纯净空模板）
 * 目录：首页 / 博客 / 随笔 / 画廊 / 留言 / 关于
 * ============================================================================
 */

window.SITE_DATA = {
  // 1. 站点名称与首页开屏文案
  profile: {
    brandName: 'My Space',
    statusBadge: 'PERSONAL SPACE · 个人空间',
    heroGreeting: 'Welcome to',
    heroName: 'My Space',
    heroPrefix: '在这里记录',
    heroPhrases: [
      '博客与思考',
      '随笔与日常',
      '画廊与光影',
      '生活与热爱',
    ],
    heroSubline: '一个安静、克制的黑曜石流体毛玻璃个人空间。',
    bio: '记录思考、随笔、光影与生活的个人数字花园。',
    email: '', // 可选：需要公开邮箱时填入
    socials: [
      // 可选：需要展示外链时取消注释并填写
      // { label: 'GitHub', url: 'https://github.com/yourname' },
    ],
  },

  // 2. 博客文章（posts）
  // 示例：
  // {
  //   id: 'post-1',
  //   title: '文章标题',
  //   date: '2026-11-20',
  //   tags: ['标签'],
  //   excerpt: '简短摘要',
  //   content: '## 正文\n支持 Markdown 格式...',
  // }
  posts: [],

  // 3. 随笔（essays）
  // 示例：
  // {
  //   id: 'essay-1',
  //   date: '2026-11-20 20:00',
  //   category: '日常',
  //   mood: '心情标签',
  //   location: '地点',
  //   text: '随笔正文...',
  //   image: '',
  // }
  essays: [],

  // 4. 画廊（gallery）
  // 示例：
  // {
  //   id: 'g-1',
  //   title: '照片标题',
  //   category: '风景',
  //   date: '2026-11',
  //   location: '拍摄地点',
  //   camera: '拍摄设备',
  //   src: './assets/images/photo.jpg',
  // }
  gallery: [],

  // 5. 留言板初始预设留言（默认空；支持访客直接在页面留言测试，后续也可接入免费 Giscus / Twikoo）
  guestbook: [],

  // 6. 关于页面（非简历，用来自由介绍你自己和这个网站）
  about: {
    heading: '关于这里',
    paragraphs: [
      // 在这里填入你想对自己和这个网站的介绍，每一项是一段话：
      // '你好，欢迎来到我的个人空间。',
    ],
    interests: [
      // 可选：你的兴趣标签，例如 '摄影', '音乐', '折腾硬件'
    ],
  },
};
