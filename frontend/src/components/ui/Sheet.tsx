import { Drawer, type DrawerProps } from "./Drawer";

export function Sheet(props: Omit<DrawerProps, "side">) {
  return <Drawer {...props} side="bottom" />;
}
