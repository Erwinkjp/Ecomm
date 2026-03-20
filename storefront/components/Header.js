'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { NAV_CATEGORIES } from '@/lib/categories';

export default function Header() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('click', onClickOutside);
    return () => document.removeEventListener('click', onClickOutside);
  }, []);

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/" className="logo">
          Vantedge<span> Systems</span>
        </Link>

        <div className="header-actions">
          <div className="nav-categories" ref={ref}>
            <button
              type="button"
              className="nav-categories__trigger"
              aria-expanded={open}
              aria-haspopup="true"
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
            >
              Shop by category
              <span className="nav-categories__chevron" aria-hidden />
            </button>
            <ul className={`nav-categories__menu ${open ? 'is-open' : ''}`} role="menu">
              {NAV_CATEGORIES.map((cat) => (
                <li key={cat.handle} role="none">
                  <Link
                    href={`/collection/${cat.handle}`}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                  >
                    {cat.label}
                    <small>{cat.description}</small>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </header>
  );
}
