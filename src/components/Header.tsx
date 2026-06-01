import { AppHeader } from '@/components/layout';
import { ReactNode } from "react";

export function Header({
  left,
  title,
  right,
}: {
  left?: ReactNode;
  title?: ReactNode;
  right?: ReactNode;
}) {
  return <AppHeader left={left} title={title} right={right} />;
}
