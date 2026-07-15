import { Container, Row, Col } from 'react-bootstrap'
import { useState } from "react";
import { BuildStatusContainer } from "./BuildStatusContainer/BuildStatusContainer"
import { DescriptionContainer } from "./DescriptionContainer/DescriptionContainer"
import { EnhanceSection } from "./EnhanceSection/EnhanceSection"
import { GeneratedViewsContainer } from "./GeneratedViewsContainer/GeneratedViewsContainer"
import type { GeneratedView } from "./GeneratedViewsContainer/GeneratedViewsContainer";
import './Style.css'

export function PageBody() {
  const [busy, setBusy] = useState(false);
  const [activeJob, setActiveJob] = useState<GeneratedView | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function refreshViewsList() {
    setRefreshKey((k) => k + 1);
  }

  function handleJobCreated(view: Record<string, unknown>) {
    setFetchError(null);
    setActiveJob(view as GeneratedView);
    refreshViewsList();
  }

  function handleEdit(view: GeneratedView) {
    setFetchError(null);
    setActiveJob(view);
  }

  function handleEnhance(instructions: string) {
    if (!activeJob) return;

    setFetchError(null);
    setBusy(true);

    fetch(`/api/generation-jobs/${activeJob.id}/enhance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((err) => {
            throw new Error(err.error ?? "Enhancement request failed.");
          });
        }
        return response.json();
      })
      .then((view) => {
        setActiveJob(view as GeneratedView);
        refreshViewsList();
        setBusy(false);
      })
      .catch((caught) => {
        setFetchError(caught instanceof Error ? caught.message : String(caught));
        setBusy(false);
      });
  }

  function handleJobUpdate(_view: GeneratedView) {
    // BuildStatusContainer received an SSE update — refresh the views list
    // so the changes are reflected in GeneratedViewsContainer
    refreshViewsList();
  }

  function handleCancelEnhance() {
    setActiveJob(null);
  }

  return (
    <Container fluid className='page'>
      <Row className="row-equal-height">
        <Col className='body-column'>
          {activeJob ? (
            <EnhanceSection
              onEnhance={handleEnhance}
              onCancel={handleCancelEnhance}
              fetchError={fetchError}
            />
          ) : (
            <DescriptionContainer
              busy={busy}
              setBusy={setBusy}
              onJobCreated={handleJobCreated}
              onMessage={() => {}}
              fetchError={fetchError}
            />
          )}
        </Col>
        <Col className='body-column'>
          <BuildStatusContainer
            initialJob={activeJob}
            onJobUpdate={handleJobUpdate}
          />
        </Col>
      </Row>
      <Row className=''>
        <Col className='body-column'>
          <GeneratedViewsContainer
            key={refreshKey}
            selectedViewId={activeJob?.id}
            onEdit={handleEdit}
            onError={setFetchError}
          />
        </Col>
      </Row>
    </Container>
  );
}