import type { ReactNode } from "react";

export const metadata = {
  title: "Apature Gate",
  description: "Hosted design-review dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, color: "#111" }}>
        <header style={{ borderBottom: "1px solid #eee", padding: "12px 20px", display: "flex", gap: 16 }}>
          <strong>Apature Gate</strong>
          <form action="/api/auth/logout" method="post" style={{ marginLeft: "auto" }}>
            <button type="submit" style={{ background: "none", border: "none", color: "#555", cursor: "pointer" }}>
              Sign out
            </button>
          </form>
        </header>
        <main style={{ padding: "20px", maxWidth: 920, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
