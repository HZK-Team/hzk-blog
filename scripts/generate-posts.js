/**
 * 构建脚本：Markdown → HTML 文章管线 + posts.json 生成
 *
 * 文章来源（两种格式并存）：
 *   1. posts/*.md   → Markdown 文章（推荐），构建时渲染成 blog/*.html
 *                     头部 front-matter 支持: title / date / tags / excerpt / draft
 *   2. blog/*.html  → 旧版手写 HTML 文章，直接提取元数据，保持兼容
 *
 * 生成文件：
 *   1. blog/<slug>.html                      → Markdown 渲染出的文章页（含 hzk-generated 标记，重复构建时自动清理重建）
 *   2. posts.json                            → 项目根目录（publish），前端 fetch
 *   3. netlify/functions/list-posts/posts-data.json → 随 Netlify Function 打包
 *
 * posts.json 字段：file / url / title / date / excerpt / tags[] / content(正文纯文本，供全文搜索)
 *
 * 运行方式：node scripts/generate-posts.js
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const postsDir = path.join(projectRoot, 'posts');   // Markdown 源文件
const blogDir = path.join(projectRoot, 'blog');     // 发布的文章 HTML
const GENERATED_MARK = '<!-- hzk-generated -->';

/* ================= 站点配置（以后绑定自定义域名时只需要改这一行） ================= */
const SITE_URL = 'https://hzk-blog.netlify.app';
const SITE_TITLE = 'HZK · 博客';
const SITE_DESCRIPTION = 'HZK 的个人博客：技术学习笔记、编程实践与生活感悟。';

