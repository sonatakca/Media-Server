import { Navbar } from "./Navbar";
import { RouteTransitionOutlet } from "./RouteTransitionOutlet";

export function Layout() {
  return (
    <div className="min-h-screen bg-transparent text-white">
      <Navbar />
      <main className="seyirlik-layout-main mx-auto w-full max-w-[95%] px-4 pb-16 pt-20 sm:px-6 lg:px-8">
        <RouteTransitionOutlet />
      </main>
    </div>
  );
}
