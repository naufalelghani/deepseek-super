# deepseek-super

Gateway lokal yang menyediakan endpoint **Anthropic Messages API-compatible** di atas `chat.deepseek.com` menggunakan Playwright. Implementasi dipecah menjadi modul CommonJS agar prompt, parsing tool, browser automation, SSE, dan HTTP handler dapat dirawat secara terpisah.

> Catatan: gateway ini mengotomatiskan antarmuka web DeepSeek, bukan API resmi. Perubahan UI situs dapat memerlukan penyesuaian selector di `src/browser.js`. Pastikan penggunaan sesuai dengan ketentuan layanan dan akun Anda.

## Persyaratan

- Node.js 18 atau lebih baru
- Google Chrome terpasang
- Akun DeepSeek yang dapat login di browser

## Instalasi, login Google, dan menjalankan

Install dependency terlebih dahulu:

```bash
npm install
```

### 1. Login ke DeepSeek menggunakan Google

Jalankan helper login sebelum menjalankan server:

```bash
node deepseek-login.js
```

Skrip akan membuka Chrome dengan profil persisten `deepseek-profile/`. Login dilakukan **manual oleh pengguna**:

1. Pada halaman DeepSeek, klik **Log in / Sign in**.
2. Pilih **Sign in with Google**.
3. Selesaikan proses Google, consent, CAPTCHA, atau 2FA sendiri di jendela browser.
4. Pastikan kotak chat DeepSeek sudah tampil dan siap digunakan, lalu tekan Enter di terminal. Skrip memverifikasi kotak chat, menyimpan backup sesi lokal opsional ke `deepseek-auth.json`, lalu menutup browser agar profil tidak terkunci.

Sesi utama disimpan di `deepseek-profile/`; folder ini dan backup `deepseek-auth.json` masuk `.gitignore` karena berisi data autentikasi. Jangan commit atau membagikan keduanya.

Kalau profil masih login, kamu tidak perlu melakukan login ulang—cukup pastikan halaman chat sudah siap lalu tekan Enter di terminal. Kalau sesi habis, jalankan kembali `node deepseek-login.js` dan lakukan login manual lagi. Timeout login default 10 menit; ubah melalui environment variable `DEEPSEEK_LOGIN_TIMEOUT_MS` jika diperlukan.

### 2. Jalankan gateway

Setelah skrip login selesai dan browsernya tertutup, jalankan:

```bash
npm start
```

Server membuka profil `deepseek-profile/` yang sama. Jangan menjalankan `node deepseek-login.js` dan `npm start` bersamaan karena keduanya memakai profil Chrome yang sama dan bisa bertabrakan.

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

## Menggunakan Anthropic TypeScript SDK

Gateway ini dapat dipanggil melalui SDK resmi Anthropic dengan mengarahkan `baseURL` ke server lokal:

```bash
npm install @anthropic-ai/sdk
```

Contoh request non-streaming:

```js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || 'any',
  baseURL: 'http://127.0.0.1:8787',
});

async function main() {
  const message = await client.messages.create({
    model: 'deepseek-super',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Jelaskan fungsi folder src/.' }],
  });

  for (const block of message.content) {
    if (block.type === 'text') process.stdout.write(block.text);
  }
}

main().catch(console.error);
```

SDK mengirim request ke `/v1/messages`; jangan menambahkan path tersebut ke `baseURL`. Jika `DEEPSEEK_SUPER_TOKEN` tidak diatur, nilai `apiKey` hanya perlu string nonkosong. Jika token server diaktifkan, `apiKey` harus sama dengan token itu.

Contoh streaming:

