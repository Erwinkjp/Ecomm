'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { MEGA_TILES, MEGA_COLUMNS, MAIN_NAV_LINKS } from '@/lib/megaMenu';
import { getShopifyAccountLoginUrl, getShopifyAccountRegisterUrl } from '@/lib/storeUrls';

function NavIcon({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 };
  switch (name) {
    case 'wrench':
      return (
        <svg {...common} aria-hidden>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case 'book':
      return (
        <svg {...common} aria-hidden>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case 'package':
      return (
        <svg {...common} aria-hidden>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common} aria-hidden>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...common} aria-hidden>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Header() {
  const [megaOpen, setMegaOpen] = useState(false);
  const megaRef = useRef(null);

  const loginUrl = getShopifyAccountLoginUrl();
  const registerUrl = getShopifyAccountRegisterUrl();

  useEffect(() => {
    function onClickOutside(e) {
      if (megaRef.current && !megaRef.current.contains(e.target)) setMegaOpen(false);
    }
    function onEsc(e) {
      if (e.key === 'Escape') setMegaOpen(false);
    }
    document.addEventListener('click', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, []);

  return (
    <header className="site-header-wrap">
      <div className="utility-bar">
        <div className="container utility-bar__inner">
          <span className="utility-bar__tagline">Professional parts &amp; peripherals</span>
          <div className="utility-bar__links">
            <a href={loginUrl} className="utility-bar__link">
              Log in
            </a>
            <a href={registerUrl} className="utility-bar__link utility-bar__link--emphasis">
              Register
            </a>
            <Link href="/order-status" className="utility-bar__link">
              My orders
            </Link>
          </div>
        </div>
      </div>

      <div className="site-header">
        <div className="container main-nav">
          <Link href="/" className="logo logo--mega" aria-label="Vantedge Systems home">
            <span className="logo__mark">VANTEDGE</span>
            <span className="logo__sub">SYSTEMS</span>
          </Link>

          <nav className="main-nav__center" aria-label="Primary">
            {MAIN_NAV_LINKS.map((item) => (
              <Link key={item.href} href={item.href} className="main-nav__item">
                <span className="main-nav__icon" aria-hidden>
                  <NavIcon name={item.icon} />
                </span>
                {item.label}
              </Link>
            ))}

            <div
              className="mega-wrap"
              ref={megaRef}
              onMouseEnter={() => {
                if (typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches) {
                  setMegaOpen(true);
                }
              }}
              onMouseLeave={() => {
                if (typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches) {
                  setMegaOpen(false);
                }
              }}
            >
              <button
                type="button"
                className={`main-nav__item main-nav__item--products ${megaOpen ? 'is-active' : ''}`}
                aria-expanded={megaOpen}
                aria-haspopup="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setMegaOpen((v) => !v);
                }}
              >
                <span className="main-nav__icon" aria-hidden>
                  <NavIcon name="grid" />
                </span>
                Products
              </button>

              <div className={`mega-menu ${megaOpen ? 'mega-menu--open' : ''}`} role="region" aria-label="Product categories">
                <div className="container mega-menu__inner">
                  <div className="mega-menu__tiles">
                    {MEGA_TILES.map((tile) => (
                      <Link
                        key={tile.label}
                        href={tile.href}
                        className="mega-tile"
                        style={{ background: tile.accent }}
                        onClick={() => setMegaOpen(false)}
                      >
                        <span className="mega-tile__label">{tile.label}</span>
                      </Link>
                    ))}
                  </div>
                  <div className="mega-menu__columns">
                    {MEGA_COLUMNS.map((col) => (
                      <div key={col.heading} className="mega-col">
                        <h3 className="mega-col__heading">{col.heading}</h3>
                        <ul className="mega-col__list">
                          {col.links.map((link) => (
                            <li key={link.label}>
                              <Link href={link.href} onClick={() => setMegaOpen(false)}>
                                {link.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </nav>

          <div className="main-nav__end">
            <Link href="/search" className="main-nav__search" aria-label="Search products">
              <NavIcon name="search" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
