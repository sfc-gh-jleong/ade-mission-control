/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "ADE Mission Control"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

/** Pages listed under "Go to" in the ⌘K command palette. */
export const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Command Center", href: "/" },
  { label: "Incidents · needs attention", href: "/incidents?view=attention" },
  { label: "Incidents · in flight", href: "/incidents?view=active" },
  { label: "Incidents · history backlog", href: "/incidents?view=backlog" },
  { label: "Fleet", href: "/fleet" },
  { label: "Analytics", href: "/analytics" },
  { label: "Chaos Lab", href: "/chaos" },
  { label: "Settings", href: "/settings" },
]

/** Unused (template demo prompts); the palette hides the group while empty. */
export const EXAMPLE_PROMPTS: string[] = []
