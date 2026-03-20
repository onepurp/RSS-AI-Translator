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
  },

  HTMLProcessor: {
    encode: (text) => {
      if (!text) return { encoded: "", map: {} };
      const map = {};
      let counter = 0;
      // Find all HTML tags and replace them with [__T0__], [__T1__], etc.
      const encoded = text.replace(/<[^>]+>/g, (match) => {
        const key = `[__T${counter}__]`;
        map[key] = match;
        counter++;
        return key;
      });
      return { encoded, map };
    },
    decode: (text, map) => {
      if (!text) return "";
      let decoded = text;
      // Swap the placeholders back to the original HTML
      for (const [key, value] of Object.entries(map)) {
        const safeKey = key.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        decoded = decoded.replace(new RegExp(safeKey, 'g'), value);
      }
      return decoded;
    }
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
    
    // NEW: Store the HTML maps so we can decode them later
    const itemMaps = {};

    const cleanedItems = items.map(i => {
      // Encode the HTML into tiny placeholders to save tokens
      const tEncoded = Utils.HTMLProcessor.encode(i.title.substring(0, 500));
      const dEncoded = Utils.HTMLProcessor.encode(i.description.substring(0, 14000));
      
      itemMaps[i.id] = { tMap: tEncoded.map, dMap: dEncoded.map };
      
      return { 
        id: i.id, 
        t: tEncoded.encoded, 
        d: dEncoded.encoded 
      };
    });
    
    const payload = JSON.stringify({
      model: "openai/gpt-oss-120b", 
      messages:[
        { 
          role: "system", 
          content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang}. CRITICAL: The text contains placeholders like [__T0__], [__T1__]. You MUST preserve these placeholders exactly as they appear, in their exact original positions. Do NOT translate or modify the placeholders. Return ONLY valid JSON: {"items":[{"id": "...", "t": "...", "d": "..."}]}`
         // content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang} but keep technical programming terms in English. CRITICAL: The text contains placeholders like [__T0__], [__T1__]. You MUST preserve these placeholders exactly as they appear, in their exact original positions. Do NOT translate or modify the placeholders. Return ONLY valid JSON: {"items":[{"id": "...", "t": "...", "d": "..."}]}`

        },
        { role: "user", content: JSON.stringify(cleanedItems) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    let data = null;
    let delay = 2000; 

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: payload
      });

      const status = res.status;

      if (res.ok) { 
        data = await res.json(); 
        break; 
      }
      
      if (status === 429 || status === 498 || status >= 500) {
        if (attempt === 3) {
          if (status === 429 || status === 498) throw new Error("RATE_LIMIT_EXCEEDED");
          if (status >= 500) throw new Error("SERVER_ERROR");
        }
        console.warn(`⚠️ Groq API (${status}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; 
      } 
      
      else {
        const errText = await res.text();
        let errorReason = "Unknown Error";
        switch(status) {
          case 400: errorReason = "Bad Request - Invalid syntax"; break;
          case 401: errorReason = "Unauthorized - Invalid API Key"; break;
          case 403: errorReason = "Forbidden - Permission restricted"; break;
          case 404: errorReason = "Not Found - Endpoint missing"; break;
          case 413: errorReason = "Payload Too Large - Reduce text size"; break;
          case 422: errorReason = "Unprocessable Entity - Semantic error/Hallucination"; break;
          case 424: errorReason = "Failed Dependency"; break;
          case 499: errorReason = "Request Cancelled"; break;
        }
        
        Utils.logError("Groq_API_Fatal", new Error(`HTTP ${status} (${errorReason}): ${errText}`));
        return[]; 
      }
    }

    if (!data?.choices?.[0]) return[];

    if (data.usage) {
      ctx ? ctx.waitUntil(StorageService.trackUsage(env, data.usage)) : await StorageService.trackUsage(env, data.usage);
    }

    try {
      let content = data.choices[0].message.content;
      
      content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      const startIdx = content.indexOf('{');
      const endIdx = content.lastIndexOf('}');
      if (startIdx !== -1 && endIdx !== -1) {
        content = content.substring(startIdx, endIdx + 1);
      }
      
      content = content.replace(/[\u0000-\u001F]+/g, " ");

      const parsed = JSON.parse(content).items ||[];
      if (!Array.isArray(parsed)) throw new Error("Invalid JSON array");
      
      return parsed.map(p => {
        const orig = items.find(i => i.id === p.id);
        if (!orig) return null;

        const maps = itemMaps[p.id];
        const decodedTitle = Utils.HTMLProcessor.decode(p.t || orig.title, maps.tMap);
        const decodedDesc = Utils.HTMLProcessor.decode(p.d || orig.description, maps.dMap);

        return { ...orig, title: decodedTitle, description: decodedDesc };
      }).filter(Boolean);
    } catch (err) { 
      Utils.logError("LLM_Parse", err);
      return 
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
        ${i.media || ""}
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

      const untranslated = items.filter(it => !translatedMap[it.id]);

      const toTranslate =[];
      let currentCharCount = 0;
      const MAX_CHARS_PER_BATCH = 14000; 

      for (const it of untranslated) {
        const textLength = (it.title || "").length + (it.description || "").length;
        if (currentCharCount + textLength > MAX_CHARS_PER_BATCH && toTranslate.length > 0) break;
        toTranslate.push(it);
        currentCharCount += textLength;
      }

      if (toTranslate.length > 0) {
        console.log(`🌐 Translating ${toTranslate.length} items (${currentCharCount} chars) for ${config.name}...`);
        const translated = await LLMService.translate(toTranslate, config.lang, env, ctx);
        
        translated.forEach(it => { translatedMap[it.id] = it; });
        
        const translatedIds = new Set(translated.map(t => t.id));
        toTranslate.forEach(it => {
          if (!translatedIds.has(it.id)) translatedMap[it.id] = { failed: true, ...it };
        });

        const prunedMap = {};
        items.forEach(it => { if (translatedMap[it.id]) prunedMap[it.id] = translatedMap[it.id]; });
        await env.FEED_METADATA.put(mapKey, JSON.stringify(prunedMap), { expirationTtl: 2592000 });
        
        console.log(`✅ Successfully updated and cached: ${config.name}`);
      } else {
        console.log(`⚡ No new items for ${config.name}. Cache refreshed.`);
      }

      const finalItems = items.slice(0, 15).map(it => (translatedMap[it.id] && !translatedMap[it.id].failed) ? translatedMap[it.id] : it);
      const rss = this.generate(finalItems, config);
      await env.RSS_CACHE.put(`feed:${config.name}`, rss, { expirationTtl: 86400 });
      
      return true; 
      
    } catch (e) {
      if (e.message === "RATE_LIMIT_EXCEEDED" || e.message === "SERVER_ERROR") {
        console.warn(`⏳ Groq API unavailable (${e.message}) for ${config.name}. Items left in queue.`);
        return false; 
      } else {
        Utils.logError(`processFeed:${config.name}`, e);
        return true; 
      }
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
    
    console.log(`🚀 Starting cron job for ${feeds.length} feeds...`);
    
    // SEQUENTIAL PROCESSING: Prevents Cloudflare CPU/Memory spikes and respects Groq rate limits
    for (const feed of feeds) {
      const shouldContinue = await RSSService.processFeed(feed, env, ctx);
      
      if (!shouldContinue) {
        console.warn("⏸️ Queue paused due to API limits. Will resume on next schedule.");
        break; 
      }
    }
    
    console.log("✅ Cron job finished.");
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
    
    if (!feedName) {
      return new Response(getPublicHTML(feeds, url.origin), { 
        headers: { "Content-Type": "text/html; charset=utf-8" } 
      });
    }
    
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
<html lang="en" class="antialiased">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSS AI Translator - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: { brand: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a' } }
        }
      }
    }
  </script>
  <style>
    .toast-enter { animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .toast-leave { animation: fadeOut 0.3s ease forwards; }
    .modal-enter { animation: scaleIn 0.2s ease-out forwards; }
    
    @keyframes slideIn { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeOut { to { opacity: 0; transform: translateY(10px); } }
    @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
    
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
    .dark ::-webkit-scrollbar-thumb { background: #475569; }

    .bg-grid-pattern {
      background-image: radial-gradient(rgba(0, 0, 0, 0.05) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    .dark .bg-grid-pattern { background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 dark:bg-[#0B1120] dark:text-slate-50 min-h-screen transition-colors duration-200 relative selection:bg-brand-500 selection:text-white">
  
  <!-- Background Grid & Glow -->
  <div class="absolute inset-0 bg-grid-pattern pointer-events-none z-0"></div>
  <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-brand-500/10 dark:bg-brand-500/20 blur-[120px] rounded-full pointer-events-none z-0"></div>

  <!-- VIEW A: AUTHENTICATION -->
  <div id="view-auth" class="hidden min-h-screen flex items-center justify-center p-4 relative z-10">
    <div class="w-full max-w-md bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-8 rounded-3xl shadow-xl border border-gray-200 dark:border-slate-700/50">
      <div class="flex justify-center mb-6">
        <div class="bg-brand-100 dark:bg-brand-900/30 p-4 rounded-2xl border border-brand-200 dark:border-brand-800/50 shadow-inner">
          <svg class="w-8 h-8 text-brand-600 dark:text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
        </div>
      </div>
      <h2 class="text-3xl font-extrabold mb-2 text-center tracking-tight">Admin Access</h2>
      <p class="text-center text-gray-500 dark:text-slate-400 mb-8">Enter your master secret to continue</p>
      <form id="login-form" class="space-y-5">
        <div>
          <label for="secret-input" class="sr-only">Admin Secret</label>
          <input type="password" id="secret-input" placeholder="Enter Admin Secret" class="w-full bg-white dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3.5 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all dark:text-white shadow-sm" required>
        </div>
        <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 text-white p-3.5 rounded-xl font-semibold transition-colors shadow-md hover:shadow-lg active:scale-[0.98]">Secure Login</button>
      </form>
    </div>
  </div>

  <!-- VIEW B: DASHBOARD -->
  <div id="view-dashboard" class="hidden max-w-5xl mx-auto p-6 space-y-8 pb-12 relative z-10">
    
    <!-- Header -->
    <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-gray-200 dark:border-slate-800/50 pb-6 pt-4">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white">RSS AI Translator</h1>
        <div class="flex items-center gap-2 mt-2">
          <span class="relative flex h-3 w-3"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span>
          <span class="text-sm font-medium text-emerald-600 dark:text-emerald-400">System Online & Active</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button id="theme-toggle" aria-label="Toggle Dark Mode" class="p-2.5 rounded-xl bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 text-gray-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors shadow-sm">
          <svg id="icon-sun" class="w-5 h-5 hidden dark:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
          <svg id="icon-moon" class="w-5 h-5 block dark:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
        </button>
        <button onclick="logout()" class="px-4 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-300 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shadow-sm">Logout</button>
      </div>
    </header>

    <!-- Top Section: Metrics -->
    <section>
      <h2 class="text-lg font-bold mb-4 text-gray-800 dark:text-slate-200">Groq Token Usage</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm hover:shadow-md transition-shadow">
          <p class="text-sm text-gray-500 dark:text-slate-400 font-semibold mb-1 uppercase tracking-wider">Prompt Tokens</p>
          <p id="stat-prompt" class="text-3xl font-extrabold text-gray-900 dark:text-white skeleton-text">---</p>
        </div>
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm hover:shadow-md transition-shadow">
          <p class="text-sm text-gray-500 dark:text-slate-400 font-semibold mb-1 uppercase tracking-wider">Completion Tokens</p>
          <p id="stat-completion" class="text-3xl font-extrabold text-gray-900 dark:text-white skeleton-text">---</p>
        </div>
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-brand-200 dark:border-brand-800/50 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
          <div class="absolute top-0 right-0 w-24 h-24 bg-brand-100 dark:bg-brand-900/20 rounded-bl-full -mr-8 -mt-8"></div>
          <p class="text-sm text-brand-600 dark:text-brand-400 font-semibold mb-1 uppercase tracking-wider">Total (This Month)</p>
          <p id="stat-total" class="text-4xl font-extrabold text-brand-700 dark:text-brand-300 skeleton-text">---</p>
        </div>
      </div>
    </section>

    <!-- Main Section: Feeds -->
    <section>
      <div class="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-4">
        <h2 class="text-lg font-bold text-gray-800 dark:text-slate-200">Managed Feeds</h2>
        
        <!-- NEW: Action Bar (Search, Clear All, Add) -->
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
          
          <!-- Live Search -->
          <div class="relative w-full sm:w-64">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </div>
            <input type="text" id="adminSearchInput" placeholder="Search feeds..." class="w-full pl-9 pr-4 py-2.5 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none transition-all shadow-sm dark:text-white text-sm placeholder-gray-400">
          </div>

          <div class="flex gap-2 w-full sm:w-auto">
            <!-- Clear All Caches -->
            <button onclick="clearAllCaches(this)" class="flex-1 sm:flex-none bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center justify-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
              Clear All
            </button>
            
            <!-- Add Feed -->
            <button onclick="openModal()" class="flex-1 sm:flex-none bg-brand-600 hover:bg-brand-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-md hover:shadow-lg flex items-center justify-center gap-2 active:scale-[0.98]">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
              Add Feed
            </button>
          </div>
        </div>
      </div>
      
      <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm overflow-hidden">
        <ul id="feeds-list" class="divide-y divide-gray-100 dark:divide-slate-700/50">
          <!-- Skeleton Loaders -->
          <li class="p-6 animate-pulse flex justify-between"><div class="h-5 bg-gray-200 dark:bg-slate-700 rounded w-1/3"></div><div class="h-8 bg-gray-200 dark:bg-slate-700 rounded w-24"></div></li>
        </ul>
      </div>
    </section>

    <!-- Footer -->
    <footer class="mt-16 text-center border-t border-gray-200 dark:border-slate-800/50 pt-8">
      <p class="text-sm text-gray-500 dark:text-slate-500 flex items-center justify-center gap-1.5">
        Powered by 
        <a href="https://github.com/onepurp/RSS-AI-Translator" target="_blank" rel="noopener noreferrer" class="font-semibold text-gray-700 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition-colors inline-flex items-center gap-1.5">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path></svg>
          RSS AI Translator
        </a>
      </p>
    </footer>
  </div>

  <!-- OVERLAY: ADD/EDIT FEED MODAL -->
  <div id="modal-backdrop" class="hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity"></div>
  <div id="modal-add" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div class="bg-white/95 dark:bg-slate-800/95 backdrop-blur-2xl w-full max-w-lg rounded-3xl shadow-2xl border border-gray-200 dark:border-slate-700/50 overflow-hidden modal-enter">
      <div class="flex justify-between items-center p-6 border-b border-gray-100 dark:border-slate-700/50">
        <h3 id="modal-title" class="text-xl font-bold text-gray-900 dark:text-white">Provision New Feed</h3>
        <button onclick="closeModal()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>
      <form id="add-feed-form" class="p-6 space-y-5">
        <input type="hidden" id="edit-index" value="">
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">URL Slug (Name)</label>
          <input type="text" id="feed-name" placeholder="e.g. tech-news" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Source RSS URL</label>
          <input type="url" id="feed-url" placeholder="https://example.com/feed.xml" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Target Language</label>
          <input type="text" id="feed-lang" placeholder="e.g. Arabic, French, Spanish" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div class="pt-4 flex gap-3 justify-end">
          <button type="button" onclick="closeModal()" class="px-5 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">Cancel</button>
          <button type="submit" id="add-btn" class="bg-brand-600 hover:bg-brand-700 text-white px-6 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-md hover:shadow-lg active:scale-[0.98]">Save Feed</button>
        </div>
      </form>
    </div>
  </div>

  <!-- TOAST CONTAINER -->
  <div id="toast-container" aria-live="polite" class="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none"></div>

  <script>
    // --- UTILITIES ---
    const escapeHTML = (str) => str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
    
    function showToast(msg, type='success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      const isError = type === 'error';
      toast.className = \`toast-enter pointer-events-auto flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl text-sm font-semibold text-white \${isError ? 'bg-red-500' : 'bg-slate-800 dark:bg-slate-700 border border-slate-600'}\`;
      
      const icon = isError 
        ? \`<svg class="w-5 h-5 text-red-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>\`
        : \`<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>\`;
      
      toast.innerHTML = \`\${icon} <span>\${escapeHTML(msg)}</span>\`;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.classList.replace('toast-enter', 'toast-leave');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // --- THEME MANAGEMENT ---
    const themeToggleBtn = document.getElementById('theme-toggle');
    function initTheme() {
      if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
    themeToggleBtn.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    initTheme();

    // --- STATE & API ---
    let secret = localStorage.getItem('admin_secret');
    let currentFeeds =[];

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

    // --- DASHBOARD LOGIC ---
    async function loadDashboard() {
      if (!secret) {
        document.getElementById('view-auth').classList.remove('hidden');
        document.getElementById('secret-input').focus();
        return;
      }
      document.getElementById('view-dashboard').classList.remove('hidden');

      try {
        const[usageRes, feedsRes] = await Promise.all([ apiFetch('/admin/usage'), apiFetch('/admin/feeds') ]);
        
        if (usageRes.ok) {
          const data = await usageRes.json();
          document.getElementById('stat-prompt').innerText = data.tokens.prompt.toLocaleString();
          document.getElementById('stat-completion').innerText = data.tokens.completion.toLocaleString();
          document.getElementById('stat-total').innerText = data.tokens.total.toLocaleString();
          document.querySelectorAll('.skeleton-text').forEach(el => el.classList.remove('skeleton-text', 'animate-pulse', 'text-transparent', 'bg-gray-200', 'dark:bg-slate-700', 'rounded'));
        }

        if (feedsRes.ok) {
          const data = await feedsRes.json();
          currentFeeds = data.feeds ||[];
          renderFeeds();
        }
      } catch(e) { showToast('Failed to load dashboard data', 'error'); }
    }

    function renderFeeds() {
      const list = document.getElementById('feeds-list');
      if(currentFeeds.length === 0) {
        list.innerHTML = '<li class="p-10 text-center text-gray-500 dark:text-slate-400 italic">No feeds configured. Click "Add Feed" to get started.</li>';
        return;
      }
      
      list.innerHTML = currentFeeds.map((f, i) => \`
        <li class="admin-feed-card p-6 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 hover:bg-gray-50/50 dark:hover:bg-slate-700/30 transition-colors group" data-search="\${escapeHTML(f.name).toLowerCase()} \${escapeHTML(f.lang).toLowerCase()}">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3 mb-1.5">
              <span dir="auto" class="font-bold text-lg text-gray-900 dark:text-white truncate">\${escapeHTML(f.name)}</span> 
              <span class="bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 text-xs font-bold px-2.5 py-1 rounded-full border border-brand-200 dark:border-brand-500/20 uppercase tracking-wider">\${escapeHTML(f.lang)}</span>
            </div>
            <a href="\${escapeHTML(f.url)}" target="_blank" class="text-sm text-gray-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 truncate block transition-colors">\${escapeHTML(f.url)}</a>
          </div>
          <div class="flex flex-wrap gap-2 w-full lg:w-auto opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
            <button onclick="navigator.clipboard.writeText(window.location.origin + '/\${escapeHTML(f.name)}'); showToast('Feed URL copied!');" class="flex-1 lg:flex-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center justify-center gap-1.5" title="Copy RSS URL">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              Copy
            </button>
            <!-- NEW: Edit Button -->
            <button onclick="openModal(\${i})" class="flex-1 lg:flex-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center justify-center gap-1.5">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
              Edit
            </button>
            <button onclick="clearCache('\${escapeHTML(f.name)}', this)" class="flex-1 lg:flex-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center justify-center gap-1.5">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
              Refresh
            </button>
            <button onclick="deleteFeed(\${i})" class="flex-1 lg:flex-none bg-white dark:bg-slate-800 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 px-3 py-2 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center justify-center gap-1.5">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
              Delete
            </button>
          </div>
        </li>
      \`).join('');
    }

    // --- LIVE SEARCH ---
    const searchInput = document.getElementById('adminSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.admin-feed-card').forEach(card => {
          card.style.display = card.getAttribute('data-search').includes(term) ? 'flex' : 'none';
        });
      });
    }

    // --- MODAL LOGIC (ADD & EDIT) ---
    const modal = document.getElementById('modal-add');
    const backdrop = document.getElementById('modal-backdrop');
    
    function openModal(editIndex = null) {
      const title = document.getElementById('modal-title');
      const btn = document.getElementById('add-btn');
      const indexInput = document.getElementById('edit-index');
      
      if (editIndex !== null) {
        const feed = currentFeeds[editIndex];
        document.getElementById('feed-name').value = feed.name;
        document.getElementById('feed-url').value = feed.url;
        document.getElementById('feed-lang').value = feed.lang;
        indexInput.value = editIndex;
        title.innerText = 'Edit Feed';
        btn.innerText = 'Update Feed';
      } else {
        document.getElementById('add-feed-form').reset();
        indexInput.value = '';
        title.innerText = 'Provision New Feed';
        btn.innerText = 'Save Feed';
      }

      modal.classList.remove('hidden');
      backdrop.classList.remove('hidden');
      setTimeout(() => document.getElementById('feed-name').focus(), 50);
    }

    function closeModal() {
      modal.classList.add('hidden');
      backdrop.classList.add('hidden');
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });

    // --- ACTIONS ---
    document.getElementById('add-feed-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('feed-name').value.trim();
      const url = document.getElementById('feed-url').value.trim();
      const lang = document.getElementById('feed-lang').value.trim();
      const editIndex = document.getElementById('edit-index').value;
      
      // Check for duplicate slug (only if adding new, or changing name of existing)
      if (editIndex === "" && currentFeeds.some(f => f.name === name)) {
        return showToast('Slug already exists!', 'error');
      }

      const btn = document.getElementById('add-btn');
      const originalText = btn.innerText;
      btn.innerText = 'Saving...'; btn.disabled = true;
      
      let newFeeds = [...currentFeeds];
      if (editIndex !== "") {
        newFeeds[editIndex] = { name, url, lang }; // Update existing
      } else {
        newFeeds.push({ name, url, lang }); // Add new
      }
      
      try {
        const res = await apiFetch('/admin/feeds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newFeeds)
        });
        if(!res.ok) throw new Error();
        
        currentFeeds = newFeeds;
        renderFeeds();
        closeModal();
        showToast(editIndex !== "" ? 'Feed updated successfully' : 'Feed provisioned successfully');
      } catch(err) {
        showToast('Failed to save feed', 'error');
      } finally {
        btn.innerText = originalText; btn.disabled = false;
      }
    });

    window.deleteFeed = async (index) => {
      if(!confirm('Are you sure you want to permanently delete this feed?')) return;
      
      const previousFeeds = [...currentFeeds];
      currentFeeds.splice(index, 1); 
      renderFeeds();
      
      try {
        const res = await apiFetch('/admin/feeds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentFeeds)
        });
        if(!res.ok) throw new Error();
        showToast('Feed deleted');
      } catch(err) {
        currentFeeds = previousFeeds; 
        renderFeeds();
        showToast('Failed to delete feed', 'error');
      }
    };

    window.clearCache = async (name, btn) => {
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Refreshing...'; 
      btn.disabled = true;
      
      try {
        const res = await apiFetch('/admin/cache/' + name, { method: 'DELETE' });
        if(res.ok) showToast('Cache cleared. Next request will fetch fresh data.');
        else throw new Error();
      } catch(err) {
        showToast('Failed to clear cache', 'error');
      } finally {
        btn.innerHTML = originalHTML; 
        btn.disabled = false;
      }
    };

    // NEW: Clear All Caches
    window.clearAllCaches = async (btn) => {
      if(!confirm('Are you sure you want to clear the cache for ALL feeds? This will force the AI to re-translate everything on the next run.')) return;
      
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Clearing...'; 
      btn.disabled = true;
      
      try {
        // Fire off delete requests for all feeds concurrently
        await Promise.all(currentFeeds.map(f => apiFetch('/admin/cache/' + f.name, { method: 'DELETE' })));
        showToast('All caches cleared successfully!');
      } catch(err) {
        showToast('Failed to clear some caches', 'error');
      } finally {
        btn.innerHTML = originalHTML; 
        btn.disabled = false;
      }
    };

    loadDashboard();
  </script>
</body>
</html>`;
}


// ==========================================
// 7. PUBLIC LANDING PAGE 
// ==========================================

function getPublicHTML(feeds, baseUrl) {
  const hasFeeds = feeds && feeds.length > 0;
  
  const feedsList = hasFeeds ? feeds.map(f => {
    const feedUrl = `${baseUrl}/${Utils.escapeHTML(f.name)}`;
    
    return `
    <div class="feed-card group flex flex-col bg-white dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm hover:shadow-xl hover:border-brand-300 dark:hover:border-brand-600 transition-all duration-300" data-search="${Utils.escapeHTML(f.name).toLowerCase()} ${Utils.escapeHTML(f.lang).toLowerCase()}">
      
      <div class="flex items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <div class="flex items-center gap-3 mb-2">
            <!-- dir="auto" ensures Arabic/Hebrew names align correctly -->
            <h2 dir="auto" class="text-xl font-bold text-gray-900 dark:text-white truncate">${Utils.escapeHTML(f.name)}</h2>
            <span class="shrink-0 bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 text-xs font-bold px-2.5 py-1 rounded-full border border-brand-200 dark:border-brand-500/20 uppercase tracking-wider">${Utils.escapeHTML(f.lang)}</span>
          </div>
          <p class="text-sm text-gray-500 dark:text-slate-400 truncate" title="${Utils.escapeHTML(f.url)}">Source: ${Utils.escapeHTML(f.url)}</p>
        </div>
        <div class="shrink-0 bg-orange-50 dark:bg-orange-500/10 p-3 rounded-xl text-orange-500 dark:text-orange-400 border border-orange-100 dark:border-orange-500/20">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19 7.38 20 6.18 20C5 20 4 19 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 11.08c5.8 0 10.5 4.7 10.5 10.5h-3.2c0-4.03-3.27-7.3-7.3-7.3v-3.2M4 4.5c9.44 0 17.1 7.66 17.1 17.1h-3.2C17.9 13.93 11.67 7.7 4 7.7V4.5z"/></svg>
        </div>
      </div>

      <div class="mt-auto pt-5 border-t border-gray-100 dark:border-slate-700/50">
        <!-- Copy URL Button (Full Width) -->
        <button onclick="copyToClipboard('${feedUrl}', this)" class="w-full flex items-center justify-center gap-2 bg-gray-50 hover:bg-gray-100 dark:bg-slate-900 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300 px-4 py-3 rounded-xl text-sm font-semibold transition-colors border border-gray-200 dark:border-slate-600">
          <svg class="icon-copy w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          <svg class="icon-check w-4 h-4 text-emerald-500 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          <span class="btn-text">Copy RSS Link</span>
        </button>
      </div>
    </div>
    `;
  }).join('') : `
    <div class="col-span-full text-center py-20 bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm rounded-3xl border border-dashed border-gray-300 dark:border-slate-700">
      <div class="bg-gray-100 dark:bg-slate-800 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
        <svg class="w-10 h-10 text-gray-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"></path></svg>
      </div>
      <h3 class="text-2xl font-bold text-gray-900 dark:text-white mb-3">No Feeds Available</h3>
      <p class="text-gray-500 dark:text-slate-400 max-w-md mx-auto text-lg">The administrator hasn't configured any translated RSS feeds yet. Check back later!</p>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en" class="antialiased">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translated RSS Feeds</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'media',
      theme: { extend: { colors: { brand: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a' } } } }
    }
  </script>
  <style>
    /* Premium Background Pattern */
    .bg-grid-pattern {
      background-image: radial-gradient(rgba(0, 0, 0, 0.05) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    @media (prefers-color-scheme: dark) {
      .bg-grid-pattern { background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
    }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 dark:bg-[#0B1120] dark:text-slate-50 min-h-screen selection:bg-brand-500 selection:text-white relative">
  
  <!-- Background Grid & Glow -->
  <div class="absolute inset-0 bg-grid-pattern pointer-events-none z-0"></div>
  <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-brand-500/10 dark:bg-brand-500/20 blur-[120px] rounded-full pointer-events-none z-0"></div>

  <!-- Admin Login Button (Top Right) -->
  <div class="absolute top-4 right-4 sm:top-6 sm:right-6 z-20">
    <a href="/admin" class="flex items-center gap-2 px-4 py-2 bg-white/50 dark:bg-slate-800/50 backdrop-blur-md border border-gray-200 dark:border-slate-700 rounded-full text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:text-brand-600 dark:hover:text-brand-400 transition-all shadow-sm">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
      Admin Login
    </a>
  </div>

  <div class="relative z-10 max-w-5xl mx-auto p-6 py-16 sm:py-24">
    
    <header class="text-center mb-16 mt-8 sm:mt-0">
      <div class="inline-flex items-center justify-center p-4 bg-white dark:bg-slate-800/50 backdrop-blur-md rounded-3xl shadow-sm border border-gray-200 dark:border-slate-700/50 mb-8">
        <svg class="w-10 h-10 text-brand-600 dark:text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path></svg>
      </div>
      <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight mb-6 text-gray-900 dark:text-white">AI Translated Feeds</h1>
      <p class="text-lg sm:text-xl text-gray-600 dark:text-slate-400 max-w-2xl mx-auto leading-relaxed">Subscribe to your favorite content, automatically translated into your preferred language using advanced AI.</p>
    </header>

    ${hasFeeds ? `
    <!-- Live Search Bar -->
    <div class="max-w-md mx-auto mb-12 relative">
      <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
        <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
      </div>
      <input type="text" id="searchInput" placeholder="Search feeds or languages..." class="w-full pl-11 pr-4 py-3.5 bg-white dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700 rounded-2xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all shadow-sm dark:text-white placeholder-gray-400 dark:placeholder-slate-500">
    </div>
    ` : ''}

    <main id="feedsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-6">
      ${feedsList}
    </main>

    <footer class="mt-24 text-center border-t border-gray-200 dark:border-slate-800/50 pt-10">
      <p class="text-sm text-gray-500 dark:text-slate-500 flex items-center justify-center gap-1.5">
        Powered by 
        <a href="https://github.com/onepurp/RSS-AI-Translator" target="_blank" rel="noopener noreferrer" class="font-semibold text-gray-700 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition-colors inline-flex items-center gap-1.5">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path></svg>
          RSS AI Translator
        </a>
      </p>
    </footer>
  </div>

  <!-- Toast Notification -->
  <div id="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-6 py-3 rounded-full shadow-2xl font-medium text-sm flex items-center gap-2 transition-all duration-300 opacity-0 translate-y-8 pointer-events-none z-50">
    <svg class="w-5 h-5 text-emerald-400 dark:text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
    Link copied to clipboard!
  </div>

  <script>
    // Copy to Clipboard Logic with Micro-interactions
    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        // Button UI Update
        const iconCopy = btn.querySelector('.icon-copy');
        const iconCheck = btn.querySelector('.icon-check');
        const btnText = btn.querySelector('.btn-text');
        
        iconCopy.classList.add('hidden');
        iconCheck.classList.remove('hidden');
        btnText.innerText = 'Copied!';
        btn.classList.add('border-emerald-500', 'text-emerald-600', 'dark:text-emerald-400');
        
        // Show Global Toast
        const toast = document.getElementById('toast');
        toast.classList.remove('opacity-0', 'translate-y-8');
        
        setTimeout(() => {
          // Reset Button
          iconCopy.classList.remove('hidden');
          iconCheck.classList.add('hidden');
          btnText.innerText = 'Copy RSS Link';
          btn.classList.remove('border-emerald-500', 'text-emerald-600', 'dark:text-emerald-400');
          
          // Hide Toast
          toast.classList.add('opacity-0', 'translate-y-8');
        }, 2500);
      });
    }

    // Live Search Filtering
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const cards = document.querySelectorAll('.feed-card');
        
        cards.forEach(card => {
          const searchableText = card.getAttribute('data-search');
          if (searchableText.includes(term)) {
            card.style.display = 'flex';
          } else {
            card.style.display = 'none';
          }
        });
      });
    }
  </script>
</body>
</html>`;
}
