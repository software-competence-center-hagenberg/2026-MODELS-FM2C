import Badge from 'react-bootstrap/Badge'
import type { GeneratedView, GeneratedStatus } from "./GeneratedViewsContainer";

type ViewProps = {
  view: GeneratedView;
  onEdit: (view: GeneratedView) => void;
};

export function View({ view, onEdit }: ViewProps) {
  return (
    <div className="gv-view-custom">
      <div className="gv-view-header">
        <p className="view-title">{view.title}</p>
        <StatusBadge status={view.status} />
      </div>

      <div className="gv-view-body">
        <p className="view-description">{view.description}</p>
        <p className="view-description">
          {view.public_url}
        </p>
        <div className="view-actions">
          <button
            className="gv-pill gv-pill-secondary"
            onClick={() => {
              onEdit(view);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Select
          </button>
          {view.status === "ready" && (
            <a
              href={view.public_url}
              target="_blank"
              rel="noreferrer"
              className="gv-pill gv-pill-primary gv-open-link"
            >
              Open
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: GeneratedStatus }) {
  const isError = status === "error";
  return (
    <Badge className={`${isError ? 'badge-error' : 'badge-success'}`}>
      {status}
    </Badge>
  );
}