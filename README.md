# webrtctesttool

網頁版的 **iperf 式網路測試工具**：在瀏覽器與伺服器之間，透過 **WebRTC DataChannel**
量測吞吐量（下載 / 上傳）、延遲（RTT）、jitter 與 UDP 丟包率。

![畫面](docs/screenshot.png)

## 為什麼不是「真的」在網頁上跑 iperf？

瀏覽器沙箱**不允許網頁存取原始 TCP/UDP socket**，所以無法在頁面裡執行原生
`iperf` / `iperf3` 執行檔（即使把 iperf 編成 WebAssembly，也一樣拿不到 socket）。

因此本工具改用瀏覽器唯一能做「自訂資料傳輸」的原生管道——**WebRTC DataChannel**
（SCTP over DTLS over UDP）——在你的瀏覽器和伺服器之間傳送資料來測量。量到的結果反映的是
**「你這台瀏覽器到伺服器」的真實連線品質**，這正是原生 iperf 在網頁情境做不到的事。

對應關係：

| iperf 概念 | 本工具做法 |
|-----------|-----------|
| TCP 吞吐量 | 可靠、有序的 DataChannel（下載 / 上傳） |
| UDP 吞吐量 + 丟包 / jitter | 不可靠、免重傳（`ordered:false, maxRetransmits:0`）的 DataChannel，封包帶序號 |
| 每秒一行的 interval 統計 | 前端每秒回報一次，並即時畫折線圖 |
| client ↔ server | 瀏覽器（client）↔ 伺服器（固定 WebRTC peer） |

## 架構

```
瀏覽器 (src/, React + Vite)             Node 服務 (server/)
  RTCPeerConnection  ──── WebSocket 訊令 ────  werift RTCPeerConnection
  DataChannel × 3    ═════ WebRTC / SCTP ═════  DataChannel × 3
  (ctrl / data / udp)                          (ctrl / data / udp)
```

- **前端**：**React 18 + Vite**（標準建置流程）。原始碼在 `src/`，`npm run build`
  由 Vite 打包成最佳化的靜態檔到 `dist/`，後端用 `express.static` 提供。折線圖用
  原生 `<canvas>` 手繪（不依賴圖表套件）。詳見下方「前端技術棧（React + Vite）」。
