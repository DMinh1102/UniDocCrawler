'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLinks, crawlSchool, isDocument, allowedHost, categoryFor, enrichLink, parseArgs } = require('./crawler');

test('extracts relative document links and decodes entities', () => {
  const html = '<tr><td>Giấy chứng nhận sinh viên</td><td><a href="/Upload/M%E1%BA%ABu%20%C4%91%C6%A1n.docx?x=1&amp;y=2"><span>Tải tại đây</span></a></td></tr>';
  const links = extractLinks(html, 'https://ctt.hust.edu.vn/forms');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://ctt.hust.edu.vn/Upload/M%E1%BA%ABu%20%C4%91%C6%A1n.docx?x=1&y=2');
  assert.match(links[0].context, /Giấy chứng nhận sinh viên/);
  assert.equal(links[0].title, 'Giấy chứng nhận sinh viên');
});

test('keeps only relevant documents from school hosts and approved document providers', async () => {
  const school = { allowedHosts: ['hust.edu.vn'], pages: [{ url: 'https://ctt.hust.edu.vn/forms', allDocumentsRelevant: false }] };
  const html = '<a href="/forms/giay-xac-nhan.docx">Tải mẫu giấy xác nhận</a>' +
    '<a href="https://evil-hust.edu.vn/giay-xac-nhan.pdf">Tải mẫu giấy xác nhận</a>' +
    '<a href="/news.html">Tin tức</a>';
  const result = await crawlSchool(school, async url => ({ html, url }));
  assert.deepEqual(result.urls, ['https://ctt.hust.edu.vn/forms/giay-xac-nhan.docx']);
  assert.deepEqual(result.errors, []);
});

test('recognizes document URLs and parses the short name', () => {
  assert.equal(isDocument('https://hust.edu.vn/file.PDF'), true);
  assert.equal(isDocument('https://docs.google.com/document/d/abc/edit'), true);
  assert.equal(isDocument('https://hust.edu.vn/article'), false);
  assert.equal(allowedHost('fakehust.edu.vn', ['hust.edu.vn']), false);
  assert.deepEqual(parseArgs(['hust', '-o', 'links.txt']), { school: 'HUST', output: 'links.txt', format: 'txt' });
  assert.deepEqual(parseArgs(['HUST']), { school: 'HUST', output: null, format: 'json' });
  assert.equal(categoryFor('Đơn đề nghị xét cấp học bổng tài trợ'), 'scholarship');
});

test('records extracted text and reports document failures honestly', async () => {
  const link = { title: 'Giấy xác nhận', url: 'https://hust.edu.vn/form.txt', category: 'administrative', member: null, document_type: 'txt' };
  const success = await enrichLink(link, async () => ({ buffer: Buffer.from('Nội dung\r\nđơn'), contentType: 'text/plain', url: link.url }));
  assert.equal(success.status, 'ok');
  assert.equal(success.text, 'Nội dung\nđơn');
  assert.equal(success.error, '');
  assert.match(success.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  const failure = await enrichLink(link, async () => { throw new Error('HTTP 404'); });
  assert.equal(failure.status, 'error');
  assert.equal(failure.text, '');
  assert.equal(failure.error, 'HTTP 404');
});