```js
const stream = await client.messages.create({
  model: 'deepseek-super',
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'Halo!' }],
});

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

### Batas kompatibilitas saat ini

Kontrak request memvalidasi `model`, `messages`, `max_tokens`, role/content, schema tools, `tool_choice`, dan `stream`. Endpoint `count_tokens` juga memakai `system`, `messages`, dan schema tools pada perkiraan input. Angka token tersebut adalah estimasi berbasis panjang karakter, bukan hitungan tokenizer DeepSeek yang sebenarnya.

SDK compatibility pada lapisan HTTP tidak berarti semua fitur model Anthropic tersedia secara semantik. Gateway ini mengotomatisasi situs web DeepSeek; misalnya, `max_tokens`, parameter sampling, fitur prompt caching, citra/dokumen, dan opsi khusus Anthropic yang tidak dipetakan ke UI belum tentu bekerja seperti API Anthropic resmi. Jangan mengandalkan opsi yang belum didokumentasikan sebagai fitur yang didukung.

## Integration test dengan Anthropic SDK

Dependency test `@anthropic-ai/sdk` sudah dipasang sebagai devDependency. Untuk menguji server lokal menggunakan SDK sungguhan, jalankan server terlebih dahulu:

```bash
npm install
npm start
```

Login ke akun DeepSeek di jendela Chrome yang dibuka oleh Playwright, lalu buka terminal kedua di folder repo dan jalankan:

```bash
npm run test:sdk
```

Smoke test ini menguji request non-streaming, event streaming SSE yang dibaca oleh SDK, pemanggilan tool, dan request lanjutan dengan `tool_result`. Tes memerlukan server yang aktif dan sesi browser DeepSeek yang sudah login. Jika server memakai `DEEPSEEK_SUPER_TOKEN`, atur `ANTHROPIC_AUTH_TOKEN` dengan nilai yang sama. Endpoint bisa diganti lewat `DEEPSEEK_SUPER_BASE_URL`, dan nama model lewat `ANTHROPIC_MODEL`.

Tool call pada tes hanya memeriksa payload: perintah yang dihasilkan tidak dieksekusi. Respons tool pada putaran selanjutnya adalah hasil sintetis. Perintah ini mengirim beberapa request ke DeepSeek, jadi perlu waktu dan akses ke akun web DeepSeek.

```bash
# Tes unit/sintaks yang tidak membutuhkan server DeepSeek aktif
npm test
npm run check
```

## Reuse percakapan DeepSeek

Gateway menggunakan satu tab Chrome Playwright dan berusaha melanjutkan URL chat DeepSeek yang tersimpan untuk request berikutnya. Hasil tool (`tool_result`) juga harus melanjutkan chat yang sama; gateway tidak semestinya membuat percakapan baru hanya karena client mengirim hasil tool.

Gateway membuat percakapan baru bila belum ada sesi tersimpan, sesi lama sudah tidak valid, atau server perlu memulai ulang setelah sesi cache hilang. Pemetaan URL percakapan disimpan di memori proses selama maksimal 30 menit, sehingga restart server akan menghapus cache tersebut. Log `[session]` menjelaskan kapan chat lama berhasil dilanjutkan atau gateway terpaksa membuat chat baru.

### Kompatibilitas pesan system dari Claude Code

Beberapa versi Claude Code dapat mengirim pesan dengan `role: "system"` di dalam array `messages`, padahal kontrak Anthropic mengharuskan instruksi sistem berada di field tingkat atas `system`. Gateway memindahkan pesan `system`/`developer` yang valid ke field tersebut sebelum validasi dan mencatat jumlah pesan yang dinormalisasi tanpa mencetak isi prompt.

## Integration test langsung dengan Claude Code

Tes ini menggunakan Claude Code CLI asli melalui 9Router lokal, dengan default berikut:

- Base URL: `http://localhost:20128/v1`
- Model combo: `byv-flash-2410`
- API key: dibaca dari variabel lingkungan `ANTHROPIC_AUTH_TOKEN` atau `ANTHROPIC_API_KEY`

Jalankan dari root repo. Pilih instruksi sesuai terminal yang digunakan. API key tidak ditampilkan saat diketik dan tidak disimpan ke repo.

**Windows PowerShell:**

```powershell
$secure = Read-Host "9Router API key" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:ANTHROPIC_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
npm run test:claude-code
Remove-Item Env:ANTHROPIC_AUTH_TOKEN
```

**Git Bash:**

```bash
read -rsp "9Router API key: " ANTHROPIC_AUTH_TOKEN; echo
export ANTHROPIC_AUTH_TOKEN
npm run test:claude-code
unset ANTHROPIC_AUTH_TOKEN
```

Tes mewajibkan enam tool dipanggil secara berurutan dan menerima hasil masing-masing: `Read`, `Glob`, `Grep`, `Edit`, `Write`, dan `Bash(pwd)`. Ini juga menguji rangkaian multi-step tool calling. Operasi tulis/edit hanya dilakukan di workspace sementara di folder temp, bukan di repo. Perintah Bash yang diizinkan hanya `pwd`; tool lain tidak tersedia. Workspace pengujian dihapus setelah selesai.

Endpoint dapat diubah melalui `DEEPSEEK_SUPER_BASE_URL`, dan model melalui `ANTHROPIC_MODEL`. Jika kamu menggunakan endpoint 9Router di atas, server `npm start` dari gateway DeepSeek lokal tidak diperlukan; 9Router saja yang harus aktif. Simpan API key hanya di lingkungan lokal, jangan commit ke repo publik.

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
- Client harus mengirim hasilnya kembali sebagai `tool_result` yang merujuk ke `tool_use_id`. Gateway melanjutkan URL chat DeepSeek yang sama dan dapat meminta tool berikutnya jika tugas belum selesai; model memberi jawaban akhir setelah hasil yang tersedia cukup atau batas pengaman percakapan tercapai.
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
