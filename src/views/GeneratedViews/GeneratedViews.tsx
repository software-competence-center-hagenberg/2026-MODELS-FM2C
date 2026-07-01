import { useEffect, useMemo, useRef, useState } from "react";

type GeneratedStatus =
  | "queued"
  | "preparing"
  | "generating"
  | "validating"
  | "building"
  | "publishing"
  | "enhancing"
  | "ready"
  | "error";

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
const PROGRESS: GeneratedStatus[] = [
  "queued",
  "preparing",
  "generating",
  "validating",
  "building",
  "publishing",
  "ready",
];
const ENHANCE_PROGRESS: GeneratedStatus[] = [
  "enhancing",
  "validating",
  "building",
  "publishing",
  "ready",
];
const PROGRESS_LABELS: Record<GeneratedStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  generating: "Generating",
  validating: "Validating",
  building: "Building",
  publishing: "Publishing",
  enhancing: "Enhancing",
  ready: "Ready",
  error: "Error",
};
const ACCEPTED_FILES =
  ".ini,.txt,.md,.json,.yaml,.yml,.csv,.png,.jpg,.jpeg,.svg";
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
  const [enhanceText, setEnhanceText] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const isEnhancingFlow = useMemo(
    () => activeJob?.status && ENHANCE_PROGRESS.includes(activeJob.status),
    [activeJob?.status],
  );
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
      const response = await fetch("/api/views");
      if (!response.ok)
        throw new Error(
          "The generator API is not available. Start it with npm run server.",
        );
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
      const response = await fetch("/api/generation-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, files: uploadPayload }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "Could not create generation job.");
      }
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
      setViews((current) => [
        view,
        ...current.filter((item) => item.id !== view.id),
      ]);
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
      source.addEventListener(status, (event) =>
        applyJobEvent((event as MessageEvent<string>).data),
      );
    }
    source.addEventListener("error", (event) => {
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
      if (payload.message)
        setEvents((current) =>
          [payload.message ?? "", ...current].slice(0, 80),
        );
      if (payload.view) {
        setActiveJob(payload.view);
        setViews((current) => [
          payload.view as GeneratedView,
          ...current.filter((item) => item.id !== payload.view?.id),
        ]);
      }
      if (payload.status === "ready" || payload.status === "error")
        void refreshViews();
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
      setViews((current) => [
        view,
        ...current.filter((item) => item.id !== view.id),
      ]);
    } catch {
      // Keep the last known status in place.
    }
  }


  async function triggerPreview(id: string) {
    setPreviewLoading(true);
    setPreviewUrl(null);
    setError(null);
    try {
      const response = await fetch(`/api/generation-jobs/${id}/preview`, {
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "Could not create preview.");
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
      setError("Please describe how you'd like to enhance the view.");
      return;
    }
    setEnhancing(true);
    setError(null);
    try {
      const response = await fetch(`/api/generation-jobs/${id}/enhance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: enhanceText.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "Could not enhance view.");
      }
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
      setViews((current) => [
        view,
        ...current.filter((item) => item.id !== view.id),
      ]);
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
    setEnhanceText("");
  }, [activeJob?.id]);

  useEffect(() => {
    if (!activeJob || previewUrl || previewLoading) return;
    if (
      activeJob.status === "generating" ||
      activeJob.status === "validating" ||
      activeJob.status === "building"
    ) {
      void triggerPreview(activeJob.id);
    }
    // triggerPreview is intentionally not a dependency; this should only react to job/status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status, previewLoading, previewUrl]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <>
      <style>{`
      .gv-pill {
        border-radius: 0;
        transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
        outline: none;
      }
      .gv-pill:hover:not(:disabled) {
        transform: translateY(-1px);
      }
      .gv-pill-primary {
        background: #000 !important;
        color: #fff !important;
        border-color: #000 !important;
      }
      .gv-pill-primary:hover:not(:disabled) {
        background: #222 !important;
        border-color: ${BORDER} !important;
      }
      .gv-pill-secondary {
        background: #fff !important;
        color: #000 !important;
        border-color: ${BORDER} !important;
      }
      .gv-pill-secondary:hover:not(:disabled) {
        background: ${BORDER} !important;
        color: #000 !important;
      }
      .gv-pill-dark {
        background: #000 !important;
        color: #fff !important;
        border-color: #000 !important;
      }
      .gv-pill-dark:hover:not(:disabled) {
        background: #222 !important;
        border-color: ${BORDER} !important;
      }
      .gv-pill-danger {
        background: #fff !important;
        color: #000 !important;
        border-color: #000 !important;
      }
      .gv-pill-danger:hover:not(:disabled) {
        background: #000 !important;
        color: #fff !important;
      }
    `}</style>
      <div
        style={{
          minHeight: "100vh",
          background: "#e5e5e5",
          padding: "32px 24px",
          color: "#000",
        }}
      >
        <div
          style={{ maxWidth: 1400, margin: "0 auto", display: "grid", gap: 32 }}
        >
          <section>
            <p style={eyebrow}>Generated views</p>
            <h1
              style={{
                margin: "8px 0",
                fontSize: 36,
                fontWeight: 800,
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
              }}
            >
              Generate standalone configurator pages from a short brief.
            </h1>
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 16,
                lineHeight: 1.6,
                color: "#444",
              }}
            >
              FM2C creates isolated React views, validates the generated code
              and makes it accessible for everyone.
            </p>
          </section>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}
          >
            {/* Step 1 — Describe */}
            <section style={card}>
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                }}
              >
                1. Describe the configurator
              </h2>
              <p
                style={{
                  margin: "0 0 16px",
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: "#444",
                }}
              >
                Write what the generated view should do. Add supporting files or
                settings when needed.
              </p>

              <label
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  overflow: "hidden",
                  clip: "rect(0,0,0,0)",
                }}
                htmlFor="gen-prompt"
              >
                Configurator description
              </label>
              <textarea
                id="gen-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={10}
                style={textarea}
                placeholder="Example: Create a product configurator with ingredient selection, pricing, SVG preview, and summary checkout."
              />
              <label style={uploadBox}>
                <input
                  type="file"
                  multiple
                  accept={ACCEPTED_FILES}
                  onChange={(event) =>
                    setFiles(Array.from(event.target.files ?? []))
                  }
                  style={{ display: "none" }}
                />
                <p style={{ margin: 0, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  Add documentation or settings
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 13, color: "#444" }}>
                  {files.length > 0
                    ? files.map((f) => f.name).join(", ")
                    : "Supports ini, txt, md, json, yaml, csv, images, and svg."}
                </p>
              </label>
              {error && <div style={errorBox}>{error}</div>}

              <div
                style={{
                  marginTop: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <p style={{ margin: 0, fontSize: 12, color: "#444" }}>
                  Generated app runs in an isolated workspace.
                </p>
                <button
                  onClick={submitJob}
                  disabled={busy || prompt.trim().length === 0}
                  className="gv-pill gv-pill-primary"
                  style={pillPrimary}
                >
                  {busy ? "Creating job…" : "Generate view"}
                </button>
              </div>
            </section>

            {/* Step 2 — Build status */}
            <section style={card}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 16,
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: 18,
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                  }}
                >
                  2. Build status
                </h2>
                {activeJob && <StatusPill status={activeJob.status} />}
              </div>

              {!activeJob ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    color: "#444",
                    lineHeight: 1.6,
                  }}
                >
                  No active job yet. Create one and you'll see the progress here
                  in real time.
                </p>
              ) : (
                <>
                  {/* Job card */}
                  <div style={{ border: `1px solid ${BORDER}`, padding: 20 }}>
                    <h3
                      style={{
                        margin: "0 0 4px",
                        fontSize: 16,
                        fontWeight: 700,
                        lineHeight: 1.35,
                        maxWidth: 480,
                      }}
                    >
                      {activeJob.title}
                    </h3>
                    <p
                      style={{
                        margin: 0,
                        fontFamily: "monospace",
                        fontSize: 12,
                        color: "#444",
                      }}
                    >
                      {activeJob.id}
                    </p>
                    {/* Labeled progress bar */}
                    <div style={{ marginTop: 24 }}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: `repeat(${isEnhancingFlow ? ENHANCE_PROGRESS.length : PROGRESS.length}, 1fr)`,
                          gap: 6,
                        }}
                      >
                        {(isEnhancingFlow ? ENHANCE_PROGRESS : PROGRESS).map(
                          (status, index) => {
                            const step = isEnhancingFlow
                              ? enhanceActiveStep
                              : activeStep;
                            const done = index <= step;
                            const current = index === step;
                            return (
                              <div key={status}>
                                <div
                                  style={{
                                    height: 4,
                                    background: done
                                      ? current
                                        ? "#000"
                                        : "#333"
                                      : "#ddd",
                                    transition: "background 0.3s",
                                  }}
                                />
                                <p
                                  style={{
                                    margin: "6px 0 0",
                                    textAlign: "center",
                                    fontSize: 11,
                                    fontWeight: current ? 700 : 400,
                                    color: done ? "#000" : "#999",
                                  }}
                                >
                                  {PROGRESS_LABELS[status] ?? status}
                                </p>
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div
                      style={{
                        marginTop: 24,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 10,
                      }}
                    >
                      {activeJob.status === "ready" && (
                        <a
                          href={activeJob.public_url}
                          target="_blank"
                          rel="noreferrer"
                          className="gv-pill gv-pill-primary"
                          style={{
                            ...pillPrimary,
                            textDecoration: "none",
                            display: "inline-flex",
                          }}
                        >
                          Open {activeJob.public_url}
                        </a>
                      )}
                      {activeJob.status === "generating" ||
                      activeJob.status === "validating" || activeJob.status === "building" ? (
                        <button
                          onClick={() => void triggerPreview(activeJob.id)}
                          disabled={previewLoading}
                          className="gv-pill gv-pill-primary"
                          style={pillPrimary}
                        >
                          {previewLoading
                            ? "Loading preview…"
                            : previewUrl
                              ? "Update preview"
                              : "Show preview"}
                        </button>
                      ) : null}
                      <button
                        onClick={() => void refreshSingleJob(activeJob.id)}
                        className="gv-pill gv-pill-secondary"
                        style={pillSecondary}
                      >
                        Refresh status
                      </button>
                    </div>
                  </div>{" "}
                  {/* close job card */}
                  {/* Enhance section */}
                  {activeJob.status === "ready" && (
                    <div
                      style={{
                        marginTop: 20,
                        border: `1px solid ${BORDER}`,
                        padding: 20,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 12,
                        }}
                      >
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>
                          Enhance this view
                        </p>
                        <p style={{ margin: 0, fontSize: 12, color: "#444" }}>
                          Ask for changes and regenerate
                        </p>
                      </div>
                      <textarea
                        value={enhanceText}
                        onChange={(event) => setEnhanceText(event.target.value)}
                        rows={4}
                        style={{ ...textarea, marginBottom: 10 }}
                        placeholder="Example: Add ingredient icons, show selected items as SVG, and include a price summary."
                      />
                      <button
                        onClick={() => void enhanceJob(activeJob.id)}
                        disabled={enhancing || !enhanceText.trim()}
                        className="gv-pill gv-pill-dark"
                        style={{
                          ...pillDark,
                          opacity: enhancing || !enhanceText.trim() ? 0.6 : 1,
                          marginTop: 12,
                        }}
                      >
                        {enhancing ? "Enhancing…" : "Enhance view"}
                      </button>
                    </div>
                  )}
                  {/* Preview iframe */}
                  {previewUrl && (
                    <div style={{ marginTop: 18 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <strong style={{ fontSize: 13 }}>Live preview</strong>
                        <button
                          onClick={() => setPreviewUrl(null)}
                          className="gv-pill gv-pill-secondary"
                          style={{
                            ...pillSecondary,
                            padding: "4px 10px",
                            fontSize: 11,
                          }}
                        >
                          Close
                        </button>
                      </div>
                      <iframe
                        title="Preview of generated view"
                        src={previewUrl}
                        sandbox="allow-scripts"
                        style={{
                          width: "100%",
                          height: 420,
                          border: `1px solid ${BORDER}`,
                          background: "#fff",
                        }}
                      />
                    </div>
                  )}
                  {/* Error */}
                  {activeJob.error_message && (
                    <div style={errorBox}>
                      Build failed: {activeJob.error_message}
                    </div>
                  )}
                  {/* Event log */}
                  {events.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <strong
                        style={{
                          fontSize: 11,
                          color: "#444",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontWeight: 700,
                        }}
                      >
                        Activity log
                      </strong>
                      <ul
                        style={{
                          margin: "8px 0 0",
                          paddingLeft: 18,
                          color: "#444",
                          fontSize: 13,
                          maxHeight: 320,
                          overflow: "auto",
                        }}
                      >
                        {events.map((event, index) => (
                          <li key={`${event}-${index}`}>{event}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          {/* ─── Generated views list ─── */}
          <section style={card}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                alignItems: "flex-start",
                marginBottom: 20,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                  Generated views
                </h2>
                <p style={{ margin: "6px 0 0", fontSize: 13, color: "#444" }}>
                  Public preview links for generated configurators.
                </p>
              </div>
              <button
                onClick={() => void refreshViews()}
                className="gv-pill gv-pill-secondary"
                style={pillSecondary}
              >
                Refresh list
              </button>
            </div>
            {views.length === 0 ? (
              <p style={{ margin: 0, fontSize: 14, color: "#444" }}>
                No generated views yet.
              </p>
) : (
              <>
                {/* Search bar */}
                <div style={{ position: "relative", marginBottom: 16 }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 14,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 16,
                      color: "#444",
                      pointerEvents: "none",
                      userSelect: "none",
                    }}
                  >
                    🔍
                  </span>
                  <input
                    type="text"
                    placeholder="Search views by title or URL…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      border: `1px solid ${BORDER}`,
                      padding: "10px 14px 10px 38px",
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#000",
                      background: "#fff",
                      outline: "none",
                      boxSizing: "border-box",
                      fontFamily: "inherit",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "#000";
                      e.currentTarget.style.boxShadow = `0 0 0 2px ${BORDER}40`;
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = BORDER;
                      e.currentTarget.style.boxShadow = "none";
                    }}
                  />
                </div>
                <div style={{ display: "grid", gap: 12 }}>
                  {views
                    .filter((view) => {
                      if (!searchQuery.trim()) return true;
                      const q = searchQuery.toLowerCase();
                      return (
                        view.title.toLowerCase().includes(q) ||
                        view.public_url.toLowerCase().includes(q) ||
                        view.id.toLowerCase().includes(q) ||
                        (view.error_message ?? "").toLowerCase().includes(q)
                      );
                    })
                    .map((view) => (
                  <article
                    key={view.id}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                      border: `1px solid ${BORDER}`,
                      padding: "14px 20px",
                      transition: "border-color 0.2s, background 0.2s",
                      cursor: "default",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#000";
                      e.currentTarget.style.background = "#f5f5f5";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = BORDER;
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <h3
                          style={{ margin: 0, fontWeight: 700, fontSize: 15 }}
                        >
                          {view.title}
                        </h3>
                        <StatusPill status={view.status} />
                      </div>
                      <p
                        style={{
                          margin: "6px 0 0",
                          fontSize: 13,
                          color: "#444",
                        }}
                      >
                        {view.description}
                      </p>
                      <p
                        style={{
                          margin: "8px 0 0",
                          fontFamily: "monospace",
                          fontSize: 12,
                          color: "#444",
                        }}
                      >
                        {view.public_url}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button
                        onClick={() => setActiveJob(view)}
                        className="gv-pill gv-pill-secondary"
                        style={pillSecondary}
                      >
                        Edit
                      </button>
                      {view.status === "ready" && (
                        <a
                          href={view.public_url}
                          target="_blank"
                          rel="noreferrer"
                          className="gv-pill gv-pill-primary"
                          style={{
                            ...pillPrimary,
                            textDecoration: "none",
                            display: "inline-flex",
                          }}
                        >
                          Open
                        </a>
                      )}
                    </div>
                    {view.status === "ready" && activeJob?.id === view.id && (
                      <iframe
                        title={`Preview of ${view.title}`}
                        src={view.public_url}
                        sandbox="allow-scripts"
                        style={{
                          width: "100%",
                          minHeight: 520,
                          border: `1px solid ${BORDER}`,
                          background: "#fff",
                        }}
                      />
                    )}
                  </article>
                ))}
                {views.length > 0 &&
                views.filter((view) => {
                  if (!searchQuery.trim()) return true;
                  const q = searchQuery.toLowerCase();
                  return (
                    view.title.toLowerCase().includes(q) ||
                    view.public_url.toLowerCase().includes(q) ||
                    view.id.toLowerCase().includes(q)
                  );
                }).length === 0 ? (
                  <p
                    style={{
                      margin: "24px 0 0",
                      fontSize: 14,
                      color: "#444",
                      textAlign: "center",
                    }}
                  >
                    No views match {'"'}{searchQuery}{'"'}
                  </p>
                ) : null}
              </div>
            </>)}
          </section>
        </div>
        <footer
          style={{
            maxWidth: 1400,
            margin: "32px auto 0",
            padding: "16px 0",
            borderTop: `1px solid ${BORDER}`,
            textAlign: "center",
            fontSize: 12,
            fontWeight: 700,
            color: "#666",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          MODEL Demo 2026 by SCCH
        </footer>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: GeneratedStatus }) {
  const isReady = status === "ready";
  const isError = status === "error";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${isError ? "#fff" : isReady ? BORDER : "#fff"}`,
        padding: "4px 10px",
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        background: isReady ? "#e6ffe6" : "transparent",
        color: "#000",
      }}
    >
      {status}
    </span>
  );
}

