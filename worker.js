// ==========================================
// UTILITIES
// ==========================================

const escapeCDATA = (str) => (str || "").replace(/]]>/g, "]]]]><![CDATA[>");
const escapeXML = (str) => (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const decodeXML = (str) => (str || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&");

// ==========================================
// WORKER ENTRY POINTS
// ==========================================

export default {
  async scheduled(event, env, ctx) {
    console.log("📅 Cron job started...");
    const FEEDS = await env.FEED_METADATA.get("config:feeds", "json") || [];
    ctx.waitUntil(this.processAll(FEEDS, env, ctx));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const endpoint = pathParts.join("/");

    const FEEDS = await env.FEED_METADATA.get("config:feeds", "json") ||[];

    // Protect all /admin routes with Authentication
    if (endpoint.startsWith("admin")) {
      const urlSecret = url.searchParams.get("secret");
      const headerSecret = request.headers.get("Authorization")?.replace("Bearer ", "");
      const providedSecret = urlSecret || headerSecret;

      if (!env.ADMIN_SECRET || providedSecret !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized. Invalid or missing secret." }), { 
          status: 401, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      // 1. Serve the Visual Admin Dashboard
      if (endpoint === "admin") {
        return new Response(getAdminHTML(), { 
          headers: { "Content-Type": "text/html; charset=utf-8" } 
        });
      }

      // 2. API: Check Token Usage
      if (endpoint === "admin/usage") {
        const date = new Date();
        const monthKey = `usage:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const currentUsage = await env.FEED_METADATA.get(monthKey, "json") || { prompt: 0, completion: 0, total: 0 };
        return new Response(JSON.stringify({ month: monthKey, tokens: currentUsage }, null, 2), { 
          headers: { "Content-Type": "application/json" } 
        });
      }

      // 3. API: Manage Feeds
      if (endpoint === "admin/feeds") {
        if (request.method === "GET") {
          return new Response(JSON.stringify({ feeds: FEEDS }, null, 2), { 
            headers: { "Content-Type": "application/json" } 
          });
        }
        
        if (request.method === "POST") {
          try {
            const newFeeds = await request.json();
            if (!Array.isArray(newFeeds)) throw new Error("Payload must be a JSON array.");
            
            const validFeeds = newFeeds.map(f => {
              if (!f.url || !f.lang || !f.name) throw new Error("Missing required fields.");
              return { url: f.url, lang: f.lang, name: f.name };
            });

            await env.FEED_METADATA.put("config:feeds", JSON.stringify(validFeeds));
            return new Response(JSON.stringify({ success: true, feeds: validFeeds }), { 
              headers: { "Content-Type": "application/json" } 
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 400 });
          }
        }
      }

      // 4. API: Clear Cache for a specific feed
      if (endpoint.startsWith("admin/cache/")) {
        if (request.method === "DELETE") {
          const feedToClear = endpoint.split("/").pop();
          await env.RSS_CACHE.delete(`feed:${feedToClear}`);
          return new Response(JSON.stringify({ success: true, message: `Cache cleared for ${feedToClear}` }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      return new Response("Admin endpoint not found", { status: 404 });
    }

    // Public Routes: Serve RSS Feeds
    const feedName = pathParts.pop();
    if (!feedName) {
      const available = FEEDS.length > 0 ? FEEDS.map(f => f.name).join(", ") : "No feeds configured yet.";
      return new Response(`Available: ${available}`);
    }
    
    const feedExists = FEEDS.some(f => f.name === feedName);
    if (!feedExists) return new Response("Feed not found", { status: 404 });

    const cached = await env.RSS_CACHE.get(`feed:${feedName}`);
    if (!cached) return new Response("Feed processing. Refresh in 1 min.", { status: 404 });

    return new Response(cached, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
  },

  async processAll(FEEDS, env, ctx) {
    if (!FEEDS || FEEDS.length === 0) return;
    for (const feed of FEEDS) {
      try {
        await processFeed(feed, env, ctx);
      } catch (e) {
        console.error(`❌ Error in ${feed.name}: ${e.message}`);
      }
    }
  }
};

// ==========================================
// CORE LOGIC
// ==========================================

async function processFeed(config, env, ctx) {
  const res = await fetch(config.url);
  if (!res.ok) throw new Error(`Failed to fetch feed: ${res.status}`);
  
  const xml = await res.text();
  const items = parseRSS(xml);
  if (items.length === 0) throw new Error("No items found in feed.");

  const mapKey = `map:${config.name}`;
  const translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

  const toTranslate = items.filter(it => !translatedMap[it.id]).slice(0, 2);

  if (toTranslate.length > 0) {
    const translated = await translateItems(toTranslate, config.lang, env, ctx);
    if (translated && translated.length > 0) {
      translated.forEach(it => { translatedMap[it.id] = it; });
      const prunedMap = {};
      items.forEach(it => { if (translatedMap[it.id]) prunedMap[it.id] = translatedMap[it.id]; });
      await env.FEED_METADATA.put(mapKey, JSON.stringify(prunedMap), { expirationTtl: 2592000 });
    }
  }

  const finalItems = items.slice(0, 15).map(it => translatedMap[it.id] || it);
  const rss = generateRSS(finalItems, config);
  await env.RSS_CACHE.put(`feed:${config.name}`, rss, { expirationTtl: 86400 });
}

async function translateItems(items, lang, env, ctx) {
  try {
    const cleanedItems = items.map(i => ({ id: i.id, t: i.title.substring(0, 300), d: i.description.substring(0, 1500) }));
    const payload = JSON.stringify({
      model: "llama-3.3-70b-versatile", 
      messages:[
        { role: "system", content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang}. Return ONLY valid JSON in this format: {"items":[{"id": "...", "t": "...", "d": "..."}]}` },
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

    if (!data || !data.choices || !data.choices[0]) return[];

    if (data.usage) {
      if (ctx) ctx.waitUntil(trackUsage(env, data.usage));
      else await trackUsage(env, data.usage);
    }

    const content = data.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content).items ||[];
      if (!Array.isArray(parsed)) throw new Error();
    } catch (err) { return[]; }
    
    return parsed.map(p => {
      const orig = items.find(i => i.id === p.id);
      if (!orig) return null;
      return { ...orig, title: p.t || orig.title, description: p.d || orig.description };
    }).filter(Boolean);
  } catch (e) { return[]; }
}

async function trackUsage(env, usageData) {
  try {
    const { prompt_tokens, completion_tokens, total_tokens } = usageData;
    const date = new Date();
    const monthKey = `usage:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    let currentUsage = await env.FEED_METADATA.get(monthKey, "json") || { prompt: 0, completion: 0, total: 0 };
    currentUsage.prompt += prompt_tokens;
    currentUsage.completion += completion_tokens;
    currentUsage.total += total_tokens;
    await env.FEED_METADATA.put(monthKey, JSON.stringify(currentUsage));
  } catch (e) {}
}

// ==========================================
// RSS PARSING & GENERATION
// ==========================================

function parseRSS(xml) {
  const items =[];
  const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);
  for (const m of matches) {
    const i = m[1];
    const get = (tag) => {
      const match = i.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"));
      return match ? decodeXML(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim()) : "";
    };
    const link = get("link");
    const id = get("guid") || link;
    const description = get("content:encoded") || get("description");
    if (id) items.push({ id, title: get("title"), description, link, pubDate: get("pubDate") });
  }
  return items;
}

function generateRSS(items, config) {
  const rtlLangs =["Arabic", "Hebrew", "Persian", "Urdu"];
  const isRTL = rtlLangs.includes(config.lang);
  const dirHtml = isRTL ? '<div dir="rtl" style="text-align: right; font-family: sans-serif;">' : '<div>';
  const closeDiv = '</div>';

  const xmlItems = items.map(i => `
    <item>
      <title><![CDATA[${escapeCDATA(i.title)}]]></title>
      <description><![CDATA[${dirHtml}${escapeCDATA(i.description)}${closeDiv}]]></description>
      <link>${escapeXML(i.link)}</link>
      <pubDate>${escapeXML(i.pubDate)}</pubDate>
      <guid isPermaLink="false">${escapeXML(i.id)}</guid>
    </item>`).join("");
    
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXML(config.name)} (${escapeXML(config.lang)})</title>${xmlItems}</channel></rss>`;
}

// ==========================================
// ADMIN DASHBOARD HTML
// ==========================================

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSS AI Translator - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800 font-sans antialiased p-6">
  <div class="max-w-5xl mx-auto space-y-8">
    
    <header class="flex justify-between items-center border-b pb-4">
      <h1 class="text-3xl font-bold text-gray-900">RSS AI Translator</h1>
      <span class="bg-green-100 text-green-800 text-sm font-medium px-3 py-1 rounded-full">System Online</span>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Token Usage Card -->
      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-1">
        <h2 class="text-lg font-semibold mb-4 text-gray-700">Groq Token Usage</h2>
        <div id="usage-stats" class="space-y-3 text-sm">
          <p class="animate-pulse text-gray-400">Loading data...</p>
        </div>
      </div>

      <!-- Feeds Management Card -->
      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-2">
        <h2 class="text-lg font-semibold mb-4 text-gray-700">Managed Feeds</h2>
        
        <ul id="feeds-list" class="space-y-3 mb-6">
          <p class="animate-pulse text-gray-400">Loading feeds...</p>
        </ul>
        
        <div class="border-t pt-6 mt-4">
          <h3 class="text-md font-medium mb-3 text-gray-700">Add New Feed</h3>
          <form id="add-feed-form" class="flex flex-col sm:flex-row gap-3">
            <input type="text" id="feed-name" placeholder="URL Slug (e.g. tech-news)" class="border border-gray-300 p-2 rounded-lg flex-1 focus:ring-2 focus:ring-blue-500 outline-none" required>
            <input type="url" id="feed-url" placeholder="Source RSS URL" class="border border-gray-300 p-2 rounded-lg flex-[2] focus:ring-2 focus:ring-blue-500 outline-none" required>
            <input type="text" id="feed-lang" placeholder="Target Lang (e.g. Arabic)" class="border border-gray-300 p-2 rounded-lg flex-1 focus:ring-2 focus:ring-blue-500 outline-none" required>
            <button type="submit" class="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition font-medium shadow-sm">Add Feed</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const secret = urlParams.get('secret');
    let currentFeeds =[];

    async function loadDashboard() {
      // Load Usage
      try {
        const usageRes = await fetch('/admin/usage?secret=' + secret);
        if(usageRes.ok) {
          const data = await usageRes.json();
          document.getElementById('usage-stats').innerHTML = \`
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Month</span> <span class="font-medium">\${data.month.replace('usage:', '')}</span></div>
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Prompt</span> <span class="font-medium">\${data.tokens.prompt.toLocaleString()}</span></div>
            <div class="flex justify-between border-b pb-2"><span class="text-gray-500">Completion</span> <span class="font-medium">\${data.tokens.completion.toLocaleString()}</span></div>
            <div class="flex justify-between pt-1 text-lg"><span class="font-bold text-gray-800">Total</span> <span class="font-bold text-blue-600">\${data.tokens.total.toLocaleString()}</span></div>
          \`;
        }
      } catch(e) { document.getElementById('usage-stats').innerHTML = '<p class="text-red-500">Failed to load usage.</p>'; }

      // Load Feeds
      try {
        const feedsRes = await fetch('/admin/feeds?secret=' + secret);
        if(feedsRes.ok) {
          const data = await feedsRes.json();
          currentFeeds = data.feeds ||[];
          renderFeeds();
        }
      } catch(e) { document.getElementById('feeds-list').innerHTML = '<p class="text-red-500">Failed to load feeds.</p>'; }
    }

    function renderFeeds() {
      const list = document.getElementById('feeds-list');
      if(currentFeeds.length === 0) {
        list.innerHTML = '<li class="text-gray-500 italic bg-gray-50 p-4 rounded-lg border border-dashed">No feeds configured yet. Add one below!</li>';
        return;
      }
      list.innerHTML = currentFeeds.map((f, i) => \`
        <li class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-50 p-4 rounded-lg border border-gray-200 hover:shadow-md transition">
          <div class="mb-3 sm:mb-0 overflow-hidden w-full sm:w-auto">
            <div class="flex items-center gap-2">
              <span class="font-bold text-gray-800">\${f.name}</span> 
              <span class="bg-blue-100 text-blue-800 text-xs font-semibold px-2 py-0.5 rounded">\${f.lang}</span>
            </div>
            <a href="\${f.url}" target="_blank" class="text-sm text-gray-500 hover:text-blue-500 truncate block max-w-xs sm:max-w-md mt-1">\${f.url}</a>
          </div>
          <div class="flex gap-2 w-full sm:w-auto">
            <button onclick="clearCache('\${f.name}')" class="flex-1 sm:flex-none bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm font-medium transition">Clear Cache</button>
            <button onclick="deleteFeed(\${i})" class="flex-1 sm:flex-none bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded text-sm font-medium transition">Delete</button>
          </div>
        </li>
      \`).join('');
    }

    async function saveFeeds(newFeeds) {
      const res = await fetch('/admin/feeds?secret=' + secret, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newFeeds)
      });
      if(res.ok) {
        currentFeeds = newFeeds;
        renderFeeds();
      } else { alert('Failed to save feeds'); }
    }

    document.getElementById('add-feed-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('feed-name').value.trim();
      const url = document.getElementById('feed-url').value.trim();
      const lang = document.getElementById('feed-lang').value.trim();
      
      if(currentFeeds.some(f => f.name === name)) return alert('A feed with this slug already exists!');

      const btn = e.target.querySelector('button');
      btn.innerText = 'Adding...';
      await saveFeeds([...currentFeeds, { name, url, lang }]);
      e.target.reset();
      btn.innerText = 'Add Feed';
    });

    window.deleteFeed = async (index) => {
      if(confirm('Are you sure you want to delete this feed?')) {
        await saveFeeds(currentFeeds.filter((_, i) => i !== index));
      }
    };

    window.clearCache = async (name) => {
      const res = await fetch('/admin/cache/' + name + '?secret=' + secret, { method: 'DELETE' });
      if(res.ok) alert('Cache cleared! The next request will trigger a fresh translation.');
      else alert('Failed to clear cache.');
    };

    loadDashboard();
  </script>
</body>
</html>`;
}
