import { useIsMobileView } from "../hooks/useIsMobileView";
import { DesktopNavbar } from "./desktop/DesktopNavbar";
import { MobileNavbar } from "./mobile/MobileNavbar";

export function Navbar() {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return <MobileNavbar />;
  }

  return <DesktopNavbar />;
}
