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
瀏覽器 (public/app.js)                Node 服務 (server/)
  RTCPeerConnection  ──── WebSocket 訊令 ────  werift RTCPeerConnection
  DataChannel × 3    ═════ WebRTC / SCTP ═════  DataChannel × 3
  (ctrl / data / udp)                          (ctrl / data / udp)
```

- **前端**：純 HTML / CSS / JS，無打包工具、無外部 CDN；折線圖用原生 `<canvas>` 手繪。
- **後端**：單一 Node.js 服務，同時負責靜態網頁、WebSocket 訊令（signaling）、以及
  用 [`werift`](https://github.com/shinyoshiaki/werift-webrtc)（純 TypeScript 的 WebRTC 實作，
  **無原生編譯依賴**）擔任伺服器端的固定 WebRTC peer。

瀏覽器是 WebRTC 的 initiator：建立三條 DataChannel、送出 SDP offer；伺服器回 answer，
雙方交換 ICE candidate 後即建立 P2P 連線，測試協定跑在 DataChannel 上。

### DataChannel 用途

| Label | 屬性 | 用途 |
|-------|------|------|
| `ctrl` | 可靠、有序 | JSON 控制訊息、ping/pong、上傳的 interval / summary 回報 |
| `data` | 可靠、有序 | 下載 / 上傳的二進位資料塊（TCP 式吞吐量） |
| `udp`  | 不可靠、免重傳 | 帶序號的資料塊，量丟包率與 jitter（UDP 式） |

## 安裝與執行

需要 Node.js 18 以上。

```bash
npm install
npm start
# 開啟 http://localhost:3000
```

用瀏覽器開啟頁面 → 選測試時長與項目 → 按「開始測試」。

自訂連接埠：`PORT=8080 npm start`。

## 測試項目

- **延遲 (Latency)**：連續 ping/pong，取 RTT 的 min / avg / max 與 jitter。
- **下載 (Download)**：伺服器往瀏覽器灌資料，瀏覽器每秒統計吞吐量。
- **上傳 (Upload)**：瀏覽器往伺服器灌資料，伺服器每秒回報吞吐量。
- **UDP 丟包**：伺服器送出帶序號的封包（不可靠 channel），瀏覽器依收到的封包數
  與序號算出丟包率與 jitter。

吞吐量的關鍵是**流量控制**：傳送端維持 DataChannel 的 `bufferedAmount` 在
高低水位之間（`bufferedAmountLowThreshold` + `bufferedamountlow` 事件），
才能吃滿鏈路又不讓送出緩衝無限膨脹。

## 部署注意事項（NAT / STUN / TURN）

- 前後端都設定了公用 STUN（`stun:stun.l.google.com:19302`）。
- 伺服器若有**公開 IP**，其 host / server-reflexive candidate 通常可直接連通。
- 若伺服器位於對稱式 NAT 後方而無法建立連線，需要自備 **TURN** 伺服器
  （例如 coturn），並把它加進 `server/signaling.js` 與 `public/app.js` 的 `iceServers`。
- 正式環境請以 **HTTPS** 提供頁面；此時前端會自動改用 `wss://` 連訊令伺服器。

## 已知限制

- `werift` 是純 JavaScript 的 SCTP / DTLS 實作，吞吐量會受 **CPU** 限制，
  在低階機器上可能無法達到很高的 Mbps。它量測的是「瀏覽器到這台伺服器」的
  連線，適合相對比較與連線品質檢測，不宜當作絕對頻寬的權威數字。
- 單一伺服器 peer；未做多使用者資源上限管理。

## 專案結構

```
webrtctesttool/
├── server/
│   ├── index.js       # http + express 靜態檔 + WebSocket 訊令掛載
│   ├── signaling.js   # 每條連線的 werift peer 與 offer/answer/candidate 中繼
│   ├── peer.js        # 伺服器端測試協定（收送資料塊、統計）
│   └── config.js      # 共用常數（chunk 大小、水位、channel label）
└── public/
    ├── index.html
    ├── app.js         # 瀏覽器 WebRTC、測試流程、canvas 折線圖
    └── styles.css
```
