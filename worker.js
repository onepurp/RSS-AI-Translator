// ==========================================
// 1. UTILITIES, SECURITY & LOGGING
// ==========================================

const LogService = {
  logs: [],
  info(msg) { this.log('INFO', msg); },
  warn(msg) { this.log('WARN', msg); },
  error(msg) { this.log('ERROR', msg); },
  log(level, msg) {
    this.logs.push({ t: new Date().toISOString(), l: level, m: msg });
    if(level === 'ERROR') console.error(msg);
    else if(level === 'WARN') console.warn(msg);
    else console.log(msg);
  },
  // CRITICAL FIX: Made save() safe for concurrent calls and flushes memory instantly
  async save(env) {
    if (!this.logs.length) return;
    try {
      const logsToSave = [...this.logs];
      this.logs = []; // Clear immediately to prevent duplicates
      const existing = await env.FEED_METADATA.get("system:logs", "json") || [];
      const updated = [...existing, ...logsToSave].slice(-200); 
      await env.FEED_METADATA.put("system:logs", JSON.stringify(updated));
    } catch (e) { console.error("Failed to save logs to KV", e); }
  }
};

const Utils = {
  escapeCDATA: (str) => (str || "").replace(/]]>/g, "]]]]><![CDATA[>"),
  escapeXML: (str) => (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
  decodeXML: (str) => (str || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&"),
  escapeHTML: (str) => (str || "").replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])),
  
  logError: (context, error) => {
    LogService.error(`[${context}] ${error.message}`);
  },

  safeFetch: async (url, options = {}, timeoutMs = 15000) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
      }
      throw error;
    }
  },

  HTMLProcessor: {
    encode: (text) => {
      if (!text) return { encoded: "", map: {} };
      const map = {};
      let counter = 0;
      const encoded = text.replace(/<[^>]+>|https?:\/\/[^\s<"']+/gi, (match) => {
        const key = `[T${counter}]`;
        map[key] = match;
        counter++;
        return key;
      });
      return { encoded, map };
    },
    decode: (text, map) => {
      if (!text) return "";
      let decoded = text;
      for (const [key, value] of Object.entries(map)) {
        const num = key.match(/\d+/)[0];
        const regex = new RegExp(`\\\\\\[\\s*[Tt]${num}\\s*\\\\\\]|\\[\\s*[Tt]${num}\\s*\\]`, 'g');
        decoded = decoded.replace(regex, value);
      }
      return decoded;
    }
  }
};

// ==========================================
// 2. STORAGE SERVICE
// ==========================================

let memoryCache = { feeds: null, lastFetch: 0 };
const CACHE_TTL_MS = 60000; 

