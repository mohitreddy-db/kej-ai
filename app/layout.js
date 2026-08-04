import "./globals.css";

export const metadata = {
  title: "kejAI Operations Control",
  description: "Founder-facing operating dashboard for KEJ Minerals",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8f9fa",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
