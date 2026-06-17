/**
 * Dashboard navigation shell model (TRD §7, §13). The Next.js layout renders
 * these; keeping them as data makes the shell trivial and testable.
 */
export interface NavItem {
  key: string;
  label: string;
  href: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "runs", label: "Runs", href: "/runs" },
  { key: "findings", label: "Findings", href: "/findings" },
  { key: "feedback", label: "Feedback", href: "/feedback" },
  { key: "config", label: "Config", href: "/config" },
  { key: "billing", label: "Billing", href: "/billing" },
] as const;
