import React from 'react';
import './MilestoneProgressBar.css';

export interface Milestone {
  percentage: number;
  label: string;
}

interface MilestoneProgressBarProps {
  value: number;
  milestones?: Milestone[];
  progressColor?: string;
  baseColor?: string;
}

const DEFAULT_MILESTONES: Milestone[] = [
  { percentage: 0, label: '0%' },
  { percentage: 25, label: '25%' },
  { percentage: 50, label: '50%' },
  { percentage: 75, label: '75%' },
  { percentage: 100, label: '100%' },
];

export function MilestoneProgressBar({
  value,
  milestones = DEFAULT_MILESTONES,
  progressColor,
  baseColor,
}: MilestoneProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      className="vefs-milestone-wrapper"
      style={
        {
          '--progress-color': progressColor,
          '--base-color': baseColor,
        } as React.CSSProperties
      }
    >
      <div className="milestone-container">
        {/* Chart: line + dots */}
        <div className="chart-container">
          <div className="line-container">
            <div className="line" />
            <div className="line left" style={{ width: `${clamped}%` }} />
          </div>
          <div className="dot-container">
            {milestones.map((m) => {
              const completed = clamped >= m.percentage;
              return (
                <div
                  key={m.percentage}
                  className="milestones"
                  style={{ left: `${m.percentage}%` }}
                >
                  <div className={`dot${completed ? ' completed' : ''}`} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Labels */}
        <div className="label-container">
          {milestones.map((m) => {
            const completed = clamped >= m.percentage;
            return (
              <div
                key={`label-${m.percentage}`}
                className="milestones"
                style={{ left: `${m.percentage}%` }}
              >
                <div className={`label${completed ? ' colored' : ''}`}>
                  {m.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}