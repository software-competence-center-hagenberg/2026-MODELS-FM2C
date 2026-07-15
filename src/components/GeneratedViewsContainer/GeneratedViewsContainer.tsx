import Card from 'react-bootstrap/Card'
import { Col, Row } from 'react-bootstrap'
import { useEffect, useMemo, useState } from "react";
import { View } from "../View/View";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRotateRight, faEyeSlash, faEye } from '@fortawesome/free-solid-svg-icons';

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
  selectedViewId?: string | null;
  onEdit: (view: GeneratedView) => void;
  onError?: (error: string | null) => void;
};

export function GeneratedViewsContainer({
  selectedViewId,
  onEdit,
  onError,
}: GeneratedViewsContainerProps) {
  const [views, setViews] = useState<GeneratedView[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [hideErrors, setHideErrors] = useState(false);
  const [visibleCount, setVisibleCount] = useState(6);

  useEffect(() => {
    void refreshViews();
  }, []);

  // Reset pagination when filters or search query change
  useEffect(() => {
    setVisibleCount(6);
  }, [searchQuery, hideErrors]);

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
    let result = views;

    if (hideErrors) {
      result = result.filter((view) => view.status !== "error");
    }

    if (!searchQuery.trim()) return result;
    const q = searchQuery.toLowerCase();
    return result.filter(
      (view) =>
        view.title.toLowerCase().includes(q) ||
        view.public_url.toLowerCase().includes(q) ||
        view.id.toLowerCase().includes(q) ||
        (view.error_message ?? "").toLowerCase().includes(q),
    );
  }, [views, searchQuery, hideErrors]);

  const visibleViews = filteredViews.slice(0, visibleCount);
  const hasMore = visibleCount < filteredViews.length;

  return (
    <Card>
      <Card.Header className="gv-header-row">
        <div className="gv-header-text">
          <span className="gv-header-title">Generated configurators</span>
          <p className="gv-header-subtitle">
            Public preview links for generated configurators.
          </p>
        </div>

        <div className="gv-controls">
          <div className="gv-search-wrapper">
            <input
              type="text"
              className="gv-search-input"
              placeholder="Search configurators by title or URL"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {/* Added the icon as a separate overlay element */}
            <span className="gv-search-icon">🔎︎</span>
          </div>
          <button
            className="gv-pill gv-pill-secondary refresh-btn"
            onClick={() => void refreshViews()}
          >
            Refresh list <FontAwesomeIcon icon={faArrowRotateRight} />
          </button>

          <button
            className={`gv-pill gv-pill-secondary ${hideErrors ? 'gv-filter-active' : 'gv-filter-inactive'}`}
            onClick={() => setHideErrors((prev) => !prev)}
            title={hideErrors ? "Show all views" : "Hide views with errors"}
          >
            <FontAwesomeIcon icon={hideErrors ? faEye : faEyeSlash} />
          </button>
        </div>
      </Card.Header>

      <Card.Body>
        <Row className="g-3">
          {visibleViews.map((view) => (
            <Col key={view.id} xs={12} md={6}>
              <View
                view={view}
                onEdit={onEdit}
                isSelected={view.id === selectedViewId}
              />
            </Col>
          ))}
        </Row>

        {filteredViews.length === 0 && searchQuery.trim() && (
          <p className="gv-no-results">
            No configurators match &ldquo;{searchQuery}&rdquo;
          </p>
        )}

        {filteredViews.length > 0 && (
          <div className="d-flex justify-content-between align-items-center mt-1 pt-2 border-top">
            <button
              className="show-more"
              onClick={() => setVisibleCount((prev) => prev + 6)}
              style={{ display: hasMore ? 'inline-flex' : 'none' }}
            >
              Show more
            </button>
            <span className="gv-view-count">
              Showing {visibleViews.length} out of {filteredViews.length}
            </span>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}