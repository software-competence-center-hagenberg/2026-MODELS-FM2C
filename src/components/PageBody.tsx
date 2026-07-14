import { Container, Row, Col } from 'react-bootstrap'
import { useState } from "react";
import { BuildStatusContainer } from "./BuildStatusContainer"
import { DescriptionContainer } from "./DescriptionContainer"
import { GeneratedViewsContainer } from "./GeneratedViewsContainer"
import type { GeneratedView} from "./GeneratedViewsContainer";
import './Style.css'

export function PageBody() {
  const [busy, setBusy] = useState(false);
  const [activeJob, setActiveJob] = useState<GeneratedView | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  function handleJobCreated(view: Record<string, unknown>) {
    setFetchError(null); // Clear fetch error when a new job starts
    setActiveJob(view as GeneratedView);
  }

  function handleEdit(view: GeneratedView) {
    setActiveJob(view);
  }

  return (
    <Container fluid>
      <Row className='app-heading'>fm2c Playground</Row>
      <Row className="mb-4 row-equal-height">
        <Col>
          <DescriptionContainer
            busy={busy}
            setBusy={setBusy}
            onJobCreated={handleJobCreated}
            onMessage={() => {}}
            fetchError={fetchError}
          />
        </Col>
        <Col>
          <BuildStatusContainer initialJob={activeJob} />
        </Col>
      </Row>
      <Row>
        <Col>
          <GeneratedViewsContainer 
            onEdit={handleEdit} 
            onError={setFetchError} 
          />
        </Col>
      </Row>
    </Container>
  );
}