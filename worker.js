// ==========================================
// CONFIGURATION & UTILITIES
// ==========================================

const FEEDS =[
  { url: "https://example.com/original-feed-0.xml", lang: "Arabic", name: "feed0" },
  { url: "https://example.com/original-feed-1.xml", lang: "French", name: "feed1" }
];

const escapeCDATA = (str) => (str || "").replace(/]]>/g, "]]]]><![CDATA[>");
const escapeXML = (str) => (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const decodeXML = (str) => (str || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&");

// ==========================================
// WORKER ENTRY POINTS
// ==========================================

export default {
  async scheduled(event, env, ctx) {
    console.log("📅 Cron job started...");
    // Pass ctx down so we can use ctx.waitUntil for non-blocking background tasks (like saving token usage)
    ctx.waitUntil(this.processAll(env, ctx));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const endpoint = pathParts.join("/");

    if (endpoint === "admin/usage") {
      const date = new Date();
      const monthKey = `usage:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const currentUsage = await env.FEED_METADATA.get(monthKey, "json") || { prompt: 0, completion: 0, total: 0 };
      return new Response(JSON.stringify({ month: monthKey, tokens: currentUsage }, null, 2), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const feedName = pathParts.pop();
    if (!feedName) return new Response(`Available: ${FEEDS.map(f => f.name).join(", ")}`);
    
    const feedExists = FEEDS.some(f => f.name === feedName);
    if (!feedExists) return new Response("Feed not found", { status: 404 });

    const cached = await env.RSS_CACHE.get(`feed:${feedName}`);
    if (!cached) return new Response("Feed processing. Refresh in 1 min.", { status: 404 });

    return new Response(cached, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
  },

  async processAll(env, ctx) {
    for (const feed of FEEDS) {
      try {
        await processFeed(feed, env, ctx);
      } catch (e) {
        console.error(`❌ Error in ${feed.name}: ${e.message}`);
      }
    }
    console.log("✅ All tasks complete.");
  }
};

// ==========================================
// CORE LOGIC
// ==========================================

async function processFeed(config, env, ctx) {
  const res = await fetch(config.url);
  if (!res.ok) throw new Error(`Failed to fetch feed: ${res.status} ${res.statusText}`);
  
  const xml = await res.text();
  const items = parseRSS(xml);
  if (items.length === 0) throw new Error("No items found in feed. Aborting to preserve cache.");

  const mapKey = `map:${config.name}`;
  const translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

  const toTranslate = items.filter(it => !translatedMap[it.id]).slice(0, 2);

  if (toTranslate.length > 0) {
    console.log(`🌐 Translating ${toTranslate.length} items for ${config.name}...`);
    const translated = await translateItems(toTranslate, config.lang, env, ctx);
    
    if (translated && translated.length > 0) {
      translated.forEach(it => { translatedMap[it.id] = it; });
      
      const prunedMap = {};
      items.forEach(it => {
        if (translatedMap[it.id]) prunedMap[it.id] = translatedMap[it.id];
      });
      
      await env.FEED_METADATA.put(mapKey, JSON.stringify(prunedMap), { expirationTtl: 2592000 });
    }
  }

  const finalItems = items.slice(0, 15).map(it => translatedMap[it.id] || it);
  const rss = generateRSS(finalItems, config);
  await env.RSS_CACHE.put(`feed:${config.name}`, rss, { expirationTtl: 86400 });
  console.log(`✅ Cached: ${config.name}`);
}

async function translateItems(items, lang, env, ctx) {
  try {
    const cleanedItems = items.map(i => ({
      id: i.id,
      t: i.title.substring(0, 300), 
      d: i.description.substring(0, 1500) 
    }));

    console.log(`📡 Sending to Groq: ${cleanedItems.length} items for translation to ${lang}...`);

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

    const MAX_RETRIES = 3;
    let delay = 1000; // Start with 1 second delay
    let data = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${env.GROQ_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: payload
      });

      if (res.ok) {
        data = await res.json();
        break; // Success! Exit the retry loop.
      }

      // If Rate Limited (429) or Server Error (5xx), we retry
      if (res.status === 429 || res.status >= 500) {
        console.warn(`⚠️ Groq API Error (${res.status}). Attempt ${attempt}/${MAX_RETRIES} failed.`);
        if (attempt === MAX_RETRIES) {
          console.error(`❌ Groq API permanently failed after ${MAX_RETRIES} attempts.`);
          return[];
        }
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Double the delay for the next attempt (1s -> 2s -> 4s)
      } else {
        // If 400 (Bad Request) or 401 (Unauthorized), retrying won't help. Abort immediately.
        console.error(`❌ Fatal Groq API Error (${res.status}):`, await res.text());
        return[];
      }
    }

    if (!data || !data.choices || !data.choices[0]) {
      console.error("❌ Groq API Error. Invalid response structure.");
      return[];
    }

    if (data.usage) {
      if (ctx) {
        // Use waitUntil so saving to KV doesn't slow down the translation process
        ctx.waitUntil(trackUsage(env, data.usage));
      } else {
        await trackUsage(env, data.usage);
      }
    }

    const content = data.choices[0].message.content;
    let parsed;
    
    try {
      parsed = JSON.parse(content).items ||[];
      if (!Array.isArray(parsed)) throw new Error("Parsed items is not an array");
    } catch (err) {
      console.error("❌ Failed to parse LLM response:", content);
      return[];
    }
    
    console.log(`✅ Successfully translated ${parsed.length} items.`);

    return parsed.map(p => {
      const orig = items.find(i => i.id === p.id);
      if (!orig) return null;
      return { ...orig, title: p.t || orig.title, description: p.d || orig.description };
    }).filter(Boolean);
  } catch (e) {
    console.error("❌ Translation function crashed:", e.message);
    return[];
  }
}

async function trackUsage(env, usageData) {
  try {
    const { prompt_tokens, completion_tokens, total_tokens } = usageData;
    const date = new Date();
    // Creates a key like "usage:2026-03"
    const monthKey = `usage:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    let currentUsage = await env.FEED_METADATA.get(monthKey, "json") || { prompt: 0, completion: 0, total: 0 };
    
    currentUsage.prompt += prompt_tokens;
    currentUsage.completion += completion_tokens;
    currentUsage.total += total_tokens;
    
    await env.FEED_METADATA.put(monthKey, JSON.stringify(currentUsage));
    console.log(`🪙 Tokens used this request: ${total_tokens}. Monthly total: ${currentUsage.total}`);
  } catch (e) {
    console.error("❌ Failed to track token usage:", e.message);
  }
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
    
    if (id) {
      items.push({ id, title: get("title"), description, link, pubDate: get("pubDate") });
    }
  }
  return items;
}

function generateRSS(items, config) {
  const rtlLangs = ["Arabic", "Hebrew", "Persian", "Urdu"];
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
    
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXML(config.name)} (${escapeXML(config.lang)})</title>
    ${xmlItems}
  </channel>
</rss>`;
}
