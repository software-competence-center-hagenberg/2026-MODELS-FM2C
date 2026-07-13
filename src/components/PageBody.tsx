import { Container, Row, Col } from 'react-bootstrap'
import { useState } from "react";
import { BuildStatusContainer } from "./BuildStatusContainer"
import { DescriptionContainer } from "./DescriptionContainer"
import { GeneratedViewsContainer } from "./GeneratedViewsContainer"
import type { GeneratedView, GeneratedStatus } from "./GeneratedViewsContainer";
import './Style.css'

export function PageBody() {
  const [busy, setBusy] = useState(false);
  const [activeJob, setActiveJob] = useState<GeneratedView | null>(null);

  function handleJobCreated(view: Record<string, unknown>) {
    setActiveJob(view as GeneratedView);
  }

  function handleEdit(view: GeneratedView) {
    setActiveJob(view);
  }

  return (
    <Container fluid>
      <Row className="mb-4">
        <Col>
          <DescriptionContainer
            busy={busy}
            setBusy={setBusy}
            onJobCreated={handleJobCreated}
            onMessage={() => {}}
          />
        </Col>
        <Col>
          <BuildStatusContainer initialJob={activeJob} />
        </Col>
      </Row>
      <Row>
        <Col>
          <GeneratedViewsContainer onEdit={handleEdit} />
        </Col>
      </Row>
    </Container>
  );
}