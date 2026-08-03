import "./globals.css";

export const metadata = {
  title: "kejAI Operations Control",
  description: "Founder-facing operating dashboard for KEJ Minerals",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
