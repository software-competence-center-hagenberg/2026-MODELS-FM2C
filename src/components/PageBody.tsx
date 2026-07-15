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

  function handleJobCreated(view: Record<string, unknown>) {
    setFetchError(null);
    setActiveJob(view as GeneratedView);
  }

  function handleEdit(view: GeneratedView) {
    setActiveJob(view);
  }

  function handleEnhance(instructions: string) {
    setFetchError(null);
    fetch("/api/generation-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: instructions,
        enhanceJob: activeJob?.id,
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Enhancement request failed.");
        return response.json();
      })
      .then((view) => setActiveJob(view as GeneratedView))
      .catch((caught) =>
        setFetchError(caught instanceof Error ? caught.message : String(caught))
      );
  }

  function handleCancelEnhance() {
    setActiveJob(null);
  }

  return (
    <Container fluid className='page'>
      <Row className='app-heading'>fm2c Playground</Row>
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
          <BuildStatusContainer initialJob={activeJob} />
        </Col>
      </Row>
      <Row className=''>
        <Col className='body-column'>
          <GeneratedViewsContainer
            selectedViewId={activeJob?.id}
            onEdit={handleEdit}
            onError={setFetchError}
          />
        </Col>
      </Row>
    </Container>
  );
}