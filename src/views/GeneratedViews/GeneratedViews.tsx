import { useEffect, useMemo, useRef, useState } from 'react';

type GeneratedStatus =
  | 'queued'
  | 'preparing'
  | 'generating'
  | 'validating'
  | 'building'
  | 'publishing'
  | 'enhancing'
  | 'ready'
  | 'error'
  | 'deleted';


type GeneratedView = {
  id: string;
  title: string;
  description: string;
  status: GeneratedStatus;
  public_url: string;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  error_message?: string | null;
};

type UploadPayload = {
  name: string;
  type: string;
  content: string;
};

type JobEvent = {
  status?: GeneratedStatus;
  message?: string;
  view?: GeneratedView | null;
};

const SAMPLE_PROMPT = `Create a deployment configurator view from these notes.
Show selectable services, constraints, environment stages, and a concise export summary.`;
const PROGRESS: GeneratedStatus[] = ['queued', 'preparing', 'generating', 'validating', 'building', 'publishing', 'ready'];
const ENHANCE_PROGRESS: GeneratedStatus[] = ['enhancing', 'validating', 'building', 'publishing', 'ready'];
const PROGRESS_LABELS: Record<GeneratedStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  generating: 'Generating',
  validating: 'Validating',
  building: 'Building',
  publishing: 'Publishing',
  enhancing: 'Enhancing',
  ready: 'Ready',
  error: 'Error',
  deleted: 'Deleted',
};
const ACCEPTED_FILES = '.ini,.txt,.md,.json,.yaml,.yml,.csv,.png,.jpg,.jpeg,.svg';
export function GeneratedViews() {
  const [prompt, setPrompt] = useState(SAMPLE_PROMPT);
  const [files, setFiles] = useState<File[]>([]);
  const [views, setViews] = useState<GeneratedView[]>([]);
  const [activeJob, setActiveJob] = useState<GeneratedView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const sseCleanupRef = useRef<(() => void) | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [enhanceText, setEnhanceText] = useState('');
  const [enhancing, setEnhancing] = useState(false);

  const isEnhancingFlow = useMemo(() => activeJob?.status && ENHANCE_PROGRESS.includes(activeJob.status), [activeJob?.status]);
  const activeStep = useMemo(() => {
    if (!activeJob) return -1;
    if (isEnhancingFlow) return -2; // special marker for enhance flow
    return PROGRESS.indexOf(activeJob.status);
  }, [activeJob, isEnhancingFlow]);
  const enhanceActiveStep = useMemo(() => {
    if (!activeJob || !isEnhancingFlow) return -1;
    return ENHANCE_PROGRESS.indexOf(activeJob.status);
  }, [activeJob, isEnhancingFlow]);
  useEffect(() => {
    void refreshViews();
    return () => {
      sseCleanupRef.current?.();
      sseCleanupRef.current = null;
    };
  }, []);

  async function refreshViews() {
    try {
      const response = await fetch('/api/views');
      if (!response.ok) throw new Error('The generator API is not available. Start it with npm run server.');
      const payload = (await response.json()) as { views: GeneratedView[] };
      setViews(payload.views);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function submitJob() {
    setBusy(true);
    setError(null);
    setEvents([]);
    try {
      const uploadPayload = await readUploadPayloads(files);
      const response = await fetch('/api/generation-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, files: uploadPayload }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Could not create generation job.');
      }
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
      setViews((current) => [view, ...current.filter((item) => item.id !== view.id)]);
      sseCleanupRef.current = listenForJob(view.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function listenForJob(id: string) {
    const source = new EventSource(`/api/generation-jobs/${id}/events`);
    source.onmessage = (event) => applyJobEvent(event.data);
    for (const status of [...PROGRESS, ...ENHANCE_PROGRESS]) {
      source.addEventListener(status, (event) => applyJobEvent((event as MessageEvent<string>).data));
    }
    source.addEventListener('error', (event) => {
      applyJobEvent((event as MessageEvent<string>).data);
    });
    source.onerror = () => {
      source.close();
      void refreshSingleJob(id);
    };
    return () => {
      source.close();
    };
  }

  function applyJobEvent(raw: string) {
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as JobEvent;
      if (payload.message) setEvents((current) => [payload.message ?? '', ...current].slice(0, 80));
      if (payload.view) {
        setActiveJob(payload.view);
        setViews((current) => [payload.view as GeneratedView, ...current.filter((item) => item.id !== payload.view?.id)]);
      }
      if (payload.status === 'ready' || payload.status === 'error') void refreshViews();
    } catch {
      // Ignore malformed event payloads; the next poll/list refresh will recover the UI.
    }
  }

  async function refreshSingleJob(id: string) {
    try {
      const response = await fetch(`/api/generation-jobs/${id}`);
      if (!response.ok) return;
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
      setViews((current) => [view, ...current.filter((item) => item.id !== view.id)]);
    } catch {
      // Keep the last known status in place.
    }
  }

  async function deleteView(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/views/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete generated view.');
      setViews((current) => current.filter((view) => view.id !== id));
      if (activeJob?.id === id) setActiveJob(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function triggerPreview(id: string) {
    setPreviewLoading(true);
    setPreviewUrl(null);
    setError(null);
    try {
      const response = await fetch(`/api/generation-jobs/${id}/preview`, { method: 'POST' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Could not create preview.');
      }
      const result = (await response.json()) as { preview_url: string };
      setPreviewUrl(result.preview_url);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function enhanceJob(id: string) {
    if (!enhanceText.trim()) {
      setError('Please describe how you\'d like to enhance the view.');
      return;
    }
    setEnhancing(true);
    setError(null);
    try {
      const response = await fetch(`/api/generation-jobs/${id}/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: enhanceText.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Could not enhance view.');
      }
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
      setViews((current) => [view, ...current.filter((item) => item.id !== view.id)]);
      sseCleanupRef.current?.();
      sseCleanupRef.current = listenForJob(view.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setEnhancing(false);
    }
  }

  // Clear preview and enhance state when switching jobs
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setPreviewUrl(null);
    setEnhanceText('');
  }, [activeJob?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div style={{ minHeight: '100%', background: '#e2e8f0', padding: 24 }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section style={{ ...card, background: 'linear-gradient(135deg, #0f172a, #172554)', color: '#fff', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gap: 8, maxWidth: 820 }}>
            <span style={eyebrow}>Chat-driven generated views</span>
            <h1 style={{ margin: 0, fontSize: 36, letterSpacing: '-0.04em' }}>Tell FM2C what configurator you want. It builds a standalone page under <code>/gen/:id</code>.</h1>
            <p style={{ margin: 0, color: '#cbd5e1', fontSize: 15 }}>
              The main SPL Visualizer stays trusted and stable. Generated React code is written into an isolated workspace, built through a separate Vite config, validated, then published as static files. Lovely stuff.
            </p>
          </div>
        </section>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.95fr) minmax(360px, 1.05fr)', gap: 18, alignItems: 'start' }}>
          <section style={card}>
            <h2 style={title}>1. Describe the configurator</h2>
            <p style={hint}>Add free-text instructions and optional supporting files. The prototype accepts text-ish files and stores job metadata in SQLite.</p>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={9}
              style={textarea}
              placeholder="Describe the configurator view you want to generate..."
            />
            <label style={uploadBox}>
              <input
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                style={{ display: 'none' }}
              />
              <strong>Drop in documentation/settings</strong>
              <span style={{ color: '#64748b', fontSize: 13 }}>{files.length ? files.map((file) => file.name).join(', ') : 'ini, txt, md, json, yaml, csv, images or svg'}</span>
            </label>
            {error && <div style={errorBox}>⚠ {error}</div>}
            <button onClick={submitJob} disabled={busy || prompt.trim().length === 0} style={primaryButton}>
              {busy ? 'Creating job…' : 'Generate standalone view'}
            </button>
          </section>

          <section style={card}>
            <h2 style={title}>2. Build status</h2>
            {!activeJob ? (
              <p style={hint}>No active job yet. Create one and you'll see the progress here in real time.</p>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div>
                    <strong style={{ color: '#0f172a', fontSize: 18 }}>{activeJob.title}</strong>
                    <div style={{ color: '#64748b', fontSize: 12 }}>{activeJob.id}</div>
                  </div>
                  <StatusPill status={activeJob.status} />
                </div>

                {/* Labeled progress bar */}
                <div style={{ marginTop: 18 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isEnhancingFlow ? ENHANCE_PROGRESS.length : PROGRESS.length}, 1fr)`, gap: 4 }}>
                    {(isEnhancingFlow ? ENHANCE_PROGRESS : PROGRESS).map((status, index) => {
                      const step = isEnhancingFlow ? enhanceActiveStep : activeStep;
                      const done = index <= step;
                      const current = index === step;
                      return (
                        <div key={status} style={{ display: 'grid', gap: 4 }}>
                          <div style={{
                            height: 6,
                            borderRadius: 999,
                            background: done ? (current ? '#2563eb' : '#3b82f6') : '#e2e8f0',
                            transition: 'background 0.3s',
                          }} />
                          <div style={{
                            fontSize: 10,
                            fontWeight: current ? 700 : 500,
                            color: done ? (current ? '#1e40af' : '#64748b') : '#cbd5e1',
                            textAlign: 'center',
                            letterSpacing: '0.02em',
                          }}>
                            {PROGRESS_LABELS[status] ?? status}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {activeJob.status === 'ready' && (
                    <a href={activeJob.public_url} target="_blank" rel="noreferrer" style={{ ...primaryButton, textDecoration: 'none', display: 'inline-flex' }}>
                      Open /gen/{activeJob.id}
                    </a>
                  )}
                  {activeJob.status === 'generating' || activeJob.status === 'validating' ? (
                    <button onClick={() => void triggerPreview(activeJob.id)} disabled={previewLoading} style={primaryButton}>
                      {previewLoading ? 'Building preview…' : previewUrl ? 'Update preview' : '👁 Show preview'}
                    </button>
                  ) : null}
                  <button onClick={() => void refreshSingleJob(activeJob.id)} style={secondaryButton}>Refresh status</button>
                </div>

                {/* Enhance section */}
                {activeJob.status === 'ready' && (
                  <div style={{ marginTop: 18, padding: 16, border: '1px solid #e2e8f0', borderRadius: 16, background: '#f8fafc' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <strong style={{ fontSize: 14, color: '#0f172a' }}>Enhance this view</strong>
                      <span style={{ fontSize: 12, color: '#64748b' }}>Ask for improvements and we'll regenerate</span>
                    </div>
                    <textarea
                      value={enhanceText}
                      onChange={(event) => setEnhanceText(event.target.value)}
                      rows={3}
                      style={{ ...textarea, marginBottom: 10 }}
                      placeholder="Describe how you'd like to improve this view..."
                    />
                    <button
                      onClick={() => void enhanceJob(activeJob.id)}
                      disabled={enhancing || !enhanceText.trim()}
                      style={{ ...primaryButton, opacity: enhancing || !enhanceText.trim() ? 0.6 : 1 }}
                    >
                      {enhancing ? 'Enhancing…' : 'Enhance view'}
                    </button>
                  </div>
                )}

                {/* Preview iframe */}
                {previewUrl && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                      <strong style={{ fontSize: 13, color: '#0f172a' }}>Live preview</strong>
                      <button onClick={() => setPreviewUrl(null)} style={{ ...secondaryButton, padding: '4px 8px', fontSize: 11 }}>Close</button>
                    </div>
                    <iframe
                      title="Preview of generated view"
                      src={previewUrl}
                      sandbox="allow-scripts"
                      style={{ width: '100%', height: 420, border: '1px solid #cbd5e1', borderRadius: 16, background: '#fff' }}
                    />
                  </div>
                )}

                {/* Error */}
                {activeJob.error_message && <div style={errorBox}>Build failed: {activeJob.error_message}</div>}

                {/* Event log */}
                {events.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <strong style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Activity log</strong>
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#475569', fontSize: 13, maxHeight: 320, overflow: 'auto' }}>
                      {events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <section style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <div>
              <h2 style={title}>Generated views</h2>
              <p style={hint}>Public-by-link prototype list. The generated page is also previewed in a sandboxed iframe when ready.</p>
            </div>
            <button onClick={() => void refreshViews()} style={secondaryButton}>Refresh list</button>
          </div>
          {views.length === 0 ? (
            <p style={hint}>No generated views yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {views.map((view) => (
                <article key={view.id} style={{ border: '1px solid #e2e8f0', borderRadius: 18, padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start', flexWrap: 'wrap' }}>
                    <div>
                      <strong style={{ color: '#0f172a' }}>{view.title}</strong>
                      <p style={{ ...hint, margin: '4px 0 0' }}>{view.description}</p>
                      <code style={{ fontSize: 12, color: '#475569' }}>{view.public_url}</code>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <StatusPill status={view.status} />
                      <button onClick={() => setActiveJob(view)} style={secondaryButton}>Select</button>
                      <button onClick={() => void deleteView(view.id)} style={dangerButton}>Delete</button>
                    </div>
                  </div>
                  {view.status === 'ready' && activeJob?.id === view.id && (
                    <iframe
                      title={`Preview of ${view.title}`}
                      src={view.public_url}
                      sandbox="allow-scripts"
                      style={{ width: '100%', minHeight: 520, border: '1px solid #cbd5e1', borderRadius: 16, background: '#fff' }}
                    />
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: GeneratedStatus }) {
  const colour = status === 'ready' ? '#16a34a' : status === 'error' ? '#dc2626' : status === 'enhancing' || status === 'building' || status === 'generating' ? '#2563eb' : '#64748b';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '5px 10px', background: `${colour}18`, color: colour, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {status}
    </span>
  );
}

async function readUploadPayloads(files: File[]): Promise<UploadPayload[]> {
  const allowed = files.slice(0, 8);
  return Promise.all(
    allowed.map(async (file) => {
      const isBinary = file.type.startsWith('image/');
      let content: string;
      if (isBinary) {
        const buffer = await file.arrayBuffer();
        content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      } else {
        content = await file.text();
      }
      return {
        name: file.name,
        type: file.type || 'text/plain',
        content,
      };
    }),
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const card = {
  background: '#fff',
  border: '1px solid #cbd5e1',
  borderRadius: 24,
  padding: 22,
  boxShadow: '0 18px 45px rgba(15, 23, 42, 0.08)',
} as const;

const title = { margin: '0 0 6px', color: '#0f172a', fontSize: 20, letterSpacing: '-0.02em' } as const;
const hint = { margin: '0 0 14px', color: '#64748b', fontSize: 13, lineHeight: 1.55 } as const;
const eyebrow = { color: '#93c5fd', fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.16em' } as const;
const textarea = { width: '100%', border: '1px solid #cbd5e1', borderRadius: 16, padding: 14, resize: 'vertical', font: 'inherit', color: '#0f172a', outline: 'none' } as const;
const uploadBox = { marginTop: 12, border: '1px dashed #94a3b8', borderRadius: 16, padding: 16, display: 'grid', gap: 4, cursor: 'pointer', background: '#f8fafc' } as const;
const primaryButton = { border: 'none', borderRadius: 999, background: '#2563eb', color: '#fff', fontWeight: 800, padding: '10px 16px', cursor: 'pointer', alignItems: 'center', justifyContent: 'center' } as const;
const secondaryButton = { border: '1px solid #cbd5e1', borderRadius: 999, background: '#fff', color: '#0f172a', fontWeight: 700, padding: '8px 12px', cursor: 'pointer' } as const;
const dangerButton = { ...secondaryButton, color: '#dc2626' } as const;
const errorBox = { marginTop: 12, border: '1px solid #fecaca', borderRadius: 14, background: '#fef2f2', color: '#991b1b', padding: 12, fontSize: 13 } as const;