/* ================= 工具函数 ================= */

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function stripTags(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

/* ================= Front-matter 解析 ================= */

function parseFrontMatter(raw) {
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!fmMatch) return { meta: {}, body: raw };

    const meta = {};
    const fmLines = fmMatch[1];
    fmLines.split(/\r?\n/).forEach(function(line) {
        const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
        if (!m) return;
        const key = m[1].toLowerCase();
        let val = m[2].trim();

        if (key === 'tags') {
            val = val.replace(/^\[/, '').replace(/\]$/, '');
            meta.tags = val.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        } else if (key === 'draft') {
            meta.draft = (val === 'true' || val === 'yes');
        } else {
            meta[key] = val.replace(/^["']|["']$/g, '');
        }
    });

    return { meta: meta, body: raw.slice(fmMatch[0].length) };
}

/* ================= Markdown 渲染（零依赖迷你实现） ================= */

function renderInline(text) {
    // 先抽取行内代码（支持 `` ` `` 与 `` `` ` `` `` 形式），避免代码内容被后续语法处理破坏
    const codes = [];
    text = text.replace(/(`+)([\s\S]*?)\1/g, function(m, ticks, content) {
        codes.push('<code>' + escapeHtml(content.replace(/\n/g, ' ').trim()) + '</code>');
        return '\u0001' + (codes.length - 1) + '\u0001';
    });

    text = escapeHtml(text);

    text = text
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 还原代码占位符
    text = text.replace(/\u0001(\d+)\u0001/g, function(m, idx) {
        return codes[parseInt(idx, 10)];
    });
    return text;
}

function markdownToHtml(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const isBlockStart = function(line) {
        return /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(line) ||
               /^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    };

    while (i < lines.length) {
        const line = lines[i];

        // 空行
        if (!line.trim()) { i++; continue; }

        // 围栏代码块（支持 3 个以上反引号/波浪线围栏，外层更长围栏可嵌套展示内层语法）
        const fenceM = line.match(/^(\s*)(`{3,}|~{3,})\s*(.*)$/);
        if (fenceM) {
            const fence = fenceM[2];
            const lang = fenceM[3].trim();
            const closeRe = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
            const buf = [];
            i++;
            while (i < lines.length && !closeRe.test(lines[i])) {
                buf.push(lines[i]);
                i++;
            }
            i++; // 跳过结束围栏
            out.push('<pre><code data-lang="' + escapeHtml(lang) + '">' +
                escapeHtml(buf.join('\n')) + '</code></pre>');
            continue;
        }

        // 标题
        let m = line.match(/^(#{1,6})\s+(.*)$/);
        if (m) {
            const level = m[1].length;
            out.push('<h' + level + '>' + renderInline(m[2]) + '</h' + level + '>');
            i++;
            continue;
        }

        // 分隔线
        if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            out.push('<hr />');
            i++;
            continue;
        }

        // 引用块
        if (line.trim().indexOf('>') === 0) {
            const buf = [];
            while (i < lines.length && lines[i].trim().indexOf('>') === 0) {
                buf.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            out.push('<blockquote>' + markdownToHtml(buf.join('\n')) + '</blockquote>');
            continue;
        }

        // 表格（当前行含 |，下一行是分隔行）
        if (line.indexOf('|') !== -1 && i + 1 < lines.length &&
            /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
            const parseRow = function(l) {
                return l.trim().replace(/^\|/, '').replace(/\|$/, '')
                    .split('|').map(function(c) { return c.trim(); });
            };
            const headers = parseRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
                rows.push(parseRow(lines[i]));
                i++;
            }
            let t = '<div class="table-wrap"><table><thead><tr>' +
                headers.map(function(h) { return '<th>' + renderInline(h) + '</th>'; }).join('') +
                '</tr></thead><tbody>';
            rows.forEach(function(r) {
                t += '<tr>' + r.map(function(c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>';
            });
            t += '</tbody></table></div>';
            out.push(t);
            continue;
        }

        // 列表
        const ulRe = /^\s*[-*+]\s+/;
        const olRe = /^\s*\d+[.)]\s+/;
        if (ulRe.test(line) || olRe.test(line)) {
            const ordered = olRe.test(line);
            const re = ordered ? olRe : ulRe;
            const items = [];
            while (i < lines.length && re.test(lines[i])) {
                items.push(lines[i].replace(re, ''));
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push('<' + tag + '>' +
                items.map(function(it) { return '<li>' + renderInline(it) + '</li>'; }).join('') +
                '</' + tag + '>');
            continue;
        }

        // 段落
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
            buf.push(lines[i]);
            i++;
        }
        out.push('<p>' + buf.map(renderInline).join('<br />') + '</p>');
    }

    return out.join('\n');
}

/* ================= 分享组件（右侧悬浮按钮 + 左展扩散菜单） ================= */

const SHARE_CSS = `
        /* ===== 右侧悬浮分享按钮 ===== */
        .share-fab {
            position: fixed; right: 22px; top: 50%; transform: translateY(-50%);
            display: flex; align-items: center; gap: 14px; z-index: 998;
            animation: fabIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.4s both;
        }
        @keyframes fabIn {
            from { opacity: 0; transform: translateY(-50%) translateX(90px); }
            to { opacity: 1; transform: translateY(-50%) translateX(0); }
        }
        .share-menu { display: flex; flex-direction: column; gap: 12px; position: relative; }
        .share-item {
            position: relative; width: 44px; height: 44px; border-radius: 50%;
            border: 1px solid var(--border); background: var(--bg-card);
            display: flex; align-items: center; justify-content: center;
            color: var(--text-secondary); cursor: pointer; padding: 0;
            opacity: 0; pointer-events: none;
            transform: translate(var(--dx, 0px), var(--dy, 0px)) scale(0.2);
            transition:
                transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) var(--d, 0s),
                opacity 0.35s ease var(--d, 0s),
                background 0.25s ease, color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
        }
        .share-fab.open .share-item { opacity: 1; pointer-events: auto; transform: translate(0, 0) scale(1); }
        .share-fab.open .share-item:hover { transform: scale(1.14); box-shadow: 0 8px 20px rgba(0,0,0,0.16); }
        .share-item svg { width: 20px; height: 20px; }
        .share-item.wechat:hover { background: #07c160; color: #fff; border-color: transparent; }
        .share-item.qq:hover { background: #12b7f5; color: #fff; border-color: transparent; }
        .share-item.weibo:hover { background: #e6162d; color: #fff; border-color: transparent; }
        .share-item.x:hover { background: #0f1419; color: #fff; border-color: transparent; }
        .share-item.facebook:hover { background: #1877f2; color: #fff; border-color: transparent; }
        .share-item.telegram:hover { background: #229ed9; color: #fff; border-color: transparent; }
        .share-item.copy:hover { background: var(--text-primary); color: var(--bg-card); border-color: transparent; }
        .share-item.copied { background: #07c160; color: #fff; border-color: transparent; }
        /* 悬停提示文案 */
        .share-item .tip {
            position: absolute; right: calc(100% + 12px); top: 50%;
            transform: translate(10px, -50%); opacity: 0; pointer-events: none;
            background: var(--bg-card); border: 1px solid var(--border); color: var(--text-primary);
            padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 500; white-space: nowrap;
            box-shadow: 0 6px 18px rgba(0,0,0,0.1);
            transition: opacity 0.25s ease 0.15s, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s;
        }
        .share-item:hover .tip, .share-item:focus-visible .tip { opacity: 1; transform: translate(0, -50%); }
        /* 主按钮（竖排文字） */
        .share-fab-btn {
            display: flex; flex-direction: column; align-items: center; gap: 9px;
            padding: 16px 11px; border-radius: 99px;
            border: 1px solid var(--border); background: var(--bg-card);
            color: var(--text-primary); cursor: pointer; font-family: var(--font);
            box-shadow: 0 10px 28px rgba(0,0,0,0.12);
            transition: background 0.3s ease, color 0.3s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease;
        }
        .share-fab-btn:hover { transform: scale(1.06); box-shadow: 0 14px 34px rgba(0,0,0,0.18); }
        .share-fab-btn:active { transform: scale(0.95); }
        .share-fab-btn svg { width: 18px; height: 18px; transition: transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .share-fab-btn .fab-text { writing-mode: vertical-rl; font-size: 12px; font-weight: 500; letter-spacing: 4px; }
        .share-fab.open .share-fab-btn { background: var(--text-primary); color: var(--bg-card); }
        .share-fab.open .share-fab-btn svg { transform: rotate(180deg); }
        /* 微信二维码弹窗 */
        .qr-mask {
            position: fixed; inset: 0; background: rgba(0,0,0,0.45); backdrop-filter: blur(6px);
            display: flex; align-items: center; justify-content: center; z-index: 999;
            opacity: 0; pointer-events: none; transition: opacity 0.25s ease;
        }
        .qr-mask.show { opacity: 1; pointer-events: auto; }
        .qr-card {
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px;
            padding: 28px; text-align: center; max-width: 88vw;
            transform: scale(0.8); transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            box-shadow: 0 24px 64px rgba(0,0,0,0.28);
        }
        .qr-mask.show .qr-card { transform: scale(1); }
        .qr-card img { width: 200px; height: 200px; display: block; margin: 0 auto; border-radius: 10px; background: #fff; padding: 10px; }
        .qr-card .qr-title { margin: 16px 0 4px; font-size: 15px; font-weight: 600; color: var(--text-primary); }
        .qr-card .qr-tip { font-size: 12px; color: var(--text-muted); line-height: 1.6; }
        .qr-close {
            margin-top: 18px; padding: 8px 26px; border-radius: 99px; border: 1px solid var(--border);
            background: transparent; color: var(--text-secondary); font-size: 13px; font-family: var(--font);
            cursor: pointer; transition: background var(--transition), color var(--transition);
        }
        .qr-close:hover { background: var(--bg-hover); color: var(--text-primary); }
        /* 复制成功提示 */
        .copy-toast {
            position: fixed; left: 50%; bottom: 44px; transform: translate(-50%, 16px);
            display: flex; align-items: center; gap: 8px;
            background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border);
            padding: 10px 22px; border-radius: 99px; font-size: 14px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.14);
            opacity: 0; pointer-events: none; z-index: 1000;
            transition: opacity 0.3s ease, transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .copy-toast.show { opacity: 1; transform: translate(-50%, 0); }
        .copy-toast svg { width: 16px; height: 16px; color: #07c160; }
        /* 微信内置浏览器转发引导层 */
        .wx-guide {
            position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 1001;
            opacity: 0; pointer-events: none; transition: opacity 0.35s ease;
        }
        .wx-guide.show { opacity: 1; pointer-events: auto; }
        .wx-guide .wx-arrow {
            position: absolute; top: 16px; right: 22px; width: 54px; height: 54px; color: #fff;
            filter: drop-shadow(0 4px 14px rgba(255,255,255,0.45));
            animation: wxArrowBob 0.85s ease-in-out infinite alternate;
        }
        .wx-guide .wx-text {
            position: absolute; top: 88px; right: 18px; text-align: right; color: #fff;
            font-size: 15px; line-height: 1.8; animation: wxTextIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.25s both;
        }
        .wx-guide .wx-text strong { font-size: 18px; display: block; margin-bottom: 4px; }
        .wx-guide .wx-text .wx-sub { font-size: 12.5px; color: rgba(255,255,255,0.72); }
        .wx-guide .wx-dismiss {
            position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%);
            color: rgba(255,255,255,0.6); font-size: 13px; letter-spacing: 1px;
        }
        @keyframes wxArrowBob { from { transform: translateY(0); } to { transform: translateY(12px); } }
        @keyframes wxTextIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 600px) {
            .share-fab { right: 12px; gap: 10px; }
            .share-item { width: 40px; height: 40px; }
            .share-item svg { width: 18px; height: 18px; }
            .share-fab-btn { padding: 13px 9px; }
        }
`;

const SHARE_HTML = `
            <div class="share-fab" id="shareFab">
                <div class="share-menu">
                    <button class="share-item wechat" data-share="wechat" aria-label="分享给微信朋友">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>
                        <span class="tip">分享给微信朋友</span>
                    </button>
                    <button class="share-item qq" data-share="qq" aria-label="分享给 QQ 好友">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>
                        <span class="tip">分享给 QQ 好友</span>
                    </button>
                    <button class="share-item weibo" data-share="weibo" aria-label="分享到微博">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.737 5.439l-.002.004zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.622.263.82.972.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.18.601l.014-.028zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.57-.18-.405-.615.375-.977.42-1.804 0-2.404-.781-1.112-2.915-1.053-5.364-.03 0 0-.766.331-.571-.271.376-1.217.315-2.224-.27-2.809-1.338-1.337-4.869.045-7.888 3.08C1.309 10.87 0 13.273 0 15.348c0 3.981 5.099 6.395 10.086 6.395 6.536 0 10.888-3.801 10.888-6.82 0-1.822-1.547-2.854-2.915-3.284v.01zm1.908-5.092c-.766-.856-1.908-1.187-2.96-.962-.436.09-.706.511-.616.932.09.42.511.691.932.602.511-.105 1.067.044 1.442.465.376.421.466.977.316 1.473-.136.406.089.856.51.992.405.119.857-.105.992-.512.33-1.021.12-2.178-.646-3.035l.03.045zm2.418-2.195c-1.576-1.757-3.905-2.419-6.054-1.968-.496.104-.812.587-.706 1.081.104.496.586.813 1.082.707 1.532-.331 3.185.15 4.296 1.383 1.112 1.246 1.429 2.943.947 4.416-.165.48.106 1.007.586 1.157.479.165.991-.104 1.157-.586.675-2.088.241-4.478-1.338-6.235l.03.045z"/></svg>
                        <span class="tip">分享到微博</span>
                    </button>
                    <button class="share-item x" data-share="x" aria-label="分享到 X">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>
                        <span class="tip">分享到 X</span>
                    </button>
                    <button class="share-item facebook" data-share="facebook" aria-label="分享到 Facebook">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>
                        <span class="tip">分享到 Facebook</span>
                    </button>
                    <button class="share-item telegram" data-share="telegram" aria-label="分享到 Telegram">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                        <span class="tip">分享到 Telegram</span>
                    </button>
                    <button class="share-item copy" data-share="copy" aria-label="复制链接">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        <span class="tip">复制链接</span>
                    </button>
                </div>
                <button class="share-fab-btn" id="shareFabBtn" aria-label="分享给其他人" title="分享给其他人">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    <span class="fab-text">分享给其他人</span>
                </button>
            </div>
            <div class="qr-mask" id="qrMask">
                <div class="qr-card">
                    <img id="qrImg" alt="微信扫码分享" />
                    <div class="qr-title">微信扫码分享</div>
                    <div class="qr-tip">用微信「扫一扫」打开这篇文章<br />再点右上角「 ⋯ 」→「发送给朋友」<br />即可发出带标题和配图的卡片</div>
                    <button class="qr-close" id="qrClose">关闭</button>
                </div>
            </div>
            <div class="copy-toast" id="copyToast">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                <span id="copyToastText">链接已复制</span>
            </div>
            <div class="wx-guide" id="wxGuide">
                <svg class="wx-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="M5.5 12.5L12 6l6.5 6.5"/></svg>
                <div class="wx-text">
                    <strong>点击右上角「 ⋯ 」</strong>
                    选择「发送给朋友」即可转发
                    <div class="wx-sub">卡片会自动展示文章标题与配图</div>
                </div>
                <div class="wx-dismiss">点击屏幕任意位置关闭</div>
            </div>
`;

const SHARE_JS = `
        (function() {
            var canonical = document.querySelector('link[rel="canonical"]');
            var pageUrl = location.origin + location.pathname;
            var qrUrl = canonical ? canonical.href : pageUrl; // 二维码用线上地址，手机扫码才能访问
            var title = document.title;
            var descEl = document.querySelector('meta[name="description"]');
            var desc = (descEl && descEl.getAttribute('content')) || title;
            var pic = location.origin + '/Logo.png';
            var u = encodeURIComponent(pageUrl),
                qu = encodeURIComponent(qrUrl + '#share-wechat'); // 二维码带分享标记：扫码后自动弹转发引导，转发前静默摘除
            var t = encodeURIComponent(title), d = encodeURIComponent(desc), p = encodeURIComponent(pic);

            var targets = {
                qq: 'https://connect.qq.com/widget/shareqq/index.html?url=' + u + '&title=' + t + '&summary=' + d + '&pics=' + p,
                weibo: 'https://service.weibo.com/share/share.php?url=' + u + '&title=' + t + '&pic=' + p,
                x: 'https://x.com/intent/tweet?url=' + u + '&text=' + t,
                facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u,
                telegram: 'https://t.me/share/url?url=' + u + '&text=' + t
            };

            var fab = document.getElementById('shareFab');
            var btn = document.getElementById('shareFabBtn');
            var items = Array.prototype.slice.call(fab.querySelectorAll('.share-item'));
            var mask = document.getElementById('qrMask');
            var toast = document.getElementById('copyToast');
            var toastText = document.getElementById('copyToastText');
            var toastTimer = null;
            var qrImg = document.getElementById('qrImg');

            /* ===== 计算每个图标的扩散起点（按钮中心）与错开延迟 ===== */
            function centerOf(el, root) {
                var x = 0, y = 0, node = el;
                while (node && node !== root) { x += node.offsetLeft; y += node.offsetTop; node = node.offsetParent; }
                return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
            }
            function layout() {
                var bc = centerOf(btn, fab);
                var maxDist = 1;
                var dists = items.map(function(it) {
                    var c = centerOf(it, fab);
                    var dist = Math.sqrt((bc.x - c.x) * (bc.x - c.x) + (bc.y - c.y) * (bc.y - c.y));
                    maxDist = Math.max(maxDist, dist);
                    return dist;
                });
                items.forEach(function(it, i) {
                    var c = centerOf(it, fab);
                    it.style.setProperty('--dx', (bc.x - c.x) + 'px');
                    it.style.setProperty('--dy', (bc.y - c.y) + 'px');
                    it.style.setProperty('--d', (dists[i] / maxDist * 0.14).toFixed(3) + 's');
                });
            }
            layout();
            window.addEventListener('resize', layout);

            /* ===== 展开与收起（收起有 450ms 缓冲，不会过快缩回） ===== */
            var openState = false;
            var pinned = false;   // 点击展开后固定，鼠标移开不收起
            var closeTimer = null;

            function openFab() {
                clearTimeout(closeTimer);
                if (!openState) { openState = true; fab.classList.add('open'); }
            }
            function closeFab() {
                clearTimeout(closeTimer);
                openState = false; pinned = false;
                fab.classList.remove('open');
            }
            function scheduleClose() {
                clearTimeout(closeTimer);
                closeTimer = setTimeout(function() { if (!pinned) closeFab(); }, 450);
            }

            fab.addEventListener('mouseenter', openFab);
            fab.addEventListener('mouseleave', scheduleClose);
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (openState) { closeFab(); } else { pinned = true; openFab(); }
            });
            document.addEventListener('click', function(e) {
                if (openState && !fab.contains(e.target)) closeFab();
            });

            /* ===== 提示与二维码 ===== */
            function showToast(msg) {
                toastText.textContent = msg;
                toast.classList.add('show');
                clearTimeout(toastTimer);
                toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 2400);
            }
            function openQr() {
                if (!qrImg.src) {
                    qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=' + qu;
                }
                mask.classList.add('show');
            }
            function closeQr() { mask.classList.remove('show'); }
            mask.addEventListener('click', function(e) { if (e.target === mask) closeQr(); });
            document.getElementById('qrClose').addEventListener('click', closeQr);

            /* ===== 复制链接 ===== */
            function copyLink(item) {
                var tip = item.querySelector('.tip');
                function ok() {
                    item.classList.add('copied');
                    if (tip) tip.textContent = '已复制';
                    showToast('链接已复制，去粘贴分享吧');
                    setTimeout(function() {
                        item.classList.remove('copied');
                        if (tip) tip.textContent = '复制链接';
                    }, 2200);
                }
                function fail() { showToast('复制失败，请手动复制地址栏链接'); }
                function fallback() {
                    var ta = document.createElement('textarea');
                    ta.value = pageUrl;
                    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                    document.body.appendChild(ta);
                    ta.focus(); ta.select();
                    try { document.execCommand('copy') ? ok() : fail(); } catch (err) { fail(); }
                    document.body.removeChild(ta);
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(pageUrl).then(ok, fallback);
                } else { fallback(); }
            }

            /* ===== 设备判断：手机端优先拉起 App，电脑端走网页分享/二维码 ===== */
            var isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
                ('ontouchstart' in window && Math.min(screen.width, screen.height) < 820);

            /* QQ 手机端：URL Scheme 直接拉起 QQ App 分享面板，未安装 2s 后回退网页版 */
            function qqMobile() {
                var scheme = 'mqqapi://share/to_fri?src_type=web&version=1&file_type=news' +
                    '&generalpastboard=1&share_id=1105471055&callback_type=scheme&cflag=0' +
                    '&url=' + u + '&title=' + t + '&description=' + d + '&image_url=' + p + '&previewimageUrl=' + p;
                var opened = false;
                function onHidden() { opened = true; }
                document.addEventListener('visibilitychange', onHidden);
                location.href = scheme;
                setTimeout(function() {
                    document.removeEventListener('visibilitychange', onHidden);
                    if (!opened && !document.hidden) {
                        window.open(targets.qq, '_blank'); // QQ 没有被拉起，回退网页分享
                    }
                }, 2000);
            }

            /* 微信内置浏览器检测（扫码/微信内打开时生效） */
            var inWeChat = /MicroMessenger/i.test(navigator.userAgent);

            /* 微信手机端（外部浏览器）：复制链接并直接拉起微信 App，粘贴即发 */
            function wechatMobile() {
                function launchWx() {
                    showToast('链接已复制，已打开微信，粘贴给好友即可发送');
                    setTimeout(function() { location.href = 'weixin://'; }, 650); // 先看清提示再切换
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(pageUrl).then(launchWx, function() {
                        showToast('打开微信后，长按粘贴发送给好友');
                        setTimeout(function() { location.href = 'weixin://'; }, 650);
                    });
                } else {
                    showToast('打开微信后，长按粘贴发送给好友');
                    setTimeout(function() { location.href = 'weixin://'; }, 650);
                }
            }

            /* 系统分享面板（Web Share API）：与原生 App 同款体验 —— 直选微信/QQ 等并进入分享。
               必须在用户手势中同步调用；不支持、或失败（非用户取消）时回退到复制 + 拉起微信。 */
            function webShare() {
                if (typeof navigator.share !== 'function') return false;
                try {
                    navigator.share({ title: title, text: desc, url: pageUrl }).catch(function(err) {
                        if (!err || err.name !== 'AbortError') wechatMobile(); // 用户主动取消则不打扰
                    });
                    return true;
                } catch (e) {
                    return false; // 同步抛错（非安全上下文等）→ 交给调用方兜底
                }
            }

            /* 微信内置浏览器：官方唯一支持的分享方式是右上角「⋯」菜单，展示引导层 */
            var wxGuide = document.getElementById('wxGuide');
            function showWxGuide() { wxGuide.classList.add('show'); }
            function hideWxGuide() { wxGuide.classList.remove('show'); }
            wxGuide.addEventListener('click', hideWxGuide);
            if (inWeChat) {
                setTimeout(showWxGuide, 900); // 页面就绪后自动引导一次
            }

            /* ===== #share-xxx 回链检测：到达即静默摘除 hash，之后转发出去的永远是干净链接 ===== */
            var hashMatch = /^#share-([a-z]+)/i.exec(location.hash);
            if (hashMatch) {
                var fromPlatform = hashMatch[1].toLowerCase();
                try {
                    // 无刷新改写地址栏：微信「⋯」转发抓取的是点击瞬间的 URL，此刻已无 hash
                    history.replaceState(null, '', location.pathname + location.search);
                } catch (e) {
                    location.replace(location.pathname + location.search); // 极旧 webview 兜底（会重载一次）
                    return;
                }
                setTimeout(function() {
                    if (fromPlatform === 'wechat') {
                        if (inWeChat) { showWxGuide(); }          // 扫码落在微信内：弹「⋯」转发引导
                        else if (isMobile) { wechatMobile(); }    // 手机外部浏览器：复制链接并拉起微信
                    } else if (fromPlatform === 'qq' && isMobile) {
                        showToast('正在为你拉起 QQ 分享面板…');
                        qqMobile();                               // 跨设备接力：直接进 QQ 好友选择
                    }
                    // 其余平台（weibo/x/facebook/telegram）：hash 已清理，正常阅读即可
                }, 700);
            }

            /* ===== 分享入口分发 ===== */
            items.forEach(function(item) {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var k = item.getAttribute('data-share');
                    if (k === 'wechat') {
                        if (inWeChat) { showWxGuide(); }                          // 微信内：引导用右上角菜单转发（卡片自动备好）
                        else if (isMobile) { if (!webShare()) wechatMobile(); }   // 手机：优先系统分享面板，兜底复制+拉起微信
                        else { openQr(); }                                        // 电脑：展示二维码
                        closeFab(); return;
                    }
                    if (k === 'copy') { copyLink(item); return; }
                    if (k === 'qq' && isMobile) { qqMobile(); closeFab(); return; }
                    if (targets[k]) {
                        window.open(targets[k], '_blank', 'width=640,height=560');
                        setTimeout(closeFab, 350); // 让用户看到点击反馈后再收起
                    }
                });
            });

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') { closeFab(); closeQr(); }
            });

            /* ===== 阅读量统计 ===== */
            var slug = location.pathname.split('/').filter(Boolean).pop() || '';
            slug = slug.split('.html')[0]; // 兼容 /blog/xxx 与 /blog/xxx.html
            if (slug && slug !== 'blog' && location.protocol !== 'file:') {
                var viewsBox = document.getElementById('viewCount');
                var viewsText = document.getElementById('viewCountText');
                fetch('/api/views?slug=' + encodeURIComponent(slug))
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        if (d && typeof d.views === 'number' && viewsBox) {
                            viewsText.textContent = d.views + ' 次阅读';
                            viewsBox.style.display = '';
                        }
                    }).catch(function() {}); // 接口不可用时静默隐藏

                /* ===== 点赞（localStorage 记忆已赞，可取消） ===== */
                var likeBtn = document.getElementById('likeBtn');
                var likeText = document.getElementById('likeText');
                var likeNum = document.getElementById('likeNum');
                var LIKE_KEY = 'hzk-liked:' + slug;
                var liked = false, likeCount = 0;
                try { liked = localStorage.getItem(LIKE_KEY) === '1'; } catch (e) {}

                function renderLikes() {
                    likeText.textContent = liked ? '已赞' : '点赞';
                    likeBtn.classList.toggle('liked', liked);
                }
                function showCount(n) {
                    likeCount = n;
                    likeNum.textContent = n;
                    likeNum.style.display = '';
                }
                function popNum() {
                    likeNum.classList.remove('pop');
                    void likeNum.offsetWidth; // 触发重排，让动画可重复播放
                    likeNum.classList.add('pop');
                }
                renderLikes();

                // 打开页面即读取点赞量（不改变数据）
                fetch('/api/likes?slug=' + encodeURIComponent(slug))
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        if (d && typeof d.likes === 'number') { showCount(d.likes); popNum(); }
                    })
                    .catch(function() {}); // 接口不可用时徽章保持隐藏

                likeBtn.addEventListener('click', function() {
                    likeBtn.classList.remove('bump'); void likeBtn.offsetWidth; likeBtn.classList.add('bump');
                    var action = liked ? 'unlike' : 'like';
                    var delta = liked ? -1 : 1;
                    liked = !liked;
                    showCount(Math.max(0, likeCount + delta)); // 乐观更新，点击立刻有反馈
                    popNum();
                    try { liked ? localStorage.setItem(LIKE_KEY, '1') : localStorage.removeItem(LIKE_KEY); } catch (e) {}
                    renderLikes();
                    fetch('/api/likes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ slug: slug, action: action })
                    })
                        .then(function(r) { return r.json(); })
                        .then(function(d) { if (typeof d.likes === 'number') { showCount(d.likes); renderLikes(); } })
                        .catch(function() { // 失败回滚
                            liked = !liked;
                            showCount(Math.max(0, likeCount - delta));
                            try { liked ? localStorage.setItem(LIKE_KEY, '1') : localStorage.removeItem(LIKE_KEY); } catch (e) {}
                            renderLikes();
                            showToast('网络异常，请稍后再试');
                        });
                });
            }
        })();
`;

/* ================= 文章页动画（进度条 / 返回顶部 / 滚动入场 / 图片淡入） ================= */

const ARTICLE_CSS = `
        /* 顶部阅读进度条 */
        .read-progress {
            position: fixed; top: 0; left: 0; height: 3px; width: 0;
            background: linear-gradient(90deg, var(--text-primary), var(--text-muted));
            border-radius: 0 99px 99px 0;
            z-index: 1002;
            transition: width 0.12s linear;
            will-change: width;
        }
        /* 返回顶部按钮 */
        .to-top {
            position: fixed; right: 22px; bottom: 26px;
            width: 44px; height: 44px; border-radius: 50%; padding: 0;
            border: 1px solid var(--border); background: var(--bg-card);
            color: var(--text-secondary); cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 6px 22px rgba(0,0,0,0.12);
            opacity: 0; transform: translateY(18px) scale(0.84); pointer-events: none;
            transition: opacity 0.35s ease, transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1),
                        background var(--transition), color var(--transition), box-shadow 0.3s ease;
            z-index: 998;
        }
        [data-theme="dark"] .to-top { box-shadow: 0 6px 22px rgba(0,0,0,0.6); }
        .to-top.show { opacity: 1; transform: none; pointer-events: auto; }
        .to-top:hover { color: var(--text-primary); transform: translateY(-3px); }
        .to-top:active { transform: scale(0.9); }
        .to-top svg { width: 19px; height: 19px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

        /* 标题 / meta / 导航 分层入场 */
        .nav { animation: artIn 0.6s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
        article h1 { animation: artIn 0.68s cubic-bezier(0.22, 1, 0.36, 1) 0.06s backwards; }
        article .meta { animation: artIn 0.68s cubic-bezier(0.22, 1, 0.36, 1) 0.16s backwards; }
        @keyframes artIn {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: none; }
        }
        .back-link svg { transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .back-link:hover svg { transform: translateX(-3px); }
        .icon-btn svg { transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .icon-btn:hover svg { transform: rotate(20deg); }
        .icon-btn.spin svg { animation: iconSpin 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
        @keyframes iconSpin {
            from { transform: rotate(0deg) scale(1); }
            50% { transform: rotate(180deg) scale(0.82); }
            to { transform: rotate(360deg) scale(1); }
        }
        .tag-chip { transition: border-color var(--transition), color var(--transition), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), background var(--transition); }
        .tag-chip:hover { border-color: var(--text-muted); color: var(--text-primary); transform: translateY(-2px); }

        /* 正文滚动入场 */
        .rv { opacity: 0; }
        .rv.in { opacity: 1; animation: rvIn 0.62s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
        @keyframes rvIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: none; }
        }

        /* 代码块 / 引用 交互 */
        .content pre {
            transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.35s ease,
                        background var(--transition), border-color var(--transition);
        }
        .content pre:hover { transform: translateY(-3px); box-shadow: 0 10px 28px rgba(0,0,0,0.09); }
        [data-theme="dark"] .content pre:hover { box-shadow: 0 10px 28px rgba(0,0,0,0.55); }
        .content blockquote { transition: border-color var(--transition), transform 0.35s ease; }
        .content blockquote:hover { transform: translateX(3px); }

        /* 图片淡入（未加载前的隐藏由 JS 打标记，JS 不可用时图片照常显示） */
        .content img[data-img-pending] { opacity: 0; }
        .content img.img-in { animation: imgIn 0.75s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
        @keyframes imgIn {
            from { opacity: 0; transform: scale(0.97); }
            to { opacity: 1; transform: none; }
        }

        @media (prefers-reduced-motion: reduce) {
            .nav, article h1, article .meta, .rv.in, .content img.img-in { animation: none; }
            .rv { opacity: 1; }
            .read-progress { transition: none; }
        }
`;

const ARTICLE_HTML = `
    <div class="read-progress" id="readProgress"></div>
    <button class="to-top" id="toTop" aria-label="返回顶部" title="返回顶部">
        <svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
    </button>
`;

const ARTICLE_JS = `
        /* ===== 文章页动效：阅读进度条 / 返回顶部 / 正文滚动入场 / 图片淡入 ===== */
        (function() {
            var bar = document.getElementById('readProgress');
            var toTop = document.getElementById('toTop');
            var ticking = false;

            function update() {
                var doc = document.documentElement;
                var max = doc.scrollHeight - window.innerHeight;
                var y = window.pageYOffset || doc.scrollTop || 0;
                var p = max > 0 ? Math.min(y / max, 1) : 0;
                if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
                if (toTop) {
                    if (y > 320) { toTop.classList.add('show'); }
                    else { toTop.classList.remove('show'); }
                }
                ticking = false;
            }
            function onScroll() {
                if (!ticking) {
                    ticking = true;
                    window.requestAnimationFrame ? window.requestAnimationFrame(update) : setTimeout(update, 16);
                }
            }
            window.addEventListener('scroll', onScroll, { passive: true });
            window.addEventListener('resize', onScroll);
            update();

            if (toTop) {
                toTop.addEventListener('click', function() {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
            }

            /* 主题按钮旋转反馈 */
            var themeBtn = document.getElementById('themeToggle');
            if (themeBtn) {
                themeBtn.addEventListener('click', function() {
                    themeBtn.classList.remove('spin');
                    void themeBtn.offsetWidth;
                    themeBtn.classList.add('spin');
                });
            }

            /* 正文 / 点赞区 / 评论区 滚动逐个入场 */
            var rvTargets = [];
            var contentBox = document.querySelector('.content');
            if (contentBox) {
                rvTargets = rvTargets.concat(Array.prototype.slice.call(contentBox.children));
            }
            var extras = document.querySelectorAll('.post-actions, .comments');
            Array.prototype.forEach.call(extras, function(el) { rvTargets.push(el); });

            if (rvTargets.length && window.IntersectionObserver) {
                var io = new IntersectionObserver(function(entries) {
                    var d = 0;
                    entries.forEach(function(en) {
                        if (!en.isIntersecting) return;
                        var el = en.target;
                        if (el.classList.contains('pre-in')) { io.unobserve(el); return; } // 过渡到达时已直接显示
                        el.style.animationDelay = (d * 70) + 'ms'; // 同批进入的错开播放
                        d++;
                        el.classList.add('in');
                        io.unobserve(el);
                    });
                }, { rootMargin: '0px 0px -50px 0px', threshold: 0.05 });
                rvTargets.forEach(function(el) {
                    el.classList.add('rv');
                    io.observe(el);
                });
            }

            /* 图片加载完成淡入 */
            var imgs = document.querySelectorAll('.content img');
            Array.prototype.forEach.call(imgs, function(img) {
                img.setAttribute('data-img-pending', '');
                function done() {
                    img.removeAttribute('data-img-pending');
                    img.classList.add('img-in');
                }
                if (img.complete && img.naturalWidth) { done(); }
                else {
                    img.addEventListener('load', done);
                    img.addEventListener('error', done);
                }
            });
        })();
`;

/* ================= 跨页面过渡（参考 14-news 报纸站的移页效果） =================
 * 报纸站是同页 SPA 切 view，用 inline transition 让两页同时滑动。
 * 博客是独立 HTML 页面，跨文档要「两页同时移动」只能用 View Transitions API。
 *
 * ⚠️ 关键坑：跨文档过渡时，新旧两个文档的样式表会合并，且**新文档优先**。
 *    若两个文档都写 ::view-transition-old(root)，新文档那条会覆盖旧文档的，
 *    导致旧页面（应移出的那页）动画失效 —— 表现就是「旧页没动、新页盖上来」。
 * 解法：用 view-transition types 标记方向，每个文档只声明自己在**该方向下的角色**，
 *    两个文档的规则互不重叠，不存在覆盖。
 *
 * 方向约定（与报纸站一致）：
 *   fwd  前进（首页 → 子页面）：首页(old) 左移出，子页面(new) 从右滑入
 *   back 返回（子页面 → 首页）：子页面(old) 右移出，首页(new) 从左滑入
 */

/* 所有页面共用同一份过渡样式。
 * ⚠️ 跨文档过渡会合并新旧文档的样式且**新文档优先**，所以两个文档必须使用
 *    **完全相同**的规则集（含 fwd / back 两个方向下 old / new 四种角色）。
 *    若各页面按自己角色只写一部分，旧页面的动画会被新文档的同名规则覆盖，
 *    表现就是「旧页没动、新页直接盖上来」。
 *    因此这里把四种角色一次性写全，所有页面原样引用。 */
const VT_ALL_CSS = `
        @view-transition { navigation: auto; }
        html { overflow-x: clip; }

        /* 关闭 UA 默认的淡入淡出；滑动动画由下方 types 规则提供 */
        ::view-transition-old(root),
        ::view-transition-new(root) { animation: none; }

        @keyframes vtOutLeft  { to   { transform: translateX(-100vw); } }
        @keyframes vtInLeft   { from { transform: translateX(-100vw); } }
        @keyframes vtOutRight { to   { transform: translateX(100vw); } }
        @keyframes vtInRight  { from { transform: translateX(100vw); } }

        /* 前进（首页 → 子页面）：首页左移出 + 子页面从右滑入 */
        :active-view-transition-type(fwd)::view-transition-old(root) {
            animation: vtOutLeft 0.42s cubic-bezier(0.4, 0, 0.2, 1) both;
        }
        :active-view-transition-type(fwd)::view-transition-new(root) {
            animation: vtInRight 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        /* 返回（子页面 → 首页）：子页面右移出 + 首页从左滑入 */
        :active-view-transition-type(back)::view-transition-old(root) {
            animation: vtOutRight 0.42s cubic-bezier(0.4, 0, 0.2, 1) both;
        }
        :active-view-transition-type(back)::view-transition-new(root) {
            animation: vtInLeft 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
        }

        /* 兜底路径（浏览器不支持跨文档过渡）：到达页整页滑入。
         * 不设 fill-mode，动画结束自动恢复，避免影响 fixed 元素定位。 */
        @keyframes pageInRight { from { opacity: 0.4; transform: translateX(100vw); } }
        @keyframes pageInLeft  { from { opacity: 0.4; transform: translateX(-100vw); } }
        html.nav-fwd body  { animation: pageInRight 0.42s cubic-bezier(0.22, 1, 0.36, 1); }
        html.nav-back body { animation: pageInLeft  0.42s cubic-bezier(0.22, 1, 0.36, 1); }

        /* 过渡到达时抑制元素级入场动画：滑动本身已是入场动效，叠加会显得乱 */
        html.vt .nav,
        html.vt article h1,
        html.vt article .meta,
        html.vt .header .logo,
        html.vt .logo-img,
        html.vt .header-actions,
        html.vt .search-section,
        html.vt .stats,
        html.vt .post-item,
        html.vt .post-tags .tag-chip,
        html.vt .code,
        html.vt .title,
        html.vt .desc,
        html.vt .search-box,
        html.vt .back-btn,
        html.vt .field,
        html.vt .submit-btn,
        html.vt .card,
        html.vt h1,
        html.vt p,
        html.vt .page-desc { animation: none; }

        /* 首屏内容直接可见，不参与二次动画 */
        html.vt .reveal,
        html.vt .rv.pre-in { opacity: 1; animation: none; }

        @media (prefers-reduced-motion: reduce) {
            html.nav-fwd body,
            html.nav-back body { animation: none; }
            :active-view-transition-type(fwd)::view-transition-old(root),
            :active-view-transition-type(fwd)::view-transition-new(root),
            :active-view-transition-type(back)::view-transition-old(root),
            :active-view-transition-type(back)::view-transition-new(root) { animation: none !important; }
        }
`;

/* 所有页面共用的过渡脚本：方向标记 + 到达处理 + 兜底 */
const VT_NAV_JS = `
        /* ===== 页面过渡：方向类型标记 + 到达处理 + 旧浏览器兜底 ===== */
        (function() {
            var REDUCED = false;
            try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

            function isHomeUrl(u) {
                try {
                    var p = new URL(u, location.href).pathname;
                    return p === '/' || p === '/index.html';
                } catch (e) { return false; }
            }
            /* 目标不是首页 → 前进 fwd；目标是首页 → 返回 back */
            function typeFor(u) { return isHomeUrl(u) ? 'back' : 'fwd'; }

            /* 让首屏内容直接可见：滑动本身已是入场动效，不再播放二次动画 */
            function markPreIn() {
                var vh = window.innerHeight || 800;
                var els = document.querySelectorAll('.rv, .reveal');
                for (var i = 0; i < els.length; i++) {
                    if (els[i].getBoundingClientRect().top < vh * 0.98) els[i].classList.add('pre-in');
                }
            }

            var hasVT = ('onpagereveal' in window) || ('onpageswap' in window);

            if (hasVT) {
                /* 离开页：标记方向，供两个文档的 CSS 精确匹配自己的角色 */
                window.addEventListener('pageswap', function(e) {
                    if (!e.viewTransition) return;
                    var to = '';
                    try { to = (e.activation && e.activation.entry) ? e.activation.entry.url : ''; } catch (err) {}
                    try { e.viewTransition.types.add(typeFor(to || location.href)); } catch (err) {}
                });
                /* 到达页：打标记抑制元素级动画，并补一次方向类型（双保险） */
                window.addEventListener('pagereveal', function(e) {
                    if (!e.viewTransition) return;
                    document.documentElement.classList.add('vt');
                    try { e.viewTransition.types.add(typeFor(location.href)); } catch (err) {}
                    markPreIn();
                });
                return;
            }

            /* ===== 兜底：不支持跨文档 View Transitions ===== */
            if (REDUCED) return;

            /* 到达页：读取来源页留下的方向标记，播放整页滑入 */
            var nav = null;
            try { nav = sessionStorage.getItem('hzk-nav'); sessionStorage.removeItem('hzk-nav'); } catch (e) {}
            if (nav === 'fwd' || nav === 'back') {
                document.documentElement.classList.add('vt');          // 抑制元素级入场，避免叠加
                document.documentElement.classList.add('nav-' + nav);  // 播放整页滑入
                markPreIn();
            }

            /* 离开页：整页滑出动画播完后再跳转（移出页全程可见，不是直接消失） */
            var DUR = 300;
            document.addEventListener('click', function(e) {
                if (e.defaultPrevented) return;
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                var a = e.target && e.target.closest ? e.target.closest('a') : null;
                if (!a) return;
                var href = a.getAttribute('href') || '';
                if (!href || href.charAt(0) === '#' || a.hasAttribute('download')) return;
                if (a.target && a.target !== '_self') return;
                var url;
                try { url = new URL(a.href, location.href); } catch (err) { return; }
                if (url.origin !== location.origin) return;            // 外链 / tencent: / mailto:
                if (url.pathname === location.pathname && url.search === location.search) return;

                e.preventDefault();
                var t = typeFor(a.href);
                try { sessionStorage.setItem('hzk-nav', t); } catch (err) {}

                var body = document.body;
                body.style.transition = 'transform ' + DUR + 'ms cubic-bezier(0.4, 0, 0.2, 1), opacity ' + DUR + 'ms ease';
                body.style.transform = 'translateX(' + (t === 'back' ? '100vw' : '-100vw') + ')';
                body.style.opacity = '0.35';

                var done = false, timer = null;
                function go() {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    location.href = a.href;
                }
                body.addEventListener('transitionend', go, { once: true });
                timer = setTimeout(go, DUR + 90);   // 兜底，防 transitionend 未触发
            }, true);
        })();
`;

/* ================= 文章页模板 ================= */

function buildArticleHtml(meta, bodyHtml) {
    const tags = meta.tags || [];
    const date = meta.date || '';
    const title = meta.title || '未命名文章';
    const excerpt = meta.excerpt || '';
    const canonical = SITE_URL + (meta.url || '/');  // 文章页传入 /blog/xxx，无 url 时退化为首页

    return GENERATED_MARK + '\n' +
'<!DOCTYPE html>\n' +
'<html lang="zh-CN" data-theme="light">\n' +
'<head>\n' +
'    <meta charset="UTF-8" />\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
'    <title>' + escapeHtml(title) + '</title>\n' +
'    <meta name="date" content="' + escapeHtml(date) + '" />\n' +
'    <meta name="description" content="' + escapeHtml(excerpt) + '" />\n' +
'    <meta name="tags" content="' + escapeHtml(tags.join(', ')) + '" />\n' +
'    <link rel="canonical" href="' + escapeHtml(canonical) + '" />\n' +
'    <meta property="og:site_name" content="' + escapeHtml(SITE_TITLE) + '" />\n' +
'    <meta property="og:title" content="' + escapeHtml(title) + '" />\n' +
'    <meta property="og:description" content="' + escapeHtml(excerpt) + '" />\n' +
'    <meta property="og:type" content="article" />\n' +
'    <meta property="og:url" content="' + escapeHtml(canonical) + '" />\n' +
'    <meta property="og:image" content="' + SITE_URL + '/Logo.png" />\n' +
'    <meta property="og:locale" content="zh_CN" />\n' +
'    <meta name="twitter:card" content="summary" />\n' +
'    <meta name="twitter:title" content="' + escapeHtml(title) + '" />\n' +
'    <meta name="twitter:description" content="' + escapeHtml(excerpt) + '" />\n' +
'    <meta name="twitter:image" content="' + SITE_URL + '/Logo.png" />\n' +
'    <style>\n' +
'        :root {\n' +
'            --bg: #fafafa; --bg-card: #ffffff; --bg-hover: #f3f4f6;\n' +
'            --text-primary: #1a1a1a; --text-secondary: #6b7280; --text-muted: #9ca3af;\n' +
'            --border: #e5e7eb; --bg-code: #f3f4f6;\n' +
'            --transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);\n' +
'            --radius: 12px; --radius-sm: 6px;\n' +
'            --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n' +
'        }\n' +
'        [data-theme="dark"] {\n' +
'            --bg: #0a0a0a; --bg-card: #141414; --bg-hover: #1f1f1f;\n' +
'            --text-primary: #e5e5e5; --text-secondary: #a3a3a3; --text-muted: #6b6b6b;\n' +
'            --border: #262626; --bg-code: #1a1a1a;\n' +
'        }\n' +
'        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'        html { scroll-behavior: smooth; }\n' +
'        body {\n' +
'            font-family: var(--font); background: var(--bg); color: var(--text-primary);\n' +
'            line-height: 1.8; -webkit-font-smoothing: antialiased;\n' +
'            transition: background var(--transition), color var(--transition);\n' +
'        }\n' +
'        a { color: inherit; text-decoration: none; }\n' +
'        .container { max-width: 680px; margin: 0 auto; padding: 0 24px; }\n' +
'        .nav { padding: 28px 0 12px; display: flex; align-items: center; justify-content: space-between; }\n' +
'        .back-link {\n' +
'            display: inline-flex; align-items: center; gap: 6px; font-size: 14px;\n' +
'            color: var(--text-muted); transition: color var(--transition), transform var(--transition);\n' +
'        }\n' +
'        .back-link:hover { color: var(--text-primary); transform: translateX(-3px); }\n' +
'        .back-link svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n' +
'        .icon-btn {\n' +
'            background: transparent; border: none; width: 36px; height: 36px; border-radius: 50%;\n' +
'            cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
'            color: var(--text-secondary); padding: 0;\n' +
'            transition: background var(--transition), color var(--transition), transform var(--transition);\n' +
'        }\n' +
'        .icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); transform: scale(1.08); }\n' +
'        .icon-btn svg { width: 19px; height: 19px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }\n' +
'        article { padding: 12px 0 80px; }\n' +
'        @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }\n' +
'        h1 { font-size: 32px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 10px; }\n' +
'        .meta {\n' +
'            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;\n' +
'            font-size: 14px; color: var(--text-muted); margin-bottom: 32px;\n' +
'            padding-bottom: 24px; border-bottom: 1px solid var(--border);\n' +
'            transition: border-color var(--transition);\n' +
'        }\n' +
'        .tag-chip {\n' +
'            display: inline-block; padding: 2px 10px; border: 1px solid var(--border);\n' +
'            border-radius: 99px; font-size: 12px; color: var(--text-secondary);\n' +
'            background: var(--bg-card); transition: all var(--transition);\n' +
'        }\n' +
'        h2 { font-size: 22px; font-weight: 600; margin-top: 36px; margin-bottom: 12px; letter-spacing: -0.3px; }\n' +
'        h3 { font-size: 18px; font-weight: 600; margin-top: 24px; margin-bottom: 10px; }\n' +
'        h4 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }\n' +
'        p { font-size: 16px; color: var(--text-secondary); margin-bottom: 16px; }\n' +
'        ul, ol { margin: 12px 0 20px 24px; color: var(--text-secondary); }\n' +
'        li { font-size: 16px; margin-bottom: 6px; }\n' +
'        li::marker { color: var(--text-muted); }\n' +
'        code {\n' +
'            background: var(--bg-code); padding: 2px 6px; border-radius: 4px; font-size: 14px;\n' +
'            font-family: "SF Mono", Consolas, "Liberation Mono", Menlo, monospace; color: var(--text-primary);\n' +
'        }\n' +
'        pre {\n' +
'            background: var(--bg-code); padding: 16px 20px; border-radius: 8px;\n' +
'            overflow-x: auto; margin: 16px 0 20px; font-size: 14px; line-height: 1.6;\n' +
'            border: 1px solid var(--border); transition: background var(--transition), border-color var(--transition);\n' +
'        }\n' +
'        pre code { background: none; padding: 0; }\n' +
'        blockquote {\n' +
'            border-left: 3px solid var(--border); padding: 4px 16px; margin: 16px 0 20px;\n' +
'            color: var(--text-muted); font-style: italic; transition: border-color var(--transition);\n' +
'        }\n' +
'        .table-wrap { overflow-x: auto; margin: 16px 0 20px; }\n' +
'        table { width: 100%; border-collapse: collapse; font-size: 14px; }\n' +
'        th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }\n' +
'        th { background: var(--bg-code); font-weight: 600; }\n' +
'        a { color: var(--text-primary); text-decoration: underline; text-underline-offset: 2px; transition: opacity var(--transition); }\n' +
'        a:hover { opacity: 0.6; }\n' +
'        strong { color: var(--text-primary); font-weight: 600; }\n' +
'        img { max-width: 100%; border-radius: var(--radius); margin: 8px 0; }\n' +
'        hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; transition: border-color var(--transition); }\n' +
'        /* 阅读量 */\n' +
'        .meta .views { display: inline-flex; align-items: center; gap: 5px; }\n' +
'        .meta .views svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n' +
'        /* 点赞按钮 */\n' +
'        .post-actions { margin-top: 44px; padding-top: 28px; border-top: 1px solid var(--border); display: flex; justify-content: center; transition: border-color var(--transition); }\n' +
'        .like-btn {\n' +
'            display: inline-flex; align-items: center; gap: 8px; padding: 10px 28px;\n' +
'            border: 1px solid var(--border); border-radius: 99px; background: var(--bg-card);\n' +
'            color: var(--text-secondary); font-size: 14px; font-family: var(--font); cursor: pointer;\n' +
'            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), border-color var(--transition), color var(--transition), background var(--transition), box-shadow 0.3s ease;\n' +
'        }\n' +
'        .like-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,0.08); }\n' +
'        .like-btn:active { transform: scale(0.94); }\n' +
'        .like-btn svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: fill 0.25s ease, transform 0.3s ease; }\n' +
'        .like-btn.liked { color: #e0245e; border-color: rgba(224,36,94,0.35); background: rgba(224,36,94,0.06); }\n' +
'        .like-btn.liked svg { fill: currentColor; }\n' +
'        .like-btn.bump { animation: likeBump 0.55s cubic-bezier(0.34, 1.56, 0.64, 1); }\n' +
'        @keyframes likeBump { 0% { transform: scale(1); } 40% { transform: scale(1.28) rotate(-8deg); } 70% { transform: scale(0.9); } 100% { transform: scale(1); } }\n' +
'        /* 点赞数徽章 */\n' +
'        .like-num {\n' +
'            min-width: 20px; padding: 1px 8px; border-radius: 99px;\n' +
'            background: var(--bg-hover); color: var(--text-secondary);\n' +
'            font-size: 12.5px; font-weight: 600; line-height: 1.6;\n' +
'            font-variant-numeric: tabular-nums;\n' +
'            transition: background var(--transition), color var(--transition);\n' +
'        }\n' +
'        .like-btn.liked .like-num { background: rgba(224,36,94,0.14); color: #e0245e; }\n' +
'        .like-num.pop { animation: numPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); }\n' +
'        @keyframes numPop { 0% { transform: scale(1); } 40% { transform: scale(1.4); } 100% { transform: scale(1); } }\n' +
'        /* 评论区 */\n' +
'        .comments { margin-top: 56px; }\n' +
'        .comments-title {\n' +
'            font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: 20px;\n' +
'            display: flex; align-items: center; gap: 8px;\n' +
'        }\n' +
'        .comments-title svg { width: 18px; height: 18px; stroke: var(--text-muted); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n' +
'        .comments-title .cmt-hint { font-size: 12px; font-weight: 400; color: var(--text-muted); margin-left: auto; }\n' +
'        /* 评论容器预留高度：giscus 延迟加载后撑开页面时不至于跳动 */\n' +
'        .giscus { min-height: 240px; }\n' +
SHARE_CSS +
ARTICLE_CSS +
VT_ALL_CSS +
'        @media (max-width: 600px) {\n' +
'            h1 { font-size: 26px; }\n' +
'            h2 { font-size: 20px; }\n' +
'            .container { padding: 0 16px; }\n' +
'        }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'    <div class="container">\n' +
'        <nav class="nav">\n' +
'            <a class="back-link" href="/">\n' +
'                <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>\n' +
'                返回首页\n' +
'            </a>\n' +
'            <button class="icon-btn" id="themeToggle" title="切换主题">\n' +
'                <svg id="themeIcon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>\n' +
'            </button>\n' +
'        </nav>\n' +
'        <article>\n' +
'            <h1>' + escapeHtml(title) + '</h1>\n' +
'            <div class="meta">\n' +
'                <span>' + escapeHtml(date) + '</span>\n' +
'                tagChipsSlot' +
'                <span class="views" id="viewCount" style="display:none">\n' +
'                    <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>\n' +
'                    <span id="viewCountText"></span>\n' +
'                </span>\n' +
'            </div>\n' +
'            <div class="content">\n' +
bodyHtml + '\n' +
'            </div>\n' +
'            <div class="post-actions">\n' +
'                <button class="like-btn" id="likeBtn" aria-label="点赞这篇文章">\n' +
'                    <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>\n' +
'                    <span id="likeText">点赞</span>\n' +
'                    <span class="like-num" id="likeNum" style="display:none">0</span>\n' +
'                </button>\n' +
'            </div>\n' +
'            <section class="comments">\n' +
'                <div class="comments-title">评论\n' +
'                    <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>\n' +
'                    <span class="cmt-hint">基于 GitHub Discussions</span>\n' +
'                </div>\n' +
'                <div class="giscus"></div>\n' +
'            </section>\n' +
'        </article>\n' +
'    </div>\n' +
ARTICLE_HTML +
SHARE_HTML +
'    <script>\n' +
'        (function() {\n' +
'            var THEME_KEY = "hzk-theme";\n' +
'            var saved = "light";\n' +
'            try { saved = localStorage.getItem(THEME_KEY) || "light"; } catch (e) {}\n' +
'            document.documentElement.setAttribute("data-theme", saved);\n' +
'            var icon = document.getElementById("themeIcon");\n' +
'            function setIcon(t) {\n' +
'                icon.innerHTML = t === "dark"\n' +
'                    ? \'<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>\'\n' +
'                    : \'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>\';\n' +
'            }\n' +
'            setIcon(saved);\n' +
'            /* giscus 评论主题跟随切换 */\n' +
'            function syncGiscus(t) {\n' +
'                var f = document.querySelector("iframe.giscus-frame");\n' +
'                if (f && f.contentWindow) {\n' +
'                    f.contentWindow.postMessage({ giscus: { setConfig: { theme: t === "dark" ? "dark" : "light" } } }, "https://giscus.app");\n' +
'                }\n' +
'            }\n' +
'            document.getElementById("themeToggle").addEventListener("click", function() {\n' +
'                var cur = document.documentElement.getAttribute("data-theme");\n' +
'                var next = cur === "dark" ? "light" : "dark";\n' +
'                document.documentElement.setAttribute("data-theme", next);\n' +
'                try { localStorage.setItem(THEME_KEY, next); } catch (e) {}\n' +
'                setIcon(next);\n' +
'                syncGiscus(next);\n' +
'            });\n' +
'        })();\n' +
SHARE_JS +
ARTICLE_JS +
VT_NAV_JS +
'    </script>\n' +
'    <script>\n' +
'        /* giscus 评论：滚动到评论区附近才加载（rootMargin 提前 400px 预取），\n' +
'         * 首屏不再等待第三方脚本，页面渲染更快；主题取自当前偏好，保证初始主题一致。 */\n' +
'        (function() {\n' +
'            var box = document.querySelector(".giscus");\n' +
'            if (!box) return;\n' +
'            var loaded = false;\n' +
'            function loadGiscus() {\n' +
'                if (loaded) return;\n' +
'                loaded = true;\n' +
'                var t = "light";\n' +
'                try { t = localStorage.getItem("hzk-theme") || "light"; } catch (e) {}\n' +
'                var s = document.createElement("script");\n' +
'                s.src = "https://giscus.app/client.js";\n' +
'                s.setAttribute("data-repo", "HZK-Team/hzk-blog-comment");\n' +
'                s.setAttribute("data-repo-id", "R_kgDOU4UUIw");\n' +
'                s.setAttribute("data-category", "Announcements");\n' +
'                s.setAttribute("data-category-id", "DIC_kwDOU4UUI84DG3IT");\n' +
'                s.setAttribute("data-mapping", "pathname");\n' +
'                s.setAttribute("data-strict", "0");\n' +
'                s.setAttribute("data-reactions-enabled", "1");\n' +
'                s.setAttribute("data-emit-metadata", "0");\n' +
'                s.setAttribute("data-input-position", "bottom");\n' +
'                s.setAttribute("data-theme", t === "dark" ? "dark" : "light");\n' +
'                s.setAttribute("data-lang", "zh-CN");\n' +
'                s.crossOrigin = "anonymous";\n' +
'                s.async = true;\n' +
'                box.appendChild(s);\n' +
'                /* giscus 渲染出 iframe 后同步一次当前主题，\n' +
'                 * 覆盖「脚本加载期间用户刚好切换了主题」的情况 */\n' +
'                var tries = 0;\n' +
'                var timer = setInterval(function() {\n' +
'                    var f = document.querySelector("iframe.giscus-frame");\n' +
'                    if (!f) { if (++tries > 25) clearInterval(timer); return; }\n' +
'                    clearInterval(timer);\n' +
'                    var cur = "light";\n' +
'                    try { cur = localStorage.getItem("hzk-theme") || "light"; } catch (e) {}\n' +
'                    if (f.contentWindow) {\n' +
'                        f.contentWindow.postMessage({ giscus: { setConfig: { theme: cur === "dark" ? "dark" : "light" } } }, "https://giscus.app");\n' +
'                    }\n' +
'                }, 200);\n' +
'            }\n' +
'            if (window.IntersectionObserver) {\n' +
'                var io = new IntersectionObserver(function(entries) {\n' +
'                    entries.forEach(function(en) {\n' +
'                        if (!en.isIntersecting) return;\n' +
'                        io.disconnect();\n' +
'                        loadGiscus();\n' +
'                    });\n' +
'                }, { rootMargin: "400px 0px" });\n' +
'                io.observe(box);\n' +
'            } else {\n' +
'                loadGiscus();  // 不支持 IO 的浏览器直接加载\n' +
'            }\n' +
'        })();\n' +
'    </script>\n' +
'</body>\n' +
'</html>\n';
}

/* ================= Markdown 文章处理 ================= */

function processMarkdownPost(mdFile) {
    const mdPath = path.join(postsDir, mdFile);
    const raw = fs.readFileSync(mdPath, 'utf8');
    const parsed = parseFrontMatter(raw);
    const meta = parsed.meta;

    if (meta.draft) {
        console.log('[generate-posts] 跳过草稿: ' + mdFile);
        return null;
    }

    // 文件名：003-my-post.md → 003-my-post.html；URL 用干净路径 /blog/003-my-post
    const htmlFile = mdFile.replace(/\.md$/i, '.html');
    const cleanSlug = htmlFile.replace(/\.html$/, '');
    const title = meta.title || htmlFile.replace('.html', '').replace(/-/g, ' ');
    const bodyHtml = markdownToHtml(parsed.body.trim());

    // 生成文章页（标签 chips 插入 meta 区域）
    let html = buildArticleHtml({
        title: title,
        date: meta.date || '',
        excerpt: meta.excerpt || stripTags(bodyHtml).slice(0, 80),
        tags: meta.tags || [],
        url: '/blog/' + cleanSlug
    }, bodyHtml);
    html = html.replace('tagChipsSlot', (meta.tags || []).length ? tagChipsHtml(meta.tags) : '');

    fs.writeFileSync(path.join(blogDir, htmlFile), html);
    console.log('[generate-posts] Markdown 已渲染: ' + mdFile + ' → blog/' + htmlFile);

    return {
        file: htmlFile,
        url: '/blog/' + cleanSlug,
        title: title,
        date: meta.date || '',
        excerpt: meta.excerpt || '',
        tags: meta.tags || [],
        content: stripTags(bodyHtml).slice(0, 4000)
    };
}

function tagChipsHtml(tags) {
    return tags.map(function(t) {
        return '<span class="tag-chip"># ' + escapeHtml(t) + '</span>';
    }).join('');
}

/* ================= 旧版 HTML 文章处理 ================= */

function extractHtmlMeta(content, file) {
    let title = file.replace('.html', '').replace(/-/g, ' ');
    let date = '';
    let excerpt = '';
    let tags = [];

    const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();

    const dateMatch = content.match(/<meta\s+name=["']date["']\s+content=["']([^"']*)["']\s*\/?>/i);
    if (dateMatch) date = dateMatch[1].trim();

    const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']\s*\/?>/i);
    if (descMatch) excerpt = descMatch[1].trim();

    const tagsMatch = content.match(/<meta\s+name=["']tags["']\s+content=["']([^"']*)["']\s*\/?>/i);
    if (tagsMatch) {
        tags = tagsMatch[1].split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    }

    return {
        file: file,
        url: '/blog/' + file.replace(/\.html$/, ''),
        title: title,
        date: date,
        excerpt: excerpt,
        tags: tags,
        content: stripTags(content).slice(0, 4000)
    };
}

/* ================= RSS / sitemap / robots 生成 ================= */

function xmlEscape(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function rfc822Date(dateStr) {
    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d.toUTCString();
    } catch (e) { /* 日期解析失败时用当前时间 */ }
    return new Date().toUTCString();
}

function buildRss(posts) {
    // posts 按文件名升序，新文章在后 → 反转后最新在前
    const items = posts.slice().reverse().map(function(p) {
        const link = SITE_URL + p.url;
        return '    <item>\n' +
            '      <title>' + xmlEscape(p.title) + '</title>\n' +
            '      <link>' + xmlEscape(link) + '</link>\n' +
            '      <guid isPermaLink="true">' + xmlEscape(link) + '</guid>\n' +
            '      <description>' + xmlEscape(p.excerpt || p.title) + '</description>\n' +
            (p.date ? '      <pubDate>' + rfc822Date(p.date) + '</pubDate>\n' : '') +
            (p.tags && p.tags.length ? p.tags.map(function(t) {
                return '      <category>' + xmlEscape(t) + '</category>';
            }).join('\n') + '\n' : '') +
            '    </item>';
    }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
        '  <channel>\n' +
        '    <title>' + xmlEscape(SITE_TITLE) + '</title>\n' +
        '    <link>' + SITE_URL + '</link>\n' +
        '    <description>' + xmlEscape(SITE_DESCRIPTION) + '</description>\n' +
        '    <language>zh-CN</language>\n' +
        '    <atom:link href="' + SITE_URL + '/rss.xml" rel="self" type="application/rss+xml" />\n' +
        '    <lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
        items + '\n' +
        '  </channel>\n' +
        '</rss>\n';
}

function buildSitemap(posts) {
    const today = new Date().toISOString().slice(0, 10);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        '  <url>\n' +
        '    <loc>' + SITE_URL + '/</loc>\n' +
        '    <lastmod>' + today + '</lastmod>\n' +
        '    <changefreq>daily</changefreq>\n' +
        '    <priority>1.0</priority>\n' +
        '  </url>\n';
    posts.forEach(function(p) {
        xml += '  <url>\n' +
            '    <loc>' + xmlEscape(SITE_URL + p.url) + '</loc>\n' +
            (p.date ? '    <lastmod>' + xmlEscape(p.date) + '</lastmod>\n' : '') +
            '    <changefreq>weekly</changefreq>\n' +
            '    <priority>0.8</priority>\n' +
            '  </url>\n';
    });
    return xml + '</urlset>\n';
}

function buildRobots() {
    return 'User-agent: *\n' +
        'Allow: /\n' +
        '\n' +
        'Sitemap: ' + SITE_URL + '/sitemap.xml\n';
}

/* ================= 内联文章数据到首页（消除回首页的骨架屏） =================
 * 把文章列表作为 window.HZK_POSTS 直接写进 index.html 的标记区：
 *   - 首页脚本同步读取 → 零请求、零等待渲染，返回首页不再闪骨架屏
 *   - View Transition 快照时列表已渲染完成，滑动进入即是完整内容
 * 数据中的 "<" 一律转义为 \u003c，防止正文出现 </script> 截断脚本。
 */

const POSTS_MARK_START = '<!-- HZK_POSTS_START -->';
const POSTS_MARK_END = '<!-- HZK_POSTS_END -->';

function injectInlinePosts(posts) {
    const indexPath = path.join(projectRoot, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.warn('[generate-posts] 未找到 index.html，跳过内联数据注入');
        return;
    }

    const html = fs.readFileSync(indexPath, 'utf8');
    const start = html.indexOf(POSTS_MARK_START);
    const end = html.indexOf(POSTS_MARK_END);
    if (start < 0 || end < 0 || start >= end) {
        console.warn('[generate-posts] index.html 缺少内联数据标记区，跳过注入');
        return;
    }

    const data = JSON.stringify(posts).replace(/</g, '\\u003c');
    const block = POSTS_MARK_START + '\n' +
        '    <script>window.HZK_POSTS=' + data + ';</script>\n' +
        '    ' + POSTS_MARK_END;

    const next = html.slice(0, start) + block + html.slice(end + POSTS_MARK_END.length);
    if (next === html) {
        console.log('[generate-posts] 内联数据无变化，跳过写入');
        return;
    }

    fs.writeFileSync(indexPath, next);
    console.log('[generate-posts] 已内联 ' + posts.length + ' 篇文章数据到 index.html（' +
        (Buffer.byteLength(data) / 1024).toFixed(1) + ' KB）');
}

/* ================= 主流程 ================= */

function main() {
    if (!fs.existsSync(blogDir)) fs.mkdirSync(blogDir, { recursive: true });

    // 1. 清理上次构建生成的 Markdown 渲染页（避免改名/删除后残留）
    let cleaned = 0;
    fs.readdirSync(blogDir).filter(function(f) { return f.endsWith('.html'); }).forEach(function(f) {
        const p = path.join(blogDir, f);
        try {
            const head = fs.readFileSync(p, 'utf8').slice(0, 200);
            if (head.indexOf(GENERATED_MARK) !== -1) {
                fs.unlinkSync(p);
                cleaned++;
            }
        } catch (e) { /* 忽略读取失败 */ }
    });
    if (cleaned > 0) console.log('[generate-posts] 已清理 ' + cleaned + ' 个上次生成的文章页');

    const posts = [];
    const generatedFiles = {};

    // 2. 处理 Markdown 文章
    if (fs.existsSync(postsDir)) {
        const mdFiles = fs.readdirSync(postsDir).filter(function(f) { return f.toLowerCase().endsWith('.md'); });
        console.log('[generate-posts] 找到 ' + mdFiles.length + ' 篇 Markdown 文章');
        mdFiles.forEach(function(f) {
            try {
                const post = processMarkdownPost(f);
                if (post) {
                    posts.push(post);
                    generatedFiles[post.file] = true;
                }
            } catch (e) {
                console.error('[generate-posts] Markdown 处理失败: ' + f + ' → ' + e.message);
            }
        });
    } else {
        console.log('[generate-posts] posts/ 目录不存在，跳过 Markdown 管线');
    }

    // 3. 处理旧版 HTML 文章（跳过本次已由 Markdown 生成的页面，避免重复）
    const htmlFiles = fs.readdirSync(blogDir).filter(function(f) {
        return f.endsWith('.html') && !generatedFiles[f];
    });
    console.log('[generate-posts] 找到 ' + htmlFiles.length + ' 篇 HTML 文章');
    htmlFiles.forEach(function(f) {
        try {
            const content = fs.readFileSync(path.join(blogDir, f), 'utf8');
            posts.push(extractHtmlMeta(content, f));
        } catch (e) {
            console.error('[generate-posts] 读取失败: ' + f + ' → ' + e.message);
        }
    });

    // 4. 按文件名排序
    posts.sort(function(a, b) { return a.file.localeCompare(b.file); });
    console.log('[generate-posts] 共 ' + posts.length + ' 篇文章待发布');

    const json = JSON.stringify(posts, null, 2);

    // 5. 写入项目根目录（publish 目录）→ 前端 fetch /posts.json
    fs.writeFileSync(path.join(projectRoot, 'posts.json'), json);
    console.log('[generate-posts] 已生成 posts.json');

    // 5.5 内联到首页：列表零请求同步渲染（消除回首页的骨架屏）
    injectInlinePosts(posts);

    // 6. 写入函数目录 → Netlify Function 运行时可读取
    const funcDir = path.join(projectRoot, 'netlify', 'functions', 'list-posts');
    if (fs.existsSync(funcDir)) {
        fs.writeFileSync(path.join(funcDir, 'posts-data.json'), json);
        console.log('[generate-posts] 已生成 posts-data.json (函数目录)');
    }

    // 7. 生成 SEO 产物：RSS 订阅 / sitemap / robots
    fs.writeFileSync(path.join(projectRoot, 'rss.xml'), buildRss(posts));
    console.log('[generate-posts] 已生成 rss.xml');

    fs.writeFileSync(path.join(projectRoot, 'sitemap.xml'), buildSitemap(posts));
    console.log('[generate-posts] 已生成 sitemap.xml');

    fs.writeFileSync(path.join(projectRoot, 'robots.txt'), buildRobots());
    console.log('[generate-posts] 已生成 robots.txt');
}

main();
