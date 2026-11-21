import { useEffect, useMemo, useState, useRef, type MouseEvent } from 'react';
import { ShieldCheck, Camera, Upload, Activity, AlertTriangle, RefreshCw, Play, Square, Eye, Video } from 'lucide-react';

type EventRow = {
  id: number;
  created_at: string;
  event_type: string;
  severity: string;
  person_track_id: number;
  object_label: string;
  object_track_id: number;
  confidence: number;
  status: string;
  source: string;
  evidence_path: string;
  notes: string;
};
type Status = { running: boolean; source: string | null; message: string; fps: number; processed: number };
type ZoneName = 'checkout' | 'exit' | 'restricted';
type Zones = Record<ZoneName, number[][]>;

const API = ((import.meta as any).env.VITE_API_BASE_URL || 'https://sentinel-ai-backend-k9to.onrender.com').replace(/\/$/, '');

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + url, init);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `Request failed (${r.status})`);
  }
  return r.json();
}

export default function App() {
  const [status, setStatus] = useState<Status>({ running: false, source: null, message: 'Connecting…', fps: 0, processed: 0 });
  const [events, setEvents] = useState<EventRow[]>([]);
  const [health, setHealth] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'overview' | 'events'>('overview');
  const [camera, setCamera] = useState('0');
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState<'retail' | 'home'>('retail');
  const [armed, setArmed] = useState(false);
  const [zones, setZones] = useState<Zones>({
    checkout: [[0.35, 0.55], [0.7, 0.55], [0.7, 0.98], [0.35, 0.98]],
    exit: [[0.82, 0.1], [0.99, 0.1], [0.99, 0.98], [0.82, 0.98]],
    restricted: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameBusyRef = useRef(false);
  const frameAbortRef = useRef<AbortController | null>(null);
  const frameUrlRef = useRef('');
  const [annotatedFrame, setAnnotatedFrame] = useState('');
  const [browserCamera, setBrowserCamera] = useState(false);
  const [calibrating, setCalibrating] = useState<ZoneName | null>(null);
  const [draftPoints, setDraftPoints] = useState<number[][]>([]);

  const refresh = async () => {
    try {
      const [s, e, h, c] = await Promise.all([
        json<Status>('/api/status'),
        json<EventRow[]>('/api/events'),
        json<any>('/api/health'),
        json<any>('/api/config'),
      ]);
      setStatus(s);
      setEvents(e);
      setHealth(h);
      if (c.zones) setZones(c.zones);
      setProfile(c.profile || 'retail');
      setArmed(!!c.armed);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'API unavailable');
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 25000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (browserCamera && status.running && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => setMessage('Could not start webcam playback. Check browser camera permission.'));
    }
  }, [browserCamera, status.running]);

  useEffect(() => {
    return () => {
      frameAbortRef.current?.abort();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!browserCamera || !status.running) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const pump = async () => {
      while (!cancelled) {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState < 2 || !video.videoWidth) {
          await wait(350);
          continue;
        }
        if (frameBusyRef.current) {
          await wait(250);
          continue;
        }
        frameBusyRef.current = true;
        const controller = new AbortController();
        frameAbortRef.current = controller;
        try {
          const width = Math.min(video.videoWidth, 640);
          const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Could not prepare webcam frame.');
          ctx.drawImage(video, 0, 0, width, height);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.65));
          if (!blob) throw new Error('Could not capture a webcam frame.');
          const fd = new FormData();
          fd.append('frame', blob, 'webcam.jpg');
          const response = await fetch(API + '/api/frame', {
            method: 'POST',
            body: fd,
            signal: controller.signal,
            cache: 'no-store',
          });
          if (response.status === 409) {
            const detail = await response.json().catch(() => ({}));
            if (!cancelled) setMessage(detail.error || 'The webcam session ended. Stop and start monitoring again.');
            break;
          }
          if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
            if (!cancelled) setMessage('AI server is waking up or busy. Retrying frame…');
            await wait(10000);
            continue;
          }
          if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.error || `Frame processing failed (${response.status})`);
          }
          const imageBlob = await response.blob();
          if (cancelled) break;
          const url = URL.createObjectURL(imageBlob);
          if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
          frameUrlRef.current = url;
          setAnnotatedFrame(url);
          setStatus((s) => ({ ...s, running: true, source: 'browser-webcam', processed: s.processed + 1 }));
        } catch (err) {
          if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
            setMessage(err instanceof Error ? err.message : String(err));
          }
          if (!cancelled) await wait(2000);
        } finally {
          frameBusyRef.current = false;
          if (frameAbortRef.current === controller) frameAbortRef.current = null;
        }
        await wait(3000);
      }
    };

    void pump();
    return () => {
      cancelled = true;
      frameAbortRef.current?.abort();
    };
  }, [browserCamera, status.running]);

  const changeProfile = async (next: 'retail' | 'home') => {
    setProfile(next);
    setCalibrating(null);
    setDraftPoints([]);
    try {
      await json('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: next }),
      });
      setMessage(next === 'home' ? 'Home security profile selected' : 'Retail loss-prevention profile selected');
    } catch (e) {
      setMessage(String(e));
    }
  };

  const changeArmed = async (next: boolean) => {
    setArmed(next);
    try {
      await json('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: next }),
      });
    } catch (e) {
      setMessage(String(e));
    }
  };

  const addCalibrationPoint = (e: MouseEvent<HTMLDivElement>) => {
    if (!calibrating) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    setDraftPoints((p) => [...p, [Number(x.toFixed(4)), Number(y.toFixed(4))]]);
  };

  const saveCalibration = async () => {
    if (!calibrating || draftPoints.length < 3) {
      setMessage('Add at least three points to define a zone.');
      return;
    }
    const next = { ...zones, [calibrating]: draftPoints };
    try {
      await json('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zones: next }),
      });
      setZones(next);
      setCalibrating(null);
      setDraftPoints([]);
      setMessage('Zone calibration saved.');
    } catch (e) {
      setMessage(String(e));
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const srcTrim = camera.trim();
      if (srcTrim === '0' || srcTrim.toLowerCase() === 'webcam' || srcTrim.toLowerCase() === 'default') {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Browser camera access is unavailable. Open the HTTPS website and allow camera permission.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } },
          audio: false,
        });
        streamRef.current = stream;
        setBrowserCamera(true);
        setStatus((s) => ({
          ...s,
          running: true,
          source: 'browser-webcam',
          message: 'Browser webcam connected; starting AI analysis…',
        }));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        await json('/api/browser/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile, armed: profile === 'home' ? armed : false }),
        });
        setMessage('Laptop webcam connected. Starting AI analysis…');
      } else {
        await json('/api/camera/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: srcTrim, profile, armed: profile === 'home' ? armed : false }),
        });
        setBrowserCamera(false);
        setStatus((s) => ({
          ...s,
          running: true,
          source: srcTrim,
          message: 'Camera/CCTV source start requested on backend.',
        }));
        setMessage('Camera/CCTV source start requested on backend.');
      }
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setBrowserCamera(false);
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const stop = async () => {
    try {
      frameAbortRef.current?.abort();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      const isBrowser = browserCamera || status.source === 'browser-webcam';
      await json(isBrowser ? '/api/browser/stop' : '/api/camera/stop', { method: 'POST' });
      setBrowserCamera(false);
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = '';
      }
      setAnnotatedFrame('');
      setStatus((s) => ({ ...s, running: false, source: null, message: 'Monitoring stopped.', fps: 0 }));
      setMessage('Monitoring stopped.');
    } catch (e) {
      setMessage(String(e));
    }
    void refresh();
  };

  const upload = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('video', file);
    fd.append('profile', profile);
    fd.append('armed', String(profile === 'home' && armed));
    setBusy(true);
    try {
      const r = await json<any>('/api/upload', { method: 'POST', body: fd });
      setMessage(r.message);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const review = async (id: number, value: string) => {
    try {
      await json(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: value }),
      });
      void refresh();
    } catch (e) {
      setMessage(String(e));
    }
  };

  const pending = useMemo(() => events.filter((e) => e.status === 'Needs review').length, [events]);
  const time = (v: string) => new Date(v).toLocaleString();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon"><ShieldCheck size={23} /></div>
          <div><b>SENTINEL AI</b><small>LOSS PREVENTION</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button className={tab === 'overview' ? 'nav active' : 'nav'} onClick={() => setTab('overview')}>
          <Activity size={18} /> Overview
        </button>
        <button className={tab === 'events' ? 'nav active' : 'nav'} onClick={() => setTab('events')}>
          <AlertTriangle size={18} /> Incident review <span className="nav-count">{pending}</span>
        </button>
        <div className="side-bottom">
          <div className="secure"><div className="secure-dot" /> Local processing enabled</div>
          <small>AI-assisted monitoring<br />Human review required</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">{profile === 'home' ? 'HOME RESIDENCE SECURITY' : 'RETAIL LOSS-PREVENTION PLATFORM'}</div>
            <h1>{tab === 'overview' ? 'Monitoring overview' : 'Incident review'}</h1>
          </div>
          <div className="top-actions">
            <span className={'status-pill ' + (status.running ? 'live' : 'idle')}>
              <i /> {status.running ? 'MONITORING' : 'STANDBY'}
            </span>
            <button className="icon-btn" onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        {message && (
          <div className="notice" onClick={() => setMessage('')}>
            {message}<span>×</span>
          </div>
        )}

        {tab === 'overview' ? (
          <>
            <section className="metrics">
              <div className="metric">
                <div className="metric-icon blue"><Camera /></div>
                <div><small>INPUT STATUS</small><strong>{status.running ? 'Active' : 'Standby'}</strong><em>{status.source || 'No active source'}</em></div>
              </div>
              <div className="metric">
                <div className="metric-icon amber"><AlertTriangle /></div>
                <div><small>NEEDS REVIEW</small><strong>{pending}</strong><em>Unreviewed alerts</em></div>
              </div>
              <div className="metric">
                <div className="metric-icon green"><Activity /></div>
                <div><small>PROCESSING SPEED</small><strong>{status.fps.toFixed(1)} <sup>FPS</sup></strong><em>{status.processed.toLocaleString()} frames processed</em></div>
              </div>
              <div className="metric">
                <div className="metric-icon violet"><Eye /></div>
                <div><small>AI COMPONENTS</small><strong>{health.yolo_available ? 'YOLOv8 ready' : 'Model pending'}</strong><em>MediaPipe {health.mediapipe_available ? 'available' : 'optional'}</em></div>
              </div>
            </section>

            <section className="content-grid">
              <div className="panel video-panel">
                <div className="panel-head">
                  <div>
                    <h2>Live camera feed</h2>
                    <p>{profile === 'home' ? 'Person-entry alerts for the configured restricted zone' : 'Person/object tracking and checkout/exit zones'}</p>
                  </div>
                  <span className="mini-live"><i />{status.running ? 'LIVE' : 'OFFLINE'}</span>
                </div>

                <div className={'video-wrap ' + (calibrating ? 'calibrating' : '')} onClick={addCalibrationPoint}>
                  {status.running ? (
                    <>
                      <video ref={videoRef} autoPlay muted playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }} />
                      
                      <canvas ref={canvasRef} className="camera-source-hidden" />
                      {browserCamera ? (
                        annotatedFrame ? (
                          <img src={annotatedFrame} alt="Live AI-annotated laptop webcam feed" style={{ position: 'relative', zIndex: 2 }} />
                        ) : (
                          <div className="video-placeholder">
                            <div className="camera-orb"><Video size={30} /></div>
                            <b>Camera connected — initializing AI</b>
                            <span>Preparing the first processed frame…</span>
                          </div>
                        )
                      ) : (
                        <img src={API + '/api/video_feed'} alt="Live annotated CCTV feed" />
                      )}
                      <svg className="zone-editor" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                        {calibrating && zones[calibrating]?.length >= 3 && (
                          <polygon points={zones[calibrating].map((p) => `${p[0] * 1000},${p[1] * 1000}`).join(' ')} className="saved-zone" />
                        )}
                        {draftPoints.length > 0 && (
                          <>
                            <polyline points={draftPoints.map((p) => `${p[0] * 1000},${p[1] * 1000}`).join(' ')} className="draft-zone" />
                            {draftPoints.map((p, i) => (
                              <circle key={i} cx={p[0] * 1000} cy={p[1] * 1000} r="9" className="draft-point" />
                            ))}
                          </>
                        )}
                      </svg>
                    </>
                  ) : (
                    <div className="video-placeholder">
                      <div className="camera-orb"><Video size={30} /></div>
                      <b>Camera feed is not active</b>
                      <span>Connect your laptop webcam to begin monitoring. You can reposition it and recalibrate zones.</span>
                    </div>
                  )}
                </div>

                {calibrating && (
                  <div className="calibration-tools">
                    <b>Calibrating {calibrating === 'restricted' ? 'restricted area' : calibrating === 'checkout' ? 'checkout area' : 'exit area'}</b>
                    <span>Click at least 3 points on the camera image to outline this zone. {draftPoints.length} points added.</span>
                    <div>
                      <button className="btn" onClick={() => setDraftPoints((p) => p.slice(0, -1))}>Undo point</button>
                      <button className="btn" onClick={() => setDraftPoints([])}>Clear points</button>
                      <button className="btn primary" onClick={saveCalibration}>Save zone</button>
                      <button className="btn danger" onClick={() => { setCalibrating(null); setDraftPoints([]); }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div className="camera-controls">
                  <label>
                    Monitoring profile
                    <select className="source-input" value={profile} onChange={(e) => changeProfile(e.target.value as 'retail' | 'home')}>
                      <option value="retail">Retail store / supermarket</option>
                      <option value="home">Home residence security</option>
                    </select>
                  </label>
                  {profile === 'home' && (
                    <label className="arm-toggle">
                      <input type="checkbox" checked={armed} onChange={(e) => changeArmed(e.target.checked)} /> Arm home monitoring
                    </label>
                  )}
                  <label>
                    Camera source
                    <input
                      className="source-input"
                      value={camera}
                      onChange={(e) => setCamera(e.target.value)}
                      placeholder="0 = this browser webcam, or RTSP URL for server-connected CCTV"
                    />
                  </label>
                  {status.running ? (
                    <button className="btn danger" onClick={stop}><Square size={15} /> Stop monitoring</button>
                  ) : (
                    <button className="btn primary" disabled={busy} onClick={start}><Play size={15} /> Start monitoring</button>
                  )}
                </div>

                <div className="zone-calibration">
                  <div>
                    <b>Camera positioning &amp; zone calibration</b>
                    <span>Move the laptop webcam whenever needed. Recalibrate the visible zones after changing its angle or position.</span>
                  </div>
                  <div className="zone-buttons">
                    {(profile === 'home' ? [['restricted', 'Restricted area']] : [['checkout', 'Checkout zone'], ['exit', 'Exit zone']]).map(
                      ([key, label]) => (
                        <button
                          key={key}
                          className={'btn ' + (calibrating === key ? 'primary' : '')}
                          disabled={!status.running}
                          onClick={() => {
                            setCalibrating(key as ZoneName);
                            setDraftPoints([]);
                          }}
                        >
                          {label}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              </div>

              <div className="panel upload-panel">
                <div className="panel-head">
                  <div>
                    <h2>Video analysis</h2>
                    <p>Review a previously recorded CCTV clip</p>
                  </div>
                  <Upload size={19} className="muted-icon" />
                </div>
                <div className="upload-zone">
                  <input
                    id="video-file"
                    type="file"
                    accept="video/mp4,video/avi,video/quicktime,video/x-matroska"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                  <label htmlFor="video-file">
                    <div className="upload-icon"><Upload /></div>
                    <b>{file ? file.name : 'Choose a video file'}</b>
                    <span>MP4, AVI, MOV or MKV · max 500 MB</span>
                  </label>
                </div>
                <button className="btn primary full" disabled={!file || busy || status.running} onClick={upload}>
                  <Activity size={16} /> {busy ? 'Submitting…' : 'Analyse uploaded video'}
                </button>
                <div className="info-note">
                  <ShieldCheck size={16} /> Video is processed locally by the AI backend. Review alerts before taking action.
                </div>
                <div className="system-note">
                  <b>System status</b>
                  <span>{health.message || status.message}</span>
                  <span className="subtle">YOLO weights download automatically on first model load.</span>
                </div>
              </div>
            </section>

            <section className="panel table-panel">
              <div className="panel-head">
                <div>
                  <h2>Recent review alerts</h2>
                  <p>{profile === 'home' ? 'Potential restricted-zone entries while armed' : 'Potential exit-with-item events detected by configured zone rules'}</p>
                </div>
                <button className="text-btn" onClick={() => setTab('events')}>View all alerts →</button>
              </div>
              <EventTable events={events.slice(0, 5)} review={review} time={time} />
            </section>
          </>
        ) : (
          <section className="panel table-panel">
            <div className="panel-head">
              <div>
                <h2>All detection events</h2>
                <p>Review each event and record the outcome.</p>
              </div>
              <span className="count-label">{events.length} records</span>
            </div>
            <EventTable events={events} review={review} time={time} />
          </section>
        )}

        <footer>Sentinel AI · Prototype for supervised loss-prevention review · Alerts are not proof of theft.</footer>
      </main>
    </div>
  );
}

function EventTable({
  events,
  review,
  time,
}: {
  events: EventRow[];
  review: (id: number, v: string) => void;
  time: (v: string) => string;
}) {
  if (!events.length) return <div className="empty">No alerts yet. Start a camera or upload a video to begin.</div>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>TIME</th>
            <th>EVENT</th>
            <th>TRACKS</th>
            <th>CONFIDENCE</th>
            <th>STATUS</th>
            <th>REVIEW</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="time-cell">{time(e.created_at)}</td>
              <td>
                <div className="event-name">
                  <span className="alert-dot" />{' '}
                  {e.event_type === 'RESTRICTED_ZONE_ENTRY_REVIEW' ? 'Restricted-zone entry – review' : 'Exit with item – review'}
                </div>
                <small className="muted">Object: {e.object_label || 'Unknown'}</small>
              </td>
              <td>
                Person #{e.person_track_id}
                <small className="muted">Object #{e.object_track_id}</small>
              </td>
              <td>{Math.round((e.confidence || 0) * 100)}%</td>
              <td>
                <span className={'tag ' + (e.status === 'Needs review' ? 'warning' : 'neutral')}>{e.status}</span>
              </td>
              <td>
                <select className="review-select" value={e.status} onChange={(ev) => review(e.id, ev.target.value)}>
                  <option>Needs review</option>
                  <option>Reviewed - no issue</option>
                  <option>Confirmed incident</option>
                  <option>False alert</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}