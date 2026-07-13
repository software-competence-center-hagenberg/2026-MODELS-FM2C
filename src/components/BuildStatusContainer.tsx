import Card from 'react-bootstrap/Card'
import Form from 'react-bootstrap/Form'
import { Col, Row } from 'react-bootstrap'
import { useEffect, useMemo, useRef, useState } from "react";
import { CardHeader } from './CardHeader';
import { MilestoneProgressBar } from './MilestoneProgressBar/MilestoneProgressBar';

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

type JobEvent = {
  status?: GeneratedStatus;
  message?: string;
  view?: GeneratedView | null;
};

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

const ANSI_ESCAPE = String.fromCharCode(27);

type BuildStatusContainerProps = {
  initialJob: GeneratedView | null;
};

export function BuildStatusContainer({ initialJob }: BuildStatusContainerProps) {
  const [activeJob, setActiveJob] = useState<GeneratedView | null>(initialJob);
  const [events, setEvents] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [enhanceText, setEnhanceText] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!initialJob) return;
    setActiveJob(initialJob);
    setEvents([]);
    sseCleanupRef.current?.();
    sseCleanupRef.current = listenForJob(initialJob.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJob?.id]);

  useEffect(() => {
    return () => {
      sseCleanupRef.current?.();
      sseCleanupRef.current = null;
    };
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status, previewLoading, previewUrl]);

  const isEnhancingFlow = useMemo(
    () => activeJob?.status && ENHANCE_PROGRESS.includes(activeJob.status),
    [activeJob?.status],
  );

  const currentSteps = isEnhancingFlow ? ENHANCE_PROGRESS : PROGRESS;
  const totalSteps = currentSteps.length;

  const currentStepIndex = useMemo(() => {
    if (!activeJob) return -1;
    return isEnhancingFlow
      ? ENHANCE_PROGRESS.indexOf(activeJob.status)
      : PROGRESS.indexOf(activeJob.status);
  }, [activeJob, isEnhancingFlow]);

  const progressPercent = currentStepIndex >= 0
    ? Math.round(((currentStepIndex + 1) / totalSteps) * 100)
    : 0;

  const milestones = useMemo(() => {
    return currentSteps.map((status, index) => ({
      percentage: Math.round((index / (totalSteps - 1)) * 100),
      label: PROGRESS_LABELS[status],
    }));
  }, [currentSteps, totalSteps]);

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
    return () => source.close();
  }

  function applyJobEvent(raw: string) {
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as JobEvent;
      if (payload.message) {
        const message = normaliseActivityMessage(payload.message);
        if (message) {
          setEvents((current) =>
            current[0] === message
              ? current
              : [message, ...current].slice(0, 80),
          );
        }
      }
      if (payload.view) {
        setActiveJob(payload.view as GeneratedView);
      }
    } catch {
      // Ignore malformed event payloads
    }
  }

  async function refreshSingleJob(id: string) {
    try {
      const response = await fetch(`/api/generation-jobs/${id}`);
      if (!response.ok) return;
      const view = (await response.json()) as GeneratedView;
      setActiveJob(view);
    } catch {
      // Keep the last known status in place.
    }
  }

  async function triggerPreview(id: string) {
    setPreviewLoading(true);
    setPreviewUrl(null);
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
    } catch {
      // Silently fail
    } finally {
      setPreviewLoading(false);
    }
  }

  async function enhanceJob(id: string) {
    if (!enhanceText.trim()) return;
    setEnhancing(true);
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
      sseCleanupRef.current?.();
      sseCleanupRef.current = listenForJob(view.id);
    } catch {
      // Silently fail
    } finally {
      setEnhancing(false);
    }
  }

  const isError = activeJob?.status === "error";

  return (
    <Card>
      <Card.Header className="bs-header">
        <CardHeader number="2" title="Build Status" description='' />
      </Card.Header>
      <Card.Body>

        {/* 1. Job Info - Only when active */}
        {activeJob && (
          <Row>
            <Col>
              <div className="bs-job-card">
                <p className="bs-active-job">{activeJob.title}</p>
                <p className="bs-job-id">{activeJob.id}</p>
              </div>
            </Col>
          </Row>
        )}

        {/* 2. Progress Bar - Only when active */}
        {activeJob && (
          <Row>
            <Col>
              <MilestoneProgressBar
                value={progressPercent}
                milestones={milestones}
                progressColor={isError ? 'var(--c-error)' : 'var(--c-green)'}
              />
            </Col>
          </Row>
        )}

        {/* Empty state - Only when no active job */}
        {!activeJob && (
          <Row>
            <Col>
              <p className="bs-empty">
                No active job yet. Create one and you'll see the progress here
                in real time.
              </p>
            </Col>
          </Row>
        )}

        {/* 3. Actions - Only when active */}
        {activeJob && (
          <Row>
            <Col>
              <div className="bs-actions">
                {activeJob.status === "ready" && (
                  <a
                    href={activeJob.public_url}
                    target="_blank"
                    rel="noreferrer"
                    className="gv-pill gv-pill-primary bs-btn-open"
                  >
                    Open {activeJob.public_url}
                  </a>
                )}
                {(activeJob.status === "generating" ||
                  activeJob.status === "validating" ||
                  activeJob.status === "building") && (
                  <button
                    onClick={() => void triggerPreview(activeJob.id)}
                    disabled={previewLoading}
                    className="gv-pill gv-pill-primary"
                  >
                    {previewLoading
                      ? "Loading preview…"
                      : previewUrl
                        ? "Update preview"
                        : "Show preview"}
                  </button>
                )}

                {/* Button Group: Short Preview & Refresh Status */}
                <div className="d-flex gap-2 mt-3">
                  <button
                    onClick={() => console.log("Short preview triggered")}
                    className="gv-pill gv-pill-secondary base-margin"
                  >
                    Short preview
                  </button>
                  <button
                    onClick={() => void refreshSingleJob(activeJob.id)}
                    className="gv-pill gv-pill-secondary base-margin"
                  >
                    Refresh status
                  </button>
                </div>
              </div>
            </Col>
          </Row>
        )}

        {/* 4. Enhance - Only when ready */}
        {activeJob?.status === "ready" && (
          <Row>
            <Col>
              <div className="bs-enhance">
                <div className="bs-enhance-header">
                  <p className="bs-enhance-hint">Ask for changes or enhancements and regenerate:</p>
                </div>
                <Form.Control
                  as="textarea"
                  className="dc-textarea"
                  value={enhanceText}
                  onChange={(e) => setEnhanceText(e.target.value)}
                  rows={4}
                  placeholder="Example: Add ingredient icons, show selected items as SVG, and include a price summary."
                  style={{ resize: 'none' }}
                />
                <button
                  className="gv-pill gv-pill-dark bs-enhance-btn"
                  onClick={() => void enhanceJob(activeJob.id)}
                  disabled={enhancing || !enhanceText.trim()}
                >
                  {enhancing ? "Enhancing…" : "Enhance view"}
                </button>
              </div>
            </Col>
          </Row>
        )}

        {/* 5. Preview - Only when preview URL exists */}
        {previewUrl && (
          <Row>
            <Col>
              <div className="bs-preview">
                <div className="bs-preview-header">
                  <strong className="bs-preview-title">Live preview</strong>
                  <button
                    className="gv-pill gv-pill-secondary bs-preview-close"
                    onClick={() => setPreviewUrl(null)}
                  >
                    Close
                  </button>
                </div>
                <iframe
                  title="Preview of generated view"
                  src={previewUrl}
                  sandbox="allow-scripts"
                  className="bs-preview-iframe"
                />
              </div>
            </Col>
          </Row>
        )}

        {/* 6. Error Message - Only when error exists */}
        {activeJob?.error_message && (
          <Row>
            <Col>
              <div className="bs-error">Build failed: {activeJob.error_message}</div>
            </Col>
          </Row>
        )}

        {/* 7. Activity Log - Always visible */}
        <div className="bs-events-panel">
          <strong className="bs-events-title">Activity log</strong>
          <ul className="bs-events-list">
            {events.map((event, index) => (
              <li key={`${event}-${index}`}>{event}</li>
            ))}
          </ul>
        </div>
      </Card.Body>
    </Card>
  );
}

function normaliseActivityMessage(message: string) {
  const clean = message
    .replaceAll(ANSI_ESCAPE, "")
    .replace(/\[[0-9;]*m/g, "")
    .trim();
  if (!clean) return null;
  if (clean.startsWith(">")) return null;
  if (clean === "AI generation in progress — running opencode agent.") return null;
  return clean;
}