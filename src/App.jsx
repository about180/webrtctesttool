import React, { useState, useRef, useEffect } from 'react';
import { runAll, drawChart, selectedPath } from './net.js';
import { runDiagnostics } from './diagnostics.js';

const DURATIONS = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分鐘' },
  { value: 180, label: '3 分鐘' },
  { value: 300, label: '5 分鐘' },
];

const EMPTY_METRICS = { download: '—', upload: '—', latency: '—', jitter: '—', loss: '—' };

const EMPTY_DIAG = {
  status: 'idle', // idle | running | done | error
  error: null,
  natType: null,
  stunBindings: [],
  localCandidates: [],
  remoteCandidates: [],
  pairs: [],
};

export default function App() {
  const [duration, setDuration] = useState(30);
  const [tests, setTests] = useState({ latency: true, download: true, upload: true, udp: true });
  const [running, setRunning] = useState(false);
  const [conn, setConnState] = useState({ text: '未連線', cls: '' });
  const [phase, setPhase] = useState('');
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [logLines, setLogLines] = useState([]);
  const [chartPoints, setChartPoints] = useState([]);
  const [diag, setDiag] = useState(EMPTY_DIAG);

  const canvasRef = useRef(null);
  const logRef = useRef(null);
  const ctxRef = useRef(null);

  if (!ctxRef.current) {
    ctxRef.current = {
      pc: null,
      ws: null,
      ctrl: null,
      data: null,
      udp: null,
      ctrlWaiters: {},
      setConn: (text, cls) => setConnState({ text, cls: cls || '' }),
      setPhase,
      setMetric: (key, val) => setMetrics((m) => ({ ...m, [key]: val })),
      pushLog: (line) => setLogLines((ls) => ls.concat(line)),
      resetChart: () => setChartPoints([]),
      pushPoint: (test, val) => setChartPoints((pts) => pts.concat({ test, mbps: val })),
      resetMetrics: () => setMetrics(EMPTY_METRICS),
      setRunning,
      diagSetStatus: (status) => setDiag((d) => ({ ...d, status })),
      diagSetError: (error) => setDiag((d) => ({ ...d, error })),
      diagSetResult: (result) => setDiag((d) => ({ ...d, ...result })),
    };

    // Diagnostics hook usable from the devtools console / e2e tests.
    window.__webrtctest = {
      selectedPath: () => selectedPath(ctxRef.current.pc),
    };
  }

  useEffect(() => {
    drawChart(canvasRef.current, chartPoints);
  }, [chartPoints]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const busy = running || diag.status === 'running';
  const handleStart = () => runAll(ctxRef.current, duration, tests);
  const handleDiagnose = () => runDiagnostics(ctxRef.current);
  const toggleTest = (key) => setTests((t) => ({ ...t, [key]: !t[key] }));

  return (
    <main>
      <header>
        <h1>WebRTC 網路測試工具</h1>
        <p className="subtitle">
          瀏覽器 ↔ 伺服器的 iperf 式吞吐量 / 延遲測試，走 WebRTC DataChannel。
        </p>
      </header>

      <section className="controls">
        <div className="row">
          <label>
            測試時長
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="tests">
            測試項目
            <span className="checks">
              <label>
                <input type="checkbox" checked={tests.latency} onChange={() => toggleTest('latency')} /> 延遲
              </label>
              <label>
                <input type="checkbox" checked={tests.download} onChange={() => toggleTest('download')} /> 下載
              </label>
              <label>
                <input type="checkbox" checked={tests.upload} onChange={() => toggleTest('upload')} /> 上傳
              </label>
              <label>
                <input type="checkbox" checked={tests.udp} onChange={() => toggleTest('udp')} /> UDP 丟包
              </label>
            </span>
          </label>
          <button disabled={busy} onClick={handleStart}>
            開始測試
          </button>
          <button className="secondary" disabled={busy} onClick={handleDiagnose}>
            執行網路診斷
          </button>
        </div>
        <div className="status">
          <span>連線狀態：</span>
          <span className={'badge' + (conn.cls ? ' ' + conn.cls : '')}>{conn.text}</span>
          <span className="phase">{phase}</span>
        </div>
      </section>

      <section className="results">
        <Metric label="下載" value={metrics.download} unit="Mbps" />
        <Metric label="上傳" value={metrics.upload} unit="Mbps" />
        <Metric label="延遲 (RTT)" value={metrics.latency} unit="ms" />
        <Metric label="Jitter" value={metrics.jitter} unit="ms" />
        <Metric label="UDP 丟包" value={metrics.loss} unit="%" />
      </section>

      <section className="chart-wrap">
        <canvas ref={canvasRef} width={900} height={320}></canvas>
      </section>

      <section className="log-wrap">
        <div className="log-head">
          <span>每秒統計（模仿 iperf）</span>
          <button className="ghost" onClick={() => setLogLines([])}>
            清除
          </button>
        </div>
        <pre ref={logRef}>{logLines.join('\n')}</pre>
      </section>

      {diag.status !== 'idle' && (
        <section className="diagnostics">
          <div className="diag-head">
            <span>網路診斷（ICE / STUN / NAT）</span>
            {diag.status === 'running' && <span className="phase">診斷中…</span>}
            {diag.status === 'error' && <span className="phase">錯誤：{diag.error}</span>}
          </div>

          {diag.natType && (
            <div className="metric">
              <div className="metric-label">NAT Type（近似判斷）</div>
              <div className="metric-value">
                <span className={'nat-badge nat-' + diag.natType.kind}>{diag.natType.label}</span>
              </div>
            </div>
          )}

          <details open={diag.stunBindings.length > 0}>
            <summary>STUN Binding（{diag.stunBindings.length}）</summary>
            <DiagTable
              columns={['STUN 伺服器', '對外 IP', '對外 Port']}
              rows={diag.stunBindings.map((b) => [b.server, b.address, b.port])}
            />
          </details>

          <details>
            <summary>Local Candidates（{diag.localCandidates.length}）</summary>
            <CandidateTable candidates={diag.localCandidates} />
          </details>

          <details>
            <summary>Remote Candidates（{diag.remoteCandidates.length}）</summary>
            <CandidateTable candidates={diag.remoteCandidates} />
          </details>

          <details open>
            <summary>Candidate Pairs（{diag.pairs.length}）</summary>
            <div className="table-scroll">
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>Local</th>
                    <th>Remote</th>
                    <th>狀態</th>
                    <th>Nominated</th>
                    <th>RTT (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {diag.pairs.map((p, i) => (
                    <tr key={i} className={p.state === 'succeeded' ? 'pair-selected' : ''}>
                      <td>
                        {p.localAddr}:{p.localPort}
                      </td>
                      <td>
                        {p.remoteAddr}:{p.remotePort}
                      </td>
                      <td>{p.state}</td>
                      <td>{p.nominated ? '✓' : ''}</td>
                      <td>{p.rtt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="diag-note">
            NAT Type 為近似判斷（比對 ≥2 個 STUN 目標回傳的對外 port 是否一致），並非 RFC 3489
            完整分類——公用 STUN 伺服器已不支援 CHANGE-REQUEST，瀏覽器也無法發送 raw STUN
            封包做完整偵測。若其中一個 STUN 伺服器沒有回應（逾時而非快速失敗），瀏覽器可能整批
            放棄該次 STUN 收集、不會回報任何 binding，此時會顯示「無法判斷」。另外，現代瀏覽器
            預設會隱藏本機真實區網 IP（mDNS 隱私保護），故 Local Candidates 的 host 位址多半顯示
            為空或 `.local` 名稱，屬正常現象。
          </p>
        </section>
      )}

      <footer>
        <details>
          <summary>為什麼不是「真的」iperf？</summary>
          <p>
            瀏覽器沙箱不允許網頁存取原始 TCP/UDP socket，所以無法在頁面裡執行原生
            <code>iperf</code>/<code>iperf3</code> 執行檔（即使編成 WebAssembly 也拿不到 socket）。
            這個工具改用 <strong>WebRTC DataChannel</strong>（SCTP over DTLS over UDP）在
            你的瀏覽器與伺服器之間傳資料，量測結果反映的是「你這台瀏覽器到伺服器」的真實連線。
            下載/上傳走可靠、有序的 channel（類似 iperf 的 TCP 模式）；UDP 丟包測試走
            不可靠、免重傳的 channel（類似 iperf 的 UDP 模式）。
          </p>
        </details>
      </footer>
    </main>
  );
}

function Metric({ label, value, unit }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        <span>{value}</span> <small>{unit}</small>
      </div>
    </div>
  );
}

function DiagTable({ columns, rows }) {
  if (rows.length === 0) return <p className="diag-empty">（無）</p>;
  return (
    <div className="table-scroll">
      <table className="diag-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateTable({ candidates }) {
  if (candidates.length === 0) return <p className="diag-empty">（無）</p>;
  return (
    <div className="table-scroll">
      <table className="diag-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Protocol</th>
            <th>Address</th>
            <th>Port</th>
            <th>Priority</th>
            <th>Foundation</th>
            <th>Related</th>
            <th>Server</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.id}>
              <td>{c.type}</td>
              <td>{c.protocol}</td>
              <td>{c.address}</td>
              <td>{c.port}</td>
              <td>{c.priority}</td>
              <td>{c.foundation || '—'}</td>
              <td>{c.relatedAddress ? `${c.relatedAddress}:${c.relatedPort}` : '—'}</td>
              <td>{c.url || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