async function readUploadPayloads(files: File[]): Promise<UploadPayload[]> {
  const allowed = files.slice(0, 8);
  return Promise.all(
    allowed.map(async (file) => {
      const isBinary = file.type.startsWith("image/");
      let content: string;
      if (isBinary) {
        const buffer = await file.arrayBuffer();
        content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      } else {
        content = await file.text();
      }
      return {
        name: file.name,
        type: file.type || "text/plain",
        content,
      };
    }),
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const BORDER = "#00e600";

const card = {
  background: "#fff",
  color: "#000",
  border: `1px solid ${BORDER}`,
  padding: 24,
} as const;

const eyebrow = {
  color: "#000",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
} as const;
const textarea = {
  width: "100%",
  border: `1px solid ${BORDER}`,
  padding: 14,
  resize: "vertical",
  font: "inherit",
  color: "#000",
  outline: "none",
  background: "#fff",
} as const;
const uploadBox = {
  marginTop: 12,
  border: `1px dashed ${BORDER}`,
  padding: 16,
  display: "grid",
  gap: 4,
  cursor: "pointer",
  background: "#fff",
} as const;
const pillPrimary = {
  border: "3px solid #000",
  background: "#000",
  color: "#fff",
  fontWeight: 700,
  fontSize: 14,
  padding: "10px 20px",
  cursor: "pointer",
  alignItems: "center",
  justifyContent: "center",
  letterSpacing: "0.02em",
} as const;
const pillSecondary = {
  border: `1px solid ${BORDER}`,
  background: "#fff",
  color: "#000",
  fontWeight: 700,
  fontSize: 14,
  padding: "10px 20px",
  cursor: "pointer",
  letterSpacing: "0.02em",
} as const;
const pillDark = {
  border: "3px solid #000",
  background: "#000",
  color: "#fff",
  fontWeight: 700,
  fontSize: 14,
  padding: "10px 20px",
  cursor: "pointer",
  letterSpacing: "0.02em",
} as const;
const errorBox = {
  marginTop: 12,
  border: "1px solid #000",
  background: "#fff",
  color: "#000",
  padding: 12,
  fontSize: 13,
} as const;
