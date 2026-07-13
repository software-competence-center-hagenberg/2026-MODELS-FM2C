const NAV_ITEMS = [
  { href: '/', label: 'Configurator Chat' },
  { href: '/docker', label: 'Docker Config' },
  { href: '/firefox', label: 'Firefox Config' },
];

export function Sidebar() {
  const currentPath = window.location.pathname;

  return (
    <div className="sidebar-container">
      <div className="sidebar-content">
        <a href="/" className="sidebar-logo">
        <img src="/logo.svg" alt="FM2C" className="sidebar-logo-img" />
        </a>
        <div className="sidebar-nav">
          
          
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === '/'
                ? currentPath === '/'
                : currentPath.startsWith(item.href);

            return (
              <a
                key={item.href}
                href={item.href}
                className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              >
                {item.label}
              </a>
            );
          })}
        </div>
        <div className="sidebar-tip">
          <p className="sidebar-tip-toptext">Generated Views</p>
          <h3 className="sidebar-tip-heading">Generate standalone configurator pages from a short brief.</h3>
          <p className="sidebar-tip-subheading"> fm2c creates isolated React views, validates the generated code and makes it accessible for everyone.</p>
        </div>
      </div>
    </div>
  );
}