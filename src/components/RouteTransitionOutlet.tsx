import { AnimatePresence } from "framer-motion";
import { Outlet, useLocation } from "react-router-dom";
import { PageTransition } from "./PageTransition";

interface RouteTransitionOutletProps {
  variant?: "default" | "player";
}

export function RouteTransitionOutlet({
  variant = "default",
}: RouteTransitionOutletProps) {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait" initial>
      <PageTransition key={location.pathname} variant={variant}>
        <Outlet />
      </PageTransition>
    </AnimatePresence>
  );
}
