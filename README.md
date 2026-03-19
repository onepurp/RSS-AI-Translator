# RSS AI Translator

A production-grade Cloudflare Workers application that monitors external RSS feeds, translates new content via the Groq API, and serves the results as a highly-cached, edge-optimized RSS feed. 

![Landing page](https://files.catbox.moe/hsad16.jpg )
![Admin page](https://files.catbox.moe/uyxsqo.jpg )

## Overview

The system operates on a scheduled interval to fetch external RSS feeds. It uses a persistent metadata store to track which items have already been translated, ensuring that the AI is only called for new content. It features a **built-in, secure Admin Dashboard** allowing you to manage feeds dynamically and monitor your LLM token usage without ever needing to redeploy your code.

## Core Features

* **Built-in Admin Dashboard**: A secure, Tailwind-styled UI served directly from the Worker to manage feeds, clear caches, and view real-time token usage.
* **Dynamic Feed Management**: Add, remove, and configure feeds on the fly. Feeds are stored in Cloudflare KV, eliminating the need to hardcode URLs.
* **Cost Monitoring**: Silently tracks your Groq API prompt and completion tokens in the background, keeping a running monthly total.
* **RTL Language Support**: Automatically detects Right-to-Left languages (Arabic, Hebrew, Persian, Urdu) and injects HTML formatting so feeds render perfectly in RSS readers.
* **Enterprise Resiliency**: Features parallel processing, exponential backoff for API rate limits, and a Dead Letter Queue (DLQ) to prevent failed items from blocking the translation pipeline.
* **Media Preservation**: Advanced parsing that extracts and preserves `<enclosure>` and `<media:content>` tags, ensuring images and videos appear perfectly in RSS readers.
  
## Infrastructure Requirements

1. **Cloudflare KV Namespaces**:
   * `RSS_CACHE`: Stores the generated XML feeds for instant edge delivery.
   * `FEED_METADATA`: Stores the history of translated items, feed configurations, and token usage.
2. **Environment Variables**:
   * `GROQ_API_KEY`: Required for access to Llama 3.3 models.
   * `ADMIN_SECRET`: A secure password you create to protect the Admin Dashboard.
3. **Cron Trigger**: Suggested interval of 15-20 minutes.

## Deployment

1. Create a new Cloudflare Worker and copy the `worker.js` script into it.
2. Create and bind the two KV namespaces (`RSS_CACHE` and `FEED_METADATA`) in the Worker settings.
3. Add the following Environment Variables (make sure to encrypt them):
   * `GROQ_API_KEY` = `your_groq_api_key`
   * `ADMIN_SECRET` = `your_custom_secure_password`
4. Set up a Cron Trigger to automate the translation process.
5. Deploy the Worker.

## Getting Started & Usage

Because feeds are no longer hardcoded, your Worker will start with 0 feeds. You must add them via the dashboard.

**1. Access the Admin Dashboard:**
Navigate to your worker's admin route:
`https://[worker-subdomain].workers.dev/admin`
*Log in using the `ADMIN_SECRET` you set during deployment.*

**2. Add a Feed:**
Use the dashboard UI to add a new feed by providing:
* **URL Slug**: The name used in the URL (e.g., `tech-news`)
* **Source URL**: The original RSS feed you want to translate
* **Target Lang**: The language to translate into (e.g., `Arabic`, `French`)

**3. Accessing Translated Feeds:**
Once processed, your translated public feeds are served at the Worker's base URL followed by the URL slug you created:
`https://[worker-subdomain].workers.dev/tech-news`

---

## Roadmap / To-Do

While the application is currently production-ready, the following enhancements are planned for future scaling:

- [ ] **External Monitoring & Alerting**: Integrate Sentry, Logflare, or a Discord Webhook to receive real-time push notifications if the LLM API fails or a feed goes offline.
- [ ] **Database Migration (Cloudflare D1)**: Transition feed configurations from KV to Cloudflare D1 (SQLite) to support pagination and easier management if scaling to 100+ feeds.
- [ ] **Custom System Prompts**: Add a UI field to allow per-feed custom translation instructions (e.g., *"Translate to Arabic but keep technical programming terms in English"*).
- [ ] **Multi-LLM Fallback**: Implement fallback logic to route requests to OpenAI, Anthropic, or Cloudflare Workers AI if the Groq API experiences extended downtime.
- [ ] **WebSub / PubSub Support**: Move from pure cron-based polling to real-time push notifications for feeds that support WebSub, reducing latency to zero.
