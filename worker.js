// ==========================================
// CONFIGURATION & UTILITIES
// ==========================================

const FEEDS =[
  { url: "https://example.com/original-feed-0.xml", lang: "Arabic", name: "feed0" },
  { url: "https://example.com/original-feed-1.xml", lang: "French", name: "feed1" }
];

// Safely escape CDATA closing tags to prevent XML corruption
const escapeCDATA = (str) => (str || "").replace(/]]>/g, "]]]]><![CDATA[>");

// Escape standard XML entities (Ampersand MUST be first)
const escapeXML = (str) => (str || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

// Decode XML entities during parsing so the LLM translates clean text
const decodeXML = (str) => (str || "")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

// ==========================================
// WORKER ENTRY POINTS
// ==========================================

export default {
  async scheduled(event, env, ctx) {
    console.log("📅 Cron job started...");
    ctx.waitUntil(this.processAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    
    const feedName = url.pathname.split("/").filter(Boolean).pop();
    
    if (!feedName) return new Response(`Available: ${FEEDS.map(f => f.name).join(", ")}`);
    
    const feedExists = FEEDS.some(f => f.name === feedName);
    if (!feedExists) return new Response("Feed not found", { status: 404 });

    const cached = await env.RSS_CACHE.get(`feed:${feedName}`);
    if (!cached) return new Response("Feed processing. Refresh in 1 min.", { status: 404 });

    return new Response(cached, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
  },

  async processAll(env) {
    for (const feed of FEEDS) {
      try {
        await processFeed(feed, env);
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

async function processFeed(config, env) {
  const res = await fetch(config.url);
  
  if (!res.ok) throw new Error(`Failed to fetch feed: ${res.status} ${res.statusText}`);
  
  const xml = await res.text();
  const items = parseRSS(xml);
  
  if (items.length === 0) throw new Error("No items found in feed. Aborting to preserve cache.");

  const mapKey = `map:${config.name}`;
  const translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

  // HARD LIMIT: Only 2 items to prevent timeout
  const toTranslate = items.filter(it => !translatedMap[it.id]).slice(0, 2);

  if (toTranslate.length > 0) {
    console.log(`🌐 Translating ${toTranslate.length} items for ${config.name}...`);
    const translated = await translateItems(toTranslate, config.lang, env);
    
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

async function translateItems(items, lang, env) {
  try {
    const cleanedItems = items.map(i => ({
      id: i.id,
      t: i.title.substring(0, 300), 
      d: i.description.substring(0, 1500) 
    }));

    console.log(`📡 Sending to Groq: ${cleanedItems.length} items for translation to ${lang}...`);

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${env.GROQ_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", 
        messages:[
          { 
            role: "system", 
            content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang}. Return ONLY valid JSON in this format: {"items": [{"id": "...", "t": "...", "d": "..."}]}` 
          },
          { 
            role: "user", 
            content: JSON.stringify(cleanedItems) 
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 4096
      })
    });

    if (!res.ok) {
      console.error(`❌ Groq API Error (${res.status}):`, await res.text());
      return[];
    }

    const data = await res.json();
    
    if (!data.choices || !data.choices[0]) {
      console.error("❌ Groq API Error. Full response:", JSON.stringify(data));
      return [];
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
    }).filter(Boolean); // Remove any nulls from hallucinated IDs
  } catch (e) {
    console.error("❌ Translation function crashed:", e.message);
    return[];
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
  // 1. Detect if the language is Right-to-Left (RTL)
  const rtlLangs =["Arabic", "Hebrew", "Persian", "Urdu"];
  const isRTL = rtlLangs.includes(config.lang);

  // 2. Create HTML attributes to force RTL if needed
  const dirHtml = isRTL ? '<div dir="rtl" style="text-align: right; font-family: sans-serif;">' : '<div>';
  const closeDiv = '</div>';

  const xmlItems = items.map(i => `
    <item>
      <title><![CDATA[${escapeCDATA(i.title)}]]></title>
      <!-- 3. Wrap the description in the RTL div -->
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
