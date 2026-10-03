/**
 * 本地预览服务器：模拟 Netlify 上线效果
 *
 * 用法：node scripts/preview-server.js [端口]   （默认 1024）
 *
 * - 静态托管项目根目录（index.html / blog/ / posts.json / Logo.png ...）
 * - 正确的 MIME 类型与 UTF-8 编码
 * - 目录路径自动补 index.html / pretty URL（/blog/xxx → xxx.html）
 * - 404 返回站点 404.html
 * - 模拟 Netlify Functions：
 *     GET  /api/views?slug=xxx   → 阅读量 +1 并返回
 *     POST /api/likes            → 点赞 / 取消点赞并返回
 *     POST /api/contact-notify   → 模拟「表单通知 → 钉钉群」链路
 * - 模拟 Netlify Forms：POST 表单后展示目标页（如 /thanks），
 *   同时打印将要推送到钉钉的文案；若设置了环境变量会真实发送
 *   计数数据存于系统临时目录 JSON 文件，重启不清零（模拟持久化）
 *
 * 本地验证钉钉推送（PowerShell）：
 *   $env:DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=xxx"
 *   $env:DINGTALK_SECRET="SECxxxxx"      # 机器人安全设置选「加签」时
 *   node scripts/preview-server.js
 * 然后打开 http://localhost:1024/contact 填表提交，看控制台与钉钉群。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 1024;
const METRICS_FILE = path.join(os.tmpdir(), 'hzk-blog-preview-metrics.json');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

/* ===== 模拟 Blobs 计数存储 ===== */
function loadMetrics() {
    try { return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMetrics(data) {
    try { fs.writeFileSync(METRICS_FILE, JSON.stringify(data)); } catch (e) { /* 忽略 */ }
}
function cleanSlug(s) {
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

function apiViews(slug, res) {
    const data = loadMetrics();
    const key = 'views:' + slug;
    data[key] = (data[key] || 0) + 1;
    saveMetrics(data);
    json(res, 200, { views: data[key] });
}

function apiLikes(body, res) {
    const slug = cleanSlug(body.slug);
    if (!slug) return json(res, 400, { error: 'missing slug' });
    const data = loadMetrics();
    const key = 'likes:' + slug;
    data[key] = Math.max(0, (data[key] || 0) + (body.action === 'unlike' ? -1 : 1));
    saveMetrics(data);
    json(res, 200, { likes: data[key] });
}

function json(res, status, obj) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj));
}

/* ===== 模拟 /api/contact-notify：Netlify 表单通知 → 钉钉群机器人 =====
   逻辑与 netlify/functions/contact-notify.mjs 保持一致（此处为 CommonJS 精简版） */

const DING_SKIP = ['form-name', 'bot-field', 'subject', 'ip', 'user_agent', 'referrer'];

function fmtTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return '';
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).format(d);
    } catch (e) {
        return d.toISOString().slice(0, 16).replace('T', ' ');
    }
}

function buildNotifyText(raw) {
    const p = (raw && raw.payload ? raw.payload : raw) || {};
    const data = (p.data && typeof p.data === 'object') ? p.data : {};
    const ordered = Array.isArray(p.ordered_human_fields) ? p.ordered_human_fields : [];

    const fields = [];
    const seen = {};
    ordered.forEach(function(f) {
        const key = String((f && (f.name || f.title)) || '');
        if (!key || DING_SKIP.indexOf(key) >= 0) return;
        seen[key] = 1;
        fields.push({ key: key, label: String(f.title || f.name || key), value: String(f.value == null ? '' : f.value) });
    });
    Object.keys(data).forEach(function(k) {
        if (seen[k] || DING_SKIP.indexOf(k) >= 0) return;
        fields.push({ key: k, label: k, value: String(data[k] == null ? '' : data[k]) });
    });

    const pick = function(k) {
        for (let i = 0; i < fields.length; i++) if (fields[i].key === k) return fields[i].value;
        return '';
    };

    const name = pick('name') || String(p.name || '') || '匿名访客';
    const email = pick('email') || String(p.email || '');
    const message = (pick('message') || String(p.body || '')).slice(0, 2000);
    const extra = fields.filter(function(f) {
        return ['name', 'email', 'message'].indexOf(f.key) < 0;
    });

    const lines = [];
    lines.push('#### 博客收到新留言');
    lines.push('');
    lines.push('> **' + name + '** 从联系页面发来消息');
    lines.push('');
    lines.push('- **称呼**：' + name);
    lines.push('- **邮箱**：' + (email || '未填写'));
    if (p.created_at) lines.push('- **时间**：' + fmtTime(p.created_at));
    extra.forEach(function(f) { lines.push('- **' + f.label + '**：' + f.value); });
    lines.push('');
    lines.push('**留言内容**');
    lines.push('');
    lines.push(message || '（空）');

    const tail = [];
    if (data.referrer) tail.push('- **来源页面**：[' + data.referrer + '](' + data.referrer + ')');
    if (p.number) tail.push('- **第 ' + p.number + ' 条留言**');
    if (email) tail.push('- **直接回信**：[' + email + '](mailto:' + email + ')');
    if (tail.length) { lines.push(''); tail.forEach(function(t) { lines.push(t); }); }

    return lines.join('\n');
}

