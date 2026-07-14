import Card from 'react-bootstrap/Card'
import { Col, Form, Row } from 'react-bootstrap'
import { useState } from "react";
import { CardHeader } from './CardHeader';

const ACCEPTED_FILES =
  ".ini,.txt,.md,.json,.yaml,.yml,.csv,.png,.jpg,.jpeg,.svg";

type UploadPayload = {
  name: string;
  type: string;
  content: string;
};

type DescriptionContainerProps = {
  onJobCreated: (view: Record<string, unknown>) => void;
  onMessage: (message: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  fetchError?: string | null;
};

export function DescriptionContainer({
  onJobCreated,
  busy,
  setBusy,
  fetchError,
}: DescriptionContainerProps) {
  const [prompt, setPrompt] = useState(
    `Create a deployment configurator view from these notes.\nShow selectable services, constraints, environment stages, and a concise export summary.`,
  );
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submitJob() {
    setBusy(true);
    setError(null);
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
      const view = (await response.json()) as Record<string, unknown>;
      onJobCreated(view);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // Function to remove a specific file from the state
  function removeFile(fileToRemove: File) {
    setFiles(files.filter(f => f !== fileToRemove));
  }

  return (
    <Card>
      <Card.Header>
        <CardHeader
          number="1"
          title="Describe the configurator"
          description="Write what the generated view should do. Add supporting files or settings when needed."
        />
      </Card.Header>
      <Card.Body>

        <Row>
          <Col>
            <Form.Group className="mb-3">
              <Form.Label className="sr-only" htmlFor="gen-prompt">
                Configurator description
              </Form.Label>
              <div className="dc-textarea-wrapper">
                <Form.Control
                  as="textarea"
                  id="gen-prompt"
                  className="dc-textarea"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={7}
                  placeholder="Write here..."
                />
                
                {files.length > 0 && (
                  <div className="dc-file-list-overlay">
                    {files.map((file, index) => (
                      <span 
                        key={index} 
                        className="dc-file-name" 
                        title={file.name}
                        onClick={() => removeFile(file)}
                      >
                        🗎 {file.name}
                      </span>
                    ))}
                  </div>
                )}

                <label className="gv-pill gv-pill-secondary dc-upload-btn-overlay">
                  +
                  <input
                    type="file"
                    className="dc-upload-input"
                    multiple
                    accept={ACCEPTED_FILES}
                    onChange={(event) =>
                      setFiles(Array.from(event.target.files ?? []))
                    }
                  />
                </label>
              </div>
            </Form.Group>
          </Col>
        </Row>

        {error && <div className="bs-error mb-2">{error}</div>}
        {fetchError && <div className="bs-error mb-2">{fetchError}</div>}

        <Row className="dc-footer align-items-center mt-3 justify-content-between">
          <Col xs={3}>
            <p className="dc-footer-note mb-2">
              Generated app runs in an isolated workspace.
            </p>
          </Col>
          <Col xs={3} className="text-end">
            <button
              className="gv-pill gv-pill-primary dc-generate-btn"
              onClick={submitJob}
              disabled={busy || prompt.trim().length === 0}
            >
              {busy ? "Creating job…" : "Generate view ↗"}
            </button>
          </Col>
        </Row>
      </Card.Body>
    </Card>
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