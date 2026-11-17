#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DOCUMENT_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt)(?:$|[?#])/i;
const ADMIN_TERMS = /(?:thủ tục|hành chính|biểu mẫu|đơn |mẫu |giấy |xác nhận|chứng nhận|hồ sơ|vay vốn|miễn giảm|học phí|sinh viên|quy chế|quy định|ra trường|đăng ký|đăng kí)/iu;
const EXTERNAL_DOCUMENT = /^(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/)/i;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

function decodeEntities(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!href) continue;
    let url;
    try {
      url = new URL(decodeEntities(href[1] ?? href[2] ?? href[3]), baseUrl);
    } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    url.hash = '';
    const before = html.slice(Math.max(0, match.index - 250), match.index);
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 120);
    links.push({ url: url.href, text: plainText(match[2]), context: plainText(before + ' ' + match[2] + ' ' + after) });
  }
  return links;
}

function allowedHost(host, suffixes) {
  return suffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function isDocument(url) {
  const parsed = new URL(url);
  return DOCUMENT_EXTENSIONS.test(parsed.pathname) || EXTERNAL_DOCUMENT.test(parsed.host + parsed.pathname);
}

function relevant(link, allDocumentsRelevant) {
  if (allDocumentsRelevant) return true;
  let filename = new URL(link.url).pathname;
  try { filename = decodeURIComponent(filename); } catch { /* Keep malformed escapes as-is. */ }
  return ADMIN_TERMS.test(`${link.text} ${link.context} ${filename}`);
}

function requestHtml(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'UniversityDocCrawler/0.1 (+public document-link discovery)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity'
      },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestHtml(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      if (!/html/i.test(res.headers['content-type'] ?? '')) {
        res.resume();
        return reject(new Error('Source is not HTML'));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_HTML_BYTES) {
          req.destroy(new Error('HTML exceeds size limit'));
        } else chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

async function crawlSchool(school, fetchPage = requestHtml) {
  const found = new Set();
  const errors = [];
  for (const page of school.pages) {
    try {
      const response = await fetchPage(page.url);
      for (const link of extractLinks(response.html, response.url)) {
        const host = new URL(link.url).hostname.toLowerCase();
        const external = EXTERNAL_DOCUMENT.test(host + new URL(link.url).pathname);
        if (!(allowedHost(host, school.allowedHosts) || external)) continue;
        if (isDocument(link.url) && relevant(link, page.allDocumentsRelevant)) found.add(link.url);
      }
    } catch (error) {
      errors.push(`${page.url}: ${error.message}`);
    }
  }
  return { urls: [...found].sort((a, b) => a.localeCompare(b)), errors };
}

function parseArgs(args) {
  let school = null;
  let output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      output = args[++i];
      if (!output) throw new Error('--output requires a path');
    } else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`);
    else if (!school) school = args[i].toUpperCase();
    else throw new Error('Only one school short name is accepted');
  }
  if (!school) throw new Error('Usage: node crawler.js HUST [--output path.txt]');
  return { school, output };
}

async function main() {
  const { school: key, output } = parseArgs(process.argv.slice(2));
  const schools = JSON.parse(await fs.readFile(path.join(__dirname, 'schools.json'), 'utf8'));
  const school = schools[key];
  if (!school) throw new Error(`Unknown school: ${key}. Available: ${Object.keys(schools).join(', ')}`);
  const { urls, errors } = await crawlSchool(school);
  if (errors.length) for (const error of errors) console.error(`Warning: ${error}`);
  if (errors.length === school.pages.length) throw new Error('All source pages failed; no output was written');
  const file = path.resolve(output ?? `${key}_documents.txt`);
  await fs.writeFile(file, urls.length ? `${urls.join('\n')}\n` : '', 'utf8');
  console.log(`Found ${urls.length} document links. Saved to ${file}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { extractLinks, allowedHost, isDocument, relevant, crawlSchool, parseArgs };