/* 加签：sign = urlencode(base64(hmacSHA256(secret, timestamp + "\n" + secret))) */
function dingSign(url, secret) {
    if (!secret) return url;
    const timestamp = Date.now();
    const sign = encodeURIComponent(
        crypto.createHmac('sha256', secret).update(timestamp + '\n' + secret, 'utf8').digest('base64')
    );
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'timestamp=' + timestamp + '&sign=' + sign;
}

function postDingTalk(url, payload, cb) {
    const u = new URL(url);
    const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, function(r) {
        let d = '';
        r.on('data', function(c) { d += c; });
        r.on('end', function() { cb(null, r.statusCode, d); });
    });
    req.on('error', function(e) { cb(e); });
    req.setTimeout(8000, function() { req.destroy(new Error('请求钉钉超时')); });
    req.end(JSON.stringify(payload));
}

function handleNotify(payload, res) {
    const text = buildNotifyText(payload);
    console.log('\n----- 钉钉推送内容预览 -----');
    console.log(text);
    console.log('----------------------------');

    const webhook = process.env.DINGTALK_WEBHOOK || '';
    const secret = process.env.DINGTALK_SECRET || '';
    const keyword = process.env.DINGTALK_KEYWORD || '';

    if (!webhook) {
        console.log('[preview] 未设置 DINGTALK_WEBHOOK：仅本地打印，未真实发送到钉钉');
        if (res) json(res, 200, { ok: true, dryRun: true, text: text });
        return;
    }

    const body = {
        msgtype: 'markdown',
        markdown: {
            title: (keyword ? keyword + ' ' : '') + '博客新留言',
            text: (keyword ? keyword + '\n\n' : '') + text
        }
    };
    postDingTalk(dingSign(webhook, secret), body, function(err, status, raw) {
        if (err) {
            console.error('[preview] 发送钉钉失败：' + err.message);
            if (res) json(res, 500, { ok: false, error: err.message });
            return;
        }
        console.log('[preview] 钉钉返回 HTTP ' + status + ' ' + raw);
        if (res) json(res, 200, { ok: true, status: status, dingtalk: raw });
    });
}

/* ===== 静态文件服务（含 404） ===== */
function serveStatic(urlPath, res) {
    let filePath;
    try {
        filePath = path.normalize(path.join(root, decodeURIComponent(urlPath)));
    } catch (e) {
        filePath = path.join(root, 'index.html');
    }
    if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    // 目录 → index.html；无扩展名 → 补 .html（模拟 Netlify pretty URL）
    if (urlPath.endsWith('/') || !path.extname(filePath)) {
        const tryIndex = path.join(filePath, 'index.html');
        if (fs.existsSync(tryIndex) && fs.statSync(tryIndex).isFile()) {
            filePath = tryIndex;
        } else if (!path.extname(filePath)) {
            filePath = filePath + '.html';
        }
    }

    fs.readFile(filePath, function(err, data) {
        if (err) {
            const custom404 = path.join(root, '404.html');
            if (filePath !== custom404 && fs.existsSync(custom404)) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                fs.createReadStream(custom404).pipe(res);
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
                '<title>404</title><style>body{font-family:system-ui;display:flex;' +
                'align-items:center;justify-content:center;height:100vh;margin:0;' +
                'color:#6b7280;background:#fafafa}a{color:#1a1a1a}</style></head>' +
                '<body><div style="text-align:center"><div style="font-size:48px;font-weight:700;color:#1a1a1a">404</div>' +
                '<div>页面不存在</div><p><a href="/">← 返回首页</a></p></div></body></html>');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(data);
    });
}

