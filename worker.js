const FEEDS = [
  { url: "https://example.com/original-feed-0.xml", lang: "Arabic", name: "feed0" },
  { url: "https://example.com/original-feed-1.xml", lang: "French", name: "feed1" }

];

export default {
  async scheduled(event, env, ctx) {
    console.log("📅 Cron job started...");
    ctx.waitUntil(this.processAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const feedName = url.pathname.split("/").pop();
    if (!feedName || feedName === "") return new Response(`Available: ${FEEDS.map(f => f.name).join(", ")}`);

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

async function processFeed(config, env) {
  const res = await fetch(config.url);
  const xml = await res.text();
  const items = parseRSS(xml);

  const mapKey = `map:${config.name}`;
  const translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

  // HARD LIMIT: Only 2 items to prevent timeout
  const toTranslate = items.filter(it => !translatedMap[it.id]).slice(0, 2);

  if (toTranslate.length > 0) {
    console.log(`🌐 Translating ${toTranslate.length} items for ${config.name}...`);
    const translated = await translateItems(toTranslate, config.lang, env);
    if (translated && translated.length > 0) {
      translated.forEach(it => { translatedMap[it.id] = it; });
      await env.FEED_METADATA.put(mapKey, JSON.stringify(translatedMap), { expirationTtl: 2592000 });
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
        messages: [
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

    const data = await res.json();
    
    if (!data.choices || !data.choices[0]) {
      console.error("❌ Groq API Error. Full response:", JSON.stringify(data));
      return [];
    }

    const content = data.choices[0].message.content;
    const parsed = JSON.parse(content).items;
    
    console.log(`✅ Successfully translated ${parsed.length} items.`);

    return parsed.map(p => {
      const orig = items.find(i => i.id === p.id);
      return { ...orig, title: p.t, description: p.d };
    });
  } catch (e) {
    console.error("❌ Translation function crashed:", e.message);
    return [];
  }
}

function parseRSS(xml) {
  const items = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of matches) {
    const i = m[1];
    const get = (tag) => {
      const match = i.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"));
      return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
    };
    const link = get("link");
    items.push({ id: get("guid") || link, title: get("title"), description: get("description"), link, pubDate: get("pubDate") });
  }
  return items;
}

function generateRSS(items, config) {
  const xmlItems = items.map(i => `
    <item>
      <title><![CDATA[${i.title}]]></title>
      <description><![CDATA[${i.description}]]></description>
      <link>${i.link}</link>
      <pubDate>${i.pubDate}</pubDate>
      <guid isPermaLink="false">${i.id}</guid>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${config.name} (${config.lang})</title>${xmlItems}</channel></rss>`;
}
