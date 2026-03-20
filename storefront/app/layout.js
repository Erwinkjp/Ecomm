import './globals.css';
import Header from '@/components/Header';

export const metadata = {
  title: 'Vantedge Systems',
  description: 'PC parts, peripherals, monitors & more — shop with confidence.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <Header />
        <main style={{ flex: 1 }}>{children}</main>
        <footer className="site-footer">
          <div className="container">
            © {new Date().getFullYear()} Vantedge Systems. Prices and availability on Shopify.
          </div>
        </footer>
      </body>
    </html>
  );
}
