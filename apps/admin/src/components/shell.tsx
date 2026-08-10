"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { Anchor, Box, Button, Container, Group, Text } from "@mantine/core";
import { logout } from "@/app/actions";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/mcp", label: "MCP servers" },
  { href: "/imap", label: "Mail" },
  { href: "/calendar", label: "Calendar" },
  { href: "/connectors", label: "Connectors" },
  { href: "/tasks", label: "Tasks" },
  { href: "/users", label: "Users" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pending, start] = useTransition();

  return (
    <Container size="md" py="xl">
      <Group
        justify="space-between"
        pb="md"
        mb="xl"
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        <Group gap="lg">
          <Anchor component={Link} href="/" underline="never" c="inherit">
            <Text fw={700} size="sm">
              Jarvis{" "}
              <Text span fw={400} c="dimmed">
                admin
              </Text>
            </Text>
          </Anchor>
          <Group gap={4}>
            {LINKS.map((link) => {
              // "/" would otherwise match every route.
              const active =
                link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
              return (
                <Button
                  key={link.href}
                  component={Link}
                  href={link.href}
                  size="xs"
                  variant={active ? "light" : "subtle"}
                  color={active ? "teal" : "gray"}
                >
                  {link.label}
                </Button>
              );
            })}
          </Group>
        </Group>

        <Button
          size="xs"
          variant="default"
          loading={pending}
          onClick={() => start(() => void logout())}
        >
          Log out
        </Button>
      </Group>

      <Box>{children}</Box>
    </Container>
  );
}
