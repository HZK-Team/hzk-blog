import { getStore } from '@netlify/blobs';

/**
 * Netlify Function: 文章点赞
 *
 * GET  /api/likes?slug=001-hello-world          → 读取当前点赞数（不改变数据）
 * POST /api/likes  body: { slug, action }        → action: "like" | "unlike"，返回最新总数
 * 数据存于 Netlify Blobs 的 metrics store
 */

function cleanSlug(raw) {
    return String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 120);
}

function json(obj, status) {
    return Response.json(obj, {
        status: status || 200,
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
    });
}

export default async (req) => {
    const store = getStore('metrics');

    /* ===== 读取点赞数 ===== */
    if (req.method === 'GET') {
        const slug = cleanSlug(new URL(req.url).searchParams.get('slug'));
        if (!slug) return json({ error: 'missing slug' }, 400);
        try {
            const cur = parseInt((await store.get('likes:' + slug)) || '0', 10);
            return json({ likes: cur });
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    /* ===== 点赞 / 取消点赞 ===== */
    if (req.method !== 'POST') {
        return json({ error: 'GET or POST only' }, 405);
    }

    let body = {};
    try { body = await req.json(); } catch (e) { /* 空 body */ }

    const slug = cleanSlug(body.slug);
    if (!slug) return json({ error: 'missing slug' }, 400);

    try {
        const key = 'likes:' + slug;
        const cur = parseInt((await store.get(key)) || '0', 10);
        const next = Math.max(0, cur + (body.action === 'unlike' ? -1 : 1));
        await store.set(key, String(next));
        return json({ likes: next });
    } catch (e) {
        return json({ error: e.message }, 500);
    }
};

export const config = { path: '/api/likes' };
