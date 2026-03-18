
// ==========================================
// 1. UTILITIES & SECURITY
// ==========================================

const Utils = {
  escapeCDATA: (str) => (str || "").replace(/]]>/g, "]]]]><![CDATA[>"),
  escapeXML: (str) => (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
  decodeXML: (str) => (str || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&"),
  escapeHTML: (str) => (str || "").replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])),
  
  logError: (context, error) => {
    const payload = { timestamp: new Date().toISOString(), context, message: error.message, stack: error.stack };
    console.error(`[ERROR] ${JSON.stringify(payload)}`);
  }
};

// ==========================================
// 2. STORAGE SERVICE (With In-Memory Cache)
// ==========================================

let memoryCache = { feeds: null, lastFetch: 0 };
const CACHE_TTL_MS = 60000; // 1 minute

const StorageService = {
  async getFeeds(env) {
    const now = Date.now();
    if (memoryCache.feeds && (now - memoryCache.lastFetch < CACHE_TTL_MS)) {
      return memoryCache.feeds;
    }
    const feeds = await env.FEED_METADATA.get("config:feeds", "json") ||[];
    memoryCache = { feeds, lastFetch: now };
    return feeds;
  },

  async saveFeeds(env, feeds) {
    await env.FEED_METADATA.put("config:feeds", JSON.stringify(feeds));
    memoryCache = { feeds, lastFetch: Date.now() }; // Update cache instantly
  },

  async getUsage(env) {
    const date = new Date();
    const monthKey = `usage:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return {
      key: monthKey,
      data: await env.FEED_METADATA.get(monthKey, "json") || { prompt: 0, completion: 0, total: 0 }
    };
  },

  async trackUsage(env, usageData) {
    try {
      const { key, data } = await this.getUsage(env);
      data.prompt += usageData.prompt_tokens;
      data.completion += usageData.completion_tokens;
      data.total += usageData.total_tokens;
      await env.FEED_METADATA.put(key, JSON.stringify(data));
    } catch (e) { Utils.logError("trackUsage", e); }
  }
};

// ==========================================
// 3. LLM SERVICE
// ==========================================

const LLMService = {
  async translate(items, lang, env, ctx) {
    if (!items.length) return[];
    
    const cleanedItems = items.map(i => ({ id: i.id, t: i.title.substring(0, 300), d: i.description.substring(0, 1500) }));
    const payload = JSON.stringify({
      // model: "llama-3.3-70b-versatile", 
      model: "openai/gpt-oss-120b", 

      messages:[
        { 
          role: "system", 
          content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang}. CRITICAL: You MUST preserve all HTML tags (like <img>, <video>, <iframe>, <a>) exactly as they appear. Do not translate URLs. Return ONLY valid JSON: {"items":[{"id": "...", "t": "...", "d": "..."}]}` 
          // content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang} but keep technical programming terms in English. CRITICAL: You MUST preserve all HTML tags (like <img>, <video>, <iframe>, <a>) exactly as they appear. Do not translate URLs. Return ONLY valid JSON: {"items":[{"id": "...", "t": "...", "d": "..."}]}` 
        },
        { role: "user", content: JSON.stringify(cleanedItems) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 4096
    });

    let data = null;
    let delay = 1000; 

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: payload
      });

      if (res.ok) { data = await res.json(); break; }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 3) return[];
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; 
      } else { return[]; }
    }

    if (!data?.choices?.[0]) return[];

    if (data.usage) {
      ctx ? ctx.waitUntil(StorageService.trackUsage(env, data.usage)) : await StorageService.trackUsage(env, data.usage);
    }

    try {
      const parsed = JSON.parse(data.choices[0].message.content).items ||[];
      if (!Array.isArray(parsed)) throw new Error("Invalid JSON array");
      
      return parsed.map(p => {
        const orig = items.find(i => i.id === p.id);
        return orig ? { ...orig, title: p.t || orig.title, description: p.d || orig.description } : null;
      }).filter(Boolean);
    } catch (err) { 
      Utils.logError("LLM_Parse", err);
      return[]; 
    }
  }
};

// ==========================================
// 4. RSS SERVICE
// ==========================================

