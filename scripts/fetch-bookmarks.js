/**
 * Fetch bookmarks from a Slack channel
 *
 * Setup:
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Add OAuth scope: channels:history (or groups:history for private channels)
 * 3. Install to workspace, get Bot Token (xoxb-...)
 * 4. Create a channel (e.g., #bookmarks) and invite the bot
 * 5. Set environment variables:
 *    - SLACK_BOT_TOKEN
 *    - SLACK_CHANNEL_ID (right-click channel > View channel details > copy ID at bottom)
 */

const fs = require('fs');
const path = require('path');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

async function fetchSlackMessages() {
  const response = await fetch(`https://slack.com/api/conversations.history?channel=${SLACK_CHANNEL_ID}&limit=50`, {
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (!data.ok) {
    console.error('Slack API error:', data.error);
    return [];
  }

  return data.messages || [];
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// True for "example.com", "example.com/path", "https://example.com/..." — text that is
// just a URL and not a real title. Slack uses this form as the display text for pasted links.
function looksLikeUrl(text) {
  if (!text) return true;
  const t = text.trim();
  if (/\s/.test(t)) return false;
  return /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(?::\d+)?([\/?#]\S*)?$/i.test(t);
}

async function fetchPageTitle(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 200000);
    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
      const m = html.match(re);
      return m ? (m[1] || m[2]) : null;
    };
    const raw = meta('og:title') || meta('twitter:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (!raw) return null;
    const title = decodeEntities(raw).trim().replace(/\s+/g, ' ');
    return title && !looksLikeUrl(title) ? title : null;
  } catch (e) {
    console.log(`Could not fetch title for ${url}:`, e.message);
  }
  return null;
}

// Slack attaches link previews ("unfurls") to the message; their titles survive even
// when the site blocks our own fetch.
function unfurlTitle(msg, url) {
  const atts = msg.attachments || [];
  const hit = atts.find(a => a.original_url === url || a.from_url === url);
  const t = hit && (hit.title || hit.fallback);
  return t && !looksLikeUrl(t) ? decodeEntities(t).trim() : null;
}

async function resolveTitle(msg, url, slackDisplay) {
  if (slackDisplay && !looksLikeUrl(slackDisplay)) return decodeEntities(slackDisplay).trim();
  const fromUnfurl = unfurlTitle(msg, url);
  if (fromUnfurl) return fromUnfurl;
  console.log(`Fetching title for: ${url}`);
  const fetched = await fetchPageTitle(url);
  if (fetched) return fetched;
  return humanizeUrl(url);
}

// Last resort when the site blocks us: turn "/2026/04/30/opinion/ai-labor-work-force.html"
// into "Ai labor work force"; otherwise show host + path without the scheme.
function humanizeUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = (segs[segs.length - 1] || '').replace(/\.[a-z0-9]{2,5}$/i, '');
    const words = last.split(/[-_]+/).filter(Boolean);
    const looksLikeSlug = words.length >= 3 && words.every(w => w.length <= 20 && !/^[0-9a-f]{8,}$/i.test(w));
    if (looksLikeSlug) {
      const text = decodeURIComponent(words.join(' '));
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).slice(0, 80);
  } catch (e) {
    return url;
  }
}

async function extractBookmarks(messages) {
  const bookmarks = [];

  // URL regex
  const urlRegex = /<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g;

  for (const msg of messages) {
    const text = msg.text || '';
    const timestamp = new Date(parseFloat(msg.ts) * 1000);

    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[1];
      const slackDisplay = match[2]; // Slack's display text; for pasted links it is just a shortened URL

      // Skip Slack internal links
      if (url.includes('slack.com')) continue;

      const title = await resolveTitle(msg, url, slackDisplay);

      bookmarks.push({
        url,
        title,
        date: timestamp.toISOString(),
        dateFormatted: timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      });
    }
  }

  // Sort by date, newest first
  bookmarks.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Remove duplicates by URL
  const seen = new Set();
  return bookmarks.filter(b => {
    if (seen.has(b.url)) return false;
    seen.add(b.url);
    return true;
  });
}

async function main() {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID environment variables');
    console.log('\nTo test with sample data, run with --sample flag');

    if (process.argv.includes('--sample')) {
      const sampleData = {
        updated: new Date().toISOString(),
        bookmarks: [
          { url: 'https://example.com/article-1', title: 'Sample Article 1', date: new Date().toISOString(), dateFormatted: 'Jan 30' },
          { url: 'https://example.com/article-2', title: 'Sample Article 2', date: new Date(Date.now() - 86400000).toISOString(), dateFormatted: 'Jan 29' }
        ]
      };

      const outputPath = path.join(__dirname, '..', 'static', 'data', 'bookmarks.json');
      fs.writeFileSync(outputPath, JSON.stringify(sampleData, null, 2));
      console.log('Sample data written to data/bookmarks.json');
    }
    return;
  }

  console.log('Fetching messages from Slack...');
  const messages = await fetchSlackMessages();
  console.log(`Found ${messages.length} messages`);

  const bookmarks = await extractBookmarks(messages);
  console.log(`Extracted ${bookmarks.length} bookmarks`);

  const output = {
    updated: new Date().toISOString(),
    bookmarks
  };

  const outputPath = path.join(__dirname, '..', 'static', 'data', 'bookmarks.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Written to ${outputPath}`);
}

if (require.main === module) main().catch(console.error);
module.exports = { looksLikeUrl, humanizeUrl, fetchPageTitle, resolveTitle, extractBookmarks };
