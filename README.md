

# RSS AI Translator

A Cloudflare Workers application that monitors RSS feeds, translates new content via the Groq API (Llama 3.3), and serves the results as a cached RSS feed.

## Overview

The system operates on a scheduled interval to fetch external RSS feeds. It uses a persistent metadata store to track which items have already been translated, ensuring that the AI is only called for new content. This minimizes API costs and prevents redundant processing.

## Core Features

* **Item-Level Deduplication**: Uses Cloudflare KV to store translated items individually.
* **Groq JSON Mode**: Forces the LLM to return valid JSON structures, ensuring reliable XML reconstruction.
* **Resource Optimization**: Automatically trims long descriptions and limits batch sizes to stay within Cloudflare Worker CPU limits.
* **Persistent Caching**: Serves the final XML from the edge to ensure high availability and fast load times.

## Infrastructure Requirements

1. **Cloudflare KV Namespaces**:
* `RSS_CACHE`: Stores the generated XML feeds.
* `FEED_METADATA`: Stores the history of translated items.


2. **Groq API Key**: Required for access to Llama 3.3 models.
3. **Cron Trigger**: Suggested interval of 15-20 minutes.

## Configuration

Feed settings are defined in the `FEEDS` array:

* `url`: The source RSS feed.
* `lang`: The target translation language.
* `name`: The URL slug used to access the translated feed.

## Deployment

1. Copy the script into a Cloudflare Worker.
2. Bind the two KV namespaces in the Worker settings.
3. Add the `GROQ_API_KEY` as an environment variable.
4. Set up a Cron Trigger to automate the translation process.

## Accessing Feeds

Translated feeds are served at the Worker's base URL followed by the feed name:
`https://[worker-subdomain].workers.dev/[name]`
