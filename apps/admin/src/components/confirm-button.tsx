"use client";

import { useTransition } from "react";
import { Button, Group, Menu, Modal, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

/**
 * Destructive actions behind a modal rather than `window.confirm`.
 *
 * The native dialog cannot say what is about to be lost beyond one line, and it
 * blocks the whole tab while it is open. Here the consequence is spelled out —
 * deleting a connector takes its endpoints and its credential with it, which is
 * not obvious from a button labelled "Remove".
 */
export function ConfirmButton({
  label,
  title,
  body,
  onConfirm,
  as = "button",
  colour = "red",
}: {
  label: string;
  title: string;
  body: string;
  onConfirm: () => Promise<void>;
  as?: "button" | "menu-item";
  colour?: string;
}) {
  const [opened, modal] = useDisclosure(false);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      await onConfirm();
      modal.close();
    });

  return (
    <>
      {as === "menu-item" ? (
        <Menu.Item color={colour} onClick={modal.open}>
          {label}
        </Menu.Item>
      ) : (
        <Button variant="light" color={colour} size="xs" onClick={modal.open}>
          {label}
        </Button>
      )}

      <Modal opened={opened} onClose={modal.close} title={title} size="sm" centered>
        <Text size="sm" c="dimmed">
          {body}
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={modal.close}>
            Cancel
          </Button>
          <Button color={colour} loading={pending} onClick={confirm}>
            {label}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
