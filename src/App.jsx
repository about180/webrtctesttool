import React, { useState, useRef, useEffect } from 'react';
import { runAll, drawChart, selectedPath } from './net.js';
import { runDiagnostics } from './diagnostics.js';

const DURATIONS = [
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 180, label: '3 min' },
  { value: 300, label: '5 min' },
];

const EMPTY_METRICS = { download: '—', upload: '—', latency: '—', jitter: '—', loss: '—' };

const EMPTY_DIAG = {
  status: 'idle', // idle | running | done | error
  error: null,
  natType: null,
  stunResults: [],
  localCandidates: [],
  remoteCandidates: [],
  pairs: [],
};

export default function App() {
  const [duration, setDuration] = useState(30);
  const [tests, setTests] = useState({ latency: true, download: true, upload: true, udp: true });
  const [running, setRunning] = useState(false);
  const [conn, setConnState] = useState({ text: 'Not connected', cls: '' });
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
        <h1>WebRTC Network Test Tool</h1>
        <p className="subtitle">
          iperf-style throughput / latency test between browser and server over WebRTC DataChannel.
        </p>
      </header>

      <section className="controls">
        <div className="row">
          <label>
            Test duration
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="tests">
            Tests
            <span className="checks">
              <label>
                <input type="checkbox" checked={tests.latency} onChange={() => toggleTest('latency')} /> Latency
              </label>
              <label>
                <input type="checkbox" checked={tests.download} onChange={() => toggleTest('download')} /> Download
              </label>
              <label>
                <input type="checkbox" checked={tests.upload} onChange={() => toggleTest('upload')} /> Upload
              </label>
              <label>
                <input type="checkbox" checked={tests.udp} onChange={() => toggleTest('udp')} /> UDP loss
              </label>
            </span>
          </label>
          <button disabled={busy} onClick={handleStart}>
            Start test
          </button>
          <button className="secondary" disabled={busy} onClick={handleDiagnose}>
            Run network diagnostics
          </button>
        </div>
        <div className="status">
          <span>Connection:</span>
          <span className={'badge' + (conn.cls ? ' ' + conn.cls : '')}>{conn.text}</span>
          <span className="phase">{phase}</span>
        </div>
      </section>

      <section className="results">
        <Metric label="Download" value={metrics.download} unit="Mbps" />
        <Metric label="Upload" value={metrics.upload} unit="Mbps" />
        <Metric label="Latency (RTT)" value={metrics.latency} unit="ms" />
        <Metric label="Jitter" value={metrics.jitter} unit="ms" />
        <Metric label="UDP loss" value={metrics.loss} unit="%" />
      </section>

      <section className="chart-wrap">
        <canvas ref={canvasRef} width={900} height={320}></canvas>
      </section>

      <section className="log-wrap">
        <div className="log-head">
          <span>Per-second stats (iperf-style)</span>
          <button className="ghost" onClick={() => setLogLines([])}>
            Clear
          </button>
        </div>
        <pre ref={logRef}>{logLines.join('\n')}</pre>
      </section>

      {diag.status !== 'idle' && (
        <section className="diagnostics">
          <div className="diag-head">
            <span>Network diagnostics (ICE / STUN / NAT)</span>
            {diag.status === 'running' && <span className="phase">Diagnosing…</span>}
            {diag.status === 'error' && <span className="phase">Error: {diag.error}</span>}
          </div>

          {diag.natType && (
            <div className="metric">
              <div className="metric-label">NAT Type (approximate)</div>
              <div className="metric-value">
                <span className={'nat-badge nat-' + diag.natType.kind}>{diag.natType.label}</span>
              </div>
            </div>
          )}

          <details open={diag.stunResults.length > 0}>
            <summary>
              STUN Binding (OK {diag.stunResults.filter((r) => r.ok).length} / of{' '}
              {diag.stunResults.length})
            </summary>
            <DiagTable
              columns={['STUN server', 'External IP', 'External Port', 'Status']}
              rows={diag.stunResults.map((r) => [
                r.server,
                r.ok ? r.address : '—',
                r.ok ? r.port : '—',
                r.status,
              ])}
            />
          </details>

          <details>
            <summary>Local Candidates ({diag.localCandidates.length})</summary>
            <CandidateTable candidates={diag.localCandidates} />
          </details>

          <details>
            <summary>Remote Candidates ({diag.remoteCandidates.length})</summary>
            <CandidateTable candidates={diag.remoteCandidates} />
          </details>

          <details open>
            <summary>Candidate Pairs ({diag.pairs.length})</summary>
            <div className="table-scroll">
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>Local</th>
                    <th>Remote</th>
                    <th>State</th>
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
            NAT Type is approximate (a dedicated gathering-only connection compares whether ≥2 STUN
            servers report the same external port from the <em>same local port</em>); it is not the
            full RFC 3489 classification — public STUN servers no longer support CHANGE-REQUEST, and a
            browser can't send raw STUN packets to do a complete probe. When two STUN servers return
            the same external address (typical of a Cone NAT), ICE deduplicates the redundant
            candidate, so the table above may show only 1 success while the other reads
            &ldquo;No srflx (possibly deduped)&rdquo; — as long as it didn't clearly time out, that's
            classified as Cone. Also, modern browsers hide the real local LAN IP via mDNS by default,
            so the host address in Local Candidates is usually blank, which is normal.
          </p>
        </section>
      )}

      <footer>
        <details>
          <summary>Why isn't this "real" iperf?</summary>
          <p>
            The browser sandbox doesn't allow web pages to access raw TCP/UDP sockets, so native
            <code>iperf</code>/<code>iperf3</code> binaries can't run on a page (even compiled to
            WebAssembly they can't get a socket). This tool instead uses a{' '}
            <strong>WebRTC DataChannel</strong> (SCTP over DTLS over UDP) to move data between your
            browser and the server, so the measurement reflects the real connection from your browser
            to the server. Download/upload use a reliable, ordered channel (like iperf's TCP mode);
            the UDP loss test uses an unreliable, no-retransmit channel (like iperf's UDP mode).
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
  if (rows.length === 0) return <p className="diag-empty">(none)</p>;
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
  if (candidates.length === 0) return <p className="diag-empty">(none)</p>;
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
