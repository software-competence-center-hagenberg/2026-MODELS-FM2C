import { GeneratedViews } from './views/GeneratedViews/GeneratedViews';

const NAV_ITEMS = [
  { href: '/', label: 'Configurator Chat' },
  { href: '/docker', label: 'Docker Config' },
  { href: '/firefox', label: 'Firefox Config' },
];

function TopNav() {
  const currentPath = window.location.pathname;
  return (
    <nav
      style={
        {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          background: '#000',
          borderBottom: `3px solid #00e600`,
          padding: '0 16px',
          height: 48,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        } as const
      }
    >
      <span
        style={
          {
            color: '#00e600',
            fontWeight: 800,
            fontSize: 14,
            marginRight: 24,
            letterSpacing: '-0.02em',
          } as const
        }
      >
        fm2c
      </span>
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === '/'
            ? currentPath === '/'
            : currentPath.startsWith(item.href);
        return (
          <a
            key={item.href}
            href={item.href}
            style={
              {
                color: isActive ? '#00e600' : '#aaa',
                textDecoration: 'none',
                padding: '8px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: isActive ? 700 : 500,
                background: isActive ? '#00e60018' : 'transparent',
                transition: 'all 0.15s',
                cursor: 'pointer',
              } as const
            }
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

function App() {
  return (
    <>
      <TopNav />
      <div style={{ marginTop: 48 }}>
        <GeneratedViews />
      </div>
    </>
  );
}

export default App;
