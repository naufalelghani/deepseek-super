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

## Test dan pemeriksaan sintaks

```bash
npm test
npm run check
```
