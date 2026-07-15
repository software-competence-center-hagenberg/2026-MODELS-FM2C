import { useState } from 'react';

const NAV_ITEMS = [
  { href: '/sandwich', label: 'Sandwich' },
  { href: '/docker', label: 'Docker Config' },
  { href: '/firefox', label: 'Firefox Config' },
  { href: '/linux-kernel', label: 'Linux Kernel' },
  { href: '/windows-kernel', label: 'Windows Kernel'},
  { href: '/windows-settings', label: 'Windows Settings'},
];

export function Sidebar() {
  const currentPath = window.location.pathname;
  const [showExamples, setShowExamples] = useState(false);

  return (
    <div className="sidebar-container">
      <div className="sidebar-content">
        <a href="/" className="sidebar-logo">
          <img src="/logo.svg" alt="FM2C" className="sidebar-logo-img" />
        </a>
        <div className="sidebar-nav">
          <a
            href="/"
            className={`sidebar-nav-item ${currentPath === '/' ? 'active' : ''}`}
          >
            Playground
          </a>

          <a
            href="#"
            className="sidebar-nav-item sidebar-expand-toggle"
            onClick={(e) => {
              e.preventDefault();
              setShowExamples((prev) => !prev);
            }}
          >
            Explore examples&nbsp;
            <span
              className="sidebar-expand-arrow"
              style={{ transform: showExamples ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
            >
              ▸
            </span>
          </a>

          {showExamples &&
            NAV_ITEMS.map((item) => {
              const isActive = currentPath.startsWith(item.href);
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={`sidebar-nav-item sidebar-sub-item ${isActive ? 'active' : ''}`}
                >
                  {item.label}
                </a>
              );
            })}
        </div>
        <div className="sidebar-tip">
          <p className="sidebar-tip-toptext">Generated Configurators</p>
          <h3 className="sidebar-tip-heading">From feature model to a configurator.</h3>
          <p className="sidebar-tip-subheading">FM2C creates isolated React configurators, validates the generated code and makes it accessible for everyone.</p>
        </div>
      </div>
    </div>
  );
}