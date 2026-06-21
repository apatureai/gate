import { NAV_ITEMS } from "@gate/dashboard";
import Link from "next/link";
import type { ReactNode } from "react";
import { requireInstallation } from "@/lib/session";

/** Installation-scoped shell: enforces access, renders the core nav. */
export default async function InstallationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;
  await requireInstallation(Number(installationId));

  return (
    <div>
      <nav style={{ display: "flex", gap: 14, marginBottom: 20, borderBottom: "1px solid #eee", paddingBottom: 8 }}>
        {NAV_ITEMS.map((item) => (
          <Link key={item.key} href={`/${installationId}${item.href}`}>
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