const server = http.createServer(function(req, res) {
    const urlPath = req.url.split('?')[0];
    const query = {};
    (req.url.split('?')[1] || '').split('&').forEach(function(kv) {
        if (!kv) return;
        const p = kv.split('=');
        query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });

    /* ===== 模拟 Netlify Functions ===== */
    if (urlPath === '/api/views' && req.method === 'GET') {
        const slug = cleanSlug(query.slug);
        if (!slug) return json(res, 400, { error: 'missing slug' });
        return apiViews(slug, res);
    }
    if (urlPath === '/api/likes' && req.method === 'GET') {
        const slug = cleanSlug(query.slug);
        if (!slug) return json(res, 400, { error: 'missing slug' });
        const data = loadMetrics();
        return json(res, 200, { likes: data['likes:' + slug] || 0 });
    }
    if (urlPath === '/api/likes' && req.method === 'POST') {
        let body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) { /* 空 */ }
            apiLikes(parsed, res);
        });
        return;
    }

    /* ===== 模拟表单通知回调：POST 一个 Netlify 负载 → 组装并推送钉钉 ===== */
    if (urlPath === '/api/contact-notify') {
        let body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
            if (req.method === 'GET' || !body) {
                return json(res, 200, {
                    ok: true,
                    hint: 'POST 一个 Netlify 表单负载（JSON）。设置 DINGTALK_WEBHOOK / DINGTALK_SECRET 后会真实发送到钉钉群。',
                    sample: buildNotifyText({
                        number: 1,
                        created_at: new Date().toISOString(),
                        form_name: 'contact',
                        data: { name: '示例访客', email: 'demo@example.com', message: '这是一条本地预览用的测试留言。' }
                    })
                });
            }
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
            handleNotify(parsed, res);
        });
        return;
    }

    /* ===== 模拟 Netlify Forms：POST 表单 → 模拟表单通知 + 展示目标页 ===== */
    if (req.method === 'POST') {
        let body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
            const fields = {};
            body.split('&').forEach(function(kv) {
                if (!kv) return;
                const i = kv.indexOf('=');
                const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
                const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
                if (k) fields[k] = v;
            });

            if (fields['form-name']) {
                console.log('[preview] 收到表单提交（' + fields['form-name'] + '）→ 触发模拟通知，然后展示 ' + urlPath);
                handleNotify({
                    form_name: fields['form-name'],
                    site_url: 'http://localhost:' + PORT,
                    created_at: new Date().toISOString(),
                    data: fields,
                    ordered_human_fields: Object.keys(fields)
                        .filter(function(k) { return k !== 'form-name'; })
                        .map(function(k) { return { title: k, name: k, value: fields[k] }; })
                }, null);
            } else {
                console.log('[preview] 收到表单提交 → 展示 ' + urlPath);
            }
            serveStatic(urlPath, res);
        });
        return;
    }

    serveStatic(urlPath, res);
});

server.listen(PORT, function() {
    console.log('[preview] HZK-Blog 预览服务已启动');
    console.log('[preview] 地址: http://localhost:' + PORT);
    console.log('[preview] 托管目录: ' + root);
    console.log('[preview] 模拟接口: GET /api/views · POST /api/likes · POST /api/contact-notify · 表单 POST');
    console.log('[preview] 计数存储: ' + METRICS_FILE);
    console.log('[preview] 钉钉推送: ' + (process.env.DINGTALK_WEBHOOK
        ? '已配置 Webhook，表单提交会真实发送' + (process.env.DINGTALK_SECRET ? '（加签）' : '（未加签）')
        : '未配置 DINGTALK_WEBHOOK，仅在控制台打印预览'));
});
