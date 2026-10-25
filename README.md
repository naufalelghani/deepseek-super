# deepseek-super

Gateway lokal yang menyediakan endpoint **Anthropic Messages API-compatible** di atas `chat.deepseek.com` menggunakan Playwright. Implementasi dipecah menjadi modul CommonJS agar prompt, parsing tool, browser automation, SSE, dan HTTP handler dapat dirawat secara terpisah.

> Catatan: gateway ini mengotomatiskan antarmuka web DeepSeek, bukan API resmi. Perubahan UI situs dapat memerlukan penyesuaian selector di `src/browser.js`. Pastikan penggunaan sesuai dengan ketentuan layanan dan akun Anda.

## Persyaratan

- Node.js 18 atau lebih baru
- Google Chrome terpasang
- Akun DeepSeek yang dapat login di browser

## Instalasi dan menjalankan

```bash
npm install
npm start
```

Saat pertama kali dijalankan, Playwright membuka Chrome menggunakan profil di folder `deepseek-profile/`. Login ke DeepSeek melalui jendela tersebut jika diperlukan. Folder profil tidak di-commit karena berisi data sesi lokal.

Default endpoint: `http://127.0.0.1:8787`

## Konfigurasi

Semua konfigurasi dibaca dari environment variables:

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `8787` | Port server lokal |
| `MODEL_NAME` | `deepseek-super` | Nama model virtual yang dilaporkan API |
| `PROFILE_DIR` | `./deepseek-profile` | Folder profil Chrome persisten |
| `DEEPSEEK_SUPER_TOKEN` | kosong | Token opsional untuk autentikasi |
| `POLL_MS` | `200` | Interval polling UI dalam milidetik |
| `STABLE_MS` | `4000` | Waktu tanpa perubahan sebelum turn dianggap selesai |
| `MAX_TURN_MS` | `300000` | Batas waktu satu turn |
| `MAX_REPLAY` | `60000` | Batas karakter replay riwayat percakapan |

Jika `DEEPSEEK_SUPER_TOKEN` diisi, kirim token dengan header `x-api-key` atau `Authorization: Bearer <token>`. Tanpa token, server tetap hanya bind ke `127.0.0.1`.

Contoh konfigurasi client:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_AUTH_TOKEN=any
ANTHROPIC_MODEL=deepseek-super
```

Jika autentikasi server diaktifkan, atur `ANTHROPIC_AUTH_TOKEN` sama dengan `DEEPSEEK_SUPER_TOKEN`.

## Endpoint

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`

`POST /v1/messages` mendukung respons streaming SSE dan non-streaming JSON, serta pemetaan `tool_use`/`tool_result` ke format prompt yang digunakan gateway.

## Audit kompatibilitas DeepSeek / Anthropic

Gateway ini meniru sebagian kontrak Anthropic Messages API agar client seperti Claude Code dapat berbicara dengan antarmuka web DeepSeek. Ini bukan koneksi langsung ke `https://api.deepseek.com/anthropic`: prompt, tool call, streaming, dan token usage diproses oleh adapter lokal dan otomasi browser.

### Tool use dan round trip

- Permintaan dengan `tools` menyertakan nama tool, deskripsi, dan `input_schema` dalam instruksi prompt lokal.
- Tool call yang dikenali dikembalikan sebagai blok Anthropic `tool_use`; gateway tidak menjalankan tool client-side. Claude Code atau client terkait yang menjalankan tool.
- Client harus mengirim hasilnya kembali sebagai `tool_result` yang merujuk ke `tool_use_id`. Setelah menerima hasil, gateway meminta model menyusun jawaban akhir tanpa mengeluarkan tool call baru untuk giliran hasil itu.
- Payload tool yang dihasilkan model tetap perlu diperiksa: validasi nama tool dan bentuk input di parser/client, jangan menganggap JSON model tepercaya.
- `tool_choice` dipetakan secara lokal. Semantik khusus Anthropic seperti `disable_parallel_tool_use` tidak otomatis tersedia di gateway ini; beberapa opsi kompatibilitas dapat berbeda dari API resmi.

