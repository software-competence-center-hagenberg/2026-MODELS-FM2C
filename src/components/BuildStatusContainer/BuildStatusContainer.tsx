import Card from 'react-bootstrap/Card'
import { OverlayTrigger, Tooltip, Col, Row } from 'react-bootstrap';
import { useEffect, useMemo, useRef, useState } from "react";
import { CardHeader } from '../CardHeader/CardHeader';
import { MilestoneProgressBar } from '../MilestoneProgressBar/MilestoneProgressBar';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons';

import './BuildStatusContainer.css';

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
  const sseCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!initialJob) return;
    setActiveJob(initialJob);
    setEvents([]);
    sseCleanupRef.current?.();
    sseCleanupRef.current = listenForJob(initialJob.id);
    // eslint-disable-next-line react-hooks/exhaustible-deps
  }, [initialJob?.id]);

  useEffect(() => {
    return () => {
      sseCleanupRef.current?.();
      sseCleanupRef.current = null;
    };
  }, []);

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

  const isError = activeJob?.status === "error";

  return (
    <Card>
      <Card.Header className="bs-header">
        <CardHeader
          number="2"
          title="Build status"
          description={
            activeJob
              ? `Currently viewing ${activeJob.id}`
              : "No view selected. Create one and you'll see the progress here in real time."
          }
        />
      </Card.Header>
      <Card.Body>

        {activeJob && (
          <Row>
            <Col>
              <div className="bs-job-card">
                <p className="bs-active-job">{activeJob.title}</p>
              </div>
            </Col>
          </Row>
        )}

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

        {activeJob && (
          <Row>
            <Col>
              <div className="bs-actions">
                <div className="d-flex gap-2 mt-3">
                  <button
                    onClick={() => void refreshSingleJob(activeJob.id)}
                    className="gv-pill gv-pill-secondary base-margin"
                  >
                    Refresh status <FontAwesomeIcon icon={faArrowRotateRight} />
                  </button>
                </div>
              </div>
            </Col>
          </Row>
        )}

        {activeJob?.error_message && (
          <Row>
            <Col>
              <div className="bs-error">Build failed: {activeJob.error_message}</div>
            </Col>
          </Row>
        )}

        <div className="bs-events-panel">
          <strong className="bs-events-title">
            Activity log
            <OverlayTrigger
              placement="top"
              trigger="hover"
              overlay={
                <Tooltip id="activity-log-tooltip">
                  Displays real-time build steps, warnings, and errors.
                </Tooltip>
              }
            >
              <FontAwesomeIcon
                icon={faCircleQuestion}
                style={{ marginLeft: '0.3rem', marginBottom: '0.2rem', cursor: 'help', verticalAlign: 'middle' }}
              />
            </OverlayTrigger>
          </strong>
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