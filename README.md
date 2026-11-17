# University document link crawler

Finds links to public documents related to **Thủ tục hành chính**. It saves URLs only; it does not download the documents.

Requires Node.js 18 or newer. No packages need to be installed.

```powershell
node crawler.js HUST
```

This writes `HUST_documents.txt` in the current directory, one URL per line. To choose a path:

```powershell
node crawler.js HUST --output .\results\hust.txt
```

Create the output directory first if needed. School names are case insensitive. To add a school, add its short name, allowed domain suffixes, and public HTML source pages to `schools.json`. Set `allDocumentsRelevant` only for pages dedicated entirely to administrative forms; on other pages, the crawler filters document links by Vietnamese administrative keywords.

The HUST demo uses the [student forms page](https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=38014), [study forms page](https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=77), and [SoICT forms page](https://soict.hust.edu.vn/bieu-mau-va-quy-dinh-danh-cho-sinh-vien.html). It scans the configured public pages, so coverage depends on the sources listed in `schools.json`. JavaScript-only pages are not supported yet. A source failure produces a warning; if every source fails, the crawler exits without replacing the output file.

Run the offline tests with `npm test`.