const StorageService = {
  async getFeeds(env) {
    const now = Date.now();
    if (memoryCache.feeds && (now - memoryCache.lastFetch < CACHE_TTL_MS)) {
      return memoryCache.feeds;
    }
    try {
      const feeds = await env.FEED_METADATA.get("config:feeds", "json") || [];
      memoryCache = { feeds, lastFetch: now };
      return feeds;
    } catch (e) {
      LogService.error("CRITICAL: Failed to parse 'config:feeds' from KV. Data might be corrupted.");
      return [];
    }
  },

  async saveFeeds(env, feeds) {
    await env.FEED_METADATA.put("config:feeds", JSON.stringify(feeds));
    memoryCache = { feeds, lastFetch: Date.now() }; 
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
// 3. LLM SERVICE (Multi-Model Fallback)
// ==========================================

const LLMService = {
  exhaustedModels: new Set(),

  async translate(items, lang, env, ctx) {
    if (!items.length) return [];
    
    const itemMaps = {};

    const cleanedItems = items.map((i, idx) => {
      const tData = Utils.HTMLProcessor.encode(i.title || "");
      const dData = Utils.HTMLProcessor.encode(i.description || "");
      
      let tSafe = tData.encoded;
      let dSafe = dData.encoded;

      // Ensure the absolute size of the text is tiny to accommodate small fallback models
      if (tSafe.length > 400) tSafe = tSafe.substring(0, 400).replace(/\[[T\d]*$/, '') + '...';
      if (dSafe.length > 2000) dSafe = dSafe.substring(0, 2000).replace(/\[[T\d]*$/, '') + '...';
      
      itemMaps[idx] = { id: i.id, tMap: tData.map, dMap: dData.map };
      return { i: idx, t: tSafe, d: dSafe };
    });
    
    const MODELS = [
      { name: "openai/gpt-oss-120b", tokens: 2500 },
      { name: "meta-llama/llama-4-scout-17b-16e-instruct", tokens: 1500 } // Smaller request to avoid 413s on strict tiers
    ];

    let data = null;

    for (const modelConfig of MODELS) {
      if (this.exhaustedModels.has(modelConfig.name)) continue;

      LogService.info(`🧠 Attempting translation with model: ${modelConfig.name}`);
      
      const payload = JSON.stringify({
        model: modelConfig.name, 
        messages:[
          { 
            role: "system", 
            content: `You are a professional translator. Translate 't' (title) and 'd' (description) into ${lang}. 
CRITICAL INSTRUCTIONS:
1. The text contains placeholders like [T0]. Preserve them exactly.
2. Return ONLY a valid JSON object. Do NOT wrap in markdown.
3. Keep the integer index "i" exactly as provided.
4. Escape all double quotes (") inside translated text as (\\").
5. Format: {"items":[{"i": 0, "t": "...", "d": "..."}]}`
          },
          { role: "user", content: JSON.stringify(cleanedItems) }
        ],
        temperature: 0.1,
        // DYNAMIC FIX: Use model-specific token requests to prevent 413 payload breaches
        max_tokens: modelConfig.tokens 
      });

      let delay = 2000; 
      let modelExhausted = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        let res;
        try {
          res = await Utils.safeFetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
            body: payload
          }, 45000);
        } catch (fetchErr) {
          LogService.warn(`⚠️ API connection failed: ${fetchErr.message}. Retrying...`);
          if (attempt === 3) { modelExhausted = true; break; }
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue; 
        }

        const status = res.status;

        if (res.ok) { 
          data = await res.json(); 
          break; 
        }
        
        if (status === 429 || status === 498) {
          const errText = await res.text();
          if (errText.includes("tokens per day (TPD)")) {
            LogService.warn(`🛑 Daily Limit hit for ${modelConfig.name}. Blacklisting for this session...`);
            this.exhaustedModels.add(modelConfig.name); 
            modelExhausted = true;
            break; 
          }
          
          LogService.warn(`⚠️ API Rate Limit (${status}): ${errText}`);
          if (attempt === 3) { modelExhausted = true; break; }
          LogService.warn(`⚠️ Sleeping 60 seconds to refill token bucket...`);
          await LogService.save(env); 
          await new Promise(resolve => setTimeout(resolve, 60000));
          
        } else if (status >= 500) {
          if (attempt === 3) { modelExhausted = true; break; }
          LogService.warn(`⚠️ Server Error (${status}). Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; 
        } else if (status === 413) {
          throw new Error("PAYLOAD_TOO_LARGE");
        } else {
          const errText = await res.text();
          Utils.logError("Groq_API_Fatal", new Error(`HTTP ${status}: ${errText}`));
          modelExhausted = true;
          break; 
        }
      }

      if (data) break; 
    }

    if (!data?.choices?.[0]) throw new Error("RATE_LIMIT_EXCEEDED");

    if (data.usage) {
      ctx ? ctx.waitUntil(StorageService.trackUsage(env, data.usage)) : await StorageService.trackUsage(env, data.usage);
    }

    try {
      let content = data.choices[0].message.content;
      content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      const startIdx = content.indexOf('{');
      if (startIdx !== -1) content = content.substring(startIdx);
      content = content.replace(/[\u0000-\u0009\u000B-\u000C\u000E-\u001F]+/g, "");
      content = content.replace(/,\s*([\]}])/g, '$1');

      let parsed = null;
      
      try {
        parsed = JSON.parse(content).items || [];
      } catch (err) {
        let valid = false;
        let searchIdx = content.length;
        while (searchIdx > 10) {
          const lastBracket = content.lastIndexOf('}', searchIdx);
          if (lastBracket === -1) break;
          const testStr = content.substring(0, lastBracket + 1) + ']}';
          try {
            parsed = JSON.parse(testStr).items || [];
            valid = true;
            LogService.info(`✅ Salvage successful! Recovered ${parsed.length} items.`);
            break;
          } catch (e) { searchIdx = lastBracket - 1; }
        }

        if (!valid && items.length === 1) {
          const lastQuote = content.lastIndexOf('"');
          if (lastQuote > 10) {
            const salvagedStr = content.substring(0, lastQuote) + '"]}]}';
            try {
              parsed = JSON.parse(salvagedStr).items || [];
              valid = true;
              LogService.info(`✅ Brutal salvage successful! Item recovered.`);
            } catch(e) {}
          }
        }
        if (!valid) throw new Error("OUTPUT_TRUNCATED");
      }

      if (!Array.isArray(parsed)) throw new Error("Invalid JSON array");
      
      return parsed.map(p => {
        const mappedIdx = parseInt(p.i, 10);
        const mappedData = itemMaps[mappedIdx];
        if (!mappedData) return null;
        
        const orig = items.find(i => i.id === mappedData.id);
        if (!orig) return null;
        
        const decodedTitle = Utils.HTMLProcessor.decode(p.t || orig.title, mappedData.tMap);
        const decodedDesc = Utils.HTMLProcessor.decode(p.d || orig.description, mappedData.dMap);
        
        return { ...orig, title: decodedTitle, description: decodedDesc };
      }).filter(Boolean);
    } catch (err) { 
      if (err.message === "OUTPUT_TRUNCATED") throw err;
      Utils.logError("LLM_Parse", err);
      return [];
    }
  }
};

// ==========================================
// 4. RSS SERVICE
// ==========================================



// ==========================================
// 4. RSS SERVICE
// ==========================================

const RSSService = {
  parse(xml) {
    const items = [];
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
    const isRTL = ["Arabic", "Hebrew", "Persian", "Urdu"].includes(config.lang);
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
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${Utils.escapeXML(config.name)} (${Utils.escapeXML(config.lang)})</title>${xmlItems}</channel></rss>`;
  },

  async processFeed(config, env, ctx, startTime) {
    let hitFatalLimit = false;
    let translatedMap = {};
    let items = [];

    try {
      LogService.info(`📡 [${config.name}] Fetching RSS source...`);
      await LogService.save(env); 
      
      // CRITICAL FIX 1: Disguise as Google Chrome & increase timeout to 25 seconds
      // This stops RSSHubs/Telegram scrapers from blocking or throttling the request
      const res = await Utils.safeFetch(config.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml, application/xml, text/xml, */*"
        }
      }, 25000);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const xml = await res.text();
      items = this.parse(xml);
      if (!items.length) throw new Error("Empty feed");

      const mapKey = `map:${config.name}`;
      translatedMap = await env.FEED_METADATA.get(mapKey, "json") || {};

      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
      let didPruneOldData = false;

      for (const [key, value] of Object.entries(translatedMap)) {
        if (value._ts && (now - value._ts > THIRTY_DAYS_MS)) {
          delete translatedMap[key];
          didPruneOldData = true;
        }
        else if (value.failed && value._failedAt && (now - value._failedAt > THREE_DAYS_MS)) {
          delete translatedMap[key];
          didPruneOldData = true;
        }
      }
      if (didPruneOldData) {
        LogService.info(`🧹 [${config.name}] Swept old items from database.`);
      }

      let untranslated = items.filter(it => !translatedMap[it.id] || (translatedMap[it.id].failed === true && !translatedMap[it.id]._failedAt));
      
      // CRITICAL FIX 2: Graceful Fallback
      // If an item hasn't been translated yet (or if it permanently failed), we output the original `it`!
      const initialItems = items.slice(0, 15).map(it => (translatedMap[it.id] && !translatedMap[it.id].failed) ? translatedMap[it.id] : it);
      await env.RSS_CACHE.put(`feed:${config.name}`, this.generate(initialItems, config), { expirationTtl: 2592000 }); 

      if (untranslated.length === 0) {
        LogService.info(`⚡ [${config.name}] No new items. Cache updated.`);
        return true;
      }

      let currentMaxBatchChars = 1800; 

      while (untranslated.length > 0) {
        const toTranslate = [];
        let currentCharCount = 0;

        for (const it of untranslated) {
          let textLength = (it.title || "").length + (it.description || "").length;
          if (textLength > 3000) textLength = 3000; 
          
          if (textLength > currentMaxBatchChars && toTranslate.length === 0) {
            toTranslate.push(it);
            currentCharCount += textLength;
            break;
          }
          if (currentCharCount + textLength > currentMaxBatchChars && toTranslate.length > 0) break;
          toTranslate.push(it);
          currentCharCount += textLength;
        }

        if (toTranslate.length > 0) {
          LogService.info(`🌐 [${config.name}] Translating batch of ${toTranslate.length} items (${currentCharCount} chars)...`);
          await LogService.save(env); 
          
          try {
            const translated = await LLMService.translate(toTranslate, config.lang, env, ctx);
            
            if (translated && translated.length > 0) {
              translated.forEach(it => { translatedMap[it.id] = { ...it, _ts: Date.now() }; });
              currentMaxBatchChars = 1800; 
              
              const processedIds = new Set(Object.keys(translatedMap));
              untranslated = untranslated.filter(it => !processedIds.has(it.id));
              
              const prunedMap = {};
              items.forEach(it => { if (translatedMap[it.id]) prunedMap[it.id] = translatedMap[it.id]; });
              await env.FEED_METADATA.put(mapKey, JSON.stringify(prunedMap), { expirationTtl: 2592000 });

              // FALLBACK FIX: Includes untranslated items in the live cache updates
              const interimItems = items.slice(0, 15).map(it => (translatedMap[it.id] && !translatedMap[it.id].failed) ? translatedMap[it.id] : it);
              await env.RSS_CACHE.put(`feed:${config.name}`, this.generate(interimItems, config), { expirationTtl: 2592000 });
              LogService.info(`💾 [${config.name}] Incremental cache updated.`);
              
            } else {
              LogService.warn(`⚠️ [${config.name}] Translation returned empty. Skipping to prevent data loss.`);
              break; 
            }
          } catch (e) {
            if (e.message === "RATE_LIMIT_EXCEEDED" || e.message === "SERVER_ERROR") {
              LogService.warn(`⏳ [${config.name}] Global Limit Exhausted. Preserving completed translations...`);
              hitFatalLimit = true;
              break; 
            }
            if (e.message === "PAYLOAD_TOO_LARGE" || e.message === "OUTPUT_TRUNCATED") {
              LogService.warn(`⚠️ [${config.name}] Payload Limit breached. Shrinking batch size and retrying...`);
              currentMaxBatchChars = Math.floor(currentMaxBatchChars / 2);
              
              if (toTranslate.length === 1) {
                LogService.error(`❌ [${config.name}] Item too complex. Putting in 3-day penalty box.`);
                translatedMap[toTranslate[0].id] = { failed: true, _failedAt: Date.now(), ...toTranslate[0] };
                untranslated = untranslated.filter(it => it.id !== toTranslate[0].id);
                await env.FEED_METADATA.put(mapKey, JSON.stringify(translatedMap), { expirationTtl: 2592000 });
              }
              continue; 
            }
            throw e;
          }
        }

        if (Date.now() - startTime > 810000) {
          LogService.warn(`⏳ Cloudflare 15-min limit approaching. Pausing loop.`);
          hitFatalLimit = true;
          break;
        }
      }
    } catch (e) {
      Utils.logError(`processFeed:${config.name}`, e);
    }

    if (!hitFatalLimit) LogService.info(`✅ [${config.name}] Fully processed and cached.`);
    return !hitFatalLimit; 
  }
};



// ==========================================
// 5. ROUTER & WORKER ENTRY
// ==========================================

export default {
  async scheduled(event, env, ctx) {
    try {
      const startTime = Date.now(); 
      LogService.info(`🚀 Starting cron job...`);
      await LogService.save(env); // Force flush initial log
      
      const feeds = await StorageService.getFeeds(env);
      
      if (feeds.length > 0) {
        for (const feed of feeds) {
          const shouldContinue = await RSSService.processFeed(feed, env, ctx, startTime);
          await LogService.save(env); // Flush logs after every feed completes
          if (!shouldContinue) {
            LogService.warn("⏸️ Queue paused globally due to API limits.");
            break; 
          }
        }
      } else {
        LogService.warn("⚠️ No feeds configured.");
      }
      LogService.info("🏁 Cron job finished.");
    } catch (err) {
      LogService.error(`CRITICAL CRON ERROR: ${err.message}`);
    } finally {
      await LogService.save(env); // Guarantee final flush even if worker crashes
    }
  },

  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const endpoint = pathParts.join("/");

      if (endpoint.startsWith("admin")) {
        const authHeader = request.headers.get("Authorization")?.replace("Bearer ", "");
        const isAuthorized = env.ADMIN_SECRET && authHeader === env.ADMIN_SECRET;

        if (endpoint === "admin") return new Response(getAdminHTML(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        if (!isAuthorized) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

        if (endpoint === "admin/usage") {
          const usage = await StorageService.getUsage(env);
          return new Response(JSON.stringify({ month: usage.key, tokens: usage.data }), { headers: { "Content-Type": "application/json" } });
        }

        if (endpoint === "admin/logs") {
          if (request.method === "GET") {
            const logs = await env.FEED_METADATA.get("system:logs", "json") || [];
            return new Response(JSON.stringify({ logs }));
          }
          if (request.method === "DELETE") {
            await env.FEED_METADATA.delete("system:logs");
            return new Response(JSON.stringify({ success: true }));
          }
        }

        if (endpoint === "admin/feeds") {
          if (request.method === "GET") {
            let adminFeeds = await StorageService.getFeeds(env);
            if (!Array.isArray(adminFeeds)) adminFeeds = [];
            return new Response(JSON.stringify({ feeds: adminFeeds }));
          }
          if (request.method === "POST") {
            try {
              const newFeeds = await request.json();
              if (!Array.isArray(newFeeds)) throw new Error("Payload must be an array.");
              const validFeeds = newFeeds.map(f => ({ url: f.url, lang: f.lang, name: f.name }));
              await StorageService.saveFeeds(env, validFeeds);
              LogService.info("🛠️ Admin updated feed configuration.");
              ctx.waitUntil(LogService.save(env));
              return new Response(JSON.stringify({ success: true, feeds: validFeeds }));
            } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 400 }); }
          }
        }

        if (endpoint.startsWith("admin/cache/") && request.method === "DELETE") {
          const feedToClear = endpoint.split("/").pop();
          await env.RSS_CACHE.delete(`feed:${feedToClear}`);
          await env.FEED_METADATA.delete(`map:${feedToClear}`); 
          LogService.info(`🗑️ Admin cleared cache and memory for: ${feedToClear}`);
          ctx.waitUntil(LogService.save(env));
          return new Response(JSON.stringify({ success: true }));
        }

        return new Response("Not found", { status: 404 });
      }

      // --- PUBLIC ROUTES ---
      let feeds = await StorageService.getFeeds(env);
      if (!Array.isArray(feeds)) feeds = []; 
      
      const feedName = pathParts.pop();
      if (!feedName) return new Response(getPublicHTML(feeds, url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (!feeds.some(f => f.name === feedName)) return new Response("Feed not found", { status: 404 });

      const cached = await env.RSS_CACHE.get(`feed:${feedName}`);
      
      if (!cached) {
        const feedObj = feeds.find(f => f.name === feedName);
        ctx.waitUntil((async () => {
          LogService.info(`🚀 Background sync started for missing cache: ${feedName}`);
          await RSSService.processFeed(feedObj, env, ctx, Date.now());
          await LogService.save(env);
        })());
        
        await new Promise(r => setTimeout(r, 1000));
        const instantCache = await env.RSS_CACHE.get(`feed:${feedName}`);
        if (instantCache) return new Response(instantCache, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=30" } });
        
        return new Response("Feed processing. Refresh page in 10 seconds.", { status: 404 });
      }

      return new Response(cached, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });

    } catch (error) {
      return new Response(`CRITICAL WORKER CRASH:\n${error.message}\n\nStack Trace:\n${error.stack}`, { status: 500, headers: { "Content-Type": "text/plain" } });
    }
  }
};

// ==========================================
// 6. SECURE UI GENERATOR (PREMIUM ADMIN SPA)
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
      theme: { extend: { colors: { brand: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a' } } } }
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
    .bg-grid-pattern { background-image: radial-gradient(rgba(0, 0, 0, 0.05) 1px, transparent 1px); background-size: 24px 24px; }
    .dark .bg-grid-pattern { background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 dark:bg-[#0B1120] dark:text-slate-50 min-h-screen transition-colors duration-200 relative selection:bg-brand-500 selection:text-white">
  
  <div class="absolute inset-0 bg-grid-pattern pointer-events-none z-0"></div>
  <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-brand-500/10 dark:bg-brand-500/20 blur-[120px] rounded-full pointer-events-none z-0"></div>

  <!-- AUTH VIEW -->
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
          <input type="password" id="secret-input" placeholder="Enter Admin Secret" class="w-full bg-white dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3.5 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none transition-all dark:text-white shadow-sm" required>
        </div>
        <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 text-white p-3.5 rounded-xl font-semibold transition-colors shadow-md active:scale-[0.98]">Secure Login</button>
      </form>
    </div>
  </div>

  <!-- DASHBOARD VIEW -->
  <div id="view-dashboard" class="hidden max-w-5xl mx-auto p-6 space-y-8 pb-12 relative z-10">
    <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-gray-200 dark:border-slate-800/50 pb-6 pt-4">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white">RSS AI Translator</h1>
        <div class="flex items-center gap-2 mt-2">
          <span class="relative flex h-3 w-3"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span>
          <span class="text-sm font-medium text-emerald-600 dark:text-emerald-400">System Online</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button id="theme-toggle" class="p-2.5 rounded-xl bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 text-gray-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400 shadow-sm">
          <svg id="icon-sun" class="w-5 h-5 hidden dark:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
          <svg id="icon-moon" class="w-5 h-5 block dark:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
        </button>
        <button onclick="logout()" class="px-4 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-300 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700 shadow-sm">Logout</button>
      </div>
    </header>

    <!-- NEW: Live Terminal Section -->
    <section class="mt-8">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-bold text-gray-800 dark:text-slate-200 flex items-center gap-2">
          <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M4 17h16a2 2 0 002-2V9a2 2 0 00-2-2H4a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>
          Live Terminal
        </h2>
        <div class="flex items-center gap-4">
          <span class="text-xs text-emerald-500 font-bold tracking-widest uppercase animate-pulse flex items-center gap-1.5"><span class="w-2 h-2 bg-emerald-500 rounded-full"></span> LIVE</span>
          <button onclick="clearTerminal()" class="text-xs font-semibold text-gray-500 hover:text-red-500 transition-colors">Clear Logs</button>
        </div>
      </div>
      <div id="terminal-output" class="bg-[#0f172a] text-gray-300 p-4 rounded-2xl font-mono text-xs sm:text-sm h-56 overflow-y-auto border border-gray-800 shadow-inner flex flex-col gap-1.5 scroll-smooth">
        <div class="text-gray-500 italic">Initializing live feed connection...</div>
      </div>
    </section>

    <!-- Metrics -->
    <section>
      <h2 class="text-lg font-bold mb-4 text-gray-800 dark:text-slate-200">Token Usage (This Month)</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm">
          <p class="text-sm text-gray-500 dark:text-slate-400 font-semibold mb-1 uppercase tracking-wider">Prompt</p>
          <p id="stat-prompt" class="text-3xl font-extrabold text-gray-900 dark:text-white skeleton-text">---</p>
        </div>
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm">
          <p class="text-sm text-gray-500 dark:text-slate-400 font-semibold mb-1 uppercase tracking-wider">Completion</p>
          <p id="stat-completion" class="text-3xl font-extrabold text-gray-900 dark:text-white skeleton-text">---</p>
        </div>
        <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl p-6 rounded-2xl border border-brand-200 dark:border-brand-800/50 shadow-sm relative overflow-hidden">
          <div class="absolute top-0 right-0 w-24 h-24 bg-brand-100 dark:bg-brand-900/20 rounded-bl-full -mr-8 -mt-8"></div>
          <p class="text-sm text-brand-600 dark:text-brand-400 font-semibold mb-1 uppercase tracking-wider">Total</p>
          <p id="stat-total" class="text-4xl font-extrabold text-brand-700 dark:text-brand-300 skeleton-text">---</p>
        </div>
      </div>
    </section>

    <!-- Feeds -->
    <section>
      <div class="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-4">
        <h2 class="text-lg font-bold text-gray-800 dark:text-slate-200">Managed Feeds</h2>
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
          <div class="relative w-full sm:w-64">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </div>
            <input type="text" id="adminSearchInput" placeholder="Search feeds..." class="w-full pl-9 pr-4 py-2.5 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none text-sm dark:text-white">
          </div>
          <div class="flex gap-2 w-full sm:w-auto">
            <button onclick="clearAllCaches(this)" class="flex-1 sm:flex-none bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border border-gray-200 dark:border-slate-700/50 text-gray-700 dark:text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-sm flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-slate-700">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Clear All
            </button>
            <button onclick="openModal()" class="flex-1 sm:flex-none bg-brand-600 hover:bg-brand-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-md flex items-center justify-center gap-2 active:scale-[0.98]">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> Add Feed
            </button>
          </div>
        </div>
      </div>
      
      <div class="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-sm overflow-hidden">
        <ul id="feeds-list" class="divide-y divide-gray-100 dark:divide-slate-700/50">
          <li class="p-6 animate-pulse flex justify-between"><div class="h-5 bg-gray-200 dark:bg-slate-700 rounded w-1/3"></div><div class="h-8 bg-gray-200 dark:bg-slate-700 rounded w-24"></div></li>
        </ul>
      </div>
    </section>
  </div>

  <!-- MODAL -->
  <div id="modal-backdrop" class="hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity"></div>
  <div id="modal-add" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div class="bg-white/95 dark:bg-slate-800/95 backdrop-blur-2xl w-full max-w-lg rounded-3xl shadow-2xl border border-gray-200 dark:border-slate-700/50 overflow-hidden modal-enter">
      <div class="flex justify-between items-center p-6 border-b border-gray-100 dark:border-slate-700/50">
        <h3 id="modal-title" class="text-xl font-bold text-gray-900 dark:text-white">Provision Feed</h3>
        <button onclick="closeModal()" class="text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 p-1.5 rounded-lg"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
      </div>
      <form id="add-feed-form" class="p-6 space-y-5">
        <input type="hidden" id="edit-index" value="">
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">URL Slug</label>
          <input type="text" id="feed-name" placeholder="e.g. tech-news" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Source RSS URL</label>
          <input type="url" id="feed-url" placeholder="https://example.com/feed.xml" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Target Language</label>
          <input type="text" id="feed-lang" placeholder="e.g. Arabic" class="w-full bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700 p-3 rounded-xl focus:ring-2 focus:ring-brand-500 outline-none dark:text-white shadow-sm" required>
        </div>
        <div class="pt-4 flex justify-end gap-3">
          <button type="button" onclick="closeModal()" class="px-5 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700">Cancel</button>
          <button type="submit" id="add-btn" class="bg-brand-600 hover:bg-brand-700 text-white px-6 py-2.5 rounded-xl text-sm font-semibold shadow-md active:scale-[0.98]">Save Feed</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast-container" aria-live="polite" class="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none"></div>

  <script>
    const escapeHTML = (str) => str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
    
    function showToast(msg, type='success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      const isError = type === 'error';
      toast.className = \`toast-enter pointer-events-auto flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl text-sm font-semibold text-white \${isError ? 'bg-red-500' : 'bg-slate-800 dark:bg-slate-700 border border-slate-600'}\`;
      toast.innerHTML = \`<svg class="w-5 h-5 \${isError ? 'text-red-100' : 'text-emerald-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="\${isError ? 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' : 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'}"></path></svg><span>\${escapeHTML(msg)}</span>\`;
      container.appendChild(toast);
      setTimeout(() => { toast.classList.replace('toast-enter', 'toast-leave'); setTimeout(() => toast.remove(), 300); }, 4000);
    }

    const themeToggleBtn = document.getElementById('theme-toggle');
    function initTheme() {
      if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      } else { document.documentElement.classList.remove('dark'); }
    }
    themeToggleBtn.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    initTheme();

    let secret = localStorage.getItem('admin_secret');
    let currentFeeds =[];
    let logInterval = null;

    async function apiFetch(path, options = {}) {
      options.headers = { ...options.headers, 'Authorization': 'Bearer ' + secret };
      const res = await fetch(path, options);
      if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
      return res;
    }

    function logout() { localStorage.removeItem('admin_secret'); location.reload(); }

    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      localStorage.setItem('admin_secret', document.getElementById('secret-input').value);
      location.reload();
    });

    // NEW: Live Terminal Polling
    async function fetchLogs() {
      try {
        const res = await apiFetch('/admin/logs');
        if (res.ok) {
          const data = await res.json();
          const term = document.getElementById('terminal-output');
          if (data.logs.length === 0) {
            term.innerHTML = '<div class="text-gray-500 italic">No logs recorded yet.</div>';
            return;
          }
          const isAtBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 20;
          
          term.innerHTML = data.logs.map(l => {
            const time = new Date(l.t).toLocaleTimeString([], { hour12: false });
            let color = 'text-emerald-400';
            if (l.l === 'WARN') color = 'text-amber-400';
            if (l.l === 'ERROR') color = 'text-red-400';
            return \`<div><span class="text-gray-500">[\${time}]</span> <span class="\${color} font-bold">[\${l.l}]</span> <span class="text-gray-300">\${escapeHTML(l.m)}</span></div>\`;
          }).join('');

          if (isAtBottom) term.scrollTop = term.scrollHeight;
        }
      } catch (e) {}
    }

    window.clearTerminal = async () => {
      if(!confirm("Clear all logs?")) return;
      await apiFetch('/admin/logs', { method: 'DELETE' });
      document.getElementById('terminal-output').innerHTML = '<div class="text-gray-500 italic">Logs cleared.</div>';
      showToast('Logs cleared');
    };

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
        
        // Start Terminal
        fetchLogs();
        logInterval = setInterval(fetchLogs, 5000);
      } catch(e) { showToast('Failed to load data', 'error'); }
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
              <span class="bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 text-xs font-bold px-2.5 py-1 rounded-full uppercase">\${escapeHTML(f.lang)}</span>
            </div>
            <a href="\${escapeHTML(f.url)}" target="_blank" class="text-sm text-gray-500 hover:text-brand-600 truncate block transition-colors">\${escapeHTML(f.url)}</a>
          </div>
          <div class="flex flex-wrap gap-2 w-full lg:w-auto opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
            <button onclick="navigator.clipboard.writeText(window.location.origin + '/\${escapeHTML(f.name)}'); showToast('URL copied!');" class="px-3 py-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl text-sm font-semibold shadow-sm flex items-center gap-1.5">Copy</button>
            <button onclick="openModal(\${i})" class="px-3 py-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl text-sm font-semibold shadow-sm flex items-center gap-1.5">Edit</button>
            <button onclick="clearCache('\${escapeHTML(f.name)}', this)" class="px-3 py-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl text-sm font-semibold shadow-sm flex items-center gap-1.5">Refresh</button>
            <button onclick="deleteFeed(\${i})" class="px-3 py-2 bg-white dark:bg-slate-800 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl text-sm font-semibold shadow-sm flex items-center gap-1.5">Delete</button>
          </div>
        </li>
      \`).join('');
    }

    const searchInput = document.getElementById('adminSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.admin-feed-card').forEach(card => card.style.display = card.getAttribute('data-search').includes(term) ? 'flex' : 'none');
      });
    }

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
        title.innerText = 'Edit Feed'; btn.innerText = 'Update Feed';
      } else {
        document.getElementById('add-feed-form').reset();
        indexInput.value = '';
        title.innerText = 'Provision New Feed'; btn.innerText = 'Save Feed';
      }
      modal.classList.remove('hidden'); backdrop.classList.remove('hidden');
      setTimeout(() => document.getElementById('feed-name').focus(), 50);
    }

    function closeModal() { modal.classList.add('hidden'); backdrop.classList.add('hidden'); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

    document.getElementById('add-feed-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('feed-name').value.trim();
      const url = document.getElementById('feed-url').value.trim();
      const lang = document.getElementById('feed-lang').value.trim();
      const editIndex = document.getElementById('edit-index').value;
      
      if (editIndex === "" && currentFeeds.some(f => f.name === name)) return showToast('Slug already exists!', 'error');

      const btn = document.getElementById('add-btn');
      const originalText = btn.innerText;
      btn.innerText = 'Saving...'; btn.disabled = true;
      
      let newFeeds = [...currentFeeds];
      if (editIndex !== "") newFeeds[editIndex] = { name, url, lang }; else newFeeds.push({ name, url, lang });
      
      try {
        const res = await apiFetch('/admin/feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newFeeds) });
        if(!res.ok) throw new Error();
        currentFeeds = newFeeds; renderFeeds(); closeModal();
        showToast(editIndex !== "" ? 'Feed updated' : 'Feed provisioned');
      } catch(err) { showToast('Failed to save feed', 'error'); } finally { btn.innerText = originalText; btn.disabled = false; }
    });

    window.deleteFeed = async (index) => {
      if(!confirm('Are you sure you want to permanently delete this feed?')) return;
      const previousFeeds = [...currentFeeds];
      currentFeeds.splice(index, 1); renderFeeds();
      try {
        const res = await apiFetch('/admin/feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentFeeds) });
        if(!res.ok) throw new Error(); showToast('Feed deleted');
      } catch(err) { currentFeeds = previousFeeds; renderFeeds(); showToast('Failed to delete', 'error'); }
    };

    window.clearCache = async (name, btn) => {
      const originalHTML = btn.innerHTML;
      btn.innerHTML = 'Refreshing...'; btn.disabled = true;
      try {
        const res = await apiFetch('/admin/cache/' + name, { method: 'DELETE' });
        if(res.ok) { showToast('Cache cleared!'); fetchLogs(); } else throw new Error();
      } catch(err) { showToast('Failed to clear', 'error'); } finally { btn.innerHTML = originalHTML; btn.disabled = false; }
    };

    window.clearAllCaches = async (btn) => {
      if(!confirm('Clear the cache for ALL feeds?')) return;
      const originalHTML = btn.innerHTML;
      btn.innerHTML = 'Clearing...'; btn.disabled = true;
      try {
        await Promise.all(currentFeeds.map(f => apiFetch('/admin/cache/' + f.name, { method: 'DELETE' })));
        showToast('All caches cleared!'); fetchLogs();
      } catch(err) { showToast('Failed to clear some caches', 'error'); } finally { btn.innerHTML = originalHTML; btn.disabled = false; }
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
