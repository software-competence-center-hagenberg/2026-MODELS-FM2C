import { useState } from "react";
import Form from 'react-bootstrap/Form';

type EnhanceSectionProps = {
  isEnhancing: boolean;
  onEnhance: (instructions: string) => void;
};

export function EnhanceSection({ isEnhancing, onEnhance }: EnhanceSectionProps) {
  const [text, setText] = useState("");

  return (
    <div className="bs-enhance">
      <div className="bs-enhance-header">
        <p className="bs-enhance-hint">Ask for changes or enhancements and regenerate:</p>
      </div>
      <Form.Control
        as="textarea"
        className="dc-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Example: Add ingredient icons, show selected items as SVG, and include a price summary."
        style={{ resize: 'none' }}
        disabled={isEnhancing}
      />
      <button
        className="gv-pill gv-pill-dark bs-enhance-btn"
        onClick={() => onEnhance(text)}
        disabled={isEnhancing || !text.trim()}
      >
        {isEnhancing ? "Enhancing…" : "Enhance view"}
      </button>
    </div>
  );
}