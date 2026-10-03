const fs = require('fs');
const path = require('path');

/**
 * Netlify Function: 返回文章列表 JSON
 *
 * 数据来源优先级：
 *   1. 同目录下的 posts-data.json（构建脚本生成，随函数打包）
 *   2. 项目根目录的 posts.json（构建脚本生成，publish 目录）
 *   3. 实时读取 blog/ 目录（本地 netlify dev 时可用）
 *
 * 访问路径: /.netlify/functions/list-posts
 */

exports.handler = async function(event, context) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
    };

    try {
        let posts = null;

        // 策略1：读取同目录下的 posts-data.json（随函数打包，最可靠）
        const localDataPath = path.join(__dirname, 'posts-data.json');
        if (fs.existsSync(localDataPath)) {
            const raw = fs.readFileSync(localDataPath, 'utf8');
            posts = JSON.parse(raw);
        }

        // 策略2：尝试从项目根目录读取 posts.json
        if (!posts) {
            const rootPaths = [
                path.join(__dirname, '../../../posts.json'),
                path.join(__dirname, '../../posts.json'),
                path.join(process.cwd(), 'posts.json'),
                '/var/task/posts.json',
                '/opt/build/repo/posts.json'
            ];
            for (const p of rootPaths) {
                try {
                    if (fs.existsSync(p)) {
                        posts = JSON.parse(fs.readFileSync(p, 'utf8'));
                        break;
                    }
                } catch (e) { /* 继续尝试下一个路径 */ }
            }
        }

        // 策略3：实时读取 blog/ 目录（本地 netlify dev 场景）
        if (!posts) {
            const blogPaths = [
                path.join(__dirname, '../../../blog'),
                path.join(__dirname, '../../blog'),
                path.join(process.cwd(), 'blog'),
                '/var/task/blog',
                '/opt/build/repo/blog'
            ];
            for (const blogDir of blogPaths) {
                try {
                    if (fs.existsSync(blogDir) && fs.statSync(blogDir).isDirectory()) {
                        const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html'));
                        if (files.length > 0) {
                            posts = files.map(function(file) {
                                const filePath = path.join(blogDir, file);
                                let title = file.replace('.html', '').replace(/-/g, ' ');
                                let date = '';
                                let excerpt = '';
                                try {
                                    const content = fs.readFileSync(filePath, 'utf8');
                                    const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
                                    if (titleMatch) title = titleMatch[1].trim();
                                    const dateMatch = content.match(/<meta\s+name=["']date["']\s+content=["']([^"']*)["']\s*\/?>/i);
                                    if (dateMatch) date = dateMatch[1].trim();
                                    const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']\s*\/?>/i);
                                    if (descMatch) excerpt = descMatch[1].trim();
                                } catch (e) { /* 使用默认值 */ }
                                return { file, url: '/blog/' + file, title, date, excerpt };
                            });
                            posts.sort((a, b) => a.file.localeCompare(b.file));
                            break;
                        }
                    }
                } catch (e) { /* 继续尝试下一个路径 */ }
            }
        }

        // 如果所有策略都失败，返回空数组
        if (!posts) {
            posts = [];
        }

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify(posts)
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ error: error.message, posts: [] })
        };
    }
};