### Context caching

DeepSeek API resmi mengaktifkan disk context caching otomatis dan mencocokkan prefix input yang identik. Prefix yang sama dapat digunakan ulang pada permintaan berikutnya, tetapi cache hit bersifat best-effort dan tidak dijamin. API resmi melaporkan `prompt_cache_hit_tokens` dan `prompt_cache_miss_tokens` di `usage`.

Gateway Playwright ini berinteraksi dengan `chat.deepseek.com`, bukan endpoint API resmi. Karena itu, kode gateway tidak dapat mengatur atau memastikan cache API resmi, dan angka `usage` lokal merupakan estimasi, bukan pengukuran token/cache DeepSeek. Jangan menafsirkan `cache_control` Anthropic sebagai pengaturan cache yang aktif di gateway.

Untuk menjaga konteks konsisten dan menghindari pemotongan riwayat yang tidak perlu, instruksi dan schema tool dibuat dari request yang diterima; percakapan yang dilanjutkan menggunakan tool schema pada prompt giliran tersebut. UI DeepSeek atau perubahan isi prompt dapat tetap memengaruhi perilaku dan efisiensi caching internal situs.

### Field Anthropic dan batas kompatibilitas

Adapter mendukung bentuk umum `system`, `messages`, `tools`, `tool_choice`, `stream`, serta blok `text`, `tool_use`, dan `tool_result` yang diperlukan client. Ini bukan implementasi penuh Anthropic API. Field atau blok yang tidak dipetakan secara eksplisit dapat diabaikan atau dinormalisasi oleh adapter. Khususnya, `cache_control` tidak mengaktifkan cache terkontrol pada adapter ini.

Referensi resmi:

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Using the Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)

## Struktur proyek

```text
deepseek-super/
├── deepseek-super-server.js   # Entry point kompatibel dengan cara menjalankan lama
├── package.json
├── README.md
├── .gitignore
├── src/
│   ├── index.js               # Public API dan lifecycle server
│   ├── config.js              # Environment variables dan helper dasar
│   ├── content.js             # Normalisasi blok pesan dan session key
│   ├── prompts.js             # Prompt, tool_choice, dan tool schema
│   ├── tool-parser.js         # Parser streaming dan parser TOOL_CALL
│   ├── session-store.js       # Cache URL percakapan
│   ├── browser.js             # Playwright, polling, dan runner turn
│   ├── sse-sink.js            # Serialisasi Anthropic SSE
│   ├── handler.js             # Handler endpoint Messages
│   ├── http-utils.js          # Parsing body, auth, dan error response
│   └── server.js              # Routing HTTP
└── test/
    ├── content.test.js
    └── tool-parser.test.js
```

## Menggunakan sebagai library

```js
const { createServer, config } = require('deepseek-super');

const server = createServer();
server.listen(config.PORT, '127.0.0.1');
```

Untuk shutdown normal saat menggunakan `createServer()` secara langsung, tutup HTTP server dan panggil `shutdownBrowser()` dari `deepseek-super/src/browser` agar konteks Chrome ikut ditutup. Untuk penggunaan CLI biasa, gunakan `npm start` sehingga handler shutdown bawaan aktif.

## Troubleshooting tool call

Jika DeepSeek menghasilkan blok `<TOOL_CALL>` dengan JSON yang tidak valid, gateway mengirim sampai dua prompt koreksi di percakapan yang sama. Parser hanya memproses jawaban assistant yang baru, bukan baris user yang baru saja ditambahkan ke UI. Log akan mencatat jumlah payload, status blok yang terpotong, dan alasan parse gagal.

Untuk satu sesi diagnosis, jalankan server dengan `DEBUG_TOOL_PARSER=1` agar log menampilkan cuplikan awal payload bermasalah. Cuplikan dapat berisi perintah shell atau konten prompt, jadi jaga log tetap privat dan matikan flag setelah selesai.

## Test dan pemeriksaan sintaks

```bash
npm test
npm run check
```
