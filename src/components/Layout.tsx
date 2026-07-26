import { Navbar } from "./Navbar";
import { RouteTransitionOutlet } from "./RouteTransitionOutlet";
import { DevSkeletonToggle } from "./DevSkeletonToggle";

export function Layout() {
  return (
    <div className="min-h-screen overflow-x-clip bg-transparent text-white">
      <Navbar />

      <main
        className="
          seyirlik-layout-main
          mx-auto
          w-full
          max-w-[95%]
          px-4
          pb-16
          pt-20
          [--page-gutter:calc(2.5vw_+_1rem)]
          sm:px-6
          sm:[--page-gutter:calc(2.5vw_+_1.5rem)]
          lg:px-8
          lg:[--page-gutter:calc(2.5vw_+_2rem)]
        "
      >
        <RouteTransitionOutlet />
      </main>

      <DevSkeletonToggle />
    </div>
  );
}