const RSSService = {
  parse(xml) {
    const items =[];
    const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);
    for (const m of matches) {
      const i = m[1];
      const get = (tag) => {
        const match = i.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"));
        return match ? Utils.decodeXML(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim()) : "";
      };
      const link = get("link");
      const id = get("guid") || link;
      const description = get("content:encoded") || get("description");
      
      const mediaMatches = i.match(/<(enclosure|media:[a-zA-Z0-9]+)[^>]*>(?:[\s\S]*?<\/\1>)?/gi);
      const media = mediaMatches ? mediaMatches.join("\n") : "";

      if (id) items.push({ id, title: get("title"), description, link, pubDate: get("pubDate"), media });
    }
    return items;
  },

  generate(items, config) {
    const isRTL =["Arabic", "Hebrew", "Persian", "Urdu"].includes(config.lang);
    const dirHtml = isRTL ? '<div dir="rtl" style="text-align: right; font-family: sans-serif;">' : '<div>';
    
    const xmlItems = items.map(i => `
      <item>
        <title><![CDATA[${Utils.escapeCDATA(i.title)}]]></title>
        <description><![CDATA[${dirHtml}${Utils.escapeCDATA(i.description)}</div>]]></description>
        <link>${Utils.escapeXML(i.link)}</link>
        <pubDate>${Utils.escapeXML(i.pubDate)}</pubDate>
        <guid isPermaLink="false">${Utils.escapeXML(i.id)}</guid>
        ${i.media || ""} <!-- FIX: Inject the original media tags back into the item -->
      </item>`).join("");
      
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${Utils.escapeXML(config.name)} (${Utils.escapeXML(config.lang)})</title>
    ${xmlItems}
  </channel>
</rss>`;
  },

  async processFeed(config, env, ctx) {
    try {
      const res = await fetch(config.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const xml = await res.text();
      const items = this.parse(xml);
      if (!items.length) throw new Error("Empty feed");

      const mapKey = `map:${config.name}`;
      const translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

      const toTranslate = items.filter(it => !translatedMap[it.id]).slice(0, 2);

      if (toTranslate.length > 0) {
        const translated = await LLMService.translate(toTranslate, config.lang, env, ctx);
        
        translated.forEach(it => { translatedMap[it.id] = it; });
        
        const translatedIds = new Set(translated.map(t => t.id));
        toTranslate.forEach(it => {
          if (!translatedIds.has(it.id)) translatedMap[it.id] = { failed: true, ...it };
        });

        const prunedMap = {};
        items.forEach(it => { if (translatedMap[it.id]) prunedMap[it.id] = translatedMap[it.id]; });
        await env.FEED_METADATA.put(mapKey, JSON.stringify(prunedMap), { expirationTtl: 2592000 });
      }

      const finalItems = items.slice(0, 15).map(it => (translatedMap[it.id] && !translatedMap[it.id].failed) ? translatedMap[it.id] : it);
      const rss = this.generate(finalItems, config);
      await env.RSS_CACHE.put(`feed:${config.name}`, rss, { expirationTtl: 86400 });
    } catch (e) {
      Utils.logError(`processFeed:${config.name}`, e);
    }
  }
};

// ==========================================
// 5. ROUTER & WORKER ENTRY
// ==========================================

export default {
  async scheduled(event, env, ctx) {
    const feeds = await StorageService.getFeeds(env);
    if (!feeds.length) return;
    await Promise.allSettled(feeds.map(feed => RSSService.processFeed(feed, env, ctx)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const endpoint = pathParts.join("/");

    // --- ADMIN ROUTES ---
    if (endpoint.startsWith("admin")) {
      const authHeader = request.headers.get("Authorization")?.replace("Bearer ", "");
      const isAuthorized = env.ADMIN_SECRET && authHeader === env.ADMIN_SECRET;

      if (endpoint === "admin") {
        return new Response(getAdminHTML(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // API Protection
      if (!isAuthorized) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

      if (endpoint === "admin/usage") {
        const usage = await StorageService.getUsage(env);
        return new Response(JSON.stringify({ month: usage.key, tokens: usage.data }), { headers: { "Content-Type": "application/json" } });
      }

      if (endpoint === "admin/feeds") {
        if (request.method === "GET") {
          return new Response(JSON.stringify({ feeds: await StorageService.getFeeds(env) }));
        }
        if (request.method === "POST") {
          try {
            const newFeeds = await request.json();
            if (!Array.isArray(newFeeds)) throw new Error("Payload must be an array.");
            const validFeeds = newFeeds.map(f => ({ url: f.url, lang: f.lang, name: f.name }));
            await StorageService.saveFeeds(env, validFeeds);
            return new Response(JSON.stringify({ success: true, feeds: validFeeds }));
          } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 400 }); }
        }
      }

      if (endpoint.startsWith("admin/cache/") && request.method === "DELETE") {
        const feedToClear = endpoint.split("/").pop();
        await env.RSS_CACHE.delete(`feed:${feedToClear}`);
        return new Response(JSON.stringify({ success: true }));
      }

      return new Response("Not found", { status: 404 });
    }

    // --- PUBLIC ROUTES ---
    const feeds = await StorageService.getFeeds(env);
    const feedName = pathParts.pop();
    
    if (!feedName) return new Response(`Available: ${feeds.map(f => f.name).join(", ") || "None"}`);
    if (!feeds.some(f => f.name === feedName)) return new Response("Feed not found", { status: 404 });

    const cached = await env.RSS_CACHE.get(`feed:${feedName}`);
    if (!cached) return new Response("Feed processing. Refresh in 1 min.", { status: 404 });

    return new Response(cached, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }
};

// ==========================================
// 6. SECURE UI GENERATOR
// ==========================================

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSS AI Translator - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    #toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 50; display: flex; flex-direction: column; gap: 10px; }
    .toast { padding: 12px 20px; border-radius: 8px; color: white; font-weight: 500; opacity: 0; transform: translateY(20px); animation: slideIn 0.3s forwards; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .toast.success { background-color: #10B981; }
    .toast.error { background-color: #EF4444; }
    @keyframes slideIn { to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body class="bg-gray-50 text-gray-800 font-sans antialiased p-6">
  
  <!-- LOGIN SCREEN -->
  <div id="login-screen" class="max-w-md mx-auto mt-20 bg-white p-8 rounded-xl shadow-sm border border-gray-200 hidden">
    <h2 class="text-2xl font-bold mb-6 text-center">Admin Login</h2>
    <form id="login-form" class="space-y-4">
      <input type="password" id="secret-input" placeholder="Enter Admin Secret" class="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required>
      <button type="submit" class="w-full bg-blue-600 text-white p-3 rounded-lg font-medium hover:bg-blue-700 transition">Access Dashboard</button>
    </form>
  </div>

  <!-- DASHBOARD SCREEN -->
  <div id="dashboard-screen" class="max-w-5xl mx-auto space-y-8 hidden">
    <header class="flex justify-between items-center border-b pb-4">
      <h1 class="text-3xl font-bold text-gray-900">RSS AI Translator</h1>
      <div class="flex gap-4 items-center">
        <span class="bg-green-100 text-green-800 text-sm font-medium px-3 py-1 rounded-full">System Online</span>
        <button onclick="logout()" class="text-sm text-gray-500 hover:text-red-500 underline">Logout</button>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-1">
        <h2 class="text-lg font-semibold mb-4 text-gray-700">Groq Token Usage</h2>
        <div id="usage-stats" class="space-y-3 text-sm"><p class="animate-pulse text-gray-400">Loading...</p></div>
      </div>

      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-2">
        <h2 class="text-lg font-semibold mb-4 text-gray-700">Managed Feeds</h2>
        <ul id="feeds-list" class="space-y-3 mb-6"><p class="animate-pulse text-gray-400">Loading...</p></ul>
        
        <div class="border-t pt-6 mt-4">
          <h3 class="text-md font-medium mb-3 text-gray-700">Add New Feed</h3>
          <form id="add-feed-form" class="flex flex-col sm:flex-row gap-3">
            <input type="text" id="feed-name" placeholder="URL Slug (e.g. tech)" class="border p-2 rounded-lg flex-1 outline-none" required>
            <input type="url" id="feed-url" placeholder="Source RSS URL" class="border p-2 rounded-lg flex-[2] outline-none" required>
            <input type="text" id="feed-lang" placeholder="Target Lang" class="border p-2 rounded-lg flex-1 outline-none" required>
            <button type="submit" id="add-btn" class="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition font-medium">Add</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <div id="toast-container"></div>

  <script>
    // XSS Prevention Utility
    const escapeHTML = (str) => str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));

    let secret = localStorage.getItem('admin_secret');
    let currentFeeds =[];

    function showToast(msg, type='success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = \`toast \${type}\`;
      toast.innerText = msg;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    async function apiFetch(path, options = {}) {
      options.headers = { ...options.headers, 'Authorization': 'Bearer ' + secret };
      const res = await fetch(path, options);
      if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
      return res;
    }

    function logout() {
      localStorage.removeItem('admin_secret');
      location.reload();
    }

    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      localStorage.setItem('admin_secret', document.getElementById('secret-input').value);
      location.reload();
    });

    async function loadDashboard() {
      if (!secret) {
        document.getElementById('login-screen').classList.remove('hidden');
        return;
      }
      document.getElementById('dashboard-screen').classList.remove('hidden');

      try {
        const [usageRes, feedsRes] = await Promise.all([ apiFetch('/admin/usage'), apiFetch('/admin/feeds') ]);
        
        if (usageRes.ok) {
          const data = await usageRes.json();
          document.getElementById('usage-stats').innerHTML = \`
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Month</span> <span class="font-medium">\${escapeHTML(data.month.replace('usage:', ''))}</span></div>
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Prompt</span> <span class="font-medium">\${data.tokens.prompt.toLocaleString()}</span></div>
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Completion</span> <span class="font-medium">\${data.tokens.completion.toLocaleString()}</span></div>
            <div class="flex justify-between pt-1 text-lg"><span class="font-bold text-gray-800">Total</span> <span class="font-bold text-blue-600">\${data.tokens.total.toLocaleString()}</span></div>
          \`;
        }

        if (feedsRes.ok) {
          const data = await feedsRes.json();
          currentFeeds = data.feeds ||[];
          renderFeeds();
        }
      } catch(e) { showToast('Failed to load data', 'error'); }
    }

    function renderFeeds() {
      const list = document.getElementById('feeds-list');
      if(currentFeeds.length === 0) {
        list.innerHTML = '<li class="text-gray-500 italic bg-gray-50 p-4 rounded-lg border border-dashed">No feeds configured.</li>';
        return;
      }
      list.innerHTML = currentFeeds.map((f, i) => \`
        <li class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-50 p-4 rounded-lg border border-gray-200">
          <div class="mb-3 sm:mb-0 overflow-hidden w-full sm:w-auto">
            <div class="flex items-center gap-2">
              <span class="font-bold text-gray-800">\${escapeHTML(f.name)}</span> 
              <span class="bg-blue-100 text-blue-800 text-xs font-semibold px-2 py-0.5 rounded">\${escapeHTML(f.lang)}</span>
            </div>
            <a href="\${escapeHTML(f.url)}" target="_blank" class="text-sm text-gray-500 hover:text-blue-500 truncate block max-w-xs sm:max-w-md mt-1">\${escapeHTML(f.url)}</a>
          </div>
          <div class="flex gap-2 w-full sm:w-auto">
            <button onclick="clearCache('\${escapeHTML(f.name)}', this)" class="flex-1 sm:flex-none bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm font-medium transition">Clear Cache</button>
            <button onclick="deleteFeed(\${i})" class="flex-1 sm:flex-none bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded text-sm font-medium transition">Delete</button>
          </div>
        </li>
      \`).join('');
    }

    async function saveFeeds(newFeeds) {
      const res = await apiFetch('/admin/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newFeeds)
      });
      if(res.ok) {
        currentFeeds = newFeeds;
        renderFeeds();
        showToast('Feeds updated successfully');
      } else { showToast('Failed to save feeds', 'error'); }
    }

    document.getElementById('add-feed-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('feed-name').value.trim();
      const url = document.getElementById('feed-url').value.trim();
      const lang = document.getElementById('feed-lang').value.trim();
      
      if(currentFeeds.some(f => f.name === name)) return showToast('Slug already exists!', 'error');

      const btn = document.getElementById('add-btn');
      btn.innerText = 'Adding...'; btn.disabled = true;
      await saveFeeds([...currentFeeds, { name, url, lang }]);
      e.target.reset();
      btn.innerText = 'Add'; btn.disabled = false;
    });

    window.deleteFeed = async (index) => {
      if(confirm('Delete this feed?')) await saveFeeds(currentFeeds.filter((_, i) => i !== index));
    };

    window.clearCache = async (name, btn) => {
      btn.innerText = 'Clearing...'; btn.disabled = true;
      const res = await apiFetch('/admin/cache/' + name, { method: 'DELETE' });
      if(res.ok) showToast('Cache cleared for ' + name);
      else showToast('Failed to clear cache', 'error');
      btn.innerText = 'Clear Cache'; btn.disabled = false;
    };

    loadDashboard();
  </script>
</body>
</html>`;
}
