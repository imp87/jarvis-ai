import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, createTheme, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jarvis Admin",
  description: "Tool registry and MCP server management",
};

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "md",
  cursorType: "pointer",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        {/* Applies the stored scheme before first paint, so the page never
            flashes light before switching. */}
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="dark">
          <Notifications position="top-right" />
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
