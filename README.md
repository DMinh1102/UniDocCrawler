# University document crawler

Finds public documents related to **Thủ tục hành chính**, downloads them in memory, and extracts their text into JSON records. It does not save the original files.

Requires Node.js 20 or newer. Install dependencies once with `npm install`.

```powershell
node crawler.js HUST
```

This writes `HUST_documents.json` in the current directory. Each record has `title`, `url`, `category`, `member`, `document_type`, `fetched_at`, `status`, `text`, and `error`. `text` contains extracted document content when `status` is `ok`. `member` is `null` unless a source page sets it in `schools.json`. Categories are inferred from the title.

To choose a path:

```powershell
node crawler.js HUST --output .\results\hust.json
```

For the previous URL-only output, use `node crawler.js HUST --format txt`. This skips downloading documents and writes one URL per line. The `.txt` format is also inferred when `--output` ends in `.txt`.

School names are case insensitive. To add a school, add its short name, allowed domain suffixes, and public HTML source pages to `schools.json`. Set `allDocumentsRelevant` only for pages dedicated entirely to administrative forms; on other pages, the crawler filters document links by Vietnamese administrative keywords.

The HUST demo uses the [student forms page](https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=38014), [study forms page](https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=77), and [SoICT forms page](https://soict.hust.edu.vn/bieu-mau-va-quy-dinh-danh-cho-sinh-vien.html). It scans configured public pages, so coverage depends on the sources listed in `schools.json`. JavaScript-only pages are not supported yet. PDF, DOC, DOCX, and TXT text are supported; other document types receive `status: "unsupported"`. Scanned PDFs with no selectable text receive `status: "empty"` because OCR is not included. Download or parse failures receive `status: "error"` and a message in `error`.

Generated `*_documents.json` and `*_documents.txt` files are ignored by Git.

Run the offline tests with `npm test`.
