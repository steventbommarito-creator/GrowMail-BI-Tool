import { Geist } from "next/font/google";
import "./globals.css";
import Nav from "../components/Nav";
import ChatWidget from "../components/ChatWidget";
import { ThemeProvider } from "../context/ThemeContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata = {
  title: "GrowMail BI",
  description: "Postage tracking, cashflow and forecasting",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col" style={{ background: 'var(--bg)' }}>
        <ThemeProvider>
          <Nav />
          <main className="flex-1 p-4 md:p-6">{children}</main>
          {/* Floating AI chat widget — self-gates rendering by user email. */}
          <ChatWidget />
        </ThemeProvider>
      </body>
    </html>
  );
}
