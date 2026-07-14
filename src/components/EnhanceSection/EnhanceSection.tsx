import Card from 'react-bootstrap/Card'
import { Col, Form, Row } from 'react-bootstrap'
import { useState } from "react";
import { CardHeader } from '../CardHeader/CardHeader';

type EnhanceSectionProps = {
  onEnhance: (instructions: string) => void;
  onCancel: () => void;
  fetchError?: string | null;
};

export function EnhanceSection({
  onEnhance,
  onCancel,
  fetchError,
}: EnhanceSectionProps) {
  const [text, setText] = useState("");
  const [isEnhancing, setIsEnhancing] = useState(false);

  function handleSubmit() {
    if (!text.trim()) return;
    setIsEnhancing(true);
    onEnhance(text);
    setText("");
    setIsEnhancing(false);
  }

  return (
    <Card>
      <Card.Header>
        <CardHeader
          number="3"
          title="Enhance or modify a view"
          description="Refine the generated view. Request layout changes, new features, or styling adjustments."
        />
      </Card.Header>
      <Card.Body>
        <Row>
          <Col>
            <Form.Group className="mb-3">
              <Form.Label className="sr-only" htmlFor="enhance-prompt">
                Enhancement instructions
              </Form.Label>
              <div className="dc-textarea-wrapper">
                <Form.Control
                  as="textarea"
                  id="enhance-prompt"
                  className="dc-textarea"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={7}
                  placeholder="Example: Add ingredient icons, show selected items as SVG, and include a price summary."
                  disabled={isEnhancing}
                />
              </div>
            </Form.Group>
          </Col>
        </Row>

        {fetchError && <div className="bs-error mb-2">{fetchError}</div>}

        <Row className="dc-footer align-items-center mt-3 justify-content-between">
          <Col xs={3}>
            <p className="dc-footer-note mb-2">
              Generated app runs in an isolated workspace.
            </p>
          </Col>
          <Col xs={5} className="text-end">
            <div className="d-flex gap-2 justify-content-end">
              <button
                className="gv-pill gv-pill-secondary red-btn mr-2"
                onClick={onCancel}
                disabled={isEnhancing}
              >
                Cancel
              </button>
              <button
                className="gv-pill gv-pill-primary green-btn"
                onClick={handleSubmit}
                disabled={isEnhancing || !text.trim()}
              >
                {isEnhancing ? "Enhancing…" : "Enhance ↗"}
              </button>
            </div>
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}