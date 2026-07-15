import Badge from 'react-bootstrap/Badge';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare, faCheck } from '@fortawesome/free-solid-svg-icons';
import type { GeneratedView, GeneratedStatus } from '../GeneratedViewsContainer/GeneratedViewsContainer';
import './View.css';


type ViewProps = {
  view: GeneratedView;
  onEdit: (view: GeneratedView) => void;
  isSelected?: boolean;
};

export function View({ view, onEdit, isSelected }: ViewProps) {
  return (
    <div
      className={`gv-view-custom ${isSelected ? 'gv-view-selected' : ''}`}
    >
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
            className={`gv-pill ${isSelected ? 'select-disabled-btn' : 'select-btn'}`}
            onClick={() => {
              onEdit(view);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            disabled={isSelected}
          >
            {isSelected ? (
              <>Editing <FontAwesomeIcon icon={faCheck} /></>
            ) : (
              <>Select <FontAwesomeIcon icon={faCheck} /></>
            )}
          </button>
          {view.status === "ready" && (
            <a
              href={view.public_url}
              target="_blank"
              rel="noreferrer"
              className="gv-pill gv-pill-primary green-btn"
            >
              Open <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: GeneratedStatus }) {
  const isError = status === "error";
  const isReady = status === "ready";
  return (
    <Badge className={`${isError ? 'badge-error' :'badge-success'}`}>
      {isError ? 'Error ⛌' : isReady ? 'Ready ✓' : 'Generating ⧖'}
    </Badge>
  );
}