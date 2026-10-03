import { getStore } from '@netlify/blobs';

/**
 * Netlify Function: 文章阅读量
 *
 * GET /api/views?slug=001-hello-world
 * 每次访问 +1，返回当前总数（存于 Netlify Blobs 的 metrics store）
 */

export default async (req) => {
    const url = new URL(req.url);
    const slug = (url.searchParams.get('slug') || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 120);

    if (!slug) {
        return Response.json({ error: 'missing slug' }, { status: 400 });
    }

    try {
        const store = getStore('metrics');
        const key = 'views:' + slug;
        const next = parseInt((await store.get(key)) || '0', 10) + 1;
        await store.set(key, String(next));
        return Response.json(
            { views: next },
            { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }
        );
    } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
    }
};

export const config = { path: '/api/views' };