- **後端**：單一 Node.js 服務，同時負責靜態網頁（`dist/`）、WebSocket 訊令（signaling）、
  以及用 [`werift`](https://github.com/shinyoshiaki/werift-webrtc)（純 TypeScript 的 WebRTC
  實作，**無原生編譯依賴**）擔任伺服器端的固定 WebRTC peer。

瀏覽器是 WebRTC 的 initiator：建立三條 DataChannel、送出 SDP offer；伺服器回 answer，
雙方交換 ICE candidate 後即建立 P2P 連線，測試協定跑在 DataChannel 上。

### DataChannel 用途

| Label | 屬性 | 用途 |
|-------|------|------|
| `ctrl` | 可靠、有序 | JSON 控制訊息、ping/pong、上傳的 interval / summary 回報 |
| `data` | 可靠、有序 | 下載 / 上傳的二進位資料塊（TCP 式吞吐量） |
| `udp`  | 不可靠、免重傳 | 帶序號的資料塊，量丟包率與 jitter（UDP 式） |

## 安裝與執行

**執行伺服器**需要 Node.js 16.16.0 以上；**建置前端**（Vite）需要 Node.js 18 以上
（相容性細節見下方「Node.js 相容性」）。

```bash
npm install
npm run build      # Vite 打包前端到 dist/
npm start          # 啟動伺服器
# 開啟 http://localhost:3000
```

用瀏覽器開啟頁面 → 選測試時長與項目 → 按「開始測試」。

**開發模式**（Vite dev server + HMR，前端改動即時反映）：

```bash
npm start          # 終端機 1：後端 (訊令 / WebRTC)，:3000
npm run dev        # 終端機 2：Vite dev server，:5173
# 開啟 http://localhost:5173（/config 與 /ws 會自動 proxy 到 :3000）
```

自訂連接埠：`PORT=8080 npm start`。

## Node.js 相容性

支援 **Node.js 16.16.0 以上**（含較舊的地端環境）。已在真正的 Node 16.16.0 上實測
連線與四項測試皆正常。

需要注意的一點：後端 WebRTC 由 `werift`（純 TS）擔任，它相依的
`@peculiar/x509` **最新版（1.14.1+）宣告需要 Node 20/22**。為了在 Node 16 上安裝，
`package.json` 用 npm `overrides` 把它釘在最後一個不要求新 Node 的版本：

```json
"overrides": { "@peculiar/x509": "1.14.0" }
```

這仍滿足 werift 的 `@peculiar/x509: ^1.12.3` 需求。若你把 Node 升到 20/22，此
override 可保留（無害）或移除皆可。werift 的 WebRTC DTLS 憑證用 ECDSA P-256、
透過 `crypto.webcrypto`（Node 15+ 即有），故在 Node 16 可正常產生憑證。

> 離線 / `npm ci` 部署務必連同 `package-lock.json` 一起帶走，才會鎖到正確的
> `@peculiar/x509@1.14.0`。

## 前端技術棧（React + Vite）

前端是標準的 **React 18 + [Vite](https://vitejs.dev/)** 專案：

- 原始碼在 `src/`：`main.jsx`（掛載）、`App.jsx`（元件）、`net.js`（WebRTC /
  測試協定 / canvas 折線圖）、`styles.css`。進入點是根目錄的 `index.html`。
- `npm run build` 由 Vite（+ `@vitejs/plugin-react`）打包成最佳化、hash 命名的
  靜態檔到 `dist/`（約 155 KB，gzip 後約 51 KB）。
- **伺服器端不變**：`server/index.js` 用 `express.static('dist')` 提供建置產物；
  Node 16.16.0 相容性、`LAN_ONLY` 離線模式、npm audit 清零都不受影響。

### 建置與執行環境的 Node 版本

| 動作 | 需要的 Node | 說明 |
|------|------------|------|
| **執行伺服器**（`npm start`） | **16.16.0+** | 只需 `express` / `ws` / `werift`，見「Node.js 相容性」 |
| **建置前端**（`npm run build`） | **18+** | Vite 6 需要 Node 18 以上 |

`react` / `react-dom` 是 `dependencies`；`vite` / `@vitejs/plugin-react` 是
`devDependencies`。這代表**只跑伺服器**的機器可以 `npm ci --omit=dev` 略過 Vite。

### 地端 / 離線設備若只有 Node 16 怎麼辦

Vite 建置需要 Node 18+，但**建置產物 `dist/` 是純靜態檔**，不挑執行環境。所以：

1. 在**任一台有 Node 18+ 的機器**上 `npm install && npm run build`。
2. 把 **`dist/` 資料夾**連同 `server/`、`vendor/`、`package.json`、`package-lock.json`
   複製到只有 Node 16.16.0 的離線設備。
3. 在離線設備上 `npm ci --omit=dev`（只裝伺服器需要的套件、略過 Vite）→ `npm start`。

（`dist/` 已列入 `.gitignore`，是建置產物、不進版控。）

## 安全性（npm audit）

`npm audit` **回報 0 個弱點**。

過程中處理過一個傳遞相依的告警：`ip` 套件（被 werift → werift-ice 使用）有一個
高風險 SSRF 分類錯誤告警 [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp)，
且上游**無修補版本**（套件已停止維護）。

- **實際風險**：該告警只影響 `ip.isPublic()` / `ip.isPrivate()` 這兩個函式，且需要
  應用程式用它們來過濾使用者可控的對外請求（SSRF）。werift 只用到 `ip` 的
  `toBuffer` / `toString` / `isV4Format` / `isLoopback`（STUN 位址編碼與本機介面過濾），
  **從未呼叫 `isPublic`/`isPrivate`**；本工具也沒有 SSRF 的攻擊面。故此告警在本專案
  **不可觸發**。
- **處理方式**：為了讓 `npm audit` 乾淨且徹底移除受影響程式碼，`vendor/ip/` 放了一份
  `ip` 的精簡副本（保留 werift 用到的函式，**移除** `isPublic`/`isPrivate`），並在
  `package.json` 用 `overrides` + `"ip": "file:./vendor/ip"` 讓相依改指向它。已實測
  ICE / 四項測試在 Node 16.16.0 上（含跨網卡 LAN 路徑）皆正常。

> 若日後 werift 或 `ip` 上游有了修補版本，可移除 `vendor/ip/` 與相關 `overrides`
> 改回官方套件。

## 測試項目

- **延遲 (Latency)**：連續 ping/pong，取 RTT 的 min / avg / max 與 jitter。
- **下載 (Download)**：伺服器往瀏覽器灌資料，瀏覽器每秒統計吞吐量。
- **上傳 (Upload)**：瀏覽器往伺服器灌資料，伺服器每秒回報吞吐量。
- **UDP 丟包**：伺服器送出帶序號的封包（不可靠 channel），瀏覽器依收到的封包數
  與序號算出丟包率與 jitter。

吞吐量的關鍵是**流量控制**：傳送端維持 DataChannel 的 `bufferedAmount` 在
高低水位之間（`bufferedAmountLowThreshold` + `bufferedamountlow` 事件），
才能吃滿鏈路又不讓送出緩衝無限膨脹。

## 部署

### 1. 伺服器端

需要一台有公開 IP（或經反向代理可達）的機器。**建置前端需 Node 18+；執行伺服器需
Node 16.16.0+**（若建置與執行同一台，Node 18+ 即可涵蓋兩者）。

```bash
git clone <repo-url> && cd webrtctesttool
npm install
npm run build            # 產生 dist/
PORT=3000 npm start
```

正式環境建議用行程管理器常駐（systemd / pm2）。若執行環境只有 Node 16，
見下方「地端 / 離線」——在別台 Node 18+ 機器 build 好 `dist/` 再帶過去即可。

### 2. 環境變數（部署用設定）

所有 WebRTC / 網路設定都用環境變數控制，不必改程式碼：

| 變數 | 說明 | 範例 |
|------|------|------|
| `PORT` | HTTP / WebSocket 監聽埠 | `3000` |
| `PUBLIC_IP` | 伺服器對外可達的公開 IP。雲端 VM 多半是 1:1 NAT（內網只看得到私有 IP），設了才會把公開 IP 當成 host candidate 廣告出去 | `203.0.113.10` |
| `ICE_PORT_MIN` / `ICE_PORT_MAX` | 把 ICE 用的 UDP 埠固定在一個範圍，方便開防火牆（兩個要一起設） | `40000` / `40100` |
| `STUN_URL` | 自訂 STUN（預設 Google 公用） | `stun:stun.l.google.com:19302` |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | 對稱式 NAT 後方的用戶端需要 TURN 中繼時設定 | `turn:turn.example.com:3478` |

瀏覽器端會自動向伺服器的 `GET /config` 取得同一份 `iceServers`（含 TURN），
所以 **TURN 帳密只設在伺服器**、不必改前端。

範例（雲端 VM，固定 UDP 埠 + 公開 IP）：

```bash
PORT=3000 PUBLIC_IP=203.0.113.10 ICE_PORT_MIN=40000 ICE_PORT_MAX=40100 \
  node server/index.js
```

### 3. 防火牆 / 安全群組

- **TCP**：對外開放 HTTP/WebSocket 埠（`PORT`，或經反向代理的 80/443）。
- **UDP**：開放 `ICE_PORT_MIN`–`ICE_PORT_MAX`（若未設則需允許臨時 UDP 埠）。
  WebRTC 的實際資料走這些 UDP 埠，沒開會連不上。

### 4. HTTPS（建議）

用 nginx / Caddy 之類的反向代理掛上 TLS，同時代理 HTTP 與 `/ws`（WebSocket 需
`Upgrade` header）。頁面走 HTTPS 時，前端會自動改用 `wss://` 連訊令伺服器。

Caddy 範例：

```
測試網域.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 5. 發起方（瀏覽器）

使用者端**不需要安裝任何東西**：用現代瀏覽器（Chrome / Edge / Firefox / Safari，
近幾年版本都支援 WebRTC）開啟你的網址即可（`https://測試網域.example.com` 或
`http://伺服器IP:3000`），選好項目按「開始測試」。

- 若企業防火牆封鎖 UDP 導致連不上，就需要走 **TURN**（可設定成 TCP/TLS 443 中繼）。
- 建議正式環境走 HTTPS，避免部分瀏覽器對非安全來源的限制。

## 地端 / 離線（air-gapped）安裝

**可以完全離線執行**，而且同一區網內比公網部署更單純——因為兩端直接用 host
candidate 互連，**根本不需要 STUN/TURN，不會連任何外部服務**。

需要處理的是：先在有網路的機器上**建置前端 + 準備相依套件**，再把成品帶進離線設備。

1. **在有網路的機器上準備**（需要 Node 18+ 以執行 Vite 建置）：

   ```bash
   npm install
   npm run build      # 產生 dist/（純靜態檔）
   ```

2. **把以下項目複製到離線設備**：`dist/`、`server/`、`vendor/`、`package.json`、
   `package-lock.json`（以及 `node_modules/`，或到離線設備上再 `npm ci --omit=dev`）。
   離線設備只需要 **Node 16.16.0+** 執行伺服器，**不需要 Node 18 / 不需要 Vite**。
   - 本專案伺服器相依為純 JS、無原生編譯，跨機複製 `node_modules/` 沒問題。
   - `--omit=dev` 會略過 Vite 等只在建置時需要的套件。

3. **關閉 STUN/TURN**：用 `LAN_ONLY=1` 啟動，`iceServers` 會是空的，
   完全走 host candidate，不對外連線：

   ```bash
   LAN_ONLY=1 PORT=3000 npm start
   # 使用者瀏覽器開 http://<設備區網IP>:3000
   ```

4. **前端無外部連線**：Vite 打包出的 `dist/` 沒有外部 CDN、web 字型或外部 API，
   全部由本機伺服器提供，離線可正常載入與繪圖。

5. **HTTPS**：`RTCPeerConnection` / DataChannel 在非安全來源（`http://` 的區網 IP）
   也能運作，離線 LAN 用 HTTP 即可；若要 HTTPS 需自備內部憑證。

> 已實測：`LAN_ONLY=1` 時 `/config` 回傳空 `iceServers`，連線僅用 host candidate
> 即建立成功、四項測試皆正常。

## 已知限制

- `werift` 是純 JavaScript 的 SCTP / DTLS 實作，吞吐量會受 **CPU** 限制，
  在低階機器上可能無法達到很高的 Mbps。它量測的是「瀏覽器到這台伺服器」的
  連線，適合相對比較與連線品質檢測，不宜當作絕對頻寬的權威數字。
- 單一伺服器 peer；未做多使用者資源上限管理。

## 專案結構

```
webrtctesttool/
├── index.html         # Vite 進入點（掛載 <div id="root">）
├── vite.config.js     # Vite 設定（react plugin、dist 輸出、dev proxy）
├── src/
│   ├── main.jsx       # React 掛載進入點
│   ├── App.jsx        # React 元件（UI）
│   ├── net.js         # WebRTC 訊令、測試協定、canvas 折線圖
│   └── styles.css
├── server/
│   ├── index.js       # http + express 靜態檔（dist/）+ WebSocket 訊令掛載
│   ├── signaling.js   # 每條連線的 werift peer 與 offer/answer/candidate 中繼
│   ├── peer.js        # 伺服器端測試協定（收送資料塊、統計）
│   └── config.js      # 共用常數 + env 驅動的部署設定（ICE servers / 埠範圍 / 公開 IP）
├── vendor/ip/         # 精簡版 ip 套件（移除 SSRF 告警函式，見「安全性」）
└── dist/              # Vite 建置產物（gitignored）
```
