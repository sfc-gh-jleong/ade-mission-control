import type { Metadata } from "next"
import type React from "react"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { AppShell } from "@/components/ade/shell"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import "./globals.css"

// Sets the theme class before first paint. Dark is the default for this
// operations console; the user's explicit choice (localStorage "theme") wins.
// Keep in sync with components/theme-provider.tsx.
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="dark"||!t||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){document.documentElement.classList.add("dark")}`

export const metadata: Metadata = {
  title: { default: APP_TITLE, template: `%s · ${APP_TITLE}` },
  description: "Autonomous Investigator, Fixer and Reviewer agents for failed Snowflake jobs, with per-step telemetry.",
  icons: { icon: LOGO_SRC },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <QueryProvider>
            <AppShell>{children}</AppShell>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
