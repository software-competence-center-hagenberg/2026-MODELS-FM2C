import Card from 'react-bootstrap/Card'
import { Col, Row } from 'react-bootstrap'
import { useEffect, useMemo, useState } from "react";
import { View } from "./View";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons';

type GeneratedStatus =
  | "queued" | "preparing" | "generating" | "validating"
  | "building" | "publishing" | "enhancing" | "ready" | "error";

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

export type { GeneratedView, GeneratedStatus };

type GeneratedViewsContainerProps = {
  onEdit: (view: GeneratedView) => void;
  onError?: (error: string | null) => void;
};

export function GeneratedViewsContainer({ onEdit, onError }: GeneratedViewsContainerProps) {
  const [views, setViews] = useState<GeneratedView[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    void refreshViews();
  }, []);

  async function refreshViews() {
    onError?.(null);
    try {
      const response = await fetch("/api/views");
      if (!response.ok)
        throw new Error(
          "The generator API is not available. Start it with npm run server.",
        );
      const payload = (await response.json()) as { views: GeneratedView[] };
      setViews(payload.views);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : String(caught);
      onError?.(msg);
    }
  }

  const filteredViews = useMemo(() => {
    if (!searchQuery.trim()) return views;
    const q = searchQuery.toLowerCase();
    return views.filter(
      (view) =>
        view.title.toLowerCase().includes(q) ||
        view.public_url.toLowerCase().includes(q) ||
        view.id.toLowerCase().includes(q) ||
        (view.error_message ?? "").toLowerCase().includes(q),
    );
  }, [views, searchQuery]);

  return (
    <Card>
      <Card.Header className="gv-header-row">
        <div className="gv-header-text">
          <span className="gv-header-title">Generated views</span>
          <p className="gv-header-subtitle">
            Public preview links for generated configurators.
          </p>
        </div>

        <div className="gv-controls">
          <div className="gv-search-wrapper">
            <input
              type="text"
              className="gv-search-input"
              placeholder="Search views by title or URL…               🔎︎"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button
            className="gv-pill gv-pill-secondary gv-refresh-btn"
            onClick={() => void refreshViews()}
          >
            Refresh list <FontAwesomeIcon icon={faArrowRotateRight} />
          </button>
        </div>
      </Card.Header>

      <Card.Body>
        <Row className="g-3">
          {filteredViews.map((view) => (
            <Col key={view.id} xs={12} md={6}>
              <View view={view} onEdit={onEdit} />
            </Col>
          ))}
        </Row>

        {filteredViews.length === 0 && searchQuery.trim() && (
          <p className="gv-no-results">
            No views match &ldquo;{searchQuery}&rdquo;
          </p>
        )}
      </Card.Body>
    </Card>
  );
}