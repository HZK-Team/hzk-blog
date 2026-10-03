import crypto from 'node:crypto';

/**
 * Netlify Function: 联系表单 → 钉钉群推送
 *
 * 链路（两种模式都支持）：
 *
 *   模式一（默认，推荐）：contact.html（Netlify Forms）
 *     → Netlify 表单通知（Outgoing webhook）
 *     → POST /api/contact-notify（JSON）
 *     → 本函数组装 markdown → 钉钉自定义机器人
 *     ⚠️ 前置条件：Netlify 后台必须开启 Form detection 并重新部署，否则表单不会被接管
 *
 *   模式二（备用）：contact.html 直接 fetch POST 本函数（application/x-www-form-urlencoded）
 *     不依赖 Netlify Forms；自带蜜罐 bot-field 拦截；可返回 JSON 供前端做行内成功动画
 *
 * 为什么需要这一层：
 *   钉钉机器人只认自己的 JSON 结构（msgtype/markdown），
 *   Netlify 发来的是「表单提交快照」，两者必须做一次翻译。
 *
 * 环境变量（Netlify → Site configuration → Environment variables，改完需重新部署）：
 *   DINGTALK_WEBHOOK     必填。机器人 Webhook 完整地址（含 access_token）
 *   DINGTALK_SECRET      选填。安全设置选「加签」时填密钥
 *   DINGTALK_KEYWORD     选填。安全设置选「自定义关键词」时填那个关键词
 *   DINGTALK_AT_MOBILE   选填。需要 @ 某人时填手机号，多个用英文逗号分隔
 *
 * 调试：POST /api/contact-notify?dry=1 → 只返回组装好的文案，不发送、不需要环境变量。
 *
 * 注意：钉钉的 markdown 只支持 标题/引用/加粗/斜体/列表/链接/图片，**不支持表格**，
 *       也不支持代码块高亮。机器人限流 20 条/分钟。
 */

const MAX_TEXT = 4500;     // 钉钉 markdown 正文安全上限（官方建议 500，实测可远大于此）
const MAX_MESSAGE = 2000;  // 用户留言截断长度，与表单 maxlength 保持一致

/* 负载里属于元数据、不用于展示的字段 */
const SKIP_FIELDS = ['form-name', 'bot-field', 'subject', 'ip', 'user_agent', 'referrer'];

/* 蜜罐字段名：被填写即视为机器人，静默丢弃（不发送、不报错） */
const HONEYPOT = 'bot-field';

/* 钉钉常见错误码 → 人话提示 */
const DING_HINT = {
    310000: '（安全设置未通过：用「加签」要配 DINGTALK_SECRET，用「自定义关键词」要配 DINGTALK_KEYWORD）',
    400101: '（access_token 不存在，检查 DINGTALK_WEBHOOK 是否为完整地址）',
    400102: '（机器人已停用，请在钉钉群里启用）',
    400106: '（机器人不在群里了，重新添加或换群）',
    43004: '（Content-Type 必须是 application/json）',
    410100: '（发送太快被限流，机器人上限 20 条/分钟）',
    430101: '（内容含不安全外链，被钉钉拦截）'
};

function str(v) {
    return v === null || v === undefined ? '' : String(v);
}

/* 单行字段：压掉换行并转义会破坏 markdown 的字符 */
function mdSafe(v) {
    return str(v).replace(/\s*\n+\s*/g, ' ').trim().replace(/([*_`\[\]\\])/g, '\\$1');
}

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

/**
 * 把 Netlify 的表单负载整理成统一结构。
 * 兼容两种来源：表单通知 webhook（扁平对象）与事件函数（{ payload: {...} } 包裹）。
 */
function normalize(raw) {
    const p = (raw && raw.payload ? raw.payload : raw) || {};
    const data = p.data && typeof p.data === 'object' ? p.data : {};
    const ordered = Array.isArray(p.ordered_human_fields) ? p.ordered_human_fields : [];

    const fields = [];
    const seen = Object.create(null);

    /* 优先用 ordered_human_fields：它带 HTML 里的字段标题，顺序也和人填表一致 */
    ordered.forEach(function (f) {
        const key = str(f && (f.name || f.title));
        if (!key || SKIP_FIELDS.indexOf(key) >= 0) return;
        seen[key] = 1;
        fields.push({ key: key, label: str(f.title || f.name || key), value: str(f.value) });
    });

    /* 补上 ordered_human_fields 里没有的字段，并剔除 ip / user_agent 等元数据 */
    Object.keys(data).forEach(function (k) {
        if (seen[k] || SKIP_FIELDS.indexOf(k) >= 0) return;
        fields.push({ key: k, label: k, value: str(data[k]) });
    });

    const pick = function (k) {
        for (let i = 0; i < fields.length; i++) {
            if (fields[i].key === k) return fields[i].value;
        }
        return '';
    };

    return {
        name: pick('name') || str(p.name) || '匿名访客',
        email: pick('email') || str(p.email),
        message: (pick('message') || str(p.body)).slice(0, MAX_MESSAGE),
        extra: fields.filter(function (f) {
            return ['name', 'email', 'message'].indexOf(f.key) < 0;
        }),
        number: p.number || '',
        siteUrl: str(p.site_url),
        createdAt: str(p.created_at),
        referrer: str(data.referrer)
    };
}

function buildText(raw) {
    const info = normalize(raw);
    const lines = [];

    lines.push('#### 博客收到新留言');
    lines.push('');
    lines.push('> **' + mdSafe(info.name) + '** 从联系页面发来消息');
    lines.push('');
    lines.push('- **称呼**：' + mdSafe(info.name));
    lines.push('- **邮箱**：' + (info.email ? mdSafe(info.email) : '未填写'));
    if (info.createdAt) lines.push('- **时间**：' + mdSafe(fmtTime(info.createdAt)));
    info.extra.forEach(function (f) {
        lines.push('- **' + mdSafe(f.label) + '**：' + mdSafe(f.value));
    });
    lines.push('');
    lines.push('**留言内容**');
    lines.push('');
    lines.push(info.message ? info.message : '（空）');

    const tail = [];
    if (info.referrer) {
        tail.push('- **来源页面**：[' + mdSafe(info.referrer) + '](' + info.referrer + ')');
    }
    if (info.number) {
        tail.push('- **第 ' + info.number + ' 条留言**');
    }
    if (info.email) {
        tail.push('- **直接回信**：[' + mdSafe(info.email) + '](mailto:' + info.email + ')');
    }
    if (tail.length) {
        lines.push('');
        tail.forEach(function (t) { lines.push(t); });
    }

    return lines.join('\n').slice(0, MAX_TEXT);
}

/* 加签：sign = urlencode(base64(hmacSHA256(secret, timestamp + "\n" + secret))) */
function signUrl(webhook, secret) {
    if (!secret) return webhook;
    const timestamp = Date.now();
    const sign = encodeURIComponent(
        crypto.createHmac('sha256', secret).update(timestamp + '\n' + secret, 'utf8').digest('base64')
    );
    return webhook + (webhook.indexOf('?') >= 0 ? '&' : '?') + 'timestamp=' + timestamp + '&sign=' + sign;
}

async function sendDingTalk(text) {
    const webhook = process.env.DINGTALK_WEBHOOK || '';
    const secret = process.env.DINGTALK_SECRET || '';
    const keyword = process.env.DINGTALK_KEYWORD || '';

    if (!webhook) {
        throw new Error('缺少环境变量 DINGTALK_WEBHOOK（Netlify 站点环境变量里未配置）');
    }

    /* 关键词安全设置要求消息内容包含该关键词，正文和会话标题都补上 */
    const title = (keyword ? keyword + ' ' : '') + '博客新留言';
    let body = (keyword ? keyword + '\n\n' : '') + text;

    const payload = { msgtype: 'markdown', markdown: { title: title, text: body } };

    const mobiles = (process.env.DINGTALK_AT_MOBILE || '')
        .split(',').map(function (m) { return m.trim(); }).filter(Boolean);
    if (mobiles.length) {
        payload.at = { atMobiles: mobiles, isAtAll: false };
        payload.markdown.text += '\n\n' + mobiles.map(function (m) { return '@' + m; }).join(' ');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
        const r = await fetch(signUrl(webhook, secret), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl.signal
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || (j.errcode !== undefined && j.errcode !== 0)) {
            const code = j.errcode !== undefined ? j.errcode : r.status;
            throw new Error('钉钉返回 ' + code + ' ' + (j.errmsg || '') + (DING_HINT[code] || ''));
        }
        return j;
    } finally {
        clearTimeout(timer);
    }
}

/** 把浏览器直连提交的 urlencoded / multipart 表单转成与 Netlify 通知一致的结构。
 *  三个核心字段（name/email/message）的标题由 buildText 统一渲染，这里用原始字段名即可。 */
function fromFormData(data, origin) {
    const keys = Object.keys(data).filter(function (k) { return k !== 'form-name'; });
    return {
        form_name: data['form-name'] || 'contact',
        site_url: origin || '',
        created_at: new Date().toISOString(),
        data: data,
        ordered_human_fields: keys.map(function (k) {
            return { title: k, name: k, value: data[k] };
        })
    };
}

export default async (req) => {
    const url = new URL(req.url);

    if (req.method !== 'POST') {
        return Response.json(
            { error: 'POST only', hint: '这是 Netlify 表单通知的回调地址，请勿直接访问' },
            { status: 405 }
        );
    }

    const ctype = (req.headers.get('content-type') || '').toLowerCase();
    let payload;

    if (ctype.indexOf('form-urlencoded') >= 0 || ctype.indexOf('multipart/form-data') >= 0) {
        /* ===== 模式二：浏览器表单直连（方案 B，不经过 Netlify Forms）===== */
        let data;
        try {
            const form = await req.formData();
            data = {};
            form.forEach(function (v, k) { if (typeof v === 'string') data[k] = v; });
        } catch (e) {
            return Response.json({ ok: false, error: 'invalid form body' }, { status: 400 });
        }

        /* 蜜罐被填写 → 静默丢弃，伪装成功（不给机器人任何反馈） */
        if (str(data[HONEYPOT]).trim() !== '') {
            console.log('[contact-notify] 蜜罐字段被填写，已丢弃该提交');
            return Response.json({ ok: true, dropped: 'honeypot' });
        }

        payload = fromFormData(data, url.origin);
    } else {
        /* ===== 模式一：Netlify 表单通知 webhook（JSON）===== */
        try {
            payload = await req.json();
        } catch (e) {
            return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
        }
    }

    const text = buildText(payload);

    /* 调试模式：只看文案，不发送 */
    if (url.searchParams.get('dry') === '1') {
        return Response.json({ ok: true, dryRun: true, text: text });
    }

    try {
        const result = await sendDingTalk(text);
        console.log('[contact-notify] 已推送到钉钉群', JSON.stringify(result));
        return Response.json({ ok: true, dingtalk: result });
    } catch (e) {
        console.error('[contact-notify] 推送失败：' + e.message);
        return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
};

export const config = { path: '/api/contact-notify' };
