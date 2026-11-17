#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { decode } = require('html-entities');

const DOCUMENT_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt)(?:$|[?#])/i;
const ADMIN_TERMS = /(?:thủ tục|hành chính|biểu mẫu|đơn |mẫu |giấy |xác nhận|chứng nhận|hồ sơ|vay vốn|miễn giảm|học phí|sinh viên|quy chế|quy định|ra trường|đăng ký|đăng kí)/iu;
const EXTERNAL_DOCUMENT = /^(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/)/i;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function decodeEntities(value) {
  return decode(value);
}

function plainText(html) {
  return decodeEntities(html
    .replace(/<br\b[^>]*\/?\s*>|<\/(?:p|div|li|ul|ol|td|th|tr|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

function enclosingBlock(html, start, end, tag) {
  const lower = html.toLowerCase();
  const open = lower.lastIndexOf(`<${tag}`, start);
  const priorClose = lower.lastIndexOf(`</${tag}`, start);
  const close = lower.indexOf(`</${tag}>`, end);
  return open > priorClose && close !== -1 ? html.slice(open, close + tag.length + 3) : null;
}

function titleFromLink(html, match, text, url) {
  const cleanedText = text.replace(/\s*(?:tại đây|xem tại đây|tải tại đây)\.?$/iu, '').trim();
  if (cleanedText.length >= 5 && !/^(?:tải|xem|download|here|file)\b/iu.test(cleanedText)) return cleanedText;
  const row = enclosingBlock(html, match.index, match.index + match[0].length, 'tr');
  if (row) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(cell => plainText(cell[1]));
    const candidate = cells.find(cell => cell.length >= 5 && !/^\d+[.)]?$/.test(cell) && cell !== text);
    if (candidate) return candidate;
  }
  const item = enclosingBlock(html, match.index, match.index + match[0].length, 'li');
  if (item) {
    const candidate = plainText(item).replace(/\s*(?:tải|xem|tại đây)\.?\s*$/iu, '').trim();
    if (candidate.length >= 5) return candidate;
  }
  let filename = new URL(url).pathname.split('/').pop() || '';
  try { filename = decodeURIComponent(filename); } catch { /* Keep malformed escapes as-is. */ }
  return filename.replace(/\.[^.]+$/, '').replace(/^\d+[-_. ]*/, '').replace(/[-_]+/g, ' ').trim() || url;
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
    const text = plainText(match[2]);
    links.push({ url: url.href, text, title: titleFromLink(html, match, text, url.href), context: plainText(before + ' ' + match[2] + ' ' + after) });
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

function categoryFor(title) {
  const normalized = title.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
  if (/hoc bong/.test(normalized)) return 'scholarship';
  if (/hoc phan|hoc tap|dang ky lop|dang ki lop|chuyen diem|hoan thi|thi bu|thuc tap|do an/.test(normalized)) return 'study';
  return 'administrative';
}

function documentType(url, contentType = '') {
  const mime = contentType.toLowerCase();
  if (mime.includes('application/pdf')) return 'pdf';
  if (mime.includes('wordprocessingml.document')) return 'docx';
  if (mime.includes('application/msword')) return 'doc';
  if (mime.includes('text/plain')) return 'txt';
  const extension = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (extension && /^(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt)$/.test(extension)) return extension;
  return 'unknown';
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
  const found = new Map();
  const errors = [];
  for (const page of school.pages) {
    try {
      const response = await fetchPage(page.url);
      for (const link of extractLinks(response.html, response.url)) {
        const host = new URL(link.url).hostname.toLowerCase();
        const external = EXTERNAL_DOCUMENT.test(host + new URL(link.url).pathname);
        if (!(allowedHost(host, school.allowedHosts) || external)) continue;
        if (isDocument(link.url) && relevant(link, page.allDocumentsRelevant) && !found.has(link.url)) {
          found.set(link.url, {
            title: link.title,
            url: link.url,
            category: categoryFor(link.title),
            member: page.member ?? null,
            document_type: documentType(link.url)
          });
        }
      }
    } catch (error) {
      errors.push(`${page.url}: ${error.message}`);
    }
  }
  const links = [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
  return { links, urls: links.map(link => link.url), errors };
}

function downloadUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'drive.google.com') {
    const id = /^\/file\/d\/([^/]+)/.exec(parsed.pathname)?.[1];
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }
  return url;
}

function requestDocument(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'UniversityDocCrawler/0.2 (+public document discovery)', 'Accept-Encoding': 'identity' },
      timeout: 20000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestDocument(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_DOCUMENT_BYTES) req.destroy(new Error('Document exceeds 25 MB limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '', url }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

async function extractText(buffer, type) {
  if (type === 'txt') return buffer.toString('utf8');
  if (type === 'doc' || type === 'docx') {
    const WordExtractor = require('word-extractor');
    const document = await new WordExtractor().extract(buffer);
    return document.getBody();
  }
  if (type === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try { return (await parser.getText()).text; }
    finally { await parser.destroy(); }
  }
  throw new Error(`Text extraction is not supported for ${type}`);
}

async function enrichLink(link, fetchFile = requestDocument, parseText = extractText) {
  const record = { ...link, fetched_at: new Date().toISOString(), status: 'error', text: '', error: '' };
  try {
    const response = await fetchFile(downloadUrl(link.url));
    record.document_type = documentType(response.url || link.url, response.contentType);
    if (/text\/html/i.test(response.contentType)) throw new Error('Document URL returned HTML, not a downloadable file');
    if (!['pdf', 'doc', 'docx', 'txt'].includes(record.document_type)) {
      record.status = 'unsupported';
      record.error = `Text extraction is not supported for ${record.document_type}`;
      return record;
    }
    record.text = (await parseText(response.buffer, record.document_type)).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    if (record.text) record.status = 'ok';
    else {
      record.status = 'empty';
      record.error = 'No extractable text found; scanned files may require OCR';
    }
  } catch (error) {
    record.error = error.message;
  }
  return record;
}

function parseArgs(args) {
  let school = null;
  let output = null;
  let format = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      output = args[++i];
      if (!output) throw new Error('--output requires a path');
    } else if (args[i] === '--format') {
      format = args[++i];
      if (!['json', 'txt'].includes(format)) throw new Error('--format must be json or txt');
    } else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`);
    else if (!school) school = args[i].toUpperCase();
    else throw new Error('Only one school short name is accepted');
  }
  if (!school) throw new Error('Usage: node crawler.js HUST [--format json|txt] [--output path]');
  return { school, output, format: format ?? (output?.toLowerCase().endsWith('.txt') ? 'txt' : 'json') };
}

async function main() {
  const { school: key, output, format } = parseArgs(process.argv.slice(2));
  const schools = JSON.parse(await fs.readFile(path.join(__dirname, 'schools.json'), 'utf8'));
  const school = schools[key];
  if (!school) throw new Error(`Unknown school: ${key}. Available: ${Object.keys(schools).join(', ')}`);
  const { links, urls, errors } = await crawlSchool(school);
  if (errors.length) for (const error of errors) console.error(`Warning: ${error}`);
  if (errors.length === school.pages.length) throw new Error('All source pages failed; no output was written');
  const file = path.resolve(output ?? `${key}_documents.${format}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (format === 'txt') {
    await fs.writeFile(file, urls.length ? `${urls.join('\n')}\n` : '', 'utf8');
    console.log(`Found ${urls.length} document links. Saved to ${file}`);
  } else {
    const records = [];
    for (const link of links) {
      const record = await enrichLink(link);
      records.push(record);
      console.log(`${records.length}/${links.length} ${record.status} ${record.url}`);
    }
    await fs.writeFile(file, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    console.log(`Saved ${records.length} document records to ${file}`);
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { extractLinks, allowedHost, isDocument, relevant, categoryFor, documentType, crawlSchool, extractText, enrichLink, parseArgs };
